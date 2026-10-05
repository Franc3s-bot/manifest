---
'manifest': patch
---

Forward `tool_choice` and `parallel_tool_calls` when a Chat Completions or Anthropic Messages request is sent to a Responses endpoint (ChatGPT subscription, Responses-only OpenAI models, Copilot and xAI Responses). Both were dropped, so a forced or disabled tool call and a request for one tool call at a time reached the model as the defaults.
