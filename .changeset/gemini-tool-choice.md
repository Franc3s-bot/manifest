---
'manifest': patch
---

Forward `tool_choice` to Gemini as `toolConfig` on Google routes. It was dropped, so a forced (`required` or named function) or disabled (`none`) tool call was left to the model's own choice.
