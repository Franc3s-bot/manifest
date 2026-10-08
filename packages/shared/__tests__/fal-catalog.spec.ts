import { FAL_MODELS, FAL_MODEL_BY_ID, FAL_MEDIA_PRICES, SHARED_PROVIDER_BY_ID } from '../src/index';

describe('fal.ai catalog', () => {
  it('registers fal as a media-capable provider', () => {
    const entry = SHARED_PROVIDER_BY_ID.get('fal');
    expect(entry).toBeDefined();
    expect(entry?.media).toEqual({ image: true, video: true });
    expect(entry?.requiresApiKey).toBe(true);
  });

  it('resolves the aliases to the canonical fal entry', () => {
    const entry = SHARED_PROVIDER_BY_ID.get('fal');
    for (const alias of entry?.aliases ?? []) {
      expect(entry?.aliases).toContain(alias);
    }
    expect(entry?.aliases).toContain('fal-ai');
  });

  it('exposes image and video models', () => {
    const outputs = new Set(FAL_MODELS.map((m) => m.output));
    expect(outputs).toEqual(new Set(['image', 'video']));
  });

  it('curates the MiniMax H3 Max video models', () => {
    const textToVideo = FAL_MODEL_BY_ID.get('minimax/h3-max/text-to-video');
    expect(textToVideo?.output).toBe('video');
    expect(textToVideo?.displayName).toMatch(/H3 Max/);

    const imageToVideo = FAL_MODEL_BY_ID.get('minimax/h3-max/image-to-video');
    expect(imageToVideo?.output).toBe('video');
  });

  it('prices H3 Max per second by resolution tier', () => {
    const rate = FAL_MEDIA_PRICES.videoPerSecond?.['minimax/h3-max/text-to-video'];
    expect(rate).toEqual({ default: 0.08, '480P': 0.05, '768P': 0.08, '1080P': 0.16 });
  });

  it('prices the curated image models per image', () => {
    expect(FAL_MEDIA_PRICES.imagePerImage?.['fal-ai/flux/schnell']).toBe(0.003);
    expect(FAL_MEDIA_PRICES.imagePerImage?.['fal-ai/flux/dev']).toBe(0.025);
  });
});
