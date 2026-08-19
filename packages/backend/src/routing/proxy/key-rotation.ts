import type { KeyRotationRule } from 'manifest-shared';

/**
 * Per-request key rotation state. Maps a rotation state key to the set of key
 * labels already attempted during THIS request. Created once per proxy request
 * and shared between the primary attempt flow (proxy.service), the fallback
 * chain (proxy-fallback.service), and the Auto-fix rotate_key reforward, so a
 * label burned by one hop is never re-tried for the same model later in the
 * same request.
 *
 * The state is keyed by (provider, model) so that a key that fails for one
 * model does not burn that key for subsequent models in the fallback chain.
 * See {@link keyRotationStateKey}.
 */
export type KeyRotationState = Map<string, Set<string>>;

export function createKeyRotationState(): KeyRotationState {
  return new Map();
}

/**
 * The state key for a rule+model pair. Key rotation state is tracked per
 * (provider, model) so a failed label is not retried for the same model in one
 * request, while subsequent models in a fallback chain (even under a
 * provider-level rule) start fresh with the provider's key rotation list.
 */
export function keyRotationStateKey(rule: KeyRotationRule, model: string): string {
  return `${rule.provider.toLowerCase()}:${model.toLowerCase()}`;
}

/** Record that `label` was already attempted for `rule`+`model` in this request. */
export function markKeyLabelUsed(
  state: KeyRotationState,
  rule: KeyRotationRule,
  model: string,
  label: string | undefined,
): void {
  if (!label) return;
  const key = keyRotationStateKey(rule, model);
  let used = state.get(key);
  if (!used) {
    used = new Set();
    state.set(key, used);
  }
  used.add(label);
}

/**
 * First label in the rule's order that this request hasn't attempted yet for
 * `model`. Returns undefined when the order is exhausted — the model then
 * counts as failed and the chain advances to the next model.
 */
export function nextUnusedKeyLabel(
  rule: KeyRotationRule,
  state: KeyRotationState,
  model: string,
): string | undefined {
  const used = state.get(keyRotationStateKey(rule, model));
  if (!used) return rule.keyOrder[0];
  for (const label of rule.keyOrder) {
    if (!used.has(label)) return label;
  }
  return undefined;
}

/** Count of labels already attempted for `rule`+`model` (for rotation logging). */
export function usedLabelCount(
  state: KeyRotationState,
  rule: KeyRotationRule,
  model: string,
): number {
  return state.get(keyRotationStateKey(rule, model))?.size ?? 0;
}
