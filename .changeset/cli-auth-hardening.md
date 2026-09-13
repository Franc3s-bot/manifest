---
'manifest': patch
---

Harden the mnfst CLI auth and command edges: refuse HTTP redirects so the workspace API key cannot leak cross-origin, strip inherited `MANIFEST_AGENT_KEY`/`MANIFEST_API_KEY` (and variant casing) from `mnfst run` children, require the requested `--auth-type` on `agent configure`'s primary model so an unroutable route is rejected before any write, and report clearer errors for a raced key file, an array-valued config, and a JSON `null` token response.
