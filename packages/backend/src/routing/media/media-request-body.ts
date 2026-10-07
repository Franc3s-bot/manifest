/**
 * Provider-native request bodies wrap part of the payload in `extra_body`
 * (Agnes accepts `response_format` and reference images only that way). The
 * OpenAI-shaped surface Manifest publishes keeps them at the top level.
 *
 * `normalizeMediaBody` accepts both shapes so pointing an existing
 * provider-native client at the gateway does not silently drop fields: a
 * `response_format` or `image` sent inside `extra_body` behaves exactly like
 * the top-level one. The top level wins when both are present, and the
 * `extra_body` wrapper is removed so nothing is forwarded twice.
 */
export function normalizeMediaBody(body: Record<string, unknown>): Record<string, unknown> {
  const extraBody = body.extra_body;
  if (!isPlainObject(extraBody)) return body;
  const normalized: Record<string, unknown> = { ...extraBody };
  for (const [key, value] of Object.entries(body)) {
    if (key === 'extra_body') continue;
    normalized[key] = value;
  }
  return normalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
