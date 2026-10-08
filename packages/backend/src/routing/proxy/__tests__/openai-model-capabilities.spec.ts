import { openAiModelCapabilities } from '../openai-model-capabilities';
import type { DiscoveredModel } from '../../../model-discovery/model-fetcher';

function makeModel(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: 'gpt-4o',
    displayName: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128000,
    inputPricePerToken: 0.0000025,
    outputPricePerToken: 0.00001,
    capabilityReasoning: false,
    capabilityCode: false,
    qualityScore: 4,
    authType: 'api_key',
    ...overrides,
  };
}

describe('openAiModelCapabilities', () => {
  it('returns undefined when nothing is known — unknown is not reported as unsupported', () => {
    expect(openAiModelCapabilities(makeModel())).toBeUndefined();
    expect(
      openAiModelCapabilities(
        makeModel({ inputModalities: [], outputModalities: [], supportedEndpoints: [] }),
      ),
    ).toBeUndefined();
  });

  it('projects input and output modalities as separate fields', () => {
    expect(
      openAiModelCapabilities(
        makeModel({ inputModalities: ['text', 'image'], outputModalities: ['text'] }),
      ),
    ).toEqual({
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
    });
  });

  it('keeps only endpoint features from the merged capability list', () => {
    expect(
      openAiModelCapabilities(makeModel({ capabilities: ['text', 'image', 'stream', 'tools'] })),
    ).toEqual({ features: ['stream', 'tools'] });
  });

  it('omits features when the capability list carries no endpoint features', () => {
    expect(openAiModelCapabilities(makeModel({ capabilities: ['text'] }))).toBeUndefined();
  });

  it('passes supported endpoints through verbatim', () => {
    expect(openAiModelCapabilities(makeModel({ supportedEndpoints: ['/responses'] }))).toEqual({
      supported_endpoints: ['/responses'],
    });
  });

  it('emits a context window that is a real fact', () => {
    expect(
      openAiModelCapabilities(
        makeModel({
          contextWindow: 524_288,
          contextWindowSource: 'provider',
          maxOutputTokens: 65_536,
        }),
      ),
    ).toEqual({ context_window: 524_288, max_output_tokens: 65_536 });
  });

  it('treats a catalog-sourced window as a fact too', () => {
    expect(
      openAiModelCapabilities(
        makeModel({ contextWindow: 200_000, contextWindowSource: 'catalog' }),
      ),
    ).toEqual({ context_window: 200_000 });
  });

  it('omits the nominal 128k discovery default instead of publishing it as a fact', () => {
    expect(
      openAiModelCapabilities(
        makeModel({ contextWindow: 128_000, contextWindowSource: 'provider_default' }),
      ),
    ).toBeUndefined();
    expect(openAiModelCapabilities(makeModel({ contextWindow: 128_000 }))).toBeUndefined();
  });

  it('keeps a default-labelled window a catalog lookup replaced with a real value', () => {
    expect(
      openAiModelCapabilities(
        makeModel({ contextWindow: 200_000, contextWindowSource: 'provider_default' }),
      ),
    ).toEqual({ context_window: 200_000 });
  });

  it('carries no chat-only fields for a pure media model', () => {
    expect(
      openAiModelCapabilities(
        makeModel({
          id: 'agnes-image-2.1-flash',
          provider: 'agnes',
          contextWindow: 128_000,
          contextWindowSource: 'provider_default',
          maxOutputTokens: 4096,
          inputModalities: ['text', 'image'],
          outputModalities: ['image'],
        }),
      ),
    ).toEqual({
      input_modalities: ['text', 'image'],
      output_modalities: ['image'],
      supported_endpoints: ['/v1/images/generations'],
    });
  });

  it('derives the media endpoint from the output modality when discovery states none', () => {
    expect(openAiModelCapabilities(makeModel({ id: 'v', outputModalities: ['video'] }))).toEqual({
      output_modalities: ['video'],
      supported_endpoints: ['/v1/videos'],
    });
  });

  it('publishes reasoning only as a positive assertion', () => {
    expect(openAiModelCapabilities(makeModel({ capabilityReasoning: true }))).toEqual({
      features: ['reasoning'],
    });
    expect(openAiModelCapabilities(makeModel({ capabilityReasoning: false }))).toBeUndefined();
  });
});
