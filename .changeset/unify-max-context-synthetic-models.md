---
'manifest': minor
---

Unify maximum context window for synthetic auto-tier models: aggregate the tier route chain's context window as the most prevalent (mode, conservative tie-break toward the smaller window), expose it as `capabilities.context_window` / `max_output_tokens` on `GET /v1/models?capabilities=true`, and use majority-vote for other capabilities. Add `maxOutputTokens` to the discovered-model descriptor and populate it from models.dev.
