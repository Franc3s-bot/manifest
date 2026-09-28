---
'manifest': patch
---

Forward `tool_choice` and `parallel_tool_calls` to Anthropic when translating Chat Completions or Responses requests. They were dropped, so a forced or disabled tool call was left to the model's own choice.
