import { normalizeMediaBody } from '../media-request-body';

describe('normalizeMediaBody', () => {
  it('returns the body untouched when there is no extra_body', () => {
    const body = { prompt: 'a cat', response_format: 'url' };
    expect(normalizeMediaBody(body)).toBe(body);
  });

  it('lifts provider-native extra_body fields to the top level', () => {
    expect(
      normalizeMediaBody({
        model: 'agnes-image-2.1-flash',
        prompt: 'a cat',
        extra_body: { response_format: 'b64_json', image: 'https://example.com/ref.png' },
      }),
    ).toEqual({
      model: 'agnes-image-2.1-flash',
      prompt: 'a cat',
      response_format: 'b64_json',
      image: 'https://example.com/ref.png',
    });
  });

  it('prefers the top level when both shapes carry the same field', () => {
    expect(
      normalizeMediaBody({
        response_format: 'url',
        extra_body: { response_format: 'b64_json' },
      }),
    ).toEqual({ response_format: 'url' });
  });

  it('ignores a non-object extra_body and never forwards the wrapper twice', () => {
    expect(normalizeMediaBody({ prompt: 'a cat', extra_body: 'nope' })).toEqual({
      prompt: 'a cat',
      extra_body: 'nope',
    });
    expect(normalizeMediaBody({ prompt: 'a cat', extra_body: {} })).toEqual({ prompt: 'a cat' });
    expect(normalizeMediaBody({ prompt: 'a cat', extra_body: ['x'] })).toEqual({
      prompt: 'a cat',
      extra_body: ['x'],
    });
  });
});
