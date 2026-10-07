import type { MediaApiMode } from './media-provider-client';

/**
 * Manifest-side validation for media generation requests.
 *
 * A malformed media body used to reach the provider and come back as a
 * provider 400 — which pollutes provider reliability and gives the caller no
 * actionable, linkable error. Validating here lets Manifest reject it locally
 * with a documented M304 instead.
 *
 * Only rules that are certain are enforced: a generic pass for every provider,
 * plus provider-specific rules where the provider's contract is documented
 * (Agnes' generation modes). Anything a provider might accept stays untouched.
 */

export interface MediaValidationInput {
  provider: string;
  apiMode: MediaApiMode;
  body: Record<string, unknown>;
}

/**
 * Returns a human-readable reason when the request is invalid, or undefined
 * when it is acceptable.
 */
export function validateMediaRequest(input: MediaValidationInput): string | undefined {
  const generic = validateGeneric(input.apiMode, input.body);
  if (generic) return generic;
  if (input.provider.toLowerCase() === 'agnes') {
    return validateAgnes(input.apiMode, input.body);
  }
  return undefined;
}

/* ── Generic ──────────────────────────────────────────────────────── */

const MAX_IMAGES_PER_REQUEST = 10;

function validateGeneric(apiMode: MediaApiMode, body: Record<string, unknown>): string | undefined {
  const prompt = body.prompt;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return '"prompt" is required and must be a non-empty string.';
  }

  if (apiMode === 'images') {
    if (body.n !== undefined) {
      const n = body.n;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_IMAGES_PER_REQUEST) {
        return `"n" must be an integer between 1 and ${MAX_IMAGES_PER_REQUEST}.`;
      }
    }
    if (body.response_format !== undefined && !isResponseFormat(body.response_format)) {
      return '"response_format" must be "url" or "b64_json".';
    }
    if (body.image !== undefined && !isValidReferences(body.image)) {
      return '"image" must be a non-empty string or an array of non-empty strings.';
    }
  }

  return undefined;
}

/* ── Agnes ────────────────────────────────────────────────────────── */

const AGNES_VIDEO_MODES = ['text', 'keyframe', 'reference'] as const;
const AGNES_MAX_REFERENCE_MEDIA = 12;
const AGNES_MIN_SECONDS = 4;
const AGNES_MAX_SECONDS = 12;

function validateAgnes(apiMode: MediaApiMode, body: Record<string, unknown>): string | undefined {
  if (apiMode === 'images') return validateAgnesImage(body);
  return validateAgnesVideo(body);
}

function validateAgnesImage(body: Record<string, unknown>): string | undefined {
  if (body.size !== undefined && (typeof body.size !== 'string' || body.size.trim().length === 0)) {
    return '"size" must be a size tier (1K, 2K, …) or "WIDTHxHEIGHT".';
  }
  return undefined;
}

function validateAgnesVideo(body: Record<string, unknown>): string | undefined {
  const rawMode = body.mode;
  if (rawMode !== undefined && !isAgnesVideoMode(rawMode)) {
    return '"mode" must be one of "text", "keyframe", or "reference".';
  }
  const mode = isAgnesVideoMode(rawMode) ? rawMode : 'text';

  const hasFrames = isNonEmptyString(body.first_frame) || isNonEmptyString(body.last_frame);
  const imageCount = countReferences(body.images);
  const audioCount = countReferences(body.audios);
  const videoCount = Array.isArray(body.videos) ? body.videos.length : 0;
  const hasReferences = imageCount + audioCount + videoCount > 0;

  if (mode === 'text') {
    if (hasFrames || hasReferences) {
      return (
        'mode "text" accepts no media: drop first_frame/last_frame/images/audios/videos, ' +
        'or switch mode.'
      );
    }
  } else if (mode === 'keyframe') {
    if (hasReferences) return 'mode "keyframe" accepts only first_frame/last_frame.';
    if (!hasFrames) return 'mode "keyframe" requires first_frame and/or last_frame.';
  } else {
    if (hasFrames) {
      return 'mode "reference" accepts images/audios/videos, not first_frame/last_frame.';
    }
    if (!hasReferences) {
      return 'mode "reference" requires at least one of images/audios/videos.';
    }
    const mediaCount = imageCount + audioCount + videoCount;
    if (mediaCount > AGNES_MAX_REFERENCE_MEDIA) {
      return `at most ${AGNES_MAX_REFERENCE_MEDIA} reference media files per request (got ${mediaCount}).`;
    }
  }

  if (body.seconds !== undefined) {
    const seconds = body.seconds;
    if (
      typeof seconds !== 'number' ||
      !Number.isInteger(seconds) ||
      seconds < AGNES_MIN_SECONDS ||
      seconds > AGNES_MAX_SECONDS
    ) {
      return `"seconds" must be an integer between ${AGNES_MIN_SECONDS} and ${AGNES_MAX_SECONDS}.`;
    }
  }

  return undefined;
}

/* ── Helpers ──────────────────────────────────────────────────────── */

function isAgnesVideoMode(value: unknown): value is (typeof AGNES_VIDEO_MODES)[number] {
  return typeof value === 'string' && (AGNES_VIDEO_MODES as readonly string[]).includes(value);
}

function isResponseFormat(value: unknown): boolean {
  return value === 'url' || value === 'b64_json';
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidReferences(value: unknown): boolean {
  if (isNonEmptyString(value)) return true;
  if (Array.isArray(value)) {
    return value.length > 0 && value.every(isNonEmptyString);
  }
  return false;
}

function countReferences(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value !== undefined) return 1;
  return 0;
}
