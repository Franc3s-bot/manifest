import {
  MediaProviderClient,
  toVideoObject,
  translateAgnesImageBody,
  translateAgnesVideoBody,
  translateFalImageBody,
  translateFalVideoBody,
} from '../media-provider-client';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('media request translation', () => {
  it('moves response_format into extra_body and normalizes references', () => {
    const translated = translateAgnesImageBody({
      model: 'agnes-image-2.1-flash',
      prompt: 'a cat',
      response_format: 'b64_json',
      size: '2K',
      ratio: '16:9',
      image: 'https://example.com/ref.png',
      n: 2,
    });

    expect(translated).toEqual({
      model: 'agnes-image-2.1-flash',
      prompt: 'a cat',
      size: '2K',
      ratio: '16:9',
      extra_body: {
        response_format: 'b64_json',
        image: ['https://example.com/ref.png'],
      },
    });
  });

  it('defaults the image size and response format', () => {
    const translated = translateAgnesImageBody({ prompt: 'a dog' });
    expect(translated.size).toBe('1K');
    expect(translated.extra_body).toEqual({ response_format: 'url' });
  });

  it('accepts the provider-native extra_body shape for images', () => {
    // An existing Agnes client sends response_format / image inside
    // extra_body. Pointing it at the gateway must not silently drop them.
    const native = translateAgnesImageBody({
      model: 'agnes-image-2.1-flash',
      prompt: 'a cat',
      size: '2K',
      extra_body: {
        response_format: 'b64_json',
        image: 'https://example.com/ref.png',
      },
    });
    const topLevel = translateAgnesImageBody({
      model: 'agnes-image-2.1-flash',
      prompt: 'a cat',
      size: '2K',
      response_format: 'b64_json',
      image: 'https://example.com/ref.png',
    });

    expect(native).toEqual(topLevel);
    expect(native.extra_body).toEqual({
      response_format: 'b64_json',
      image: ['https://example.com/ref.png'],
    });
  });

  it('lets the top level win over extra_body', () => {
    const translated = translateAgnesImageBody({
      prompt: 'a cat',
      response_format: 'url',
      extra_body: { response_format: 'b64_json', image: 'https://example.com/ref.png' },
    });

    expect(translated.extra_body).toEqual({
      response_format: 'url',
      image: ['https://example.com/ref.png'],
    });
  });

  it('accepts the provider-native extra_body shape for video', () => {
    const native = translateAgnesVideoBody({
      model: 'agnes-video-v2.0',
      prompt: 'waves',
      extra_body: { ratio: '9:16', seconds: 8 },
    });
    const topLevel = translateAgnesVideoBody({
      model: 'agnes-video-v2.0',
      prompt: 'waves',
      ratio: '9:16',
      seconds: 8,
    });

    expect(native).toEqual(topLevel);
    expect(native).not.toHaveProperty('extra_body');
  });

  it('maps video ratio to aspect_ratio and seconds to a string', () => {
    const translated = translateAgnesVideoBody({
      model: 'agnes-video-v2.0',
      prompt: 'waves',
      ratio: '9:16',
      seconds: 8,
    });

    expect(translated).toMatchObject({
      model: 'agnes-video-v2.0',
      prompt: 'waves',
      mode: 'text',
      size: '720P',
      aspect_ratio: '9:16',
      seconds: '8',
    });
  });

  it('prefers an explicit aspect_ratio over ratio and defaults the rest', () => {
    const translated = translateAgnesVideoBody({ prompt: 'x', aspect_ratio: '1:1', ratio: '9:16' });
    expect(translated.aspect_ratio).toBe('1:1');
    expect(translated.seconds).toBe('5');
  });
});

describe('fal request translation', () => {
  it('maps the OpenAI-shaped image fields onto fal input', () => {
    const translated = translateFalImageBody({
      model: 'fal-ai/flux/schnell',
      prompt: 'a cat',
      n: 2,
      size: '1K',
      ratio: '16:9',
      response_format: 'b64_json',
      image: 'https://example.com/ref.png',
    });

    expect(translated).toEqual({
      prompt: 'a cat',
      num_images: 2,
      image_size: { width: 1024, height: 576 },
      sync_mode: true,
      image_url: 'https://example.com/ref.png',
    });
    // The model is not part of a fal endpoint's input schema.
    expect(translated).not.toHaveProperty('model');
  });

  it('translates an explicit WIDTHxHEIGHT size and passes fal-native fields through', () => {
    const translated = translateFalImageBody({
      prompt: 'x',
      size: '1280x720',
      num_inference_steps: 8,
      seed: 42,
      image_size: 'landscape_4_3',
    });

    expect(translated).toMatchObject({
      prompt: 'x',
      num_inference_steps: 8,
      seed: 42,
      image_size: 'landscape_4_3',
    });
    expect(translated).not.toHaveProperty('n');
    expect(translated).not.toHaveProperty('size');
  });

  it('tags multiple references as image_urls', () => {
    const translated = translateFalImageBody({
      prompt: 'x',
      images: ['https://a.png', 'https://b.png'],
    });
    expect(translated.image_urls).toEqual(['https://a.png', 'https://b.png']);
  });

  it('maps the OpenAI-shaped video fields onto fal input', () => {
    const translated = translateFalVideoBody({
      model: 'minimax/h3-max/text-to-video',
      prompt: 'waves',
      seconds: 5,
      size: '768P',
      ratio: '16:9',
      first_frame: 'https://a.png',
      last_frame: 'https://b.png',
    });

    expect(translated).toEqual({
      prompt: 'waves',
      duration: 5,
      resolution: '768P',
      aspect_ratio: '16:9',
      image_url: 'https://a.png',
      end_image_url: 'https://b.png',
    });
  });

  it('normalizes the resolution and drops an unsupported tier', () => {
    expect(translateFalVideoBody({ prompt: 'x', resolution: '480p' }).resolution).toBe('480P');
    expect(translateFalVideoBody({ prompt: 'x', size: '720P' })).not.toHaveProperty('resolution');
  });

  it('prefers fal-native image_url/end_image_url over the aliases', () => {
    const translated = translateFalVideoBody({
      prompt: 'x',
      image_url: 'https://native.png',
      end_image_url: 'https://native-end.png',
      first_frame: 'https://ignored.png',
      last_frame: 'https://ignored-end.png',
    });
    expect(translated.image_url).toBe('https://native.png');
    expect(translated.end_image_url).toBe('https://native-end.png');
  });
});

describe('toVideoObject', () => {
  it('maps Agnes statuses onto the OpenAI vocabulary', () => {
    expect(toVideoObject('v1', 'm', { status: 'in_progress' }).status).toBe('processing');
    expect(toVideoObject('v1', 'm', { status: 'completed' }).status).toBe('completed');
    expect(toVideoObject('v1', 'm', { status: 'failed' }).status).toBe('failed');
    expect(toVideoObject('v1', 'm', { status: 'weird' }).status).toBe('queued');
  });

  it('carries url, seconds, size and a normalized error', () => {
    const video = toVideoObject('v1', 'agnes-video-v2.0', {
      status: 'completed',
      url: 'https://cdn/v.mp4',
      seconds: '6',
      size: '720P',
      error: { message: 'boom' },
    });
    expect(video).toMatchObject({
      id: 'v1',
      object: 'video',
      model: 'agnes-video-v2.0',
      status: 'completed',
      url: 'https://cdn/v.mp4',
      seconds: 6,
      size: '720P',
      error: { message: 'boom' },
    });
  });
});

describe('MediaProviderClient', () => {
  let client: MediaProviderClient;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    client = new MediaProviderClient();
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('generates an image and merges n calls', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ created: 1, data: [{ url: 'a' }] }))
      .mockResolvedValueOnce(jsonResponse({ created: 1, data: [{ url: 'b' }] }));

    const result = await client.forward({
      provider: 'agnes',
      apiKey: 'k',
      model: 'agnes-image-2.1-flash',
      apiMode: 'images',
      body: { model: 'agnes-image-2.1-flash', prompt: 'x', n: 2 },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://apihub.agnes-ai.com/v1/images/generations');
    expect(result.ok).toBe(true);
    expect(result.body).toEqual({ created: 1, data: [{ url: 'a' }, { url: 'b' }] });
  });

  it('surfaces an image provider error', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: { message: 'bad prompt' } }, 400));

    const result = await client.forward({
      provider: 'agnes',
      apiKey: 'k',
      model: 'agnes-image-2.1-flash',
      apiMode: 'images',
      body: { prompt: 'x' },
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.errorMessage).toBe('bad prompt');
  });

  it('creates a video task and returns its id', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ video_id: 'vid_1', status: 'queued', seconds: '5' }));

    const result = await client.forward({
      provider: 'agnes',
      apiKey: 'k',
      model: 'agnes-video-v2.0',
      apiMode: 'videos',
      body: { model: 'agnes-video-v2.0', prompt: 'x' },
    });

    expect(fetchSpy.mock.calls[0][0]).toBe('https://apihub.agnes-ai.com/v1/videos');
    expect(result.ok).toBe(true);
    expect(result.taskId).toBe('vid_1');
    expect(result.videoStatus).toBe('queued');
    expect(result.seconds).toBe(5);
  });

  it('fails when a video create returns no task id', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ status: 'queued' }));
    const result = await client.forward({
      provider: 'agnes',
      apiKey: 'k',
      model: 'agnes-video-v2.0',
      apiMode: 'videos',
      body: { prompt: 'x' },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
  });

  it('polls a video task on the host root, not under /v1', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ status: 'completed', url: 'https://cdn/v.mp4', seconds: '10' }),
    );

    const result = await client.videoStatus({
      provider: 'agnes',
      apiKey: 'k',
      model: 'agnes-video-v2.0',
      taskId: 'vid_1',
    });

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('https://apihub.agnes-ai.com/agnesapi?');
    expect(url).toContain('video_id=vid_1');
    expect(url).toContain('model_name=agnes-video-v2.0');
    expect(result.videoStatus).toBe('completed');
    expect(result.seconds).toBe(10);
  });

  it('rejects an unsupported media provider', async () => {
    const result = await client.forward({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'claude',
      apiMode: 'images',
      body: { prompt: 'x' },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  it('passes the model and caller fields through to an OpenAI-compatible image API', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ created: 1, data: [{ url: 'u' }] }));

    const result = await client.forward({
      provider: 'openai',
      apiKey: 'k',
      model: 'gpt-image-1',
      apiMode: 'images',
      body: { model: 'gpt-image-1', prompt: 'x', n: 2, size: '1024x1024' },
    });

    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.openai.com/v1/images/generations');
    const sent = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(sent).toEqual({ model: 'gpt-image-1', prompt: 'x', n: 2, size: '1024x1024' });
    expect(result.ok).toBe(true);
  });

  it('does not support video for a non-Agnes provider', async () => {
    const result = await client.forward({
      provider: 'openai',
      apiKey: 'k',
      model: 'sora',
      apiMode: 'videos',
      body: { prompt: 'x' },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls fal.run for images with Key auth and returns OpenAI-shaped data', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        images: [{ url: 'https://fal/media/a.png', width: 1024, height: 1024 }],
      }),
    );

    const result = await client.forward({
      provider: 'fal',
      apiKey: 'fal-key',
      model: 'fal-ai/flux/schnell',
      apiMode: 'images',
      body: { prompt: 'a cat', size: '1K' },
    });

    expect(fetchSpy.mock.calls[0][0]).toBe('https://fal.run/fal-ai/flux/schnell');
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Key fal-key');
    expect(result.ok).toBe(true);
    expect(result.body).toMatchObject({ data: [{ url: 'https://fal/media/a.png' }] });
  });

  it('turns a fal sync data URI into b64_json', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ images: [{ url: 'data:image/png;base64,QUJD' }] }));

    const result = await client.forward({
      provider: 'fal',
      apiKey: 'k',
      model: 'fal-ai/flux/schnell',
      apiMode: 'images',
      body: { prompt: 'x', response_format: 'b64_json' },
    });

    expect(result.body).toMatchObject({ data: [{ b64_json: 'QUJD' }] });
  });

  it('submits fal video to the queue and returns the request id', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ request_id: 'req_1', queue_position: 0 }));

    const result = await client.forward({
      provider: 'fal',
      apiKey: 'k',
      model: 'minimax/h3-max/text-to-video',
      apiMode: 'videos',
      body: { prompt: 'waves', seconds: 5 },
    });

    expect(fetchSpy.mock.calls[0][0]).toBe('https://queue.fal.run/minimax/h3-max/text-to-video');
    const sent = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(sent).toEqual({ prompt: 'waves', duration: 5 });
    expect(result.ok).toBe(true);
    expect(result.taskId).toBe('req_1');
    expect(result.videoStatus).toBe('queued');
    expect(result.seconds).toBe(5);
  });

  it('fails when a fal video submit returns no request id', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ status: 'IN_QUEUE' }));
    const result = await client.forward({
      provider: 'fal',
      apiKey: 'k',
      model: 'minimax/h3-max/text-to-video',
      apiMode: 'videos',
      body: { prompt: 'x' },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.errorMessage).toBe('Provider returned no video task id');
  });

  it('polls fal status then fetches the result video url', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ status: 'COMPLETED', request_id: 'req_1' }))
      .mockResolvedValueOnce(jsonResponse({ video: { url: 'https://fal/media/v.mp4' } }));

    const result = await client.videoStatus({
      provider: 'fal',
      apiKey: 'k',
      model: 'minimax/h3-max/text-to-video',
      taskId: 'req_1',
    });

    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://queue.fal.run/minimax/h3-max/text-to-video/requests/req_1/status',
    );
    expect(fetchSpy.mock.calls[1][0]).toBe(
      'https://queue.fal.run/minimax/h3-max/text-to-video/requests/req_1',
    );
    expect(result.videoStatus).toBe('completed');
    expect(result.body).toMatchObject({ url: 'https://fal/media/v.mp4' });
  });

  it('reports fal IN_QUEUE/IN_PROGRESS without fetching a result', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ status: 'IN_PROGRESS' }));
    const result = await client.videoStatus({
      provider: 'fal',
      apiKey: 'k',
      model: 'minimax/h3-max/text-to-video',
      taskId: 'req_1',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.videoStatus).toBe('processing');
  });

  it('treats a COMPLETED fal status with an error as failed', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ status: 'COMPLETED', error: 'prompt rejected', error_type: 'safety' }),
    );
    const result = await client.videoStatus({
      provider: 'fal',
      apiKey: 'k',
      model: 'minimax/h3-max/text-to-video',
      taskId: 'req_1',
    });
    expect(result.videoStatus).toBe('failed');
    expect(result.body).toMatchObject({ error: { message: 'prompt rejected' } });
  });

  it('surfaces a fal failure detail on a non-ok response', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ detail: 'invalid api key', error_type: 'auth' }, 401),
    );
    const result = await client.forward({
      provider: 'fal',
      apiKey: 'bad',
      model: 'fal-ai/flux/schnell',
      apiMode: 'images',
      body: { prompt: 'x' },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.errorMessage).toBe('invalid api key');
  });
});
