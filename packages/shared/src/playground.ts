import type { AuthType } from './auth-types';
import type { GeneratedImage, VideoStatus } from './media';

/**
 * What a Playground column produces. `text` is the chat-completions path;
 * `image` and `video` route through the media surface (`/v1/images/generations`
 * and `/v1/videos`).
 */
export const PLAYGROUND_OUTPUT_KINDS = ['text', 'image', 'video'] as const;
export type PlaygroundOutputKind = (typeof PLAYGROUND_OUTPUT_KINDS)[number];

export function isPlaygroundOutputKind(value: unknown): value is PlaygroundOutputKind {
  return (
    typeof value === 'string' && (PLAYGROUND_OUTPUT_KINDS as readonly string[]).includes(value)
  );
}

export interface PlaygroundMetrics {
  cost: number | null;
  inputTokens: number;
  outputTokens: number;
  /** Total wall time from request start to the last streamed token. */
  durationMs: number;
  /** Time to first token (ms). Null when the provider streamed no usable delta. */
  ttftMs?: number | null;
  /** Output tokens per second over the generation window. Null when underivable. */
  tokensPerSec?: number | null;
  /** Number of images returned by an image-generation run. */
  imageCount?: number | null;
  /** Output duration in seconds of a video-generation run. */
  videoSeconds?: number | null;
}

/**
 * The concrete provider route that actually served a run. A synthetic
 * `auto-{tier}` request resolves to a real model at request time; this is the
 * only place the client learns which one handled it.
 */
export interface PlaygroundResolvedRoute {
  provider: string;
  model: string;
  /** Header-tier name when the run came from a synthetic `auto-*` model. */
  tier?: string | null;
  /** Tier badge color, when the tier advertises one. */
  tierColor?: string | null;
  /** True when the requested model was a synthetic `auto-*` model. */
  synthetic: boolean;
  /** The model id the client requested (may differ from `model`). */
  requestedModel: string;
  /**
   * The harness (agent) whose header tier the synthetic model resolved to.
   * A reserved Playground agent owns no tiers, so synthetic runs resolve
   * against the harness that defines the tier.
   */
  harness?: string | null;
}

/** Synchronous image-generation output (OpenAI `images/generations` shape). */
export interface PlaygroundImageOutput {
  kind: 'image';
  images: GeneratedImage[];
  /** Echoes the requested `response_format` (`url` | `b64_json`). */
  responseFormat?: string | null;
}

/** Asynchronous video-generation output; polled until it reaches a terminal status. */
export interface PlaygroundVideoOutput {
  kind: 'video';
  taskId: string;
  status: VideoStatus;
  url?: string;
  seconds?: number | null;
  size?: string | null;
  progress?: number | null;
  error?: string | null;
}

export type PlaygroundMediaOutput = PlaygroundImageOutput | PlaygroundVideoOutput;

export interface PlaygroundRunResult {
  content: string;
  metrics: PlaygroundMetrics;
  headers: Record<string, string>;
  /** Output modality of the run. Defaults to `text` for older clients. */
  kind?: PlaygroundOutputKind;
  /** Generated media for an image/video run. */
  media?: PlaygroundMediaOutput | null;
  /** Concrete route that served the run. */
  route?: PlaygroundResolvedRoute | null;
}

/**
 * Wire contract for the streamed `POST /api/v1/playground/run` SSE response.
 * `delta` repeats with incremental text; `progress` repeats for an in-flight
 * video task; exactly one terminal `done` or `error` ends the stream.
 * `columnId` is the persisted playground_columns row so the client can mark it
 * the best answer without a history round-trip.
 */
export type PlaygroundStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'progress'; media: PlaygroundVideoOutput }
  | {
      type: 'done';
      columnId: string | null;
      content: string;
      metrics: PlaygroundMetrics;
      headers: Record<string, string>;
      kind?: PlaygroundOutputKind;
      media?: PlaygroundMediaOutput | null;
      route?: PlaygroundResolvedRoute | null;
    }
  | { type: 'error'; message: string };

export interface PlaygroundHistoryColumn {
  id: string;
  model: string;
  provider: string;
  authType: AuthType | null;
  providerKeyLabel?: string | null;
  displayName: string | null;
  status: 'success' | 'error';
  content: string | null;
  headers: Record<string, string> | null;
  errorMessage: string | null;
  metrics: PlaygroundMetrics | null;
  position: number;
  /** Output modality of the column. Absent on rows written before this field. */
  kind?: PlaygroundOutputKind;
  /** Generated media for an image/video column. */
  media?: PlaygroundMediaOutput | null;
  /** Concrete route that served the column. */
  route?: PlaygroundResolvedRoute | null;
}

export interface PlaygroundHistoryRunSummary {
  id: string;
  prompt: string;
  createdAt: string;
  modelCount: number;
  models: string[];
  starred: boolean;
  /** playground_columns.id the user marked as the best answer, or null. */
  bestColumnId: string | null;
}

export interface PlaygroundHistoryRunDetail extends PlaygroundHistoryRunSummary {
  columns: PlaygroundHistoryColumn[];
}
