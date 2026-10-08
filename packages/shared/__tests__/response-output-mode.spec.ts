import { DEFAULT_RESPONSE_MODE, RESPONSE_MODES, isResponseMode } from '../src/response-mode';
import {
  DEFAULT_OUTPUT_MODALITY,
  OUTPUT_MODALITIES,
  isOutputModality,
} from '../src/output-modality';

describe('response-mode', () => {
  it('defines buffered as the default and validates supported modes', () => {
    expect(DEFAULT_RESPONSE_MODE).toBe('buffered');
    expect(RESPONSE_MODES).toEqual(['buffered', 'stream']);
    expect(isResponseMode('buffered')).toBe(true);
    expect(isResponseMode('stream')).toBe(true);
    expect(isResponseMode('video')).toBe(false);
    expect(isResponseMode(null)).toBe(false);
  });
});

describe('output-modality', () => {
  it('accepts text, image, and video output modalities', () => {
    expect(DEFAULT_OUTPUT_MODALITY).toBe('text');
    expect(OUTPUT_MODALITIES).toEqual(['text', 'image', 'video']);
    expect(isOutputModality('text')).toBe(true);
    expect(isOutputModality('image')).toBe(true);
    expect(isOutputModality('video')).toBe(true);
    expect(isOutputModality('audio')).toBe(false);
    expect(isOutputModality(undefined)).toBe(false);
  });
});
