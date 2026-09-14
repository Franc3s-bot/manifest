---
"manifest": minor
---

Fallback-exhausted responses now say what the provider said. The error message leads with the primary provider's own sentence followed by a one-line summary of every attempt, `source` is always `provider` (the exhaustion is a routing outcome, carried by a new `fallback_exhausted: true` flag and the existing `X-Manifest-Fallback-Exhausted` header, not an error class), and `code` holds only the provider's own code. Each `attempted_fallbacks` entry now carries its sanitized `message`, `code` and `auth_type`, plus a request-scoped `autofix` summary (`applied`, `original_status`, `retry_status`) on the primary and on any hop where Phoenix was consulted. The provider-error parsers also understand FastAPI-style `{detail}` bodies (how ChatGPT Codex rejects an unsupported model) and bare `{"error":"…"}` strings, so those messages are no longer collapsed to a generic "Bad request to upstream provider".
