---
'manifest': patch
---

Report the real context window for subscription models whose provider does not publish one. OpenCode Go no longer clamps every model to a nominal 200k (models.dev supplies the gateway's per-model windows, up to 1.05M) and Command Code no longer invents 200k when its catalog omits `context_length`: both are marked `provider_default` during discovery and enriched from catalog metadata (falling back to the exact-id across-provider lookup), so the advertised window only ever comes from a provider report or the catalog.
