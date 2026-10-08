import { isMediaCapableProvider, PROVIDER_CONFIGS } from './provider-model-fetcher.service';

describe('fal media model discovery', () => {
  const parse = PROVIDER_CONFIGS['fal'].parse;

  it('marks fal media-capable and other providers not', () => {
    expect(isMediaCapableProvider('fal')).toBe(true);
    expect(isMediaCapableProvider('FAL')).toBe(true);
    expect(isMediaCapableProvider('fal-ai')).toBe(true);
    expect(isMediaCapableProvider('openai')).toBe(false);
    expect(isMediaCapableProvider('anthropic')).toBe(false);
  });

  it('appends the curated catalog when the live listing is empty', () => {
    const models = parse({ models: [] }, 'fal');
    const byId = new Map(models.map((m) => [m.id, m]));

    expect(byId.get('minimax/h3-max/text-to-video')?.outputModalities).toEqual(['video']);
    expect(byId.get('minimax/h3-max/text-to-video')?.capabilities).toEqual(['text', 'video']);
    expect(byId.get('minimax/h3-max/text-to-video')?.displayName).toMatch(/H3 Max/);
    expect(byId.get('fal-ai/flux/schnell')?.outputModalities).toEqual(['image']);
    expect(byId.get('fal-ai/flux/schnell')?.capabilities).toEqual(['text', 'image']);
  });

  it('classifies live entries from their category and drops non-media ones', () => {
    const models = parse(
      {
        models: [
          { endpoint_id: 'fal-ai/veo3', metadata: { category: 'text-to-video' } },
          { endpoint_id: 'fal-ai/flux-pro', metadata: { category: 'text-to-image' } },
          { endpoint_id: 'some/keyframes', metadata: { category: 'image-to-video' } },
          { endpoint_id: 'fal-ai/trainer', metadata: { category: 'training' } },
          { endpoint_id: 'fal-ai/tts', metadata: { category: 'text-to-speech' } },
        ],
      },
      'fal',
    );
    const byId = new Map(models.map((m) => [m.id, m]));

    expect(byId.get('fal-ai/veo3')?.outputModalities).toEqual(['video']);
    expect(byId.get('fal-ai/flux-pro')?.outputModalities).toEqual(['image']);
    expect(byId.get('some/keyframes')?.outputModalities).toEqual(['video']);
    expect(byId.has('fal-ai/trainer')).toBe(false);
    expect(byId.has('fal-ai/tts')).toBe(false);
    // The curated models are still appended.
    expect(byId.has('minimax/h3-max/text-to-video')).toBe(true);
  });

  it('does not duplicate a curated model present in the live listing', () => {
    const models = parse(
      {
        models: [
          {
            endpoint_id: 'minimax/h3-max/text-to-video',
            metadata: { category: 'text-to-video', display_name: 'Ignored' },
          },
        ],
      },
      'fal',
    );
    expect(models.filter((m) => m.id === 'minimax/h3-max/text-to-video')).toHaveLength(1);
    // The curated display name wins over the listing's.
    expect(models.find((m) => m.id === 'minimax/h3-max/text-to-video')?.displayName).toMatch(
      /H3 Max/,
    );
  });
});
