import { isMediaCapableProvider, PROVIDER_CONFIGS } from './provider-model-fetcher.service';

describe('Agnes media model discovery', () => {
  const parse = PROVIDER_CONFIGS['agnes'].parse;

  it('marks agnes media-capable and other providers not', () => {
    expect(isMediaCapableProvider('agnes')).toBe(true);
    expect(isMediaCapableProvider('Agnes')).toBe(true);
    expect(isMediaCapableProvider('agnes-ai')).toBe(true);
    expect(isMediaCapableProvider('openai')).toBe(false);
    expect(isMediaCapableProvider('anthropic')).toBe(false);
  });

  it('annotates the curated catalog with output modalities', () => {
    const models = parse({ data: [] }, 'agnes');
    const byId = new Map(models.map((m) => [m.id, m]));

    expect(byId.get('agnes-2.5-flash')?.outputModalities).toEqual(['text']);
    expect(byId.get('agnes-2.5-flash')?.capabilities).toEqual(['text', 'stream', 'tools']);
    expect(byId.get('agnes-image-2.1-flash')?.outputModalities).toEqual(['image']);
    expect(byId.get('agnes-image-2.1-flash')?.inputModalities).toEqual(['text', 'image']);
    expect(byId.get('agnes-video-v2.0')?.outputModalities).toEqual(['video']);
    expect(byId.get('agnes-video-v2.0')?.capabilities).toEqual(['text', 'video']);
  });

  it('appends curated media models missing from the live listing', () => {
    const models = parse({ data: [{ id: 'agnes-2.5-flash' }] }, 'agnes');
    const ids = models.map((m) => m.id);
    expect(ids).toContain('agnes-2.5-flash');
    expect(ids).toContain('agnes-image-2.1-flash');
    expect(ids).toContain('agnes-video-v2.0');
    // The live listing is not duplicated by the curated pass.
    expect(ids.filter((id) => id === 'agnes-2.5-flash')).toHaveLength(1);
  });

  it('keeps unknown live models as text so a new release is still routable', () => {
    const models = parse({ data: [{ id: 'agnes-3.0-flash' }] }, 'agnes');
    const unknown = models.find((m) => m.id === 'agnes-3.0-flash');
    expect(unknown?.outputModalities).toEqual(['text']);
    expect(unknown?.contextWindowSource).toBe('provider_default');
  });
});
