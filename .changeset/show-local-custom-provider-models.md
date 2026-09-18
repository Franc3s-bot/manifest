---
'manifest': patch
---

Show models from local custom providers (llama.cpp, LM Studio, and remote OpenAI-compatible engines connected as a local tile) in the routing model picker and Playground. These connections carry their model list on the custom provider record, so they report no API key and a zero cached-model count, which previously hid their auth category and made every model unreachable from the picker.
