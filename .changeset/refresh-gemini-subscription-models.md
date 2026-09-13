---
'manifest': patch
---

Refresh the Google Code Assist subscription model catalog. Add the current Generally Available `gemini-3.5-flash` (the model the latest Gemini/Antigravity CLI defaults to) and drop the retired `gemini-3.1-flash-lite-preview` preview alias. Gemini Code Assist does not expose a `/models` endpoint, so this curated list is what the routing UI offers; models outside it 404 at chat time. Also correct the provider tile and README, which advertised a non-existent "Gemini 3.6 Flash" and a "Gemini 3.1 Pro" the subscription does not offer.
