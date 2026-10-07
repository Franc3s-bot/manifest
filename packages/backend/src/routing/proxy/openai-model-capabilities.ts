import {
  mediaEndpointsForOutputModalities,
  type ModelCapability,
  type ModelModality,
} from 'manifest-shared';
import type { DiscoveredModel } from '../../model-discovery/model-fetcher';
import { DEFAULT_CONTEXT_WINDOW } from '../../model-discovery/model-fetcher';

/** Features that can appear in discovery's `capabilities` list. */
const DISCOVERY_FEATURES = ['stream', 'tools'] as const;

type DiscoveryFeature = (typeof DISCOVERY_FEATURES)[number];
/** Every feature the projection can publish, including derived ones. */
type FeatureCapability = DiscoveryFeature | 'reasoning' | 'router';

function isDiscoveryFeature(capability: ModelCapability): capability is DiscoveryFeature {
  return (DISCOVERY_FEATURES as readonly string[]).includes(capability);
}

/**
 * Context-window sources that are a positive fact rather than a nominal
 * fallback. `provider` is what the provider's own `/models` response said,
 * `subscription_config` a configured subscription limit, `catalog` a real
 * value applied from models.dev. `provider_default` (and an unlabelled source)
 * mean the window may just be `DEFAULT_CONTEXT_WINDOW`.
 */
const KNOWN_CONTEXT_WINDOW_SOURCES = new Set(['provider', 'subscription_config', 'catalog']);

/**
 * Opt-in capability extension for `/v1/models` entries
 * (`GET /v1/models?capabilities=true`).
 *
 * Every field is optional: a missing field means "unknown", never
 * "unsupported". Discovery metadata is positive-assertion only, so the
 * projection must not coerce absent data into `false` or `["text"]`.
 */
export interface OpenAiModelCapabilities {
  input_modalities?: readonly ModelModality[];
  output_modalities?: readonly ModelModality[];
  /**
   * Endpoint-level features. `stream` / `tools` are discovery facts; `reasoning`
   * is emitted only when the model is positively known to reason (never as a
   * `false`), and `router` marks a synthetic Manifest route rather than a
   * concrete provider model.
   */
  features?: readonly FeatureCapability[];
  /**
   * Manifest endpoints this entry serves. Media models list
   * `/v1/images/generations` or `/v1/videos` (derived from their output
   * modality when discovery does not state them).
   */
  supported_endpoints?: readonly string[];
  /**
   * Advertised context window. Emitted only when the window is a real fact
   * (see KNOWN_CONTEXT_WINDOW_SOURCES) and the model can hold a text
   * conversation — pure media models carry no chat-only fields. Absent means
   * unknown, so a client must not read it as "no context".
   */
  context_window?: number;
  /** Advertised max output tokens. Absent when discovery never learned one. */
  max_output_tokens?: number;
  /**
   * `true` for Manifest's synthetic routes: the untiered `auto` router and the
   * per-tier `auto-{name}` models. Their claims are aggregates (or, for `auto`,
   * deliberately absent), so a client must treat them as best-effort.
   */
  synthetic?: boolean;
  /**
   * Synthetic tiers only. `complete` when every chain member's metadata
   * resolved; `partial` when at least one member is uncatalogued and therefore
   * abstained from the aggregate. A `partial` tier's capabilities are held by
   * the majority of *known* members only — a fallback may not support them.
   */
  capabilities_coverage?: 'complete' | 'partial';
  /** Synthetic tiers only: chain members with no resolved metadata. */
  unresolved_chain_members?: number;
}

/**
 * A model can hold a text conversation when discovery did not state its output
 * modalities (unknown, so keep) or when `text` is among them. A pure media
 * model (image/video only) cannot.
 */
function hasTextOutput(modalities: readonly ModelModality[] | undefined): boolean {
  return !modalities || modalities.length === 0 || modalities.includes('text');
}

/**
 * The context window only when it is a real fact. A `provider_default` window
 * is the nominal discovery fallback; emitting it would hand a client a
 * fabricated number to size compaction from, which is worse than emitting
 * nothing. A default-labelled window that a catalog lookup replaced carries a
 * value other than the default and is kept.
 */
function knownContextWindow(model: DiscoveredModel): number | undefined {
  const window = model.contextWindow;
  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) return undefined;
  if (KNOWN_CONTEXT_WINDOW_SOURCES.has(model.contextWindowSource ?? '')) return window;
  return window === DEFAULT_CONTEXT_WINDOW ? undefined : window;
}

export function openAiModelCapabilities(
  model: DiscoveredModel,
): OpenAiModelCapabilities | undefined {
  const out: OpenAiModelCapabilities = {};
  if (model.inputModalities?.length) out.input_modalities = model.inputModalities;
  if (model.outputModalities?.length) out.output_modalities = model.outputModalities;

  const features: FeatureCapability[] = (model.capabilities ?? []).filter(isDiscoveryFeature);
  // `capabilityReasoning` is a required boolean that defaults to `false` when
  // nothing is known, so it is only ever a positive assertion. Never project it
  // as a negative one.
  if (model.capabilityReasoning) features.push('reasoning');
  if (features.length > 0) out.features = features;

  const endpoints = model.supportedEndpoints?.length
    ? model.supportedEndpoints
    : mediaEndpointsForOutputModalities(model.outputModalities);
  if (endpoints?.length) out.supported_endpoints = endpoints;

  if (hasTextOutput(model.outputModalities)) {
    const contextWindow = knownContextWindow(model);
    if (contextWindow !== undefined) out.context_window = contextWindow;
    if (model.maxOutputTokens !== undefined) out.max_output_tokens = model.maxOutputTokens;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
