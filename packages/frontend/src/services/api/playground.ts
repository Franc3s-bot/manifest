import type {
  AuthType,
  PlaygroundHistoryRunDetail,
  PlaygroundHistoryRunSummary,
  PlaygroundMediaOutput,
  PlaygroundOutputKind,
  PlaygroundResolvedRoute,
  PlaygroundRunResult,
  PlaygroundStreamEvent,
  PlaygroundVideoOutput,
} from 'manifest-shared';
import { BASE_URL, fetchJson, parseErrorMessage } from './core.js';
import type { AvailableModel } from './routing.js';

export type {
  PlaygroundHistoryColumn,
  PlaygroundHistoryRunDetail,
  PlaygroundHistoryRunSummary,
  PlaygroundMediaOutput,
  PlaygroundMetrics,
  PlaygroundOutputKind,
  PlaygroundResolvedRoute,
  PlaygroundRunResult,
  PlaygroundVideoOutput,
} from 'manifest-shared';

/** Resolved value of a completed stream (the terminal `done` event). */
export interface PlaygroundStreamResult {
  columnId: string | null;
  content: string;
  metrics: PlaygroundRunResult['metrics'];
  headers: Record<string, string>;
  kind: PlaygroundOutputKind;
  media: PlaygroundMediaOutput | null;
  route: PlaygroundResolvedRoute | null;
}

/** One OpenAI-style content part of a multimodal user message. */
export type PlaygroundContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface RunPlaygroundRequest {
  agentName: string;
  model: string;
  provider: string;
  authType?: AuthType;
  providerKeyLabel?: string;
  /** Standard chat-completions shape. Text runs always set this. */
  messages?: { role: 'system' | 'user' | 'assistant'; content: string | PlaygroundContentPart[] }[];
  /** Media-generation prompt (image / video). */
  prompt?: string;
  /** Output modality. Optional — the backend infers it from the model. */
  outputKind?: PlaygroundOutputKind;
  /** Image generation options. */
  n?: number;
  size?: string;
  ratio?: string;
  responseFormat?: 'url' | 'b64_json';
  /** Reference images for image-to-image / composition (URL or data URI). */
  referenceImages?: string[];
  /** Video generation options. */
  seconds?: number;
  mode?: 'text' | 'keyframe' | 'reference';
  firstFrame?: string;
  lastFrame?: string;
  /**
   * Verbatim recorded request body, replayed as-is. Reserved for the future
   * "replay a recorded query" flow; today the page never sets this.
   */
  rawRequestBody?: Record<string, unknown>;
  runId?: string;
  position?: number;
  requestHeaders?: Record<string, string>;
}

/**
 * Runs one model and streams its response. `onDelta` fires with each text
 * fragment as it arrives; `onProgress` fires for an in-flight video task; the
 * promise resolves with the final result once the server emits the terminal
 * `done` event.
 *
 * Failures before the stream opens come back as a normal JSON HTTP error
 * (thrown here); failures mid-stream arrive as an `error` event (also thrown).
 */
export async function streamPlayground(
  req: RunPlaygroundRequest,
  init: {
    signal?: AbortSignal;
    onDelta: (text: string) => void;
    onProgress?: (media: PlaygroundVideoOutput) => void;
  },
): Promise<PlaygroundStreamResult> {
  const res = await fetch(`${BASE_URL}/playground/run`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal: init.signal,
  });

  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok || !contentType.includes('text/event-stream') || !res.body) {
    throw new Error(await parseErrorMessage(res));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: PlaygroundStreamResult | null = null;
  let streamError: string | null = null;

  const handleEvent = (block: string): void => {
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return;
    let payload: PlaygroundStreamEvent;
    try {
      payload = JSON.parse(data) as PlaygroundStreamEvent;
    } catch {
      return;
    }
    if (payload.type === 'delta') {
      init.onDelta(payload.text);
    } else if (payload.type === 'progress') {
      init.onProgress?.(payload.media);
    } else if (payload.type === 'done') {
      result = {
        columnId: payload.columnId,
        content: payload.content,
        metrics: payload.metrics,
        headers: payload.headers,
        kind: payload.kind ?? 'text',
        media: payload.media ?? null,
        route: payload.route ?? null,
      };
    } else {
      streamError = payload.message;
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        handleEvent(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
    }
    if (done) break;
  }
  if (buffer.trim()) handleEvent(buffer);

  if (streamError !== null) throw new Error(streamError);
  if (result === null) throw new Error('Stream ended without a result');
  return result;
}

/** Poll an asynchronous video-generation task. */
export function getPlaygroundVideoStatus(
  taskId: string,
  columnId?: string,
): Promise<{ status: number; media: PlaygroundVideoOutput; costUsd: number | null }> {
  const query = columnId ? `?columnId=${encodeURIComponent(columnId)}` : '';
  return fetchJson(`/playground/videos/${encodeURIComponent(taskId)}${query}`);
}

/** Models the Playground can run, including synthetic `auto-*` entries. */
export function getPlaygroundModels(): Promise<AvailableModel[]> {
  return fetchJson<AvailableModel[]>('/playground/models');
}

export async function setPlaygroundRunBest(
  runId: string,
  columnId: string | null,
): Promise<string | null> {
  const res = await fetch(`/api/v1/playground/runs/${encodeURIComponent(runId)}/best`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnId }),
  });
  if (!res.ok) throw new Error('Failed to set best answer');
  const data = (await res.json()) as { bestColumnId: string | null };
  return data.bestColumnId;
}

export function getPlaygroundAgent(): Promise<{ name: string }> {
  return fetchJson<{ name: string }>('/playground/agent');
}

export function listPlaygroundRuns(): Promise<PlaygroundHistoryRunSummary[]> {
  return fetchJson<PlaygroundHistoryRunSummary[]>('/playground/runs');
}

export function getPlaygroundRun(runId: string): Promise<PlaygroundHistoryRunDetail> {
  return fetchJson<PlaygroundHistoryRunDetail>(`/playground/runs/${encodeURIComponent(runId)}`);
}

export async function togglePlaygroundRunStar(runId: string): Promise<boolean> {
  const res = await fetch(`/api/v1/playground/runs/${encodeURIComponent(runId)}/star`, {
    method: 'PATCH',
    credentials: 'include',
  });
  if (!res.ok) throw new Error('Failed to toggle star');
  const data = (await res.json()) as { starred: boolean };
  return data.starred;
}

export async function renamePlaygroundRun(runId: string, prompt: string): Promise<string> {
  const res = await fetch(`/api/v1/playground/runs/${encodeURIComponent(runId)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) throw new Error('Failed to rename run');
  const data = (await res.json()) as { prompt: string };
  return data.prompt;
}

export async function deletePlaygroundRun(runId: string): Promise<void> {
  const res = await fetch(`/api/v1/playground/runs/${encodeURIComponent(runId)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) throw new Error('Failed to delete run');
}

export async function deletePlaygroundColumn(runId: string, columnId: string): Promise<void> {
  const res = await fetch(
    `/api/v1/playground/runs/${encodeURIComponent(runId)}/columns/${encodeURIComponent(columnId)}`,
    { method: 'DELETE', credentials: 'include' },
  );
  if (!res.ok) throw new Error('Failed to delete column');
}
