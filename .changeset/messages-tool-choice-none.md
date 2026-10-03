---
'manifest': patch
---

Translate Anthropic `tool_choice: {type: "none"}` and `disable_parallel_tool_use` on `/v1/messages` requests routed to non-Anthropic providers. Both were dropped, so the model could still call tools, or call several at once, when the client had turned that off.
