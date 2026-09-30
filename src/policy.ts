/**
 * Operator-intent and continuation policy.
 *
 * Pure decision helpers for "who moved the model", "when a settled turn
 * deserves a retry", and "whether a parked retry continuation is still
 * relevant" — kept free of pi imports so they can be unit-tested directly.
 */

export interface ModelIdentity { provider: string; id: string }

/**
 * A model selection the operator made themselves (manual pick, cycle, or
 * session restore) becomes the new preferred model. Selections pinball
 * initiated via its own `pi.setModel` calls (bounces, return-to-preferred)
 * must not move the preference — they return null.
 */
export function nextPreferredOnModelSelect(sel: ModelIdentity & { selfInitiated: boolean }): ModelIdentity | null {
  if (sel.selfInitiated) return null;
  return { provider: sel.provider, id: sel.id };
}

/** Stop reasons that mean the session recovered from the earlier failure. */
const RECOVERY_STOPS = new Set(["stop", "tooluse", "length", "deferred"]);

/**
 * A turn that ends with one of these stop reasons supersedes any same-model
 * retry still pending for the model — the failure it was scheduled for has
 * been worked past, and letting the timer fire would re-send "retry the
 * failed step" into a healthy session.
 */
export function isRecoveryStop(stopReason: string): boolean {
  return RECOVERY_STOPS.has(stopReason.toLowerCase());
}
