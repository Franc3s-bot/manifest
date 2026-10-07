import { Injectable, Logger } from '@nestjs/common';
import { AGNES_BASE_URL, type VideoStatus } from 'manifest-shared';
import { parseDurationSeconds } from './media-pricing';

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
    if (opts.apiMode === 'images') return this.forwardOpenAiImage(opts);
    return this.unsupported(opts, 'video');
  }

  /** Poll an asynchronous video task. */
  async videoStatus(opts: VideoStatusOptions): Promise<MediaForwardResult> {
    const provider = opts.provider.toLowerCase();
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

  /* ── Generic OpenAI-compatible images ───────────────────────────── */

  private async forwardOpenAiImage(opts: MediaForwardOptions): Promise<MediaForwardResult> {
    const base = OPENAI_IMAGE_BASES[opts.provider.toLowerCase()];
    if (!base) return this.unsupported(opts, 'image');
    const body = { ...opts.body };
    delete body.model;
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
  const { response_format, image, n: _n, ...rest } = body;
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
  const { ratio, aspect_ratio, seconds, ...rest } = body;
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
  const direct = record ? firstString(record.message) : undefined;
  if (direct) return direct;
  if (typeof body === 'string' && body.length > 0) return body;
  return 'Media provider request failed';
}

function sanitizeUrl(url: string): string {
  return url.replace(/key=[^&]+/i, 'key=***');
}
