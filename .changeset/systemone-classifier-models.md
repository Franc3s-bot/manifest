---
'manifest': minor
---

Classifiers: serve OpenCode Zen's System One models through the gateway.

- `POST /zen/v1/systemone` (alias `POST /v1/systemone`) proxies the System One classifier protocol to OpenCode Zen with the tenant's existing OpenCode Zen credential — no new secret. The `{ model, state, questions }` body and the `{ model, answers, usage }` response (including `usage.input_tokens` / `usage.output_tokens`) pass through unchanged, so a client can point an `opencode` provider's base URL at `<manifest>/zen/v1` and reuse its System One transport.
- `GET /v1/models?classifiers=true` lists the classifier models (`opencode-zen/jev-1.13`, `opencode-zen/jev-1.13-free`) for agents that can reach OpenCode Zen, marked with `capabilities.features: ["classifier"]` and `capabilities.supported_endpoints: ["/zen/v1/systemone"]`. The default catalog is unchanged.
- Chat routing is untouched: classifier models are not added to the chat catalog and never participate in route or tier resolution.
