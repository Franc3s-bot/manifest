# Media Generation Routing (Images & Video)

Manifest routes **text** today: `POST /v1/chat/completions`, `/v1/responses`,
`/v1/messages` reach a provider chain resolved from a tier. Image and video
generation models (Agnes Image 2.1 Flash, Agnes Video 2.5, and later DALL·E,
Imagen, Veo, Sora, …) are excluded from discovery and have no proxy surface.

This document defines how media generation joins the same routing model:
synthetic tiers, fallback chains, per-tenant provider keys, recorded Manifest
Requests / Provider Attempts, and cost accounting.

> **Terminology** follows [`docs/glossary.md`](glossary.md): a **Manifest
> Request** is one logical request from an agent to Manifest (`requests`); a
> **Provider Attempt** is one request from Manifest to an AI provider
> (`agent_messages`).

## Decisions

These are the defaults this design is built on. Each is a user decision; change
one and the phases below shift.

| # | Decision | Choice |
|---|----------|--------|
| 1 | Integration | A media adapter abstraction in the backend, with **Agnes as the first provider**. Provider-specific quirks live in the adapter; the routing/credential/recording layers are shared. |
| 2 | Public API | **OpenAI-compatible**: `POST /v1/images/generations`, `POST /v1/videos`, `GET /v1/videos/{id}`. Clients keep using OpenAI-style SDKs; Agnes-specific fields (`ratio`, `size` tiers, `extra_body.image`) are accepted as extensions. |
| 3 | Synthetic tiers | **Reuse header tiers.** `header_tiers.output_modality` becomes `text \| image \| video`; a tier with a media modality is exposed as `auto-{name}` in `GET /v1/models` with matching `output_modalities`, and routes to the media endpoint. |
| 4 | Cost | **Per-image / per-second USD.** Media pricing is stored as a price table and written to `agent_messages.cost_usd`; token columns stay `0`. No fake token-equivalents. |

## What already exists

- `output_modality` columns on `header_tiers`, `tier_assignments`,
  `specificity_assignments` (migration `1789300000000-AddRoutingOutputControls`),
  defaulting to `text`. The column is wired through resolution and the
  `X-Manifest-Output-Modality` response header, but `OUTPUT_MODALITIES` only
  contained `text` — **extended to `text | image | video`** as the first step.
- Header tiers exposed as `auto-{name}` models in `GET /v1/models`
  (`proxy.controller.ts`), with an aggregated profile
  (`synthetic-model-profile.ts`) and resolution (`resolve.service.ts`).
- `resolveRouteCredentials()` (`route-credentials.ts`) — provider key selection,
  OAuth unwrap, `tenant_provider_id` / label attribution. Reusable as-is.
- `ProxyMessageRecorder` — Manifest Request + Provider Attempt rows, fallback
  failures, cooldown. Reusable with a media `api_mode`.
- `SPECIFICITY_CATEGORIES` already has `image_generation` / `video_generation`.
- The standalone Agnes client (`/root/.pi/agent/extensions/agnes-media/client.ts`)
  documents the verified API:
  - `POST {base}/images/generations` — synchronous, returns `data[].url | b64_json`.
  - `POST {base}/videos` — asynchronous, returns `video_id`.
  - `GET {origin}/agnesapi?video_id=&model_name=` — task status (host root, not `/v1`).
  - Base `https://apihub.agnes-ai.com/v1`; video billed per second of output.

## Agnes AI is a full provider, not media-only

The public [Agnes AI Model Catalog](https://github.com/AgnesAI-Labs/AgnesAI-Models)
lists an OpenAI-compatible surface at `https://apihub.agnes-ai.com/v1`:

| Kind | Models | Endpoint |
|------|--------|----------|
| Text | `agnes-2.5-flash` (512K ctx), `agnes-2.0-flash` (256K), `agnes-1.5-flash` (256K) | `POST /v1/chat/completions` |
| Image | `agnes-image-2.1-flash`, `agnes-image-2.0-flash` | `POST /v1/images/generations` |
| Video | `agnes-video-v2.0` | `POST /v1/videos` (async) |

Video task status: `GET https://apihub.agnes-ai.com/agnesapi?video_id=<ID>`.
Auth: `Authorization: Bearer <key>`.

So Agnes is added as a **normal OpenAI-compatible provider** (text routes through
the existing chat proxy) plus a **media-capable** one (image/video route through
the media adapter). This is why the shared provider entry carries a `media`
descriptor rather than the whole provider being special-cased.

## Architecture

```
POST /v1/images/generations            POST /v1/videos
        │                                     │
        └──────────► MediaController ◄────────┘   (AgentKeyAuthGuard, plan + rate limits)
                          │
                    MediaRoutingService
        ┌─────────────────┼──────────────────────────────┐
        │                 │                              │
  ResolveService     resolveRouteCredentials      ProxyMessageRecorder
  (header tier /     (provider key, label,        (Request + Attempt rows,
   auto-{name} /      tenant_provider_id)          cost_usd, api_mode)
   direct model)
                          │
                    MediaProviderClient
        ┌─────────────────┼──────────────────────────────┐
        │                 │                              │
   AgnesAdapter      OpenAiImagesAdapter          (future adapters)
   image + video     /v1/images/generations
```

Key points:

- **Modality gate.** `POST /v1/images/generations` requires the resolved chain's
  `output_modality === 'image'`; `/v1/videos` requires `'video'`. A mismatch is
  M301 — a request error, not a provider call.
- **Request validation.** The media body is validated before any credential or
  provider work: a missing `prompt`, an out-of-range `n` / `seconds`, malformed
  references, or an Agnes video `mode` that contradicts the supplied media is
  rejected locally with M304 instead of becoming a provider 400 that would
  count against provider reliability.
- **Same chain semantics as text.** Primary route + fallbacks, key rotation,
  cooldown, `superseded` rows, `fallback_from_model` attribution.
- **Video is async.** `POST /v1/videos` forwards to the provider, persists the
  provider task id on the Manifest Request, and returns the provider's
  OpenAI-shaped video object. `GET /v1/videos/{id}` polls upstream and, on
  completion, writes the final `cost_usd` (per-second billing needs the output
  duration, unknown at submit time).
- **Recording.** A media request writes one `requests` row and one or more
  `agent_messages` rows. `api_mode` is extended with `images` / `videos` so
  analytics can filter media traffic without touching token metrics.

## Phases

### Phase 1 — Contracts and provider catalog
- `OUTPUT_MODALITIES = ['text', 'image', 'video']` (**done**).
- `SharedProviderEntry.media` descriptor; `agnes` registered with
  `media: { image: true, video: true }` (**done**).
- `AGNES_MODELS` curated catalog (ids, display names, output modality, context
  windows) + `AGNES_BASE_URL` / `AGNES_TASK_ORIGIN` (**done**).
- Discovery: `parseAgnes` annotates the live `/v1/models` listing from the
  catalog, appends curated media models the listing omits, and media-capable
  providers bypass `filterNonChatModels` (**done**).
- `agnes` OpenAI-compatible chat endpoint in `PROVIDER_ENDPOINTS` (**done**).
- Synthetic tier profile already aggregates the chain's `outputModalities`, so
  an `auto-{name}` tier over an image model advertises `output_modalities:
  ['image']` today (**done**).
- Not yet: a media endpoint to actually call. That is Phase 2.

### Phase 2 — Image endpoint (vertical slice)
- `ProxyApiMode` gains `images` (**done**).
- `MediaController` + `MediaService` + `MediaProviderClient` (Agnes adapter) for
  `POST /v1/images/generations` (**done**).
- Recording with `cost_usd` from the image price table (**done**).
- Tests: adapter translation, modality gate, credential failure, provider
  error, recording shape (**done**).

### Phase 3 — Synthetic media tiers and UI
- Header-tier `output_modality` is settable through
  `PATCH .../header-tiers/:id/output-modality`, validated against the chain
  (**done**).
- `auto-{name}` models advertise the tier's media modality
  (**done** — `synthetic-model-profile.ts` prefers the tier modality).
- Frontend: modality selector on the tier modal (**done**); provider tile and
  model picker for Agnes (**done**).

### Phase 4 — Video endpoint (async)
- `ProxyApiMode` gains `videos` (**done**).
- `POST /v1/videos`, `GET /v1/videos/{id}`; the task id is persisted on the
  Request (`requests.media_task_id`, migration
  `1803200000000-AddRequestMediaTaskId`) (**done**).
- Completion finalizes `cost_usd` from `VIDEO_PRICE_PER_SECOND × seconds` and
  maps the provider status onto the canonical success/failed vocabulary
  (**done**).

### Phase 5 — Cost accounting and analytics
- Media pricing tables (image per-image, video per-second) resolved by
  `(provider, model, size, seconds)` in `media-pricing.ts` (**done**).
- Media rows carry zero tokens and their USD cost in `agent_messages.cost_usd`,
  so token metrics are untouched and cost is included (**done**).

## Verification

- Unit: `media-provider-client.spec.ts`, `media.service.spec.ts`,
  `media.controller.spec.ts`, `synthetic-model-profile.spec.ts`,
  `header-tier.service.spec.ts`.
- Integration (compiled app + real Postgres + mock Agnes upstream): image
  generation, modality gate (M301), video create, video status, cost
  finalization (10s → $0.40), `requests.media_task_id`, `api_mode`, and the
  `auto-image` / `auto-video` `/v1/models` capabilities.
- Migration verified against a real database (column + index created).
- Live video generation against the real Agnes API is **not** verifiable until
  API credit is loaded; the video path is covered end-to-end against a mock
  upstream instead.

## Open questions

- Does Agnes expose `/v1/models`? Discovery tries it and falls back to the
  curated `AGNES_MODELS` catalog when it is missing or empty. Update the
  catalog on new releases.
- OpenAI's `size` is `1024x1024`; Agnes uses `1K`/`2K` tiers plus `ratio`.
  The Agnes adapter passes `size`/`ratio` through unchanged; a generic
  OpenAI-images adapter exists for providers that take the exact-size form.
- Media requests count against the same plan request limit and rate limits as
  text (they are Manifest Requests like any other).
- Provider-attempt payload recording (`attempt_recording`) is not yet wired for
  media: image base64 can be large. The media Request/Attempt rows, cost, and
  attribution are recorded; the raw payload is not.
