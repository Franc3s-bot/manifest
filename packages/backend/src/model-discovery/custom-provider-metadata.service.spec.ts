import { CustomProviderMetadataService } from './custom-provider-metadata.service';
import {
  buildLiveProviderFacts,
  fetchLiveProviderFacts,
  type LiveProbeTarget,
} from './custom-provider-live-metadata';
import type { DiscoveredModel } from './model-fetcher';

jest.mock('./custom-provider-live-metadata', () => ({
  ...jest.requireActual('./custom-provider-live-metadata'),
  fetchLiveProviderFacts: jest.fn(),
}));

const fetchLive = fetchLiveProviderFacts as jest.MockedFunction<typeof fetchLiveProviderFacts>;

const TARGET: LiveProbeTarget = {
  providerKey: 'custom:cp-1',
  baseUrl: 'http://host:9931/v1',
  apiKind: 'openai',
};

function makeCustomModel(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: 'custom:cp-1/Bonsai 27b',
    displayName: 'Bonsai 27b',
    provider: 'custom:cp-1',
    authType: 'local',
    contextWindow: 128000,
    inputPricePerToken: null,
    outputPricePerToken: null,
    capabilityReasoning: false,
    capabilityCode: false,
    qualityScore: 2,
    ...overrides,
  };
}

function makeHostedModel(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: 'gpt-4o',
    displayName: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128000,
    inputPricePerToken: null,
    outputPricePerToken: null,
    capabilityReasoning: true,
    capabilityCode: true,
    qualityScore: 5,
    ...overrides,
  };
}

describe('CustomProviderMetadataService', () => {
  let service: CustomProviderMetadataService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CustomProviderMetadataService();
  });

  describe('applyLiveFacts', () => {
    it('overrides the stored window and adds server capabilities', async () => {
      fetchLive.mockResolvedValue({
        byName: new Map([
          [
            'bonsai',
            {
              contextWindow: 176128,
              capabilities: ['stream', 'tools'],
              inputModalities: ['text'],
            },
          ],
        ]),
      });

      const [model] = await service.applyLiveFacts(
        [makeCustomModel({ displayName: 'bonsai' })],
        [TARGET],
      );

      expect(model.contextWindow).toBe(176128);
      expect(model.capabilities).toEqual(['stream', 'tools']);
      expect(model.inputModalities).toEqual(['text']);
    });

    it('resolves a hand-typed label against a single-model server', async () => {
      // The real llama.cpp payload for the reported bug: the server calls the
      // model `bonsai`, the stored row says `Bonsai 27b`.
      const catalog = {
        data: [
          {
            id: 'bonsai',
            aliases: ['bonsai', 'bonsai-2', 'ternary-bonsai'],
            meta: { n_ctx: 176128, n_ctx_train: 262144 },
            context_length: 176128,
            max_context_length: 262144,
          },
        ],
      };
      const props = {
        default_generation_settings: { n_ctx: 176128 },
        model_alias: 'bonsai',
        chat_template_caps: { supports_tools: true },
        modalities: { vision: false, video: false, audio: false },
      };
      fetchLive.mockImplementation(async () => buildLiveProviderFacts(catalog, props));

      const [model] = await service.applyLiveFacts([makeCustomModel()], [TARGET]);

      expect(model.displayName).toBe('Bonsai 27b');
      expect(model.contextWindow).toBe(176128);
      expect(model.capabilities).toEqual(['stream', 'tools']);
      expect(model.inputModalities).toEqual(['text']);
    });

    it('matches a stored name that only the server alias knows', async () => {
      fetchLive.mockResolvedValue({
        byName: new Map([['ternary-bonsai', { contextWindow: 4096 }]]),
      });

      const [model] = await service.applyLiveFacts(
        [makeCustomModel({ displayName: 'ternary-bonsai' })],
        [TARGET],
      );

      expect(model.contextWindow).toBe(4096);
    });

    it('falls back to the single-model facts when the name matches nothing', async () => {
      fetchLive.mockResolvedValue({ byName: new Map(), single: { contextWindow: 32000 } });

      const [model] = await service.applyLiveFacts([makeCustomModel()], [TARGET]);

      expect(model.contextWindow).toBe(32000);
    });

    it('keeps stored capabilities the server does not mention', async () => {
      fetchLive.mockResolvedValue({ byName: new Map([['bonsai', { contextWindow: 176128 }]]) });

      const [model] = await service.applyLiveFacts(
        [makeCustomModel({ capabilities: ['tools'] })],
        [TARGET],
      );

      expect(model.capabilities).toEqual(['tools']);
    });

    it('leaves non-custom models untouched', async () => {
      fetchLive.mockResolvedValue({ byName: new Map([['bonsai', { contextWindow: 1 }]]) });
      const models = [makeHostedModel(), makeCustomModel({ displayName: 'bonsai' })];

      const out = await service.applyLiveFacts(models, [TARGET]);

      expect(out[0]).toBe(models[0]);
      expect(out[1]).not.toBe(models[1]);
      expect(out[1].contextWindow).toBe(1);
    });

    it('returns the input untouched when there is nothing to probe', async () => {
      const models = [makeHostedModel()];

      await expect(service.applyLiveFacts(models, [])).resolves.toBe(models);
      await expect(service.applyLiveFacts(models, [TARGET])).resolves.toBe(models);
      expect(fetchLive).not.toHaveBeenCalled();
    });

    it('returns the input array when the probe yields nothing to change', async () => {
      fetchLive.mockResolvedValue(null);
      const models = [makeCustomModel()];

      await expect(service.applyLiveFacts(models, [TARGET])).resolves.toBe(models);
    });

    it('never throws when the probe fails', async () => {
      fetchLive.mockRejectedValue(new Error('ECONNREFUSED'));
      const models = [makeCustomModel()];

      const out = await service.applyLiveFacts(models, [TARGET]);

      expect(out).toBe(models);
    });
  });

  describe('caching', () => {
    it('shares one probe between concurrent callers', async () => {
      fetchLive.mockResolvedValue({ byName: new Map([['bonsai', { contextWindow: 176128 }]]) });

      await Promise.all([
        service.getFacts(TARGET),
        service.getFacts(TARGET),
        service.getFacts(TARGET),
      ]);

      expect(fetchLive).toHaveBeenCalledTimes(1);
    });

    it('reuses facts within the TTL and refreshes after it', async () => {
      jest.useFakeTimers();
      try {
        fetchLive.mockResolvedValue({ byName: new Map([['bonsai', { contextWindow: 176128 }]]) });

        await service.getFacts(TARGET);
        await service.getFacts(TARGET);
        expect(fetchLive).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(15_001);
        await service.getFacts(TARGET);
        expect(fetchLive).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('caches a failed probe so a dead server is not hammered', async () => {
      fetchLive.mockResolvedValue(null);

      await service.getFacts(TARGET);
      await service.getFacts(TARGET);

      expect(fetchLive).toHaveBeenCalledTimes(1);
    });

    it('re-probes after an explicit invalidate', async () => {
      fetchLive.mockResolvedValue({ byName: new Map() });

      await service.getFacts(TARGET);
      service.invalidate('custom:cp-1');
      await service.getFacts(TARGET);

      expect(fetchLive).toHaveBeenCalledTimes(2);
    });
  });
});
