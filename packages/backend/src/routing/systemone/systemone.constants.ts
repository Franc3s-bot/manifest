/**
 * Classifier ("System One") support.
 *
 * Manifest is a chat gateway: `/v1/chat/completions` routes 1000+ chat models.
 * Classifiers are a different protocol — a typed question over a JSON state
 * that returns a probability or an ordinal level. OpenCode Zen serves the
 * System One protocol at `/v1/systemone`; Manifest proxies that route with the
 * OpenCode Zen credential it already holds for chat, so a client needs no
 * additional credential.
 *
 * The wire shape is a pass-through: `{ model, state, questions }` in,
 * `{ model, answers, usage }` out. `usage.input_tokens` / `usage.output_tokens`
 * are what a client prices from.
 */

/** Upstream OpenCode Zen System One endpoint. */
export const OPENCODE_ZEN_SYSTEMONE_URL =
  process.env['OPENCODE_ZEN_SYSTEMONE_URL'] || 'https://opencode.ai/zen/v1/systemone';

/** Provider whose credential authenticates the upstream classifier call. */
export const CLASSIFIER_PROVIDER = 'opencode-zen';

/** Path Manifest mounts the classifier proxy on (public, leading slash). */
export const SYSTEMONE_PATH = '/zen/v1/systemone';

/** Alias path, for clients that treat every Manifest surface as `/v1`. */
export const SYSTEMONE_PATH_ALIAS = '/v1/systemone';

/** Nest route paths — the same paths without the leading slash. */
export const SYSTEMONE_ROUTE = 'zen/v1/systemone';
export const SYSTEMONE_ROUTE_ALIAS = 'v1/systemone';

/**
 * How long Manifest waits for the upstream classifier. System One runs a
 * forward pass over the state, so a large context can take noticeably longer
 * than a chat token; the cap is generous but finite.
 */
export const SYSTEMONE_TIMEOUT_MS = 120_000;

export interface ClassifierModel {
  /** Upstream model id — what OpenCode Zen expects in the `model` field. */
  id: string;
  /** Public `/v1/models` id, provider-qualified like every other Manifest model. */
  publicId: string;
  displayName: string;
  /** USD per million input tokens, or 0 for a free model. */
  inputPricePerMillion: number;
  contextWindow: number;
}

/**
 * Classifier models Manifest exposes on the System One route. Kept as a static
 * list because classifiers are not chat models: they have no chat completions
 * surface, no streaming, and are deliberately absent from the chat catalog
 * built by model discovery.
 */
export const CLASSIFIER_MODELS: readonly ClassifierModel[] = [
  {
    id: 'jev-1.13-free',
    publicId: 'opencode-zen/jev-1.13-free',
    displayName: 'Jev 1.13 Free',
    inputPricePerMillion: 0,
    contextWindow: 32_000,
  },
  {
    id: 'jev-1.13',
    publicId: 'opencode-zen/jev-1.13',
    displayName: 'Jev 1.13',
    inputPricePerMillion: 0.042,
    contextWindow: 32_000,
  },
];

const CLASSIFIER_MODEL_IDS = new Set(CLASSIFIER_MODELS.map((model) => model.id));

/**
 * Prefixes a client may use when naming a classifier. Pi's `opencode` provider
 * sends the bare upstream id (`jev-1.13-free`); a client that reads Manifest's
 * `/v1/models` sends the provider-qualified id (`opencode-zen/jev-1.13-free`).
 * Both resolve to the same upstream model.
 */
const CLASSIFIER_PREFIXES = ['opencode-zen/', 'opencode/', 'zen/'] as const;

/**
 * Resolve a client-supplied model name to the upstream OpenCode Zen id, or
 * `null` when it names no classifier Manifest serves. Only the known classifier
 * ids are accepted, so the route cannot be used to reach arbitrary upstream
 * models through a classifier credential.
 */
export function normalizeClassifierModelId(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  let id = raw.trim();
  if (id.length === 0) return null;
  for (const prefix of CLASSIFIER_PREFIXES) {
    if (id.startsWith(prefix)) {
      id = id.slice(prefix.length);
      break;
    }
  }
  return CLASSIFIER_MODEL_IDS.has(id) ? id : null;
}
