/**
 * Error classification and cooldown-hint parsing.
 *
 * Pure functions, no pi imports, so the classifier and the next-model
 * selection can be unit-tested with `bun test` without booting a session.
 */

export type ErrorClass = "transient" | "quota" | "fatal";

export interface ClassifyOptions {
  /** HTTP status when the error came from `after_provider_response`. */
  status?: number;
  /** Raw `retry-after` / rate-limit headers, when available. */
  headers?: Record<string, string | string[] | undefined>;
}

/** Context-window overflow: never bounce, the next model has the same problem. */
const CONTEXT_OVERFLOW_PATTERNS = [
  /context window/i, /context length/i, /prompt is too long/i, /maximum context/i,
  /too many tokens/i, /token limit/i, /request.?too.?large/i, /input.?token/i,
  /reduce the length/i, /maximum prompt length/i,
];

/** Bad credentials, missing model, malformed request: bouncing only wastes turns. */
const FATAL_PATTERNS = [
  /\b401\b/, /\b400\b/, /invalid.?api.?key/i, /incorrect.?api.?key/i, /authentication/i,
  /unauthorized/i, /invalid.?token/i, /model.?not.?found/i, /does not exist/i,
  /unsupported.?model/i, /bad.?request/i, /permission.?denied/i,
];

/**
 * Quota / billing exhaustion: the model will not recover on its own within a
 * turn, so bounce immediately with a long cooldown.
 */
const QUOTA_PATTERNS = [
  /\b402\b/, /usage limit/i, /usage_limit/i, /insufficient.?quota/i, /quota/i,
  /resource.?exhausted/i, /prepayment/i, /payment required/i, /paywall/i,
  /billing/i, /\bcredit/i, /subscription/i, /out of budget/i, /available balance/i,
  /hit your .* limit/i, /exceeded your current quota/i, /quota exceeded/i,
];

/**
 * Transient provider failures: 5xx (incl. 529), overload, timeouts, transport
 * errors, and 429s that carry no quota/usage wording. These get retried on the
 * same model before bouncing.
 */
const TRANSIENT_PATTERNS = [
  /\b5\d\d\b/, /overloaded/i, /server_error/i, /service.?unavailable/i,
  /temporarily.?unavailable/i, /endpoint is unavailable/i, /unavailable/i,
  /timeout/i, /timed out/i, /etimedout/i, /econnreset/i, /econnrefused/i,
  /eai_again/i, /socket hang ?up/i, /fetch failed/i, /network error/i,
  /connection (?:reset|closed|error)/i, /rate.?limit/i, /too many requests/i,
  /capacity/i, /try again/i,
];

/**
 * Classify a provider error.
 *
 * - `quota`    → bounce now, long cooldown
 * - `transient`→ retry the same model with backoff, short cooldown when exhausted
 * - `fatal`    → do not bounce (context overflow, auth, bad request)
 */
export function classifyError(text: string, opts: ClassifyOptions = {}): ErrorClass {
  const raw = String(text ?? "");
  if (!raw.trim()) return "fatal";
  if (CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(raw))) return "fatal";

  const status = opts.status;
  if (status === 401 || status === 400) return "fatal";
  if (status === 402) return "quota";
  if (status === 403) return QUOTA_PATTERNS.some((p) => p.test(raw)) ? "quota" : "fatal";
  if (status === 429) return QUOTA_PATTERNS.some((p) => p.test(raw)) ? "quota" : "transient";
  if (typeof status === "number" && status >= 500) return "transient";

  if (QUOTA_PATTERNS.some((p) => p.test(raw))) return "quota";
  if (FATAL_PATTERNS.some((p) => p.test(raw))) return "fatal";
  if (TRANSIENT_PATTERNS.some((p) => p.test(raw))) return "transient";
  return "fatal";
}

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const UNIT: Record<string, number> = {
  ms: 1, s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
  m: MINUTE, min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE,
  h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
  d: DAY, day: DAY, days: DAY,
};

/** Parse `2h15m` / `90s` / `5m` into milliseconds, or null. */
export function parseDuration(text: string): number | null {
  // No trailing \b: "2h15m" has no boundary between "h" and "1".
  const re = /(\d+(?:\.\d+)?)\s*(ms|secs|seconds|second|sec|s|mins|minutes|minute|min|m|hrs|hours|hour|hr|h|days|day|d)(?![a-z])/gi;
  let total = 0, matched = false, m: RegExpExecArray | null;
  while ((m = re.exec(text))) { total += Number(m[1]) * UNIT[m[2].toLowerCase()]; matched = true; }
  return matched ? Math.round(total) : null;
}

/**
 * Best-effort extraction of "when can I use this again" from an error body or
 * its headers. Returns milliseconds, or null when no hint is present.
 *
 * Recognises `retry-after` (seconds or HTTP-date), "resets in 4h12m",
 * "try again in 30 seconds", "5-hour limit", "resets at 17:30 UTC".
 */
export function parseResetHint(text: string, headers?: Record<string, string | string[] | undefined>): number | null {
  const now = Date.now();

  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"] ?? headers?.["x-ratelimit-reset-after"];
  const headerVal = Array.isArray(raw) ? raw[0] : raw;
  if (headerVal) {
    const secs = Number(headerVal);
    if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
    const at = Date.parse(headerVal);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  // Absolute epoch seconds (some providers send retry-after as a unix ts).
  const body = String(text ?? "");
  const epoch = body.match(/"(?:reset|reset_at|resets_at|retry_at)"\s*:\s*(\d{9,})/);
  if (epoch) return Math.max(0, Number(epoch[1]) * 1000 - now);

  const relative = body.match(/(?:resets?|retry|try again|available|again)\s+(?:in|after|at)\s+([^\n"',}]{1,40})/i);
  if (relative) {
    const dur = parseDuration(relative[1]);
    if (dur !== null) return dur;
  }
  // "5-hour / 5 hour limit" (Codex-style rolling windows)
  const window = body.match(/\b(\d+(?:\.\d+)?)\s*[- ]?\s*(hour|hr|hrs|day|days?)\s+(?:usage\s+)?limit/i);
  if (window) {
    const mult = window[2].toLowerCase().startsWith("d") ? DAY : HOUR;
    return Math.round(Number(window[1]) * mult);
  }
  // "resets at 17:30" / "resets at 5:30 pm"
  const clock = body.match(/resets?\s+at\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?/i);
  if (clock) {
    let h = Number(clock[1]) % 12;
    const m = Number(clock[2]), s = Number(clock[3] ?? 0);
    if (/p/i.test(clock[4] ?? "")) h += 12;
    const target = new Date(now);
    target.setHours(h, m, s, 0);
    if (target.getTime() <= now) target.setDate(target.getDate() + 1);
    return target.getTime() - now;
  }
  return null;
}

/** Default backoff schedule for same-model transient retries. */
export const DEFAULT_TRANSIENT_BACKOFF_MS = [15_000, 60_000, 180_000];

/** Backoff delay for the 1-based transient attempt, clamped to the last entry. */
export function backoffFor(attempt: number, schedule: number[] = DEFAULT_TRANSIENT_BACKOFF_MS): number {
  const list = schedule.filter((n) => Number.isFinite(n) && n >= 0);
  if (list.length === 0) return 0;
  return list[Math.min(Math.max(1, attempt), list.length) - 1];
}
