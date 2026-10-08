import type { ModelCapability, ModelModality } from 'manifest-shared';
import { mediaEndpointsForOutputModalities } from 'manifest-shared';
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
 *  - Coverage: a chain member whose capabilities are unknown abstains rather
 *    than voting "no" (counting it would let one uncatalogued fallback
 *    suppress a capability every known model supports). The profile reports
 *    how many members abstained, so a client can tell "every chain member
 *    supports image" (`capabilities_coverage: "complete"`) from "only the
 *    known ones do" (`"partial"`) and decide whether to trust the aggregate.
 *
 * The chain is read at request time (with the routing cache's ~2 minute TTL),
 * so a mid-session chain change is picked up on the NEXT `GET /v1/models`
 * fetch. We deliberately do not try to push updates to in-flight sessions —
 * the harness re-fetches when it wants fresh facts.
 */

export interface SyntheticTierProfile {
  /**
   * Advertised context window (the mode across the chain, conservative
   * tie-break), or `undefined` for a media tier: image/video generation has no
   * chat context window, and the discovery default would be noise a client
   * could misread as a real limit.
   */
  contextWindow?: number;
  /** Advertised max output tokens (the mode across the chain, conservative tie-break). */
  maxOutputTokens?: number;
  inputModalities: readonly ModelModality[];
  outputModalities: readonly ModelModality[];
  features: readonly FeatureCapability[];
  supportedEndpoints?: readonly string[];
  /**
   * `complete` when every chain member's capabilities resolved, `partial` when
   * at least one member abstained from the aggregate. A `partial` tier's
   * capabilities are only known to be held by the majority of the members that
   * DID resolve — a fallback may not support them.
   */
  capabilitiesCoverage: 'complete' | 'partial';
  /**
   * Chain members whose capabilities could not be resolved: absent from the
   * discovered catalog, or catalogued with no modality metadata at all. Those
   * members abstain from the modality/feature aggregate, so the advertised
   * capability is only known to hold for the other members.
   */
  unresolvedChainMembers: number;
}

/** Features that can appear in discovery's `capabilities` list. */
const DISCOVERY_FEATURES = ['stream', 'tools'] as const;
type DiscoveryFeature = (typeof DISCOVERY_FEATURES)[number];
/** Everything a tier can advertise, including the derived `reasoning` marker. */
export type FeatureCapability = DiscoveryFeature | 'reasoning';

function isFeature(capability: ModelCapability): capability is DiscoveryFeature {
  return (DISCOVERY_FEATURES as readonly string[]).includes(capability);
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

/**
 * Capability lists where a capability held by more than half of the models
 * with KNOWN metadata is kept.
 *
 * A model whose metadata is unknown (`undefined`) abstains. Counting it in the
 * denominator would make it a silent "no" vote, so one uncatalogued model in
 * the chain could suppress a capability every known model supports.
 */
function majorityCapabilities<T extends string>(
  lists: readonly (readonly T[] | undefined)[],
): readonly T[] {
  const known = lists.filter((list): list is readonly T[] => list !== undefined);
  const candidates: T[] = [];
  const seen = new Set<string>();
  for (const list of known) {
    for (const value of list) {
      if (seen.has(value)) continue;
      seen.add(value);
      candidates.push(value);
    }
  }
  const kept: T[] = [];
  for (const candidate of candidates) {
    const supporters = known.filter((list) => list.includes(candidate)).length;
    if (known.length > 0 && supporters > known.length / 2) kept.push(candidate);
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
  // A chain member the catalog cannot describe — or describes without any
  // modality metadata — abstains from the aggregates below. The caller needs
  // to know how many did: `capabilities_coverage`.
  const unresolvedChainMembers =
    routes.length -
    models.filter((m) => m.inputModalities?.length || m.outputModalities?.length).length;

  // A tier configured for image/video output advertises exactly that modality:
  // it is the operator's explicit intent, and the media endpoints gate on it.
  // Otherwise fall back to the majority modality of the chain's models.
  const tierModality = tier.output_modality;
  const mediaTierModality: ModelModality | undefined =
    tierModality === 'image' || tierModality === 'video' ? tierModality : undefined;
  const isMediaTier = mediaTierModality !== undefined;
  const contextWindow = isMediaTier
    ? undefined
    : (modeConservative(models.map((m) => m.contextWindow)) ?? DEFAULT_CONTEXT_WINDOW);
  const maxOutputTokens = isMediaTier
    ? undefined
    : modeGenerous(models.map((m) => m.maxOutputTokens));
  const inputModalities = majorityCapabilities(models.map((m) => m.inputModalities));
  const outputModalities: readonly ModelModality[] = mediaTierModality
    ? [mediaTierModality]
    : majorityCapabilities(models.map((m) => m.outputModalities));
  const features: FeatureCapability[] = [
    ...majorityCapabilities(
      models.map(
        (m) => m.capabilities?.filter(isFeature) as readonly DiscoveryFeature[] | undefined,
      ),
    ),
  ];
  // Reasoning is presence-only: `capabilityReasoning` defaults to `false` when
  // nothing is known, so a `false` is not an assertion that the model cannot
  // reason. Advertise it only when the majority of the chain positively reasons.
  if (models.length > 0 && models.filter((m) => m.capabilityReasoning).length > models.length / 2) {
    features.push('reasoning');
  }
  // A media tier's endpoint is its configured modality, not the chain's. A
  // text tier falls back to the endpoints its models advertise.
  const advertisedOutputModalities =
    outputModalities.length > 0 ? outputModalities : (['text'] as readonly ModelModality[]);
  const supportedEndpoints = isMediaTier
    ? mediaEndpointsForOutputModalities(advertisedOutputModalities)
    : majorityCapabilities(models.map((m) => m.supportedEndpoints));

  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    inputModalities:
      inputModalities.length > 0 ? inputModalities : (['text'] as readonly ModelModality[]),
    outputModalities: advertisedOutputModalities,
    features,
    ...(supportedEndpoints && supportedEndpoints.length > 0 ? { supportedEndpoints } : {}),
    capabilitiesCoverage: unresolvedChainMembers === 0 ? 'complete' : 'partial',
    unresolvedChainMembers,
  };
}
