---
'manifest': patch
---

Forward the caller's `anthropic-beta` header on native Messages requests to Anthropic instead of dropping it. Manifest builds the upstream header set from scratch, so a beta flag the caller sent never arrived: the API-key path sent no flag at all and the subscription path sent a fixed list. A request whose body used a beta-gated field was then validated against the non-beta schema and rejected. The caller's flags are now appended to Manifest's own, on the primary forward, the Autofix retry and fallback hops.

Scope is deliberately narrow. Only `POST /v1/messages` to Anthropic itself, including a custom provider row pointed at it. Translated OpenAI-shaped requests are excluded, because their responses come back through converters that understand only known content blocks. The Anthropic-compatible third parties (Bedrock, BytePlus, CommandCode, MiniMax, Kimi, OpenCode Go) are excluded too.
