---
'manifest': minor
---

Add fal.ai as a media provider, including MiniMax H3 Max video.

- New `fal` provider (media-only) with a curated catalog: MiniMax H3 Max text-to-video and image-to-video, plus FLUX.1 [schnell] and FLUX.1 [dev] image models.
- Image generation runs on fal's synchronous endpoint (`fal.run`); video runs through the queue (`queue.fal.run`) with task status and result polling.
- OpenAI-shaped requests are translated onto fal's schema (`seconds` → `duration`, `size`/`resolution` → `resolution`, `ratio` → `aspect_ratio`, `first_frame`/`last_frame` → `image_url`/`end_image_url`, `n` → `num_images`, `response_format: "b64_json"` → `sync_mode`).
- Discovery annotates fal's platform model listing from the curated catalog, keeps only image/video categories, and falls back to the curated catalog when the listing is unavailable.
- Per-second video pricing by resolution tier and per-image pricing for the curated image models.
