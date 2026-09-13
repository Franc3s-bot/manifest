---
'manifest': patch
---

Kiro requests record real token usage instead of always logging zeros. Live `GenerateAssistantResponse` streams carry no per-token counts (only `assistantResponseEvent` content and a credit-based `meteringEvent`), so usage is estimated from the request conversation and the emitted text and marked `estimated: true`. When Kiro does send an explicit `tokenUsage` block it is used verbatim, and the cache read/write breakdown is preserved so `cache_read_tokens` / `cache_creation_tokens` populate the request log. Unknown Kiro event types are logged at debug.
