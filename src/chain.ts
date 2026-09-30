/**
 * Chain selection: which model to use after a failure, and which model to
 * return to once the preferred one is out of cooldown.
 *
 * Pure functions over the configured chain plus a failure ledger, so both can
 * be unit-tested without booting a pi session.
 */

import { isCooling, type FailureLedger } from "./cooldown";

export interface ChainModel { provider: string; id: string; name?: string; reasoning?: boolean }

export function modelKey(m: ChainModel): string { return `${m.provider}/${m.id}`; }

/** Index of a modelKey in the chain, or -1. */
export function chainIndex(models: ChainModel[], key: string): number {
  return models.findIndex((m) => modelKey(m) === key);
}

export interface SelectOptions {
  /** modelKey that just failed; never returned. */
  failedKey?: string;
  /** Resume the walk after this chain index (used when setModel failed). */
  afterIndex?: number;
  /** Cooldown used for keys with no explicit cooldown. */
  fallbackCooldownMs: number;
  now?: number;
}

/**
 * Next model in chain order *after* the failed one, wrapping to the head.
 *
 * Earlier versions returned the earliest non-cooling model anywhere in the
 * chain, which made pinball bounce backwards (failing on chain position 2
 * landed on position 1) and skip every model between the failure and the head.
 */
export function findNextModel(models: ChainModel[], ledger: FailureLedger, opts: SelectOptions): ChainModel | null {
  const n = models.length;
  if (n === 0) return null;
  const now = opts.now ?? Date.now();
  const start = opts.afterIndex !== undefined
    ? opts.afterIndex + 1
    : (opts.failedKey ? chainIndex(models, opts.failedKey) : -1) + 1;
  for (let i = 0; i < n; i++) {
    const model = models[(Math.max(0, start) + i) % n];
    const key = modelKey(model);
    if (opts.failedKey && key === opts.failedKey) continue;
    if (isCooling(ledger, key, opts.fallbackCooldownMs, now)) continue;
    return model;
  }
  return null;
}

export interface PreferredOptions {
  /** ModelKey of the model currently in use. */
  currentKey?: string;
  /** modelKey of the model the session started on. */
  originalKey?: string | null;
  fallbackCooldownMs: number;
  now?: number;
}

/**
 * The earliest model *earlier in the chain* than the current one that is out of
 * cooldown — the original model first, then the rest of the chain head. This is
 * what brings a session back to its preferred model once the cooldown expires.
 */
export function findPreferredModel(models: ChainModel[], ledger: FailureLedger, opts: PreferredOptions): ChainModel | null {
  const now = opts.now ?? Date.now();
  const currentIndex = opts.currentKey ? chainIndex(models, opts.currentKey) : -1;
  const seen = new Set<string>();
  const ordered: ChainModel[] = [];
  const push = (m: ChainModel) => {
    const key = modelKey(m);
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(m);
  };

  // The original model is always the first candidate, whether or not it is
  // still in the chain; the rest of the chain head follows in order.
  if (opts.originalKey) {
    const originalIndex = chainIndex(models, opts.originalKey);
    if (originalIndex >= 0) push(models[originalIndex]);
    else {
      const [provider, ...rest] = opts.originalKey.split("/");
      push({ provider, id: rest.join("/") });
    }
  }
  const head = currentIndex < 0 ? models.length : currentIndex;
  for (let i = 0; i < head; i++) push(models[i]);

  for (const model of ordered) {
    const key = modelKey(model);
    if (key === opts.currentKey) continue;
    if (isCooling(ledger, key, opts.fallbackCooldownMs, now)) continue;
    return model;
  }
  return null;
}
