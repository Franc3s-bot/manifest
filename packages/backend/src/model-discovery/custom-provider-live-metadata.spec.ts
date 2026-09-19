import {
  buildLiveProviderFacts,
  fetchLiveProviderFacts,
  parseLlamaCppProps,
  trimBaseUrl,
  type LiveProbeTarget,
} from './custom-provider-live-metadata';

/** Shape llama.cpp serves from `GET /v1/models` (trimmed to the fields we read). */
function llamaCppCatalog(contextLength: number | undefined = 176128) {
  return {
    models: [{ name: 'bonsai', capabilities: ['completion'] }],
    object: 'list',
    data: [
      {
        id: 'bonsai',
        aliases: ['bonsai', 'bonsai-2', 'default', 'ternary-bonsai'],
        object: 'model',
        owned_by: 'llamacpp',
        meta: { n_ctx: contextLength, n_ctx_train: 262144 },
        ...(contextLength !== undefined ? { context_length: contextLength } : {}),
        max_context_length: 262144,
      },
    ],
  };
}

/** Shape llama.cpp serves from `GET /props`. */
function llamaCppProps(overrides: Record<string, unknown> = {}) {
  return {
    default_generation_settings: { n_ctx: 176128, params: {} },
    model_alias: 'bonsai',
    chat_template_caps: { supports_tools: true, supports_parallel_tool_calls: true },
    modalities: { vision: false, video: false, audio: false },
    ...overrides,
  };
}

function jsonResponse(body: unknown, contentType = 'application/json'): Response {
  return {
    ok: true,
    headers: new Headers({ 'content-type': contentType }),
    json: async () => body,
  } as unknown as Response;
}

function notFoundResponse(): Response {
  return {
    ok: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({}),
  } as unknown as Response;
}

describe('trimBaseUrl', () => {
  it('strips trailing slashes', () => {
    expect(trimBaseUrl('http://host:9931/v1///')).toBe('http://host:9931/v1');
    expect(trimBaseUrl('http://host:9931/v1')).toBe('http://host:9931/v1');
  });
});

describe('parseLlamaCppProps', () => {
  it('reads n_ctx, tool support and modalities', () => {
    expect(parseLlamaCppProps(llamaCppProps())).toEqual({
      modelAlias: 'bonsai',
      contextWindow: 176128,
      supportsTools: true,
      inputModalities: ['text'],
    });
  });

  it('maps a vision-capable model to image input', () => {
    const facts = parseLlamaCppProps(
      llamaCppProps({
        modalities: { vision: true, video: false, audio: false },
        chat_template_caps: { supports_tools: false },
      }),
    );
    expect(facts?.inputModalities).toEqual(['text', 'image']);
    expect(facts?.supportsTools).toBe(false);
  });

  it('ignores a /props payload from a server that is not llama.cpp', () => {
    expect(parseLlamaCppProps({ object: 'list', data: [] })).toBeNull();
    expect(parseLlamaCppProps(null)).toBeNull();
    expect(parseLlamaCppProps('nope')).toBeNull();
  });
});

describe('buildLiveProviderFacts', () => {
  it('reads the loaded context window from the catalog, not the trained maximum', () => {
    const facts = buildLiveProviderFacts(llamaCppCatalog(176128), null);
    expect(facts?.byName.get('bonsai')?.contextWindow).toBe(176128);
    // Every alias resolves to the same facts, so a stored name still matches.
    expect(facts?.byName.get('ternary-bonsai')?.contextWindow).toBe(176128);
    expect(facts?.single?.contextWindow).toBe(176128);
  });

  it('merges /props tool support and modalities into the catalog entry', () => {
    const facts = buildLiveProviderFacts(llamaCppCatalog(), llamaCppProps());
    const entry = facts?.byName.get('bonsai');
    expect(entry?.contextWindow).toBe(176128);
    expect(entry?.capabilities).toEqual(['stream', 'tools']);
    expect(entry?.inputModalities).toEqual(['text']);
  });

  it('falls back to the process context window when the catalog omits it', () => {
    const facts = buildLiveProviderFacts(llamaCppCatalog(undefined), llamaCppProps());
    expect(facts?.byName.get('bonsai')?.contextWindow).toBe(176128);
  });

  it('never invents a context window when neither source reports one', () => {
    const facts = buildLiveProviderFacts({ data: [{ id: 'm' }] }, null);
    expect(facts?.byName.get('m')?.contextWindow).toBeUndefined();
    expect(facts?.byName.get('m')?.capabilities).toEqual(['stream']);
  });

  it('builds facts from /props alone when the catalog endpoint is missing', () => {
    const facts = buildLiveProviderFacts(null, llamaCppProps());
    expect(facts?.single?.contextWindow).toBe(176128);
    expect(facts?.single?.capabilities).toEqual(['stream', 'tools']);
  });

  it('attributes the process window only to the model /props names', () => {
    const catalog = {
      data: [
        { id: 'alpha', context_length: 32768 },
        { id: 'beta', context_length: 8192 },
      ],
    };
    const facts = buildLiveProviderFacts(catalog, llamaCppProps({ model_alias: 'alpha' }));
    expect(facts?.byName.get('alpha')?.contextWindow).toBe(32768);
    expect(facts?.byName.get('beta')?.contextWindow).toBe(8192);
    // Tool support is a property of the process, so it applies to every entry.
    expect(facts?.byName.get('beta')?.capabilities).toEqual(['stream', 'tools']);
    expect(facts?.single).toBeUndefined();
  });

  it('reads LM Studio style and vLLM style fields', () => {
    const facts = buildLiveProviderFacts(
      {
        data: [
          { id: 'lm', loaded_context_length: 4096, max_context_length: 131072 },
          { id: 'vllm', architecture: { input_modalities: ['text', 'image'] } },
        ],
      },
      null,
    );
    expect(facts?.byName.get('lm')?.contextWindow).toBe(4096);
    expect(facts?.byName.get('vllm')?.inputModalities).toEqual(['text', 'image']);
  });

  it('returns null when neither source answered with anything usable', () => {
    expect(buildLiveProviderFacts(null, null)).toBeNull();
    expect(buildLiveProviderFacts({ object: 'list' }, { hello: 'world' })).toBeNull();
  });
});

describe('fetchLiveProviderFacts', () => {
  const target: LiveProbeTarget = {
    providerKey: 'custom:cp-1',
    baseUrl: 'http://host:9931/v1/',
    apiKind: 'openai',
    apiKey: 'local-key',
  };
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('probes /models and /props with the provider credential', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    global.fetch = jest.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return url.endsWith('/props')
        ? jsonResponse(llamaCppProps())
        : jsonResponse(llamaCppCatalog());
    }) as unknown as typeof fetch;

    const facts = await fetchLiveProviderFacts(target);

    expect(calls.map((c) => c.url).sort()).toEqual([
      'http://host:9931/v1/models',
      'http://host:9931/v1/props',
    ]);
    for (const call of calls) expect(call.headers['Authorization']).toBe('Bearer local-key');
    expect(facts?.byName.get('bonsai')?.contextWindow).toBe(176128);
    expect(facts?.byName.get('bonsai')?.capabilities).toEqual(['stream', 'tools']);
  });

  it('uses the anthropic path and header scheme when configured that way', async () => {
    const urls: string[] = [];
    global.fetch = jest.fn(async (url: string) => {
      urls.push(url);
      return jsonResponse({ data: [{ id: 'm', context_length: 4096 }] });
    }) as unknown as typeof fetch;

    const facts = await fetchLiveProviderFacts({ ...target, apiKind: 'anthropic' });

    expect(urls).toContain('http://host:9931/v1/v1/models');
    expect(facts?.byName.get('m')?.contextWindow).toBe(4096);
  });

  it('still reports catalog facts when /props is a 404 (non-llama.cpp server)', async () => {
    global.fetch = jest.fn(async (url: string) =>
      url.endsWith('/props') ? notFoundResponse() : jsonResponse(llamaCppCatalog(64000)),
    ) as unknown as typeof fetch;

    const facts = await fetchLiveProviderFacts(target);

    expect(facts?.byName.get('bonsai')?.contextWindow).toBe(64000);
    expect(facts?.byName.get('bonsai')?.capabilities).toEqual(['stream']);
  });

  it('ignores a non-JSON /props page', async () => {
    global.fetch = jest.fn(async (url: string) =>
      url.endsWith('/props')
        ? jsonResponse('<html/>', 'text/html')
        : jsonResponse(llamaCppCatalog()),
    ) as unknown as typeof fetch;

    const facts = await fetchLiveProviderFacts(target);

    expect(facts?.byName.get('bonsai')?.capabilities).toEqual(['stream']);
  });

  it('is a no-op when the provider is unreachable', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await expect(fetchLiveProviderFacts(target)).resolves.toBeNull();
  });

  it('does not probe an empty base url', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchLiveProviderFacts({ ...target, baseUrl: '//' })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
