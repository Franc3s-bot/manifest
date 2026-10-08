import { HttpException } from '@nestjs/common';
import { ProviderKeyService } from '../routing-core/provider-key.service';
import { SystemOneService } from './systemone.service';
import { OPENCODE_ZEN_SYSTEMONE_URL } from './systemone.constants';

function makeService(): {
  service: SystemOneService;
  selectProviderKey: jest.Mock;
} {
  const selectProviderKey = jest.fn();
  const providerKeys = { selectProviderKey } as unknown as ProviderKeyService;
  return { service: new SystemOneService(providerKeys), selectProviderKey };
}

const baseRequest = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  body: {
    model: 'jev-1.13-free',
    state: { chunk: 'FAIL expected 401 got 200' },
    questions: {
      relevance: {
        type: 'score',
        instructions: 'relevance?',
        criteria: ['irrelevant', 'background', 'useful', 'important', 'critical'],
      },
    },
  },
};

describe('SystemOneService', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('forwards the classifier request to OpenCode Zen with the tenant credential', async () => {
    const { service, selectProviderKey } = makeService();
    selectProviderKey.mockResolvedValue({ apiKey: 'sk-zen', label: 'Dev', id: 'tp-1' });
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'jev-1.13-free',
          answers: { relevance: { type: 'score', score: 2.87, confidence: 0.38 } },
          usage: { input_tokens: 326, output_tokens: 19 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await service.classify(baseRequest);

    expect(selectProviderKey).toHaveBeenCalledWith(
      'tenant-1',
      'opencode-zen',
      'api_key',
      undefined,
      'agent-1',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(OPENCODE_ZEN_SYSTEMONE_URL);
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-zen');
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent['model']).toBe('jev-1.13-free');
    expect(sent['state']).toEqual(baseRequest.body.state);
    expect(sent['questions']).toEqual(baseRequest.body.questions);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      model: 'jev-1.13-free',
      answers: { relevance: { type: 'score', score: 2.87, confidence: 0.38 } },
      usage: { input_tokens: 326, output_tokens: 19 },
    });
  });

  it('accepts a provider-qualified model id and strips the prefix before forwarding', async () => {
    const { service, selectProviderKey } = makeService();
    selectProviderKey.mockResolvedValue({ apiKey: 'sk-zen', label: 'Dev', id: 'tp-1' });
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    await service.classify({
      ...baseRequest,
      body: { ...baseRequest.body, model: 'opencode-zen/jev-1.13' },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((JSON.parse(init.body as string) as Record<string, unknown>)['model']).toBe('jev-1.13');
  });

  it('rejects an unknown classifier model without calling upstream', async () => {
    const { service, selectProviderKey } = makeService();
    selectProviderKey.mockResolvedValue({ apiKey: 'sk-zen', label: 'Dev', id: 'tp-1' });

    await expect(
      service.classify({ ...baseRequest, body: { ...baseRequest.body, model: 'gpt-4o' } }),
    ).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when the tenant has no OpenCode Zen credential', async () => {
    const { service, selectProviderKey } = makeService();
    selectProviderKey.mockResolvedValue(null);

    const error = await service.classify(baseRequest).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes through an upstream error status and body', async () => {
    const { service, selectProviderKey } = makeService();
    selectProviderKey.mockResolvedValue({ apiKey: 'sk-zen', label: 'Dev', id: 'tp-1' });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { type: 'server_error', message: 'disabled' } }), {
        status: 403,
      }),
    );

    const result = await service.classify(baseRequest);
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: { type: 'server_error', message: 'disabled' } });
  });

  it('returns raw text when the upstream body is not JSON', async () => {
    const { service, selectProviderKey } = makeService();
    selectProviderKey.mockResolvedValue({ apiKey: 'sk-zen', label: 'Dev', id: 'tp-1' });
    fetchMock.mockResolvedValue(new Response('gateway timeout', { status: 504 }));

    const result = await service.classify(baseRequest);
    expect(result.status).toBe(504);
    expect(result.body).toBe('gateway timeout');
    expect(result.raw).toBe(true);
  });

  it('reports a 502 when the upstream call throws', async () => {
    const { service, selectProviderKey } = makeService();
    selectProviderKey.mockResolvedValue({ apiKey: 'sk-zen', label: 'Dev', id: 'tp-1' });
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    const error = await service.classify(baseRequest).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(502);
  });
});
