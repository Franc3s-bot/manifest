---
"manifest": patch
---

Make the gateway's per-tenant (M201) and per-IP (M202) rate caps configurable with `MANIFEST_RATE_MAX_REQUESTS` and `MANIFEST_IP_RATE_MAX_REQUESTS`, alongside the in-flight (M203) cap already set by `MANIFEST_CONCURRENCY_MAX`.
