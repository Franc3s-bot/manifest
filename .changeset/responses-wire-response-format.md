---
'manifest': patch
---

Forward `response_format` as `text.format` when a Chat Completions request is sent to a Responses endpoint (ChatGPT subscription, Responses-only OpenAI models, Copilot and xAI Responses). It was dropped, so a JSON schema or JSON mode request came back as free-form text.
