import { CLASSIFIER_MODELS, normalizeClassifierModelId } from './systemone.constants';

describe('normalizeClassifierModelId', () => {
  it('accepts the bare upstream id Pi sends through the opencode provider', () => {
    expect(normalizeClassifierModelId('jev-1.13-free')).toBe('jev-1.13-free');
    expect(normalizeClassifierModelId('jev-1.13')).toBe('jev-1.13');
  });

  it('accepts the provider-qualified id Manifest publishes in /v1/models', () => {
    expect(normalizeClassifierModelId('opencode-zen/jev-1.13-free')).toBe('jev-1.13-free');
    expect(normalizeClassifierModelId('opencode/jev-1.13')).toBe('jev-1.13');
    expect(normalizeClassifierModelId('zen/jev-1.13')).toBe('jev-1.13');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeClassifierModelId('  jev-1.13-free  ')).toBe('jev-1.13-free');
  });

  it('rejects chat models, empty values, and non-strings', () => {
    expect(normalizeClassifierModelId('gpt-4o')).toBeNull();
    expect(normalizeClassifierModelId('opencode-zen/gpt-5.4')).toBeNull();
    expect(normalizeClassifierModelId('')).toBeNull();
    expect(normalizeClassifierModelId('   ')).toBeNull();
    expect(normalizeClassifierModelId(undefined)).toBeNull();
    expect(normalizeClassifierModelId(null)).toBeNull();
  });

  it('every catalog entry resolves back to its own upstream id', () => {
    for (const model of CLASSIFIER_MODELS) {
      expect(normalizeClassifierModelId(model.publicId)).toBe(model.id);
      expect(normalizeClassifierModelId(model.id)).toBe(model.id);
    }
  });
});
