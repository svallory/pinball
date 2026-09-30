/**
 * Per-model failure ledger.
 *
 * `failures` maps modelKey -> timestamp of the last failure (unchanged from
 * earlier versions). `cooldowns` maps modelKey -> the cooldown that failure
 * earned, so a transient failure rests briefly while a quota failure rests
 * long. Shared by the extension and the /pinball command surface.
 */

export interface FailureLedger {
  /** modelKey -> timestamp of last failure */
  failures: Map<string, number>;
  /** modelKey -> cooldown in ms that failure earned */
  cooldowns: Map<string, number>;
}

/** Cooldown for a key, falling back to the config default when unknown. */
export function cooldownFor(ledger: FailureLedger, key: string, fallbackMs: number): number {
  return ledger.cooldowns.get(key) ?? fallbackMs;
}

/** True while the key's cooldown has not elapsed. Clears stale entries. */
export function isCooling(ledger: FailureLedger, key: string, fallbackMs: number, now = Date.now()): boolean {
  const at = ledger.failures.get(key);
  if (at === undefined) return false;
  if (now - at >= cooldownFor(ledger, key, fallbackMs)) {
    ledger.failures.delete(key);
    ledger.cooldowns.delete(key);
    return false;
  }
  return true;
}

/** Record a failure and the cooldown it earned. */
export function markFailure(ledger: FailureLedger, key: string, at: number, cooldownMs: number): void {
  ledger.failures.set(key, at);
  ledger.cooldowns.set(key, Math.max(0, cooldownMs));
}

export function clearFailure(ledger: FailureLedger, key: string): void {
  ledger.failures.delete(key);
  ledger.cooldowns.delete(key);
}

/** Keys still cooling down, as [key, remainingMs]. */
export function activeFailures(ledger: FailureLedger, fallbackMs: number, now = Date.now()): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const key of [...ledger.failures.keys()]) {
    if (!isCooling(ledger, key, fallbackMs, now)) continue;
    out.push([key, cooldownFor(ledger, key, fallbackMs) - (now - ledger.failures.get(key)!)]);
  }
  return out;
}
