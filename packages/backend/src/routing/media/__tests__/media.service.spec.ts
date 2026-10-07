import { HttpStatus } from '@nestjs/common';
import { MediaService } from '../media.service';
import type { MediaProviderClient } from '../media-provider-client';

const ctx = { tenantId: 't1', agentId: 'a1', agentName: 'agent', userId: 'u1' };

function makeResolveResponse(overrides: Record<string, unknown> = {}) {
  return {
    tier: 'standard',
    confidence: 1,
    score: 0,
    reason: 'header-match',
    route: { provider: 'agnes', authType: 'api_key', model: 'agnes-image-2.1-flash' },
    fallback_routes: null,
    output_modality: 'image',
    response_mode: 'buffered',
    ...overrides,
  };
}

function build(
  overrides: {
    resolveService?: Record<string, jest.Mock>;
    discovery?: Record<string, jest.Mock>;
    mediaClient?: Partial<Record<keyof MediaProviderClient, jest.Mock>>;
    recorder?: Record<string, jest.Mock>;
    providerKey?: Record<string, jest.Mock>;
    requestRepo?: Record<string, jest.Mock>;
    messageRepo?: Record<string, jest.Mock>;
  } = {},
) {
  const resolveService = {
    resolveAutoTierModel: jest.fn().mockResolvedValue(makeResolveResponse()),
    resolveHeaderTier: jest.fn().mockResolvedValue(null),
    ...overrides.resolveService,
  };
  const providerKeyService = {
    findProviderForModel: jest.fn().mockResolvedValue('agnes'),
    getAuthType: jest.fn().mockResolvedValue('api_key'),
    selectProviderKey: jest
      .fn()
      .mockResolvedValue({ id: 'tp1', apiKey: 'sk-test', label: 'Default' }),
    getProviderApiKey: jest.fn().mockResolvedValue({ apiKey: 'sk-test' }),
    ...overrides.providerKey,
  };
  const modelDiscovery = {
    getModelsForAgent: jest.fn().mockResolvedValue([
      {
        id: 'agnes-image-2.1-flash',
        provider: 'agnes',
        authType: 'api_key',
        outputModalities: ['image'],
      },
      {
        id: 'agnes-video-v2.0',
        provider: 'agnes',
        authType: 'api_key',
        outputModalities: ['video'],
      },
    ]),
    ...overrides.discovery,
  };
  const mediaClient = {
    forward: jest.fn(),
    videoStatus: jest.fn(),
    ...overrides.mediaClient,
  };
  const recorder = {
    recordPendingRequest: jest.fn().mockResolvedValue(undefined),
    recordPendingProviderAttempt: jest.fn().mockResolvedValue(true),
    completePendingProviderFailure: jest.fn().mockResolvedValue(undefined),
    recordSuccessMessage: jest.fn().mockResolvedValue(undefined),
    recordProviderError: jest.fn().mockResolvedValue(undefined),
    recordManifestBlockedRequest: jest.fn().mockResolvedValue(undefined),
    ...overrides.recorder,
  };
  const rateLimiter = {
    checkLimit: jest.fn(),
    checkIpLimit: jest.fn(),
    acquireSlot: jest.fn(),
    releaseSlot: jest.fn(),
  };
  const planService = { assertWithinRequestLimit: jest.fn().mockResolvedValue(undefined) };
  const requestRepo = {
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides.requestRepo,
  };
  const messageRepo = {
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides.messageRepo,
  };

  const service = new MediaService(
    resolveService as never,
    providerKeyService as never,
    modelDiscovery as never,
    mediaClient as unknown as MediaProviderClient,
    recorder as never,
    rateLimiter as never,
    planService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    requestRepo as never,
    messageRepo as never,
  );

  return {
    service,
    resolveService,
    providerKeyService,
    modelDiscovery,
    mediaClient,
    recorder,
    rateLimiter,
    requestRepo,
    messageRepo,
  };
}

describe('MediaService image generation', () => {
  it('routes an image tier, forwards, and records cost', async () => {
    const { service, mediaClient, recorder } = build({
      mediaClient: {
        forward: jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          body: { created: 1, data: [{ url: 'https://cdn/a.png' }] },
          requestUrl: 'https://apihub.agnes-ai.com/v1/images/generations',
          requestBody: {},
        }),
      },
    });

    const result = await service.handle({
      ctx,
      body: { model: 'auto-image', prompt: 'a cat' },
      headers: {},
      apiMode: 'images',
    });

    expect(mediaClient.forward).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'agnes',
        apiMode: 'images',
        model: 'agnes-image-2.1-flash',
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ created: 1, data: [{ url: 'https://cdn/a.png' }] });
    const successOpts = recorder.recordSuccessMessage.mock.calls[0][5];
    expect(successOpts.apiMode).toBe('images');
    // 1 image at the Agnes default (1K) list rate.
    expect(successOpts.costUsdOverride).toBeCloseTo(0.01, 6);
  });

  it('rejects an image request routed to a video model with M301', async () => {
    const { service, mediaClient, recorder } = build({
      resolveService: {
        resolveAutoTierModel: jest
          .fn()
          .mockResolvedValue(makeResolveResponse({ output_modality: 'video' })),
        resolveHeaderTier: jest.fn().mockResolvedValue(null),
      },
    });

    const result = await service.handle({
      ctx,
      body: { model: 'auto-video', prompt: 'a clip' },
      headers: {},
      apiMode: 'images',
    });

    expect(result.status).toBe(HttpStatus.BAD_REQUEST);
    expect(JSON.stringify(result.body)).toContain('M301');
    expect(mediaClient.forward).not.toHaveBeenCalled();
    const blocked = recorder.recordManifestBlockedRequest.mock.calls[0][1];
    expect(blocked.errorCode).toBe('M301');
    expect(blocked.apiMode).toBe('images');
  });

  it('rejects a video request routed to an image model with M301', async () => {
    const { service, mediaClient } = build();
    const result = await service.handle({
      ctx,
      body: { model: 'auto-image', prompt: 'a clip' },
      headers: {},
      apiMode: 'videos',
    });
    expect(result.status).toBe(HttpStatus.BAD_REQUEST);
    expect(JSON.stringify(result.body)).toContain('M301');
    expect(mediaClient.forward).not.toHaveBeenCalled();
  });

  it('returns M302 when no route resolves', async () => {
    const { service, recorder } = build({
      resolveService: {
        resolveAutoTierModel: jest.fn().mockResolvedValue(null),
        resolveHeaderTier: jest.fn().mockResolvedValue(null),
      },
      providerKey: { findProviderForModel: jest.fn().mockResolvedValue(undefined) },
    });

    const result = await service.handle({
      ctx,
      body: { model: 'ghost-model', prompt: 'x' },
      headers: {},
      apiMode: 'images',
    });

    expect(result.status).toBe(HttpStatus.BAD_REQUEST);
    expect(JSON.stringify(result.body)).toContain('M302');
    expect(recorder.recordManifestBlockedRequest).toHaveBeenCalled();
  });

  it('records a provider error and passes the upstream status through', async () => {
    const { service, recorder, mediaClient } = build({
      mediaClient: {
        forward: jest.fn().mockResolvedValue({
          ok: false,
          status: 429,
          body: { error: { message: 'rate limited' } },
          requestUrl: 'u',
          requestBody: {},
          errorMessage: 'rate limited',
        }),
      },
    });

    const result = await service.handle({
      ctx,
      body: { model: 'auto-image', prompt: 'x' },
      headers: {},
      apiMode: 'images',
    });

    expect(result.status).toBe(429);
    expect(mediaClient.forward).toHaveBeenCalled();
    expect(recorder.recordProviderError).toHaveBeenCalled();
    expect(recorder.recordSuccessMessage).not.toHaveBeenCalled();
  });

  it('rejects a malformed media request with M304 before any provider work', async () => {
    const { service, mediaClient, recorder } = build({
      resolveService: {
        resolveAutoTierModel: jest
          .fn()
          .mockResolvedValue(makeResolveResponse({ output_modality: 'video' })),
        resolveHeaderTier: jest.fn().mockResolvedValue(null),
      },
    });

    const result = await service.handle({
      ctx,
      body: { model: 'auto-video', prompt: 'x', mode: 'reference' },
      headers: {},
      apiMode: 'videos',
    });

    expect(result.status).toBe(HttpStatus.BAD_REQUEST);
    expect(JSON.stringify(result.body)).toContain('M304');
    expect(JSON.stringify(result.body)).toContain('requires at least one');
    expect(mediaClient.forward).not.toHaveBeenCalled();
    const blocked = recorder.recordManifestBlockedRequest.mock.calls[0][1];
    expect(blocked.errorCode).toBe('M304');
  });

  it('rejects a missing prompt with M304', async () => {
    const { service, mediaClient } = build();
    const result = await service.handle({
      ctx,
      body: { model: 'auto-image' },
      headers: {},
      apiMode: 'images',
    });
    expect(result.status).toBe(HttpStatus.BAD_REQUEST);
    expect(JSON.stringify(result.body)).toContain('M304');
    expect(mediaClient.forward).not.toHaveBeenCalled();
  });

  it('resolves a direct model through discovery', async () => {
    const { service, mediaClient, resolveService } = build({
      resolveService: {
        resolveAutoTierModel: jest.fn(),
        resolveHeaderTier: jest.fn().mockResolvedValue(null),
      },
      mediaClient: {
        forward: jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          body: { created: 1, data: [] },
          requestUrl: 'u',
          requestBody: {},
        }),
      },
    });

    const result = await service.handle({
      ctx,
      body: { model: 'agnes-image-2.1-flash', prompt: 'x' },
      headers: {},
      apiMode: 'images',
    });

    expect(resolveService.resolveAutoTierModel).not.toHaveBeenCalled();
    expect(mediaClient.forward).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'agnes-image-2.1-flash' }),
    );
    expect(result.status).toBe(200);
  });

  it('routes the provider-qualified id that /v1/models publishes', async () => {
    const { service, mediaClient } = build({
      resolveService: {
        resolveAutoTierModel: jest.fn(),
        resolveHeaderTier: jest.fn().mockResolvedValue(null),
      },
      mediaClient: {
        forward: jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          body: { created: 1, data: [] },
          requestUrl: 'u',
          requestBody: {},
        }),
      },
    });

    const result = await service.handle({
      ctx,
      body: { model: 'agnes/agnes-image-2.1-flash', prompt: 'x' },
      headers: {},
      apiMode: 'images',
    });

    // The published id resolves to the provider-native model, not M302.
    expect(mediaClient.forward).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'agnes-image-2.1-flash' }),
    );
    expect(result.status).toBe(200);
  });

  it('blocks a media request when the provider key is missing', async () => {
    const { service, mediaClient, recorder } = build({
      providerKey: {
        findProviderForModel: jest.fn().mockResolvedValue('agnes'),
        getAuthType: jest.fn().mockResolvedValue('api_key'),
        selectProviderKey: jest.fn().mockResolvedValue(null),
      },
    });

    const result = await service.handle({
      ctx,
      body: { model: 'auto-image', prompt: 'x' },
      headers: {},
      apiMode: 'images',
    });

    expect(result.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(JSON.stringify(result.body)).toContain('M100');
    expect(mediaClient.forward).not.toHaveBeenCalled();
    expect(recorder.recordManifestBlockedRequest).toHaveBeenCalled();
  });
});

describe('MediaService video generation', () => {
  it('creates a video task, records it, and attaches the task id', async () => {
    const { service, recorder, requestRepo } = build({
      resolveService: {
        resolveAutoTierModel: jest
          .fn()
          .mockResolvedValue(makeResolveResponse({ output_modality: 'video' })),
        resolveHeaderTier: jest.fn().mockResolvedValue(null),
      },
      mediaClient: {
        forward: jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          body: { id: 'vid_1', object: 'video', status: 'queued' },
          requestUrl: 'u',
          requestBody: {},
          taskId: 'vid_1',
          videoStatus: 'queued',
          seconds: 5,
        }),
      },
    });

    const result = await service.handle({
      ctx,
      body: { model: 'auto-video', prompt: 'x', seconds: 5 },
      headers: {},
      apiMode: 'videos',
    });

    expect(result.status).toBe(200);
    const successOpts = recorder.recordSuccessMessage.mock.calls[0][5];
    // Video cost is unknown until the task completes.
    expect(successOpts.costUsdOverride).toBeNull();
    expect(requestRepo.update).toHaveBeenCalledWith(
      { id: expect.any(String) },
      expect.objectContaining({ media_task_id: 'vid_1' }),
    );
  });

  it('finalizes the per-second cost when the task completes', async () => {
    const { service, messageRepo, requestRepo, mediaClient } = build({
      requestRepo: {
        findOne: jest.fn().mockResolvedValue({
          id: 'req_1',
          agent_id: 'a1',
          media_task_id: 'vid_1',
          request_params: { seconds: 5, size: '720P' },
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      messageRepo: {
        findOne: jest.fn().mockResolvedValue({
          id: 'msg_1',
          request_id: 'req_1',
          attempt_number: 1,
          provider: 'agnes',
          model: 'agnes-video-2.5',
          auth_type: 'api_key',
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      mediaClient: {
        videoStatus: jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          body: { id: 'vid_1', object: 'video', status: 'completed' },
          requestUrl: 'u',
          requestBody: {},
          videoStatus: 'completed',
          seconds: 10,
        }),
      },
    });

    const result = await service.videoStatus(ctx, 'vid_1');

    expect(mediaClient.videoStatus).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'agnes', model: 'agnes-video-2.5', taskId: 'vid_1' }),
    );
    expect(result.status).toBe(200);
    expect(messageRepo.update).toHaveBeenCalledWith(
      { id: 'msg_1' },
      expect.objectContaining({ cost_usd: expect.any(Number), status: 'success' }),
    );
    // 10s at the 720P Agnes video rate ($0.025/s).
    const cost = messageRepo.update.mock.calls[0][1].cost_usd as number;
    expect(cost).toBeCloseTo(0.25, 6);
  });

  it('marks a failed video task as failed with the canonical status', async () => {
    const { service, messageRepo, requestRepo } = build({
      requestRepo: {
        findOne: jest
          .fn()
          .mockResolvedValue({ id: 'req_1', agent_id: 'a1', media_task_id: 'vid_1' }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      messageRepo: {
        findOne: jest.fn().mockResolvedValue({
          id: 'msg_1',
          request_id: 'req_1',
          provider: 'agnes',
          model: 'agnes-video-v2.0',
          auth_type: 'api_key',
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      mediaClient: {
        videoStatus: jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          body: { id: 'vid_1', object: 'video', status: 'failed' },
          requestUrl: 'u',
          requestBody: {},
          videoStatus: 'failed',
        }),
      },
    });

    await service.videoStatus(ctx, 'vid_1');

    expect(messageRepo.update).toHaveBeenCalledWith(
      { id: 'msg_1' },
      expect.objectContaining({ status: 'failed' }),
    );
    expect(requestRepo.update).toHaveBeenCalledWith({ id: 'req_1' }, { status: 'failed' });
  });

  it('returns 404 for an unknown task', async () => {
    const { service } = build({
      requestRepo: { findOne: jest.fn().mockResolvedValue(null), update: jest.fn() },
    });
    const result = await service.videoStatus(ctx, 'nope');
    expect(result.status).toBe(404);
  });
});
