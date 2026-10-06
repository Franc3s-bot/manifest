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
  an M-code request error, not a provider call.
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
- Shared media request/response types (image generation, video task, task status).
- `SharedProviderEntry` gains a media descriptor (`media?: { image?: boolean; video?: boolean }`).
- `agnes` added to `SHARED_PROVIDERS` with a curated model catalog
  (`agnes-image-2.1-flash`, `agnes-video-2.5`) and media pricing constants.
- Discovery: media models for media-capable providers bypass
  `filterNonChatModels` and are published in `GET /v1/models` with
  `output_modalities: ['image'] | ['video']`.

### Phase 2 — Image endpoint (vertical slice)
- `ProxyApiMode` gains `images`.
- `MediaController` + `MediaRoutingService` + `AgnesAdapter` for
  `POST /v1/images/generations`.
- Recording with `cost_usd` from the image price table.
- Tests: adapter translation, modality gate, fallback on provider error,
  recording shape.

### Phase 3 — Synthetic media tiers and UI
- Header-tier create/update accepts `output_modality: image | video`, validated
  against the configured chain.
- `auto-{name}` models advertise media `output_modalities`
  (`synthetic-model-profile.ts` already aggregates discovered modalities).
- Frontend: modality selector on the tier card; model picker filtered by
  modality; provider connect tile for Agnes.

### Phase 4 — Video endpoint (async)
- `ProxyApiMode` gains `videos`.
- `POST /v1/videos`, `GET /v1/videos/{id}`; task id persisted on the Request.
- Completion updates `cost_usd` from `VIDEO_PRICE_PER_SECOND × seconds`.

### Phase 5 — Cost accounting and analytics
- Media pricing tables (image per-image, video per-second) resolved by
  `(provider, model, size, seconds)`.
- Dashboard: media requests excluded from token metrics, included in cost.

## Open questions

- Does Agnes expose `/v1/models`? If yes, discovery can fetch; if not, the
  curated catalog is authoritative and must be updated on new releases.
- OpenAI's `size` is `1024x1024`; Agnes uses `1K`/`2K` tiers plus `ratio`. Do we
  accept both and translate, or only Agnes-native?
- Should media requests count against the same plan request limit as text?
- Where does the raw media payload live — `attempt_recording` today stores
  request/response bodies; image base64 can be large. A size cap or URL-only
  policy is needed.
