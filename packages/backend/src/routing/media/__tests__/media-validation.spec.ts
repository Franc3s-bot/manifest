import { validateMediaRequest } from '../media-validation';

describe('validateMediaRequest', () => {
  describe('generic rules', () => {
    it('requires a non-empty prompt', () => {
      expect(validateMediaRequest({ provider: 'agnes', apiMode: 'images', body: {} })).toMatch(
        /prompt/,
      );
      expect(
        validateMediaRequest({ provider: 'agnes', apiMode: 'images', body: { prompt: '   ' } }),
      ).toMatch(/prompt/);
      expect(
        validateMediaRequest({ provider: 'openai', apiMode: 'videos', body: { prompt: 42 } }),
      ).toMatch(/prompt/);
    });

    it('rejects an out-of-range n', () => {
      const base = { provider: 'openai', apiMode: 'images' as const };
      expect(validateMediaRequest({ ...base, body: { prompt: 'x', n: 0 } })).toMatch(/"n"/);
      expect(validateMediaRequest({ ...base, body: { prompt: 'x', n: 11 } })).toMatch(/"n"/);
      expect(validateMediaRequest({ ...base, body: { prompt: 'x', n: 1.5 } })).toMatch(/"n"/);
      expect(validateMediaRequest({ ...base, body: { prompt: 'x', n: 4 } })).toBeUndefined();
    });

    it('rejects an unknown response_format', () => {
      expect(
        validateMediaRequest({
          provider: 'openai',
          apiMode: 'images',
          body: { prompt: 'x', response_format: 'webp' },
        }),
      ).toMatch(/response_format/);
    });

    it('rejects malformed image references', () => {
      expect(
        validateMediaRequest({
          provider: 'agnes',
          apiMode: 'images',
          body: { prompt: 'x', image: [] },
        }),
      ).toMatch(/"image"/);
      expect(
        validateMediaRequest({
          provider: 'agnes',
          apiMode: 'images',
          body: { prompt: 'x', image: ['ok', 5] },
        }),
      ).toMatch(/"image"/);
      expect(
        validateMediaRequest({
          provider: 'agnes',
          apiMode: 'images',
          body: { prompt: 'x', image: ['https://a', 'https://b'] },
        }),
      ).toBeUndefined();
    });
  });

  describe('Agnes image rules', () => {
    it('rejects a non-string size', () => {
      expect(
        validateMediaRequest({
          provider: 'agnes',
          apiMode: 'images',
          body: { prompt: 'x', size: 1024 },
        }),
      ).toMatch(/"size"/);
    });

    it('accepts an image-to-image request', () => {
      expect(
        validateMediaRequest({
          provider: 'agnes',
          apiMode: 'images',
          body: { prompt: 'x', image: 'https://ref.png', size: '2K', ratio: '16:9' },
        }),
      ).toBeUndefined();
    });
  });

  describe('Agnes video rules', () => {
    const agnes = (body: Record<string, unknown>) =>
      validateMediaRequest({ provider: 'agnes', apiMode: 'videos', body });

    it('rejects an unknown mode', () => {
      expect(agnes({ prompt: 'x', mode: 'morph' })).toMatch(/"mode"/);
    });

    it('text mode accepts no media', () => {
      expect(agnes({ prompt: 'x', mode: 'text', first_frame: 'https://a' })).toMatch(
        /"text" accepts no media/,
      );
      expect(agnes({ prompt: 'x', images: ['https://a'] })).toMatch(/"text" accepts no media/);
      expect(agnes({ prompt: 'x' })).toBeUndefined();
      expect(agnes({ prompt: 'x', mode: 'text' })).toBeUndefined();
    });

    it('keyframe mode requires a frame and rejects other media', () => {
      expect(agnes({ prompt: 'x', mode: 'keyframe' })).toMatch(/requires first_frame/);
      expect(agnes({ prompt: 'x', mode: 'keyframe', images: ['https://a'] })).toMatch(
        /only first_frame/,
      );
      expect(agnes({ prompt: 'x', mode: 'keyframe', first_frame: 'https://a' })).toBeUndefined();
      expect(agnes({ prompt: 'x', mode: 'keyframe', last_frame: 'https://b' })).toBeUndefined();
    });

    it('reference mode requires media and rejects frames', () => {
      expect(agnes({ prompt: 'x', mode: 'reference' })).toMatch(/requires at least one/);
      expect(agnes({ prompt: 'x', mode: 'reference', first_frame: 'https://a' })).toMatch(
        /not first_frame/,
      );
      expect(
        agnes({ prompt: 'x', mode: 'reference', videos: [{ url: 'https://v' }] }),
      ).toBeUndefined();
      expect(agnes({ prompt: 'x', mode: 'reference', images: ['https://a'] })).toBeUndefined();
    });

    it('caps reference media at 12 files', () => {
      const images = Array.from({ length: 13 }, (_, i) => `https://a/${i}`);
      expect(agnes({ prompt: 'x', mode: 'reference', images })).toMatch(/at most 12/);
    });

    it('enforces the 4-12 second range', () => {
      expect(agnes({ prompt: 'x', seconds: 3 })).toMatch(/"seconds"/);
      expect(agnes({ prompt: 'x', seconds: 13 })).toMatch(/"seconds"/);
      expect(agnes({ prompt: 'x', seconds: 4 })).toBeUndefined();
      expect(agnes({ prompt: 'x', seconds: 12 })).toBeUndefined();
    });
  });

  it('does not apply Agnes rules to other providers', () => {
    expect(
      validateMediaRequest({
        provider: 'openai',
        apiMode: 'videos',
        body: { prompt: 'x', mode: 'text', images: ['https://a'], seconds: 30 },
      }),
    ).toBeUndefined();
  });
});
