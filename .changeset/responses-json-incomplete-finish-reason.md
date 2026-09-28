---
'manifest': patch
---

Report a truncated or filtered non-streaming Responses API reply as `finish_reason: "length"` / `"content_filter"` instead of `"stop"`, matching the streaming path.
