import { buildSyntheticTierProfile, collectTierRoutes } from '../synthetic-model-profile';
import type { HeaderTier } from '../../../entities/header-tier.entity';
import type { DiscoveredModel } from '../../../model-discovery/model-fetcher';

function makeTier(overrides: Partial<HeaderTier> = {}): HeaderTier {
  return {
    id: 'tier-1',
    tenant_id: 'tenant-1',
    agent_id: 'agent-1',
    name: 'Standard',
    header_key: 'x-manifest-complexity',
    header_value: 'standard',
    badge_color: 'blue',
    sort_order: 0,
    enabled: true,
    override_route: null,
    fallback_routes: null,
    output_modality: 'text',
    response_mode: 'buffered',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as HeaderTier;
}

function makeModel(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: 'gpt-5',
    displayName: 'GPT-5',
    provider: 'openai',
    contextWindow: 128000,
    inputPricePerToken: null,
    outputPricePerToken: null,
    capabilityReasoning: false,
    capabilityCode: false,
    qualityScore: 4,
    authType: 'api_key',
    ...overrides,
  };
}

describe('collectTierRoutes', () => {
  it('collects the override primary plus fallbacks in order', () => {
    const tier = makeTier({
      override_route: { provider: 'openai', authType: 'api_key', model: 'gpt-5' },
      fallback_routes: [
        { provider: 'anthropic', authType: 'api_key', model: 'claude-5' },
        { provider: 'gemini', authType: 'api_key', model: 'gemini-3-pro' },
      ],
    });
    expect(collectTierRoutes(tier).map((r) => r.model)).toEqual([
      'gpt-5',
      'claude-5',
      'gemini-3-pro',
    ]);
  });

  it('returns an empty chain when no routes are configured', () => {
    expect(collectTierRoutes(makeTier())).toEqual([]);
  });
});

describe('buildSyntheticTierProfile', () => {
  it('uses the most prevalent context window (mode) across the chain', () => {
    const tier = makeTier({
      override_route: { provider: 'openai', authType: 'api_key', model: 'big-1' },
      fallback_routes: [
        { provider: 'openai', authType: 'api_key', model: 'big-2' },
        { provider: 'openai', authType: 'api_key', model: 'small-1' },
      ],
    });
    const models = [
      makeModel({ id: 'big-1', contextWindow: 1_000_000 }),
      makeModel({ id: 'big-2', contextWindow: 1_000_000 }),
      makeModel({ id: 'small-1', contextWindow: 128_000 }),
    ];
    const profile = buildSyntheticTierProfile(tier, models);
    expect(profile.contextWindow).toBe(1_000_000);
  });

  it('breaks a context-window tie toward the conservative (smaller) value', () => {
    const tier = makeTier({
      override_route: { provider: 'openai', authType: 'api_key', model: 'a' },
      fallback_routes: [{ provider: 'openai', authType: 'api_key', model: 'b' }],
    });
    const models = [
      makeModel({ id: 'a', contextWindow: 200_000 }),
      makeModel({ id: 'b', contextWindow: 128_000 }),
    ];
    const profile = buildSyntheticTierProfile(tier, models);
    expect(profile.contextWindow).toBe(128_000);
  });

  it('takes max output tokens as the mode, breaking ties toward the larger value', () => {
    const tier = makeTier({
      override_route: { provider: 'openai', authType: 'api_key', model: 'a' },
      fallback_routes: [
        { provider: 'openai', authType: 'api_key', model: 'b' },
        { provider: 'openai', authType: 'api_key', model: 'c' },
      ],
    });
    const models = [
      makeModel({ id: 'a', maxOutputTokens: 32_768 }),
      makeModel({ id: 'b', maxOutputTokens: 65_536 }),
      makeModel({ id: 'c', maxOutputTokens: 32_768 }),
    ];
    const profile = buildSyntheticTierProfile(tier, models);
    expect(profile.maxOutputTokens).toBe(32_768);
  });

  it('keeps only capabilities the majority of models support', () => {
    const tier = makeTier({
      override_route: { provider: 'openai', authType: 'api_key', model: 'a' },
      fallback_routes: [
        { provider: 'openai', authType: 'api_key', model: 'b' },
        { provider: 'openai', authType: 'api_key', model: 'c' },
      ],
    });
    const models = [
      makeModel({
        id: 'a',
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        capabilities: ['text', 'image', 'stream', 'tools'],
        supportedEndpoints: ['/responses'],
      }),
      makeModel({
        id: 'b',
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
        capabilities: ['text', 'image', 'stream', 'tools'],
        supportedEndpoints: ['/responses'],
      }),
      makeModel({
        id: 'c',
        inputModalities: ['text'],
        outputModalities: ['text'],
        capabilities: ['text', 'stream'],
        supportedEndpoints: ['/chat/completions'],
      }),
    ];
    const profile = buildSyntheticTierProfile(tier, models);
    // text + stream are in 3/3; image + tools in 2/3 (majority); /responses in 2/3.
    expect(profile.inputModalities).toEqual(['text', 'image']);
    expect(profile.outputModalities).toEqual(['text']);
    expect(profile.features).toContain('stream');
    expect(profile.features).toContain('tools');
    expect(profile.supportedEndpoints).toEqual(['/responses']);
  });

  it('falls back to the default window and text-only modalities when the chain is unresolvable', () => {
    const tier = makeTier({
      override_route: { provider: 'openai', authType: 'api_key', model: 'ghost-model' },
    });
    const profile = buildSyntheticTierProfile(tier, []);
    expect(profile.contextWindow).toBe(128_000);
    expect(profile.inputModalities).toEqual(['text']);
    expect(profile.outputModalities).toEqual(['text']);
    expect(profile.maxOutputTokens).toBeUndefined();
  });

  it('resolves routes by provider-qualified and bare model ids', () => {
    const tier = makeTier({
      override_route: { provider: 'openai', authType: 'subscription', model: 'gpt-5' },
      fallback_routes: [{ provider: 'anthropic', authType: 'api_key', model: 'claude-5' }],
    });
    const models = [
      makeModel({
        id: 'gpt-5',
        provider: 'openai',
        authType: 'subscription',
        contextWindow: 200_000,
      }),
      makeModel({
        id: 'claude-5',
        provider: 'anthropic',
        authType: 'api_key',
        contextWindow: 200_000,
      }),
    ];
    const profile = buildSyntheticTierProfile(tier, models);
    expect(profile.contextWindow).toBe(200_000);
  });
});
