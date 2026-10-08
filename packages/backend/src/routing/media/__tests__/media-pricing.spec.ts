import { imageCostUsd, parseDurationSeconds, videoCostUsd } from '../media-pricing';

describe('media pricing', () => {
  describe('imageCostUsd', () => {
    it('prices per image by resolution tier', () => {
      expect(imageCostUsd('agnes', 'agnes-image-2.5-flash', 2, '1K')).toBeCloseTo(0.02, 6);
      expect(imageCostUsd('agnes', 'agnes-image-2.5-flash', 1, '4K')).toBeCloseTo(0.024, 6);
      expect(imageCostUsd('agnes', 'agnes-image-2.1-flash', 3, '2K')).toBeCloseTo(0.054, 6);
    });

    it('falls back to the default tier when no size is given', () => {
      expect(imageCostUsd('agnes', 'agnes-image-2.5-flash', 1)).toBeCloseTo(0.01, 6);
      expect(imageCostUsd('agnes', 'agnes-image-2.5-flash', 1, '9K')).toBeCloseTo(0.01, 6);
    });

    it('returns null when no rate is known', () => {
      expect(imageCostUsd('agnes', 'agnes-unknown-image', 1)).toBeNull();
      expect(imageCostUsd('openai', 'gpt-image-1', 1)).toBeNull();
      expect(imageCostUsd('agnes', 'agnes-image-2.5-flash', 0)).toBeNull();
    });
  });

  describe('videoCostUsd', () => {
    it('prices per second by resolution tier', () => {
      expect(videoCostUsd('agnes', 'agnes-video-2.5', 10, '720P')).toBeCloseTo(0.25, 6);
      expect(videoCostUsd('agnes', 'agnes-video-2.5', 10, '1080P')).toBeCloseTo(0.4, 6);
      expect(videoCostUsd('agnes', 'agnes-video-2.5', 10, '2K')).toBeCloseTo(0.55, 6);
    });

    it('falls back to the default tier when no size is given', () => {
      expect(videoCostUsd('agnes', 'agnes-video-2.5', 10)).toBeCloseTo(0.4, 6);
    });

    it('prices the promotional flash video model at zero', () => {
      expect(videoCostUsd('agnes', 'agnes-video-2.5-flash', 10, '720P')).toBe(0);
    });

    it('returns null for an unpriced or retired model', () => {
      expect(videoCostUsd('agnes', 'agnes-video-v2.0', 10)).toBeNull();
      expect(videoCostUsd('openai', 'sora', 10)).toBeNull();
      expect(videoCostUsd('agnes', 'agnes-video-2.5', 0)).toBeNull();
    });
  });

  describe('fal pricing', () => {
    it('prices H3 Max video per second by resolution tier', () => {
      expect(videoCostUsd('fal', 'minimax/h3-max/text-to-video', 10, '480P')).toBeCloseTo(0.5, 6);
      expect(videoCostUsd('fal', 'minimax/h3-max/text-to-video', 10, '768P')).toBeCloseTo(0.8, 6);
      expect(videoCostUsd('fal', 'minimax/h3-max/image-to-video', 5, '1080P')).toBeCloseTo(0.8, 6);
    });

    it('falls back to the default tier when no size is given', () => {
      expect(videoCostUsd('fal', 'minimax/h3-max/text-to-video', 5)).toBeCloseTo(0.4, 6);
    });

    it('prices the curated fal image models per image', () => {
      expect(imageCostUsd('fal', 'fal-ai/flux/schnell', 2)).toBeCloseTo(0.006, 6);
      expect(imageCostUsd('fal', 'fal-ai/flux/dev', 1)).toBeCloseTo(0.025, 6);
    });

    it('returns null for an unpriced fal model instead of fabricating a rate', () => {
      expect(imageCostUsd('fal', 'fal-ai/unknown', 1)).toBeNull();
      expect(videoCostUsd('fal', 'fal-ai/unknown-video', 5)).toBeNull();
      expect(videoCostUsd('fal', 'minimax/h3-max/reference-to-video', 5)).toBeNull();
    });
  });

  describe('parseDurationSeconds', () => {
    it('accepts numbers and numeric strings', () => {
      expect(parseDurationSeconds(6)).toBe(6);
      expect(parseDurationSeconds('6')).toBe(6);
      expect(parseDurationSeconds('6.5')).toBe(6.5);
    });

    it('rejects unusable values', () => {
      expect(parseDurationSeconds('abc')).toBeUndefined();
      expect(parseDurationSeconds(0)).toBeUndefined();
      expect(parseDurationSeconds(undefined)).toBeUndefined();
    });
  });
});
