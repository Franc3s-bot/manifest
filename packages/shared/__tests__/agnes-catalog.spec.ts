import { AGNES_MODELS, AGNES_MODEL_BY_ID, SHARED_PROVIDER_BY_ID } from '../src/providers';

describe('Agnes AI catalog', () => {
  it('registers agnes as a media-capable provider', () => {
    const entry = SHARED_PROVIDER_BY_ID.get('agnes');
    expect(entry).toBeDefined();
    expect(entry?.media).toEqual({ image: true, video: true });
    expect(entry?.requiresApiKey).toBe(true);
  });

  it('exposes text, image, and video models', () => {
    const outputs = new Set(AGNES_MODELS.map((m) => m.output));
    expect(outputs).toEqual(new Set(['text', 'image', 'video']));
  });

  it('carries context windows for text models and none for media models', () => {
    const text = AGNES_MODEL_BY_ID.get('agnes-2.5-flash');
    expect(text?.output).toBe('text');
    expect(text?.contextWindow).toBe(524_288);

    const image = AGNES_MODEL_BY_ID.get('agnes-image-2.1-flash');
    expect(image?.output).toBe('image');
    expect(image?.contextWindow).toBeUndefined();

    const video = AGNES_MODEL_BY_ID.get('agnes-video-v2.0');
    expect(video?.output).toBe('video');
  });
});
