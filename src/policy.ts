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

/**
 * Input the operator typed themselves supersedes any scheduled retry — fresh
 * interactive input cancels pending same-model retries and parked retry
 * continuations. Extension- and rpc-sourced input is machine-driven and
 * leaves retries alone.
 */
export function shouldCancelRetriesOnInput(source: string): boolean {
  return source === "interactive";
}

/**
 * Whether a settled turn deserves a retry. An operator abort (Esc) means
 * "stay stopped": scheduling a retry for a turn they interrupted makes the
 * agent resume on its own up to the backoff maximum later. An unknown
 * (null) outcome keeps the old behavior.
 */
export function shouldScheduleRetryAfterSettle(outcome: string | null): boolean {
  return outcome !== "aborted";
}

export interface UserMessageRef { timestamp: number; text: string }

/**
 * A retry continuation parked while the session was busy is stale once a
 * *different* user message landed after it was parked — injecting it would
 * append a stale "retry the failed step" instruction to an unrelated turn.
 * Messages identical to the parked content (pinball's own continuation)
 * keep it fresh.
 */
export function isStaleContinuation(parkedAt: number, content: string, userMessages: UserMessageRef[]): boolean {
  const trimmed = content.trim();
  return userMessages.some((m) => m.timestamp > parkedAt && m.text.trim() !== trimmed);
}
