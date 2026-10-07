/**
 * Shared contracts for image and video generation.
 *
 * Manifest exposes an OpenAI-compatible media surface:
 *   POST /v1/images/generations   (synchronous)
 *   POST /v1/videos               (asynchronous, returns a task id)
 *   GET  /v1/videos/{id}          (task status)
 *
 * Provider-specific extras (Agnes `ratio`, size tiers, reference images) ride
 * along as optional fields. The routing tier's `output_modality` decides which
 * surface a synthetic `auto-{name}` model belongs to.
 */

/** Media output modalities, mirroring the `image` / `video` members of OutputModality. */
export const MEDIA_OUTPUT_MODALITIES = ['image', 'video'] as const;
export type MediaOutputModality = (typeof MEDIA_OUTPUT_MODALITIES)[number];

export function isMediaOutputModality(value: unknown): value is MediaOutputModality {
  return (
    typeof value === 'string' && (MEDIA_OUTPUT_MODALITIES as readonly string[]).includes(value)
  );
}

/* ── Image generation ─────────────────────────────────────────────── */

export const IMAGE_RESPONSE_FORMATS = ['url', 'b64_json'] as const;
export type ImageResponseFormat = (typeof IMAGE_RESPONSE_FORMATS)[number];

export interface ImageGenerationRequest {
  model?: string;
  prompt: string;
  /** Number of images. Providers that only return one image are called n times. */
  n?: number;
  /**
   * Output size. Either a provider tier (`1K`, `2K`, …) or an exact
   * `WIDTHxHEIGHT` (e.g. `1024x1024`). Translated per provider.
   */
  size?: string;
  /** Aspect ratio (Agnes extension), e.g. `16:9`. */
  ratio?: string;
  response_format?: ImageResponseFormat;
  /**
   * Reference images for image-to-image / composition. Each entry is a
   * publicly reachable URL or a `data:` URI.
   */
  image?: string | readonly string[];
  /** Provider passthrough for unrecognised params. */
  [key: string]: unknown;
}

export interface GeneratedImage {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}

export interface ImageGenerationResponse {
  created: number;
  data: GeneratedImage[];
}

/* ── Video generation ─────────────────────────────────────────────── */

export const VIDEO_STATUSES = ['queued', 'processing', 'completed', 'failed'] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];

export interface VideoGenerationRequest {
  model?: string;
  prompt: string;
  /** Output resolution tier (`720P`, `1080P`, `1K`, `2K`). */
  size?: string;
  /** Aspect ratio (Agnes extension), e.g. `16:9`. */
  ratio?: string;
  /** Output duration in seconds (4–12 on Agnes). */
  seconds?: number;
  /** Agnes generation mode. */
  mode?: 'text' | 'keyframe' | 'reference';
  /** First-frame image for keyframe mode. */
  first_frame?: string;
  /** Last-frame image for keyframe mode. */
  last_frame?: string;
  /** Reference images / audio / video for reference mode. */
  images?: readonly string[];
  audios?: readonly string[];
  videos?: readonly { url: string; start_seconds?: number; require_audio?: boolean }[];
  [key: string]: unknown;
}

/** OpenAI-shaped video task object. */
export interface VideoObject {
  id: string;
  object: 'video';
  model: string;
  status: VideoStatus;
  created_at: number;
  progress?: number;
  seconds?: number;
  size?: string;
  /** Download URL once the task completes. */
  url?: string;
  error?: { message: string } | null;
  /** Provider passthrough for unrecognised fields. */
  [key: string]: unknown;
}

/* ── Pricing ──────────────────────────────────────────────────────── */

/**
 * A flat USD rate, or a per-size-tier map (`1K`, `2K`, `720P`, `1080P`, …).
 * Maps must carry a `default` entry used when the request names no size.
 */
export type MediaRate = number | Readonly<Record<string, number>>;

/**
 * USD pricing for media generation, keyed by `<provider>/<model>`.
 * Unknown models fall through to the provider default, then to `null`
 * (cost not tracked).
 */
export interface MediaPriceTable {
  /** USD per generated image for a given model. */
  imagePerImage?: Readonly<Record<string, MediaRate>>;
  /** Default USD per image for the provider when the model is not listed. */
  imageDefaultPerImage?: MediaRate;
  /** USD per second of output for a given model. */
  videoPerSecond?: Readonly<Record<string, MediaRate>>;
  /** Default USD per second for the provider when the model is not listed. */
  videoDefaultPerSecond?: MediaRate;
}

/**
 * Agnes public pricing (https://www.agnes-ai.com/en/docs/pricing).
 *
 * Image output is billed per image by resolution tier; all tiers are
 * currently free during the promotional window, so the list price is used
 * here to keep cost tracking meaningful once the promotion ends.
 * Video is billed per second of output duration, by resolution tier.
 */
export const AGNES_MEDIA_PRICES: MediaPriceTable = {
  imagePerImage: {
    'agnes-image-2.5-flash': { default: 0.01, '1K': 0.01, '2K': 0.018, '3K': 0.021, '4K': 0.024 },
    'agnes-image-2.1-flash': { default: 0.01, '1K': 0.01, '2K': 0.018, '3K': 0.021, '4K': 0.024 },
    'agnes-image-2.0-flash': { default: 0.01, '1K': 0.01, '2K': 0.018, '3K': 0.021, '4K': 0.024 },
  },
  videoPerSecond: {
    'agnes-video-2.5': { default: 0.04, '720P': 0.025, '1080P': 0.04, '1K': 0.04, '2K': 0.055 },
    // Promotional: free for a limited time (list 720P $0.025/s).
    'agnes-video-2.5-flash': { default: 0, '720P': 0 },
  },
};
