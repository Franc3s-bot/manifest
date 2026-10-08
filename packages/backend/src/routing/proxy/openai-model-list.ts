import type { MediaRate } from 'manifest-shared';
import type { OpenAiModelCapabilities } from './openai-model-capabilities';
import type { SyntheticTierProfile } from './synthetic-model-profile';

/** Discovery never records when a model was published, so every entry says 0. */
export const MODEL_CREATED_UNKNOWN = 0;

export interface OpenAiModelCost {
  /** USD per million input tokens. */
  input?: number;
  /** USD per million output tokens. */
  output?: number;
}

/**
 * Media pricing for a model whose output is an image or a video. Token costs do
 * not apply to media generation, so this block replaces `cost` rather than
 * joining it. `rates` is a flat USD amount or a per-size-tier map.
 */
export interface OpenAiMediaCost {
  /** What one unit is: one generated image, or one second of video. */
  unit: 'image' | 'second';
  rates: MediaRate;
}

export interface OpenAiModelObject {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  provider_model_id?: string;
  auth_type?: string;
  capabilities?: OpenAiModelCapabilities;
  cost?: OpenAiModelCost;
  media_cost?: OpenAiMediaCost;
}

export interface OpenAiModelList {
  object: 'list';
  data: OpenAiModelObject[];
}

/**
 * USD per million tokens, or `undefined` when no price is known. A null price
 * is "not tracked", not a free model.
 */
export function openAiModelCost(
  inputPricePerToken: number | null,
  outputPricePerToken: number | null,
): OpenAiModelCost | undefined {
  const input =
    inputPricePerToken != null && Number.isFinite(inputPricePerToken) && inputPricePerToken >= 0
      ? inputPricePerToken * 1_000_000
      : undefined;
  const output =
    outputPricePerToken != null && Number.isFinite(outputPricePerToken) && outputPricePerToken >= 0
      ? outputPricePerToken * 1_000_000
      : undefined;
  if (input === undefined && output === undefined) return undefined;
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

/**
 * Capabilities for the untiered `auto` router.
 *
 * A marker, not a claim: `auto` resolves to a different concrete model per
 * request, so any per-request fact (modalities, context window, features) would
 * be a guess. `features: ["router"]` plus `synthetic: true` is what tells a
 * client to treat every other field as best-effort and to expect the resolved
 * model to differ. Deliberately no `input_modalities`: emitting `["text"]`
 * would be a negative assertion about image input that the router cannot make,
 * and a client that reads it would stop trying images on a tier that may route
 * to a vision model.
 */
export function autoRouterCapabilities(): OpenAiModelCapabilities {
  return {
    synthetic: true,
    features: ['router'],
  };
}

/** Capabilities for an `auto-{name}` tier, aggregated from its route chain. */
export function syntheticTierCapabilities(profile: SyntheticTierProfile): OpenAiModelCapabilities {
  return {
    synthetic: true,
    input_modalities: profile.inputModalities,
    output_modalities: profile.outputModalities,
    capabilities_coverage: profile.capabilitiesCoverage,
    unresolved_chain_members: profile.unresolvedChainMembers,
    ...(profile.contextWindow !== undefined ? { context_window: profile.contextWindow } : {}),
    ...(profile.maxOutputTokens !== undefined
      ? { max_output_tokens: profile.maxOutputTokens }
      : {}),
    ...(profile.features.length > 0 ? { features: profile.features } : {}),
    ...(profile.supportedEndpoints && profile.supportedEndpoints.length > 0
      ? { supported_endpoints: profile.supportedEndpoints }
      : {}),
  };
}
