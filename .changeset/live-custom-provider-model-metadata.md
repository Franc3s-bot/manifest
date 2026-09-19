---
'manifest': patch
---

Report live capabilities and the real context window for custom-provider models (llama.cpp, LM Studio, vLLM).

A custom provider's model list is hand-edited on the provider record, so it could not carry facts that change per server launch: an `auto-local` synthetic tier advertised the stored value (a hard-coded 128000) and no capabilities at all. Manifest now reads the running server on every model-list read — `GET {base}/models` for `context_length` / `max_context_length` / `meta.n_ctx` and input modalities, plus llama.cpp's `GET {base}/props` for `default_generation_settings.n_ctx`, `chat_template_caps.supports_tools` and `modalities` — with a 15-second cache, request de-duplication and a 2-second timeout. The probe is best-effort: an unreachable or silent server leaves the stored values in place, and stored capabilities are never removed. "Fetch models" while adding a provider also stores the window the server reports instead of silently defaulting to 128k.
