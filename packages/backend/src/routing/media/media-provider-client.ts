import { Injectable, Logger } from '@nestjs/common';
import {
  AGNES_BASE_URL,
  FAL_BASE_URL,
  FAL_QUEUE_BASE_URL,
  type VideoStatus,
} from 'manifest-shared';
import { parseDurationSeconds } from './media-pricing';
import { normalizeMediaBody } from './media-request-body';

/** The media surfaces Manifest exposes. Mirrors the media members of ProxyApiMode. */
export type MediaApiMode = 'images' | 'videos';

const IMAGE_TIMEOUT_MS = 360_000;
const VIDEO_CREATE_TIMEOUT_MS = 120_000;
const VIDEO_STATUS_TIMEOUT_MS = 30_000;

/**
 * Agnes base URL. `AGNES_BASE_URL` overrides the public default so a
 * self-hosted gateway or a test mock can stand in for the public API; the
 * task-status origin derives from it the same way the public one does.
 */
function agnesBaseUrl(): string {
  return (process.env['AGNES_BASE_URL']?.trim() || AGNES_BASE_URL).replace(/\/+$/, '');
}

function agnesTaskOrigin(): string {
  const explicit = process.env['AGNES_TASK_ORIGIN']?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return agnesBaseUrl().replace(/\/v\d+$/, '');
}

/**
 * fal's synchronous inference origin (images) and async queue origin (video).
 * `FAL_BASE_URL` / `FAL_QUEUE_BASE_URL` overrides let a self-hosted gateway or
 * a test mock stand in for the public API.
 */
function falBaseUrl(): string {
  return (process.env['FAL_BASE_URL']?.trim() || FAL_BASE_URL).replace(/\/+$/, '');
}

function falQueueBaseUrl(): string {
  return (process.env['FAL_QUEUE_BASE_URL']?.trim() || FAL_QUEUE_BASE_URL).replace(/\/+$/, '');
}

/** fal authenticates with `Authorization: Key <key>`, not a bearer token. */
function falHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Key ${apiKey}` };
}

export interface MediaForwardOptions {
  provider: string;
  apiKey: string;
  model: string;
  apiMode: MediaApiMode;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface MediaForwardResult {
  ok: boolean;
  status: number;
  /** Parsed JSON when the upstream returned JSON, raw text otherwise. */
  body: unknown;
  requestUrl: string;
  requestBody: Record<string, unknown>;
  /** Provider task id for an async video task. */
  taskId?: string;
  /** Normalized task status for a video create/status response. */
  videoStatus?: VideoStatus;
  /** Output duration in seconds, when the provider reports it. */
  seconds?: number;
  /** Human-readable failure for a non-ok response. */
  errorMessage?: string;
}

export interface VideoStatusOptions {
  provider: string;
  apiKey: string;
  model: string;
  taskId: string;
  signal?: AbortSignal;
}

/**
 * Forwards image/video generation to a media-capable provider.
 *
 * This deliberately does not use ProviderClient: that client speaks the chat
 * wire formats (OpenAI chat, Responses, Anthropic Messages, Google), while
 * media has its own endpoints and bodies. The routing, credential, recording,
 * and pricing layers around it are shared with the text proxy.
 */
@Injectable()
export class MediaProviderClient {
  private readonly logger = new Logger(MediaProviderClient.name);

  async forward(opts: MediaForwardOptions): Promise<MediaForwardResult> {
    const provider = opts.provider.toLowerCase();
    if (provider === 'agnes') {
      return opts.apiMode === 'images'
        ? this.forwardAgnesImage(opts)
        : this.forwardAgnesVideo(opts);
    }
    if (provider === 'fal') {
      return opts.apiMode === 'images' ? this.forwardFalImage(opts) : this.forwardFalVideo(opts);
    }
    if (opts.apiMode === 'images') return this.forwardOpenAiImage(opts);
    return this.unsupported(opts, 'video');
  }

  /** Poll an asynchronous video task. */
  async videoStatus(opts: VideoStatusOptions): Promise<MediaForwardResult> {
    const provider = opts.provider.toLowerCase();
    if (provider === 'fal') return this.falVideoStatus(opts);
    if (provider !== 'agnes') return this.unsupportedVideoStatus(opts);

    const query = new URLSearchParams({ video_id: opts.taskId, model_name: opts.model });
    const url = `${agnesTaskOrigin()}/agnesapi?${query.toString()}`;
    const res = await this.request(
      'GET',
      url,
      opts.apiKey,
      undefined,
      opts.signal,
      VIDEO_STATUS_TIMEOUT_MS,
    );
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        body: res.body,
        requestUrl: url,
        requestBody: {},
        errorMessage: extractErrorMessage(res.body),
      };
    }
    const payload = asRecord(res.body) ?? {};
    const video = toVideoObject(opts.taskId, opts.model, payload);
    return {
      ok: true,
      status: 200,
      body: video,
      requestUrl: url,
      requestBody: {},
      taskId: opts.taskId,
      videoStatus: video.status,
      seconds: parseDurationSeconds(video.seconds),
    };
  }

  /* ── Agnes ──────────────────────────────────────────────────────── */

  private async forwardAgnesImage(opts: MediaForwardOptions): Promise<MediaForwardResult> {
    const url = `${agnesBaseUrl()}/images/generations`;
    const count = positiveInteger(opts.body.n) ?? 1;
    const translated = translateAgnesImageBody(opts.body);

    const data: unknown[] = [];
    let created: number | undefined;
    for (let i = 0; i < count; i++) {
      const res = await this.request(
        'POST',
        url,
        opts.apiKey,
        translated,
        opts.signal,
        IMAGE_TIMEOUT_MS,
      );
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          body: res.body,
          requestUrl: url,
          requestBody: translated,
          errorMessage: extractErrorMessage(res.body),
        };
      }
      const payload = asRecord(res.body) ?? {};
      if (Array.isArray(payload.data)) data.push(...payload.data);
      if (typeof payload.created === 'number') created = payload.created;
    }

    return {
      ok: true,
      status: 200,
      body: { created: created ?? Math.floor(Date.now() / 1000), data },
      requestUrl: url,
      requestBody: translated,
    };
  }

  private async forwardAgnesVideo(opts: MediaForwardOptions): Promise<MediaForwardResult> {
    const url = `${agnesBaseUrl()}/videos`;
    const translated = translateAgnesVideoBody(opts.body);
    const res = await this.request(
      'POST',
      url,
      opts.apiKey,
      translated,
      opts.signal,
      VIDEO_CREATE_TIMEOUT_MS,
    );
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        body: res.body,
        requestUrl: url,
        requestBody: translated,
        errorMessage: extractErrorMessage(res.body),
      };
    }
    const payload = asRecord(res.body) ?? {};
    const taskId = firstString(payload.video_id, payload.id, payload.task_id);
    if (!taskId) {
      return {
        ok: false,
        status: 502,
        body: res.body,
        requestUrl: url,
        requestBody: translated,
        errorMessage: 'Provider returned no video task id',
      };
    }
    const video = toVideoObject(taskId, opts.model, payload);
    return {
      ok: true,
      status: 200,
      body: video,
      requestUrl: url,
      requestBody: translated,
      taskId,
      videoStatus: video.status,
      seconds: parseDurationSeconds(video.seconds) ?? parseDurationSeconds(translated.seconds),
    };
  }

  /* ── fal.ai ─────────────────────────────────────────────────────── */

  /**
   * fal images run on the synchronous endpoint (`POST fal.run/{model}`): the
   * response is the model's own output object, so no queue polling is needed.
   */
  private async forwardFalImage(opts: MediaForwardOptions): Promise<MediaForwardResult> {
    const url = `${falBaseUrl()}/${opts.model}`;
    const translated = translateFalImageBody(opts.body);
    const res = await this.request(
      'POST',
      url,
      opts.apiKey,
      translated,
      opts.signal,
      IMAGE_TIMEOUT_MS,
      falHeaders(opts.apiKey),
    );
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        body: res.body,
        requestUrl: url,
        requestBody: translated,
        errorMessage: extractErrorMessage(res.body),
      };
    }
    const payload = asRecord(res.body) ?? {};
    const images = Array.isArray(payload.images) ? payload.images : [];
    const data = images
      .map((entry) => toFalImage(entry, translated.sync_mode === true))
      .filter((entry): entry is Record<string, unknown> => entry !== undefined);
    return {
      ok: true,
      status: 200,
      body: { created: Math.floor(Date.now() / 1000), data },
      requestUrl: url,
      requestBody: translated,
    };
  }

  /** fal videos are long-running, so they go through the queue. */
  private async forwardFalVideo(opts: MediaForwardOptions): Promise<MediaForwardResult> {
    const url = `${falQueueBaseUrl()}/${opts.model}`;
    const translated = translateFalVideoBody(opts.body);
    const res = await this.request(
      'POST',
      url,
      opts.apiKey,
      translated,
      opts.signal,
      VIDEO_CREATE_TIMEOUT_MS,
      falHeaders(opts.apiKey),
    );
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        body: res.body,
        requestUrl: url,
        requestBody: translated,
        errorMessage: extractErrorMessage(res.body),
      };
    }
    const payload = asRecord(res.body) ?? {};
    const taskId = firstString(payload.request_id, payload.requestId);
    if (!taskId) {
      return {
        ok: false,
        status: 502,
        body: res.body,
        requestUrl: url,
        requestBody: translated,
        errorMessage: 'Provider returned no video task id',
      };
    }
    const video = toVideoObject(taskId, opts.model, { status: 'queued' });
    return {
      ok: true,
      status: 200,
      body: video,
      requestUrl: url,
      requestBody: translated,
      taskId,
      videoStatus: 'queued',
      seconds: parseDurationSeconds(translated.duration),
    };
  }

  /**
   * fal's queue status only carries the status; the result (a video URL) lives
   * behind a second request. A status of `COMPLETED` with an `error` is a
   * failed run, not a success.
   */
  private async falVideoStatus(opts: VideoStatusOptions): Promise<MediaForwardResult> {
    const statusUrl = `${falQueueBaseUrl()}/${opts.model}/requests/${opts.taskId}/status`;
    const res = await this.request(
      'GET',
      statusUrl,
      opts.apiKey,
      undefined,
      opts.signal,
      VIDEO_STATUS_TIMEOUT_MS,
      falHeaders(opts.apiKey),
    );
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        body: res.body,
        requestUrl: statusUrl,
        requestBody: {},
        errorMessage: extractErrorMessage(res.body),
      };
    }
    const payload = asRecord(res.body) ?? {};
    const failed = payload.error !== undefined && payload.error !== null;
    const status = mapFalStatus(payload.status, failed);

    let result: Record<string, unknown> | undefined;
    if (status === 'completed') {
      const resultUrl = `${falQueueBaseUrl()}/${opts.model}/requests/${opts.taskId}`;
      const resultRes = await this.request(
        'GET',
        resultUrl,
        opts.apiKey,
        undefined,
        opts.signal,
        VIDEO_STATUS_TIMEOUT_MS,
        falHeaders(opts.apiKey),
      );
      if (resultRes.ok) result = asRecord(resultRes.body);
    }

    const video = toVideoObject(opts.taskId, opts.model, {
      ...(result ?? {}),
      status,
      ...(result ? { url: firstString(asRecord(result.video)?.url, result.url) } : {}),
      ...(failed ? { error: payload.error ?? payload.error_type } : {}),
    });
    return {
      ok: true,
      status: 200,
      body: video,
      requestUrl: statusUrl,
      requestBody: {},
      taskId: opts.taskId,
      videoStatus: video.status,
      seconds: parseDurationSeconds(video.seconds),
    };
  }

  /* ── Generic OpenAI-compatible images ───────────────────────────── */

  private async forwardOpenAiImage(opts: MediaForwardOptions): Promise<MediaForwardResult> {
    const base = OPENAI_IMAGE_BASES[opts.provider.toLowerCase()];
    if (!base) return this.unsupported(opts, 'image');
    // The OpenAI images API takes the model in the body; keep every caller
    // field (`n`, `size`, `quality`, `response_format`, …) as-is.
    const body = { ...opts.body };
    const res = await this.request('POST', base, opts.apiKey, body, opts.signal, IMAGE_TIMEOUT_MS);
    return {
      ok: res.ok,
      status: res.status,
      body: res.body,
      requestUrl: base,
      requestBody: body,
      errorMessage: res.ok ? undefined : extractErrorMessage(res.body),
    };
  }

  /* ── HTTP ───────────────────────────────────────────────────────── */

  private async request(
    method: 'GET' | 'POST',
    url: string,
    apiKey: string,
    body: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    headers?: Record<string, string>,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, body: parseBody(text) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Media request to ${sanitizeUrl(url)} failed: ${message}`);
      return { ok: false, status: 502, body: { error: { message } } };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private unsupported(opts: MediaForwardOptions, kind: string): MediaForwardResult {
    return {
      ok: false,
      status: 400,
      body: {
        error: {
          message: `Provider "${opts.provider}" does not support ${kind} generation through Manifest.`,
        },
      },
      requestUrl: '',
      requestBody: opts.body,
      errorMessage: `Provider "${opts.provider}" does not support ${kind} generation through Manifest.`,
    };
  }

  private unsupportedVideoStatus(opts: VideoStatusOptions): MediaForwardResult {
    return {
      ok: false,
      status: 400,
      body: {
        error: {
          message: `Provider "${opts.provider}" does not support video task status through Manifest.`,
        },
      },
      requestUrl: '',
      requestBody: {},
      errorMessage: `Provider "${opts.provider}" does not support video task status through Manifest.`,
    };
  }
}

const OPENAI_IMAGE_BASES: Readonly<Record<string, string>> = {
  openai: 'https://api.openai.com/v1/images/generations',
};

/* ── Translation helpers ──────────────────────────────────────────── */

/**
 * Agnes wants `response_format` inside `extra_body` (a top-level one is
 * rejected) and reference images as `extra_body.image`.
 */
export function translateAgnesImageBody(body: Record<string, unknown>): Record<string, unknown> {
  const { response_format, image, n: _n, ...rest } = normalizeMediaBody(body);
  const extraBody: Record<string, unknown> = {
    response_format: typeof response_format === 'string' ? response_format : 'url',
  };
  const references = normalizeReferences(image);
  if (references) extraBody.image = references;
  return {
    ...rest,
    size: typeof rest.size === 'string' && rest.size.length > 0 ? rest.size : '1K',
    extra_body: extraBody,
  };
}

/**
 * Agnes video create body. `seconds` is sent as a string because the API
 * expects one, and `aspect_ratio` is the Agnes name for `ratio`.
 */
export function translateAgnesVideoBody(body: Record<string, unknown>): Record<string, unknown> {
  const { ratio, aspect_ratio, seconds, ...rest } = normalizeMediaBody(body);
  const out: Record<string, unknown> = {
    ...rest,
    mode: typeof rest.mode === 'string' ? rest.mode : 'text',
    size: typeof rest.size === 'string' && rest.size.length > 0 ? rest.size : '720P',
    aspect_ratio:
      typeof aspect_ratio === 'string' && aspect_ratio.length > 0
        ? aspect_ratio
        : typeof ratio === 'string' && ratio.length > 0
          ? ratio
          : '16:9',
    seconds: String(positiveInteger(seconds) ?? 5),
  };
  return out;
}

/* ── fal.ai translation ───────────────────────────────────────────── */

/**
 * fal rejects unknown input fields with a 422, so the translated body is built
 * from the fields a fal endpoint actually accepts rather than spread from the
 * caller's body. fal-native names are accepted alongside the OpenAI-shaped
 * `size` / `ratio` / `seconds` aliases so an existing fal client pointed at the
 * gateway keeps working.
 */
const FAL_IMAGE_FIELDS = [
  'prompt',
  'num_inference_steps',
  'seed',
  'guidance_scale',
  'enable_safety_checker',
  'output_format',
  'acceleration',
  'sync_mode',
  'num_images',
  'image_size',
  'image_url',
  'image_urls',
] as const;

const FAL_VIDEO_FIELDS = [
  'prompt',
  'seed',
  'enable_safety_checker',
  'sync_mode',
  'prompt_expansion_mode',
  'target_audio_url',
  'image_url',
  'end_image_url',
] as const;

/** Pixel side length for a Manifest image size tier. */
const FAL_IMAGE_TIER_PX: Readonly<Record<string, number>> = {
  '1K': 1024,
  '2K': 2048,
  '3K': 3072,
  '4K': 4096,
};

/** fal named image sizes, used when the caller sends only an aspect ratio. */
const FAL_NAMED_IMAGE_SIZES: Readonly<Record<string, string>> = {
  '1:1': 'square_hd',
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
  '4:3': 'landscape_4_3',
  '3:4': 'portrait_4_3',
};

/**
 * OpenAI-shaped image request → fal endpoint input. `size` / `ratio` become
 * `image_size`, `n` becomes `num_images`, and `response_format: "b64_json"`
 * becomes `sync_mode` (fal then returns a data URI Manifest turns into
 * `b64_json`).
 */
export function translateFalImageBody(body: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeMediaBody(body);
  const out = pickFalFields(normalized, FAL_IMAGE_FIELDS);

  const count = positiveInteger(normalized.n);
  if (out.num_images === undefined && count !== undefined) out.num_images = count;
  if (out.image_size === undefined) {
    const imageSize = falImageSize(normalized.size, normalized.ratio);
    if (imageSize !== undefined) out.image_size = imageSize;
  }
  if (out.sync_mode === undefined && normalized.response_format === 'b64_json') {
    out.sync_mode = true;
  }

  const references = normalizeReferences(normalized.image ?? normalized.images);
  if (references && out.image_url === undefined && out.image_urls === undefined) {
    if (references.length === 1) out.image_url = references[0];
    else out.image_urls = references;
  }
  return out;
}

/**
 * OpenAI-shaped video request → fal endpoint input. `seconds` → `duration`,
 * `size`/`resolution` → `resolution`, `ratio` → `aspect_ratio`, and the
 * keyframe aliases → `image_url` / `end_image_url`.
 */
export function translateFalVideoBody(body: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeMediaBody(body);
  const out = pickFalFields(normalized, FAL_VIDEO_FIELDS);

  const duration = positiveNumber(normalized.seconds) ?? positiveNumber(normalized.duration);
  if (duration !== undefined) out.duration = duration;

  const resolution =
    normalizeFalResolution(normalized.resolution) ?? normalizeFalResolution(normalized.size);
  if (resolution !== undefined) out.resolution = resolution;

  const aspectRatio = firstString(normalized.aspect_ratio, normalized.ratio);
  if (aspectRatio) out.aspect_ratio = aspectRatio;

  if (out.image_url === undefined) {
    const firstFrame = firstString(
      normalized.first_frame,
      normalizeReferences(normalized.image)?.[0],
      normalizeReferences(normalized.images)?.[0],
    );
    if (firstFrame) out.image_url = firstFrame;
  }
  if (out.end_image_url === undefined) {
    const lastFrame = firstString(normalized.last_frame);
    if (lastFrame) out.end_image_url = lastFrame;
  }
  return out;
}

function pickFalFields(
  body: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (body[field] !== undefined) out[field] = body[field];
  }
  return out;
}

/**
 * Map a Manifest size / ratio onto fal's `image_size` (a named size or a
 * `{ width, height }` object). An explicit `WIDTHxHEIGHT` wins; otherwise a
 * tier and an aspect ratio compose into that tier's larger side.
 */
function falImageSize(size: unknown, ratio: unknown): unknown {
  if (typeof size === 'string') {
    const match = /^(\d+)\s*x\s*(\d+)$/i.exec(size.trim());
    if (match) {
      return { width: Number.parseInt(match[1], 10), height: Number.parseInt(match[2], 10) };
    }
  }

  const tier = typeof size === 'string' ? FAL_IMAGE_TIER_PX[size.trim().toUpperCase()] : undefined;
  const dimensions = typeof ratio === 'string' ? parseAspectRatio(ratio) : undefined;
  if (tier !== undefined && dimensions) {
    const [w, h] = dimensions;
    return w >= h
      ? { width: tier, height: Math.round((tier * h) / w) }
      : { width: Math.round((tier * w) / h), height: tier };
  }
  if (tier !== undefined) return { width: tier, height: tier };
  if (typeof ratio === 'string') {
    const named = FAL_NAMED_IMAGE_SIZES[ratio.trim()];
    if (named) return named;
  }
  return undefined;
}

function parseAspectRatio(value: string): [number, number] | undefined {
  const match = /^(\d+)\s*:\s*(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const w = Number.parseInt(match[1], 10);
  const h = Number.parseInt(match[2], 10);
  return w > 0 && h > 0 ? [w, h] : undefined;
}

/** fal's `resolution` enum is `480P` / `768P` / `1080P`. */
function normalizeFalResolution(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toUpperCase();
  const match = /^(\d+)P?$/.exec(normalized);
  if (!match) return undefined;
  const candidate = `${match[1]}P`;
  return ['480P', '768P', '1080P'].includes(candidate) ? candidate : undefined;
}

/** fal image entry → OpenAI-shaped generated image (`url` or `b64_json`). */
function toFalImage(entry: unknown, syncMode: boolean): Record<string, unknown> | undefined {
  const record = asRecord(entry);
  if (!record) return undefined;
  const url = firstString(record.url);
  if (!url) return undefined;
  if (syncMode && url.startsWith('data:')) {
    const comma = url.indexOf(',');
    if (comma !== -1) return { b64_json: url.slice(comma + 1) };
  }
  return { url };
}

/** fal queue vocabulary → canonical `VideoStatus`. */
function mapFalStatus(raw: unknown, failed: boolean): VideoStatus {
  const value = typeof raw === 'string' ? raw.toUpperCase() : '';
  if (value === 'COMPLETED') return failed ? 'failed' : 'completed';
  if (value === 'IN_PROGRESS') return 'processing';
  if (value === 'IN_QUEUE') return 'queued';
  return 'queued';
}

/** Map a provider task payload onto the OpenAI-shaped video object. */
export function toVideoObject(
  taskId: string,
  model: string,
  payload: Record<string, unknown>,
): Record<string, unknown> & { status: VideoStatus; seconds?: number } {
  const status = mapVideoStatus(payload.status);
  const seconds = parseDurationSeconds(payload.seconds);
  const progress = typeof payload.progress === 'number' ? payload.progress : undefined;
  const size = typeof payload.size === 'string' ? payload.size : undefined;
  const url = firstString(payload.url, payload.video_url);
  const created =
    typeof payload.created_at === 'number'
      ? payload.created_at
      : typeof payload.created === 'number'
        ? payload.created
        : Math.floor(Date.now() / 1000);
  const error = normalizeVideoError(payload.error);
  return {
    id: taskId,
    object: 'video',
    model,
    status,
    created_at: created,
    ...(progress !== undefined ? { progress } : {}),
    ...(seconds !== undefined ? { seconds } : {}),
    ...(size ? { size } : {}),
    ...(url ? { url } : {}),
    error,
  };
}

function mapVideoStatus(raw: unknown): VideoStatus {
  const value = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (value === 'completed' || value === 'succeeded' || value === 'success') return 'completed';
  if (value === 'failed' || value === 'error') return 'failed';
  if (value === 'in_progress' || value === 'processing' || value === 'running') return 'processing';
  return 'queued';
}

function normalizeVideoError(raw: unknown): { message: string } | null {
  if (raw === null || raw === undefined || raw === false) return null;
  if (typeof raw === 'string') return raw.length > 0 ? { message: raw } : null;
  const record = asRecord(raw);
  const message = record ? firstString(record.message, record.error) : undefined;
  return message ? { message } : null;
}

function normalizeReferences(value: unknown): string[] | undefined {
  if (typeof value === 'string' && value.length > 0) return [value];
  if (Array.isArray(value)) {
    const refs = value.filter(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0,
    );
    return refs.length > 0 ? refs : undefined;
  }
  return undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractErrorMessage(body: unknown): string {
  const record = asRecord(body);
  const error = record ? asRecord(record.error) : undefined;
  const message = error ? firstString(error.message) : undefined;
  if (message) return message;
  // fal reports failures as `{ detail, error_type }`.
  const detail = record ? firstString(record.detail) : undefined;
  if (detail) return detail;
  const direct = record ? firstString(record.message) : undefined;
  if (direct) return direct;
  if (typeof body === 'string' && body.length > 0) return body;
  return 'Media provider request failed';
}

function sanitizeUrl(url: string): string {
  return url.replace(/key=[^&]+/i, 'key=***');
}
