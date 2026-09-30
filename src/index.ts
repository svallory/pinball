import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { backoffFor, classifyError, DEFAULT_TRANSIENT_BACKOFF_MS, parseResetHint, type ErrorClass } from "./classify";
import { chainIndex, findNextModel, findPreferredModel, modelKey } from "./chain";
import { activeFailures, clearFailure, markFailure, type FailureLedger } from "./cooldown";
import { nextPreferredOnModelSelect, isRecoveryStop } from "./policy";

interface PinballModel { provider: string; id: string; name?: string; reasoning?: boolean }
interface PinballConfig {
  enabled: boolean;
  maxRetries: number;
  /** Default cooldown for a failed model (also the quota cooldown unless overridden). */
  cooldownMs: number;
  notifyOnBounce: boolean;
  models: PinballModel[];
  /** Same-model attempts for transient errors before bouncing. */
  transientRetries?: number;
  /** Backoff schedule for those attempts, in ms. */
  transientBackoffMs?: number[];
  /** Cooldown earned when transient retries are exhausted. */
  transientCooldownMs?: number;
  /** Cooldown earned by a quota failure; defaults to `cooldownMs`. */
  quotaCooldownMs?: number;
  /** Switch back to the preferred model once it is out of cooldown. */
  returnToPreferred?: boolean;
}
interface PinballState extends FailureLedger {
  currentIndex: number;
  retryCount: number;
  lastBounceTime: number;
  consecutiveFailures: number;
  gaveUp: boolean;
  /** modelKey -> transient retries spent on the current streak. */
  transientAttempts: Map<string, number>;
  bounceLog: Array<{ from: string; to: string; reason: string; timestamp: number }>;
}
type PinballRuntime = {
  getConfig(): PinballConfig;
  saveConfig(config?: PinballConfig): void;
  state: PinballState;
  getOriginalModel(): { provider: string; id: string } | null;
  resetState(clearLog?: boolean): void;
  updateStatus(ctx: ExtensionContext): void;
};

const CONFIG_FILE = "pinball.json";
const LEGACY_CONFIG_FILE = "model-bouncer.json";
const DEFAULT_CONFIG: PinballConfig = {
  enabled: true,
  maxRetries: 3,
  cooldownMs: 60_000,
  notifyOnBounce: true,
  returnToPreferred: true,
  models: [],
};
const BOUNCE_DEDUPE_MS = 10_000;
const DEFAULT_TRANSIENT_COOLDOWN_MS = 60_000;
/** Multiplier applied to the cooldown of a model that could not be set at all. */
const UNREACHABLE_COOLDOWN_FACTOR = 10;

function configPath() { return join(getAgentDir(), CONFIG_FILE); }
function loadConfig(): PinballConfig {
  const path = configPath();
  if (!existsSync(path)) {
    const legacyPath = join(getAgentDir(), LEGACY_CONFIG_FILE);
    if (existsSync(legacyPath)) {
      try {
        const migrated = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(legacyPath, "utf-8")) };
        saveConfig(migrated);
        return migrated;
      } catch (err) { console.error(`[pinball] legacy config: ${err}`); }
    }
    return { ...DEFAULT_CONFIG };
  }
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(path, "utf-8")) }; }
  catch (err) { console.error(`[pinball] config load: ${err}`); return { ...DEFAULT_CONFIG }; }
}
function saveConfig(config: PinballConfig) {
  try { writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf-8"); }
  catch (err) { console.error(`[pinball] config save: ${err}`); }
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}
function shorten(text: string, max = 90) {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
function normStopReason(msg: { stopReason?: unknown } | null | undefined) { return String(msg?.stopReason ?? "").toLowerCase(); }
function isErrorStop(msg: { stopReason?: unknown } | null | undefined) { return normStopReason(msg) === "error"; }

export default function pinballExtension(pi: ExtensionAPI) {
  let config: PinballConfig = { ...DEFAULT_CONFIG, models: [] };
  let configLoaded = false;
  let originalModel: { provider: string; id: string } | null = null;
  let pendingRetryMessage: string | null = null;
  /** True while pinball itself is switching models (suppresses model_select handling). */
  let selfModelSwitch = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  /** modelKeys with a same-model transient retry already scheduled. */
  const pendingTransient = new Set<string>();
  const state: PinballState = {
    currentIndex: 0,
    retryCount: 0,
    lastBounceTime: 0,
    consecutiveFailures: 0,
    gaveUp: false,
    failures: new Map(),
    cooldowns: new Map(),
    transientAttempts: new Map(),
    bounceLog: [],
  };

  function ensureConfig() {
    if (!configLoaded) { config = loadConfig(); configLoaded = true; }
    return config;
  }
  function persistConfig(cfg = config) {
    config = cfg;
    configLoaded = true;
    saveConfig(config);
  }
  function resetState(clearLog = true) {
    state.currentIndex = 0;
    state.retryCount = 0;
    state.consecutiveFailures = 0;
    state.gaveUp = false;
    state.failures.clear();
    state.cooldowns.clear();
    state.transientAttempts.clear();
    if (clearLog) state.bounceLog = [];
  }
  function clearTimers() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    pendingTransient.clear();
  }

  // --- cooldown policy ---------------------------------------------------------

  function quotaCooldownMs() { return ensureConfig().quotaCooldownMs ?? ensureConfig().cooldownMs; }
  function transientCooldownMs() { return ensureConfig().transientCooldownMs ?? DEFAULT_TRANSIENT_COOLDOWN_MS; }
  function transientRetryBudget() { return Math.max(0, ensureConfig().transientRetries ?? 3); }
  function backoffSchedule() { return ensureConfig().transientBackoffMs ?? DEFAULT_TRANSIENT_BACKOFF_MS; }

  function updateStatus(ctx: ExtensionContext) {
    const cfg = ensureConfig();
    if (!cfg.enabled) { ctx.ui.setStatus("pinball", undefined); return; }
    const failures = activeFailures(state, cfg.cooldownMs).length;
    const label = failures > 0 ? `🎯 (on ${failures})` : "🎯 (on)";
    ctx.ui.setStatus("pinball", ctx.ui.theme.fg(failures > 0 ? "warning" : "success", label));
  }
  const runtime: PinballRuntime = {
    getConfig: ensureConfig,
    saveConfig: persistConfig,
    state,
    getOriginalModel: () => originalModel,
    resetState,
    updateStatus,
  };
  let commandsPromise: Promise<typeof import("./commands")> | null = null;
  function loadCommands() { return commandsPromise ??= import("./commands"); }

  function logBounce(from: string, to: string, reason: string) {
    state.bounceLog.push({ from, to, reason, timestamp: Date.now() });
    if (state.bounceLog.length > 50) state.bounceLog = state.bounceLog.slice(-50);
  }

  // --- model switching ---------------------------------------------------------

  async function bounceToModel(ctx: ExtensionContext, target: PinballModel, reason: string) {
    const current = ctx.model;
    if (current?.provider === target.provider && current.id === target.id) return true;
    try {
      const model = ctx.modelRegistry.find(target.provider, target.id);
      if (!model) throw new Error("unavailable");
      // pi emits model_select and awaits handlers before setModel resolves,
      // so the flag is consumed by the handler within this await.
      selfModelSwitch = true;
      const switched = await pi.setModel(model);
      selfModelSwitch = false;
      if (!switched) throw new Error("unavailable");
    } catch {
      selfModelSwitch = false;
      markFailure(state, modelKey(target), Date.now(), ensureConfig().cooldownMs * UNREACHABLE_COOLDOWN_FACTOR);
      return false;
    }
    state.currentIndex = chainIndex(config.models, modelKey(target));
    logBounce(current ? modelKey(current) : (originalModel ? modelKey(originalModel) : "unknown"), modelKey(target), reason);
    return true;
  }

  /**
   * Switch to the next model in chain order. `kind` decides the cooldown the
   * failed model earns: quota failures rest long, exhausted transient retries
   * rest briefly.
   */
  async function bounceAway(
    ctx: ExtensionContext,
    failedProvider: string,
    failedModel: string,
    errorText: string,
    kind: ErrorClass,
    resetHintMs?: number | null,
  ) {
    const cfg = ensureConfig();
    if (!cfg.enabled || !failedProvider || !failedModel || kind === "fatal") return null;
    const failedKey = `${failedProvider}/${failedModel}`;
    const now = Date.now();
    if (!originalModel) originalModel = { provider: failedProvider, id: failedModel };

    const cooldown = kind === "quota"
      ? Math.max(quotaCooldownMs(), resetHintMs ?? 0)
      : transientCooldownMs();
    const lastFailure = state.failures.get(failedKey);
    if (lastFailure !== undefined && now - lastFailure < BOUNCE_DEDUPE_MS) {
      return findNextModel(config.models, state, { failedKey, fallbackCooldownMs: cfg.cooldownMs, now });
    }

    markFailure(state, failedKey, now, cooldown);
    state.transientAttempts.delete(failedKey);
    state.retryCount++;
    state.lastBounceTime = now;

    const maxAttempts = Math.max(1, cfg.maxRetries) * Math.max(1, cfg.models.length);
    if (state.consecutiveFailures > maxAttempts) {
      state.gaveUp = true;
      ctx.ui.notify(`pinball: ${maxAttempts} attempts exhausted; stopped (/pinball reset).`, "error");
      updateStatus(ctx);
      return null;
    }

    let cursor: number | undefined;
    for (let i = 0; i < config.models.length; i++) {
      const target = findNextModel(config.models, state, { failedKey, afterIndex: cursor, fallbackCooldownMs: cfg.cooldownMs });
      if (!target) break;
      const targetKey = modelKey(target);
      if (await bounceToModel(ctx, target, kind)) {
        if (cfg.notifyOnBounce) {
          const wait = cooldown > cfg.cooldownMs ? ` (cooldown ${formatDuration(cooldown)})` : "";
          ctx.ui.notify(`🔄 ${failedKey} → ${targetKey} (${shorten(errorText)})${wait}`, "info");
        }
        updateStatus(ctx);
        return target;
      }
      cursor = chainIndex(config.models, targetKey);
    }
    ctx.ui.notify(`pinball: no models (${shorten(errorText)}).`, "error");
    updateStatus(ctx);
    return null;
  }

  /** Switch back to the earliest model earlier in the chain that is off cooldown. */
  async function returnToPreferredModel(ctx: ExtensionContext) {
    const cfg = ensureConfig();
    const current = ctx.model;
    const currentKey = current ? modelKey(current) : undefined;
    if (currentKey && originalModel && currentKey === modelKey(originalModel)) return false;
    const target = findPreferredModel(config.models, state, {
      currentKey,
      originalKey: originalModel ? modelKey(originalModel) : null,
      fallbackCooldownMs: cfg.cooldownMs,
    });
    if (!target) return false;
    const targetKey = modelKey(target);
    if (!(await bounceToModel(ctx, target as PinballModel, "return-to-preferred"))) return false;
    if (cfg.notifyOnBounce) {
      ctx.ui.notify(`↩️ ${currentKey ?? "unknown"} → ${targetKey} (back to preferred)`, "info");
    }
    updateStatus(ctx);
    return true;
  }

  // --- continuation plumbing ---------------------------------------------------

  async function dispatchRetry(text: string) {
    try { await pi.sendUserMessage(text); }
    catch (err) { console.warn(`[pinball] retry failed: ${err}`); }
  }

  /** Re-send the failed turn on the *same* model after `delayMs`. */
  function scheduleTransientRetry(ctx: ExtensionContext, key: string, text: string, delayMs: number) {
    if (pendingTransient.has(key)) return;
    pendingTransient.add(key);
    const timer = setTimeout(() => {
      timers.delete(timer);
      pendingTransient.delete(key);
      if (!ensureConfig().enabled) return;
      if (ctx.isIdle()) void dispatchRetry(text);
      else pendingRetryMessage = text;
    }, delayMs);
    timers.add(timer);
  }

  function transientRetryMessage(key: string, attempt: number, total: number, delayMs: number, errorText: string) {
    return `[pinball] ${key} transient provider error (${shorten(errorText, 140)}). Same-model retry ${attempt}/${total} in ${formatDuration(delayMs)}; do not switch models. Continue the task; retry the failed step.`;
  }
  function bounceRetryMessage(failedKey: string, targetKey: string, errorText: string) {
    return `[pinball] ${failedKey} hit provider limit/error (${shorten(errorText, 140)}). Switched to ${targetKey}. Continue the task; retry the failed step.`;
  }

  // --- events ------------------------------------------------------------------

  pi.on("after_provider_response", async (event, ctx) => {
    if (!ensureConfig().enabled) return;
    const text = `HTTP ${event.status}`;
    const headers = (event.headers ?? {}) as Record<string, string>;
    const kind = classifyError(text, { status: event.status, headers });
    // Quota failures bounce immediately. Transient failures are retried on the
    // same model at settle time; fatal errors never bounce.
    if (kind !== "quota") return;
    const cur = ctx.model;
    if (!cur) return;
    await bounceAway(ctx, cur.provider, cur.id, text, kind, parseResetHint("", headers));
  });

  pi.on("message_end", async (event, ctx) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;
    if (isErrorStop(msg)) {
      const errorText = msg.errorMessage ?? "";
      const kind = classifyError(errorText);
      // Transient errors are retried on the same model at agent_settled, where
      // the turn is finished and can safely be re-sent.
      if (kind !== "quota") return;
      await bounceAway(ctx, msg.provider, msg.model, errorText, kind, parseResetHint(errorText));
    } else if (isRecoveryStop(normStopReason(msg))) {
      const cur = ctx.model;
      const key = cur ? modelKey(cur) : undefined;
      state.consecutiveFailures = 0;
      state.gaveUp = false;
      pendingRetryMessage = null;
      if (key) {
        state.transientAttempts.delete(key);
        clearFailure(state, key);
      }
      // The session recovered (this turn, or a queued one, succeeded): cancel
      // any same-model retry still pending so its timer cannot fire "retry the
      // failed step" into a healthy session later.
      clearTimers();
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const cfg = ensureConfig();
    if (!cfg.enabled || state.gaveUp) return;
    const cur = ctx.model;
    if (cur && !originalModel) originalModel = { provider: cur.provider, id: cur.id };
    let lastError: string | null = null;
    let lastProvider = "";
    let lastModel = "";

    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "message") continue;
      const m = entry.message;
      if (m.role === "assistant") {
        if (isErrorStop(m) && m.errorMessage) { lastError = m.errorMessage; lastProvider = m.provider; lastModel = m.model; }
        break;
      }
    }
    if (!lastError || !lastProvider) return;

    const kind = classifyError(lastError);
    if (kind === "fatal") return;
    const failedKey = `${lastProvider}/${lastModel}`;

    if (kind === "transient") {
      const budget = transientRetryBudget();
      const spent = state.transientAttempts.get(failedKey) ?? 0;
      if (spent < budget && !pendingTransient.has(failedKey)) {
        const attempt = spent + 1;
        const delayMs = backoffFor(attempt, backoffSchedule());
        state.transientAttempts.set(failedKey, attempt);
        state.retryCount++;
        if (cfg.notifyOnBounce) {
          ctx.ui.notify(`⏳ ${failedKey} transient error; retry ${attempt}/${budget} on the same model in ${formatDuration(delayMs)}`, "info");
        }
        updateStatus(ctx);
        scheduleTransientRetry(ctx, failedKey, transientRetryMessage(failedKey, attempt, budget, delayMs, lastError), delayMs);
        return;
      }
    }

    const resetHintMs = kind === "quota" ? parseResetHint(lastError) : null;
    const target = await bounceAway(ctx, lastProvider, lastModel, lastError, kind, resetHintMs);
    if (!target || modelKey(target) === failedKey) {
      if (kind === "transient") ctx.ui.notify(`pinball: no continuation model (${shorten(lastError)}).`, "error");
      return;
    }

    pendingRetryMessage = null;
    state.consecutiveFailures++;
    const maxAttempts = Math.max(1, cfg.maxRetries) * Math.max(1, cfg.models.length);
    if (state.consecutiveFailures > maxAttempts) {
      state.gaveUp = true;
      ctx.ui.notify(`pinball: ${maxAttempts} attempts exhausted; stopped (/pinball reset).`, "error");
      return;
    }

    const text = bounceRetryMessage(failedKey, modelKey(target), lastError);
    if (ctx.isIdle()) await dispatchRetry(text);
    else pendingRetryMessage = text;
  });

  pi.on("model_select", (event) => {
    const next = nextPreferredOnModelSelect({
      selfInitiated: selfModelSwitch,
      provider: event.model.provider,
      id: event.model.id,
    });
    selfModelSwitch = false;
    if (!next) return;
    // The operator picked this model themselves (manual pick, cycle, or
    // restore): it becomes the new preferred model so return-to-preferred
    // never switches away from it, and any retry pending for the old model
    // is moot — do not fight the operator.
    originalModel = next;
    clearTimers();
    pendingRetryMessage = null;
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (ensureConfig().enabled && ensureConfig().returnToPreferred !== false && !state.gaveUp) {
      try { await returnToPreferredModel(ctx); }
      catch (err) { console.warn(`[pinball] return-to-preferred failed: ${err}`); }
    }
    if (!pendingRetryMessage) return;
    const content = pendingRetryMessage;
    pendingRetryMessage = null;
    return { message: { customType: "pinball-retry", content, display: false } };
  });

  pi.registerCommand("pinball", {
    description: "Auto failover on provider errors",
    getArgumentCompletions: (prefix) => ["enable", "disable", "status", "config", "list", "add", "remove", "test", "reset", "log"]
      .filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      ensureConfig();
      const sub = args?.trim().toLowerCase() ?? "";
      switch (sub) {
        case "enable":
          config.enabled = true; persistConfig(); ctx.ui.notify("pinball: on", "info"); updateStatus(ctx); break;
        case "disable":
          config.enabled = false; persistConfig(); clearTimers(); ctx.ui.notify("pinball: off", "info"); updateStatus(ctx); break;
        case "reset":
          clearTimers();
          state.failures.clear(); state.cooldowns.clear(); state.transientAttempts.clear();
          state.retryCount = 0; state.consecutiveFailures = 0; state.gaveUp = false;
          ctx.ui.notify("pinball: reset", "info"); updateStatus(ctx); break;
        case "status": case "config": case "list": case "add": case "remove": case "test": case "log":
          try { await (await loadCommands()).handlePinballCommand(sub, pi, ctx, runtime); }
          catch (err) { console.error(`[pinball] command load: ${err}`); ctx.ui.notify(`pinball: command unavailable (${shorten(String(err))})`, "error"); }
          break;
        default:
          config.enabled = !config.enabled; persistConfig(); ctx.ui.notify(`pinball: ${config.enabled ? "on" : "off"}`, "info"); updateStatus(ctx);
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    clearTimers();
    config = loadConfig();
    configLoaded = true;
    originalModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
    pendingRetryMessage = null;
    resetState();
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => { clearTimers(); });
}
