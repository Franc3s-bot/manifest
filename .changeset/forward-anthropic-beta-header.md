---
"manifest": patch
---

Forward the caller's `anthropic-beta` header to Anthropic instead of dropping it. Manifest built the upstream header set from scratch, so a beta flag the caller sent never arrived: the API-key path sent no flag at all and the subscription path sent a fixed list that goes stale whenever Anthropic ships a new beta. Body fields those betas gate (`output_config`, `context_management`, `diagnostics`, `speed`, `thinking.adaptive`) then came back as `<field>: Extra inputs are not permitted`. The caller's flags are now appended to Manifest's own, sanitized and bounded, on the primary forward, the Autofix retry and fallback hops. Anthropic-compatible third parties (Bedrock, BytePlus, CommandCode, MiniMax, Kimi, OpenCode Go) are unaffected.
