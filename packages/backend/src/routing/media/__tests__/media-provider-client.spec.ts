import {
  MediaProviderClient,
  toVideoObject,
  translateAgnesImageBody,
  translateAgnesVideoBody,
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
});
