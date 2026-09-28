---
'manifest': patch
---

Keep system prompts sent as content-part arrays when routing to Google Gemini. They were dropped from `systemInstruction`, so Gemini answered without the system prompt (including Responses API `developer` instructions).
