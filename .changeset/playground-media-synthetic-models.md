---
'manifest': minor
---

Playground: test image and video generation models, multimodal prompts, and synthetic harness models.

- Image columns run through the media routing surface (`/v1/images/generations`) with count, size/tier, aspect ratio, `url`/`b64_json` response format, and reference images for image-to-image.
- Video columns support text/keyframe/reference modes, size, ratio, duration, first/last frame, and asynchronous task polling with an inline player.
- Chat prompts accept image attachments (vision) sent as OpenAI-style content parts; the provider adapters translate them to native Anthropic / Google blocks.
- Synthetic `auto-{tier}` models from enabled header tiers are selectable and execute through the real routing resolver, and each column shows the concrete provider/model that served it.
- Runs and single columns can be renamed and deleted from the history drawer; generated media is persisted with the run.
