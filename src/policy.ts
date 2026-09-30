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
