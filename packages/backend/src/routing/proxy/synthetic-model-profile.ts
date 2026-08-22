import type { ModelCapability, ModelModality } from 'manifest-shared';
import type { ModelRoute } from 'manifest-shared';
import type { DiscoveredModel } from '../../model-discovery/model-fetcher';
import type { HeaderTier } from '../../entities/header-tier.entity';
import { readOverrideRoute, readFallbackRoutes } from '../routing-core/route-helpers';
import { DEFAULT_CONTEXT_WINDOW } from '../../model-discovery/model-fetcher';

/**
 * Majority-vote aggregation of a synthetic auto-tier's route chain.
 *
 * A synthetic model (`auto-standard`, `auto-complex`, ...) resolves to a
 * header tier whose chain is a primary route plus zero or more fallback
 * routes. Each model in the chain may advertise a different context window
 * and different capabilities. `GET /v1/models` must return ONE honest number
 * per synthetic model — a harness caches it for the whole session and drives
 * automatic compaction from it.
 *
 * The strategy (user-directed):
 *  - Context window / max output tokens: use the value with the highest
 *    prevalence (the mode) across the chain. When multiple values are tied,
 *    prefer the most conservative (smallest) window so compaction never
 *    over-trusts a bigger claim a fallback can't honor.
 *  - Capabilities (modalities, features, supported endpoints): keep every
 *    capability supported by the MAJORITY of models in the chain (more than
 *    half). A capability that only a minority of models support is not
 *    advertised — a request routed to any majority model can rely on it.
 *
 * The chain is read at request time (with the routing cache's ~2 minute TTL),
 * so a mid-session chain change is picked up on the NEXT `GET /v1/models`
 * fetch. We deliberately do not try to push updates to in-flight sessions —
 * the harness re-fetches when it wants fresh facts.
 */

export interface SyntheticTierProfile {
  /** Advertised context window (the mode across the chain, conservative tie-break). */
  contextWindow: number;
  /** Advertised max output tokens (the mode across the chain, conservative tie-break). */
  maxOutputTokens?: number;
  inputModalities: readonly ModelModality[];
  outputModalities: readonly ModelModality[];
  features: readonly FeatureCapability[];
  supportedEndpoints?: readonly string[];
}

const FEATURE_CAPABILITIES = ['stream', 'tools'] as const;
export type FeatureCapability = (typeof FEATURE_CAPABILITIES)[number];

function isFeature(capability: ModelCapability): capability is FeatureCapability {
  return (FEATURE_CAPABILITIES as readonly string[]).includes(capability);
}

/** Aggregate all distinct models in a header tier's chain (primary + fallbacks). */
export function collectTierRoutes(tier: HeaderTier): ModelRoute[] {
  const override = readOverrideRoute(tier);
  const fallbacks = readFallbackRoutes(tier);
  const routes: ModelRoute[] = [];
  if (override) routes.push(override);
  if (fallbacks) routes.push(...fallbacks);
  return routes;
}

/**
 * Resolve a route to its discovered-model metadata (context window, max output,
 * modalities, features). Returns undefined when the model is not in the
 * discovered catalog — the route is real (it came from the tier's configured
 * chain) but the metadata is unknown, so it contributes no facts.
 */
function resolveDiscoveredModel(
  route: ModelRoute,
  discovered: readonly DiscoveredModel[],
): DiscoveredModel | undefined {
  const provider = route.provider.toLowerCase();
  const authType = route.authType;
  // Match on the provider-qualified published id first, then the bare id.
  return (
    discovered.find(
      (m) =>
        m.provider.toLowerCase() === provider && m.authType === authType && m.id === route.model,
    ) ?? discovered.find((m) => m.id === route.model && m.authType === authType)
  );
}

/** Count occurrences, keyed by the value's canonical string form. */
function tally(values: Array<number | undefined>): Map<string, { value: number; count: number }> {
  const counts = new Map<string, { value: number; count: number }>();
  for (const value of values) {
    if (value === undefined || !Number.isFinite(value)) continue;
    const key = String(value);
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { value, count: 1 });
  }
  return counts;
}

function majorityValue<T>(values: readonly T[], keyOf: (value: T) => string): T | undefined {
  const counts = new Map<string, { value: T; count: number }>();
  for (const value of values) {
    const key = keyOf(value);
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { value, count: 1 });
  }
  const majority = counts.size > 0 && values.length > 0 ? Math.floor(values.length / 2) + 1 : 0;
  const winner = [...counts.values()].find((entry) => entry.count >= majority);
  return winner?.value;
}

/**
 * The mode of a numeric series, breaking ties toward the smaller value
 * (conservative for context windows: compaction trusts the safest claim).
 */
function modeConservative(values: Array<number | undefined>): number | undefined {
  const counts = tally(values);
  if (counts.size === 0) return undefined;
  let best: { value: number; count: number } | undefined;
  for (const entry of counts.values()) {
    if (
      !best ||
      entry.count > best.count ||
      (entry.count === best.count && entry.value < best.value)
    ) {
      best = entry;
    }
  }
  return best?.value;
}

/** The mode of a numeric series, breaking ties toward the larger value (for max output). */
function modeGenerous(values: Array<number | undefined>): number | undefined {
  const counts = tally(values);
  if (counts.size === 0) return undefined;
  let best: { value: number; count: number } | undefined;
  for (const entry of counts.values()) {
    if (
      !best ||
      entry.count > best.count ||
      (entry.count === best.count && entry.value > best.value)
    ) {
      best = entry;
    }
  }
  return best?.value;
}

/** Capability lists where a capability held by more than half of models is kept. */
function majorityCapabilities<T extends string>(
  lists: readonly (readonly T[] | undefined)[],
): readonly T[] {
  const known: T[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const value of list ?? []) {
      if (seen.has(value)) continue;
      seen.add(value);
      known.push(value);
    }
  }
  const kept: T[] = [];
  for (const candidate of known) {
    const supporters = lists.filter((list) => list?.includes(candidate)).length;
    if (lists.length > 0 && supporters > lists.length / 2) kept.push(candidate);
  }
  return kept;
}

/**
 * Build the advertised profile for a synthetic auto-tier model.
 *
 * The primary route is the tier's override (or, for legacy auto-assigned
 * tiers, the effective route). Fallbacks join the chain for aggregation.
 * Models whose metadata is unknown contribute no facts, so a tier whose
 * chain is entirely unresolvable falls back to the discovery default window
 * with text-only modalities — a stable, conservative claim.
 */
export function buildSyntheticTierProfile(
  tier: HeaderTier,
  discovered: readonly DiscoveredModel[],
): SyntheticTierProfile {
  const routes = collectTierRoutes(tier);
  const models = routes
    .map((route) => resolveDiscoveredModel(route, discovered))
    .filter((m): m is DiscoveredModel => m !== undefined);

  const contextWindow =
    modeConservative(models.map((m) => m.contextWindow)) ?? DEFAULT_CONTEXT_WINDOW;
  const maxOutputTokens = modeGenerous(models.map((m) => m.maxOutputTokens));
  const inputModalities = majorityCapabilities(models.map((m) => m.inputModalities));
  const outputModalities = majorityCapabilities(models.map((m) => m.outputModalities));
  const features = majorityCapabilities(
    models.map((m) => (m.capabilities?.filter(isFeature) ?? []) as readonly FeatureCapability[]),
  );
  const supportedEndpoints = majorityCapabilities(models.map((m) => m.supportedEndpoints));

  return {
    contextWindow,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    inputModalities:
      inputModalities.length > 0 ? inputModalities : (['text'] as readonly ModelModality[]),
    outputModalities:
      outputModalities.length > 0 ? outputModalities : (['text'] as readonly ModelModality[]),
    features,
    ...(supportedEndpoints.length > 0 ? { supportedEndpoints } : {}),
  };
}
