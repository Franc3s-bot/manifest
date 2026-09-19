/**
 * Live metadata for custom providers (llama.cpp, LM Studio, vLLM, LiteLLM, …).
 *
 * A custom provider's model list is stored on the provider row and edited by
 * hand, so it cannot carry facts that change per server launch: llama.cpp's
 * context window is whatever `-c/--ctx-size` was passed, and tool support
 * depends on the chat template. Those facts are only knowable by asking the
 * server that is running right now.
 *
 * Two reads, both optional, merged per model:
 *   - `GET {base}/models`: per-model `context_length` (llama.cpp, vLLM,
 *     LiteLLM), `max_context_length` / `loaded_context_length` (LM Studio),
 *     `meta.n_ctx` (llama.cpp), `architecture.input_modalities` (vLLM).
 *   - `GET {base}/props`: llama.cpp runtime facts — `default_generation_settings.n_ctx`,
 *     `chat_template_caps.supports_tools`, `modalities`.
 *
 * Best-effort: a provider that is down, slow, or not llama.cpp contributes
 * nothing rather than a guess; callers keep their stored values as fallback.
 */

import type { ModelCapability, ModelModality } from 'manifest-shared';
import type { CustomProviderApiKind } from '../entities/custom-provider.entity';

/** Wall-clock budget for the whole probe (both calls run in parallel). */
export const LIVE_PROBE_TIMEOUT_MS = 2000;

/**
 * Custom providers always have this one: every OpenAI-compatible server speaks
 * SSE, and Manifest streams to the caller regardless. Mirrors
 * `modelSupportsStreaming()` in model-capabilities.ts.
 */
const STREAM_CAPABILITY: ModelCapability = 'stream';

/** Facts read live for one model; absent fields mean "unknown", never "unsupported". */
export interface LiveModelFacts {
  contextWindow?: number;
  capabilities?: readonly ModelCapability[];
  inputModalities?: readonly ModelModality[];
  outputModalities?: readonly ModelModality[];
}

/** Live facts for one custom provider, keyed so stored model names can be matched. */
export interface LiveProviderFacts {
  /**
   * Keyed by lowercased server-side id and by every alias, so a model saved as
   * `Bonsai 27b` still matches `bonsai` / `ternary-bonsai`.
   */
  byName: ReadonlyMap<string, LiveModelFacts>;
  /**
   * Set when the provider publishes at most one chat model. Single-model local
   * servers name the loaded model themselves, so a stored name matching neither
   * the id nor an alias still refers to this one. See {@link applyLiveFacts}.
   */
  single?: LiveModelFacts;
}

/** One provider to probe: everything needed to build the two requests. */
export interface LiveProbeTarget {
  /** Internal provider key, `custom:<uuid>`. */
  providerKey: string;
  baseUrl: string;
  apiKind: CustomProviderApiKind;
  apiKey?: string | null;
}

const MODALITY_BY_NAME: ReadonlyMap<string, ModelModality> = new Map<string, ModelModality>([
  ['text', 'text'],
  ['image', 'image'],
  ['audio', 'audio'],
  ['video', 'video'],
]);

function readPositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function normalizeModalities(value: unknown): readonly ModelModality[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ModelModality[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const modality = MODALITY_BY_NAME.get(raw.toLowerCase());
    if (modality && !out.includes(modality)) out.push(modality);
  }
  return out.length > 0 ? out : undefined;
}

/** Trailing slashes trimmed without a regex (avoids polynomial backtracking). */
export function trimBaseUrl(baseUrl: string): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return baseUrl.slice(0, end);
}

interface OpenAiModelEntry {
  id?: unknown;
  aliases?: unknown;
  context_length?: unknown;
  max_context_length?: unknown;
  loaded_context_length?: unknown;
  meta?: { n_ctx?: unknown } | null;
  architecture?: { input_modalities?: unknown } | null;
  capabilities?: unknown;
}

interface ParsedModelEntry {
  id: string;
  aliases: readonly string[];
  facts: LiveModelFacts;
}

/**
 * Context window as reported by the catalog. The loaded window wins over the
 * trained maximum: llama.cpp reports both (`context_length` vs
 * `max_context_length`), and only the former is what this session can hold.
 */
function contextWindowFromEntry(entry: OpenAiModelEntry): number | undefined {
  return (
    readPositiveInt(entry.context_length) ??
    readPositiveInt(entry.loaded_context_length) ??
    readPositiveInt(entry.meta?.n_ctx) ??
    readPositiveInt(entry.max_context_length)
  );
}

/** Per-model tool hint, when a server advertises capabilities in the catalog. */
function capabilitiesFromEntry(entry: OpenAiModelEntry): readonly ModelCapability[] {
  const out: ModelCapability[] = [STREAM_CAPABILITY];
  if (Array.isArray(entry.capabilities)) {
    for (const raw of entry.capabilities) {
      if (typeof raw !== 'string') continue;
      const value = raw.toLowerCase();
      if (
        (value === 'tools' || value === 'tool_calls' || value === 'function_calling') &&
        !out.includes('tools')
      ) {
        out.push('tools');
      }
    }
  }
  return out;
}

function parseModelEntries(body: unknown): ParsedModelEntry[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: ParsedModelEntry[] = [];
  for (const raw of data) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as OpenAiModelEntry;
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue;
    const contextWindow = contextWindowFromEntry(entry);
    const inputModalities = normalizeModalities(entry.architecture?.input_modalities);
    out.push({
      id: entry.id,
      aliases: Array.isArray(entry.aliases)
        ? entry.aliases.filter(
            (alias): alias is string => typeof alias === 'string' && alias.length > 0,
          )
        : [],
      facts: {
        capabilities: capabilitiesFromEntry(entry),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(inputModalities ? { inputModalities } : {}),
      },
    });
  }
  return out;
}

/** llama.cpp runtime facts from `GET {base}/props`. */
export interface LlamaCppPropsFacts {
  modelAlias?: string;
  contextWindow?: number;
  supportsTools?: boolean;
  inputModalities?: readonly ModelModality[];
}

export function parseLlamaCppProps(body: unknown): LlamaCppPropsFacts | null {
  if (typeof body !== 'object' || body === null) return null;
  const props = body as {
    model_alias?: unknown;
    default_generation_settings?: { n_ctx?: unknown } | null;
    chat_template_caps?: { supports_tools?: unknown } | null;
    modalities?: { vision?: unknown; audio?: unknown; video?: unknown } | null;
  };
  // `default_generation_settings` is llama.cpp-only; its absence means this is
  // some other server that happens to answer /props, so read nothing from it.
  if (
    typeof props.default_generation_settings !== 'object' ||
    props.default_generation_settings === null
  ) {
    return null;
  }
  const contextWindow = readPositiveInt(props.default_generation_settings.n_ctx);
  const supportsTools = props.chat_template_caps?.supports_tools === true;
  const modalities: ModelModality[] = ['text'];
  if (props.modalities?.vision === true) modalities.push('image');
  if (props.modalities?.audio === true) modalities.push('audio');
  if (props.modalities?.video === true) modalities.push('video');
  return {
    ...(typeof props.model_alias === 'string' && props.model_alias.length > 0
      ? { modelAlias: props.model_alias }
      : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(props.chat_template_caps ? { supportsTools } : {}),
    inputModalities: modalities,
  };
}

/** Union of two capability lists, first-seen order. */
function mergeCapabilities(
  base: readonly ModelCapability[] | undefined,
  extra: readonly ModelCapability[] | undefined,
): readonly ModelCapability[] | undefined {
  if (!base?.length) return extra;
  if (!extra?.length) return base;
  const out = [...base];
  for (const capability of extra) if (!out.includes(capability)) out.push(capability);
  return out;
}

/**
 * Overlay llama.cpp's runtime facts onto a catalog entry. `/props` is the
 * fallback for the window (the catalog is per-model, props is per-process) and
 * the only source for tool support. `usePropsContextWindow` is false when the
 * provider serves several models and props describes a different one — tool
 * support is a property of the process, the window is not.
 */
function mergePropsFacts(
  facts: LiveModelFacts,
  props: LlamaCppPropsFacts,
  usePropsContextWindow: boolean,
): LiveModelFacts {
  return {
    contextWindow: facts.contextWindow ?? (usePropsContextWindow ? props.contextWindow : undefined),
    capabilities: mergeCapabilities(
      facts.capabilities,
      props.supportsTools ? ['tools'] : undefined,
    ),
    inputModalities: props.inputModalities ?? facts.inputModalities,
    outputModalities: facts.outputModalities,
  };
}

function factsFromProps(props: LlamaCppPropsFacts): LiveModelFacts {
  return {
    ...(props.contextWindow !== undefined ? { contextWindow: props.contextWindow } : {}),
    capabilities: mergeCapabilities(
      [STREAM_CAPABILITY],
      props.supportsTools ? ['tools'] : undefined,
    ),
    ...(props.inputModalities ? { inputModalities: props.inputModalities } : {}),
  };
}

/**
 * Assemble provider facts from the two probe payloads. Returns null when neither
 * answered with anything usable, so callers can cache the negative result.
 */
export function buildLiveProviderFacts(
  catalogBody: unknown | null,
  propsBody: unknown | null,
): LiveProviderFacts | null {
  const entries = catalogBody === null ? [] : parseModelEntries(catalogBody);
  const props = propsBody === null ? null : parseLlamaCppProps(propsBody);
  if (entries.length === 0 && !props) return null;

  const byName = new Map<string, LiveModelFacts>();
  const propsAlias = props?.modelAlias?.toLowerCase();
  const merged: ParsedModelEntry[] = entries.map((entry) => {
    // With several catalog entries, only the model named by `/props` may take
    // its process-level context window; tool support applies to the server.
    const ownsPropsContext =
      entries.length <= 1 ||
      propsAlias === undefined ||
      entry.id.toLowerCase() === propsAlias ||
      entry.aliases.some((alias) => alias.toLowerCase() === propsAlias);
    return {
      ...entry,
      facts: props ? mergePropsFacts(entry.facts, props, ownsPropsContext) : entry.facts,
    };
  });

  for (const entry of merged) {
    byName.set(entry.id.toLowerCase(), entry.facts);
    for (const alias of entry.aliases) byName.set(alias.toLowerCase(), entry.facts);
  }

  const single =
    merged.length === 1
      ? merged[0].facts
      : merged.length === 0 && props
        ? factsFromProps(props)
        : undefined;
  return { byName, ...(single ? { single } : {}) };
}

async function readJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers, signal, redirect: 'error' });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

function buildHeaders(target: LiveProbeTarget): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (target.apiKind === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (target.apiKey) headers['x-api-key'] = target.apiKey;
  } else if (target.apiKey) {
    headers['Authorization'] = `Bearer ${target.apiKey}`;
  }
  return headers;
}

/**
 * Probe one custom provider. `baseUrl` is operator-supplied and was validated
 * when the provider was saved (`validatePublicUrl` in custom-provider.service),
 * the same trust level the proxy applies when it forwards requests there; the
 * probe adds `redirect: 'error'` and a hard timeout on top.
 */
export async function fetchLiveProviderFacts(
  target: LiveProbeTarget,
): Promise<LiveProviderFacts | null> {
  const base = trimBaseUrl(target.baseUrl);
  if (!base) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVE_PROBE_TIMEOUT_MS);
  try {
    const headers = buildHeaders(target);
    const catalogPath = target.apiKind === 'anthropic' ? '/v1/models' : '/models';
    const [catalogBody, propsBody] = await Promise.all([
      readJson(`${base}${catalogPath}`, headers, controller.signal),
      readJson(`${base}/props`, headers, controller.signal),
    ]);
    return buildLiveProviderFacts(catalogBody, propsBody);
  } finally {
    clearTimeout(timer);
  }
}
