---
'manifest': patch
---

Self-hosted telemetry now reports CLI and remote-MCP adoption: `mnfst login` key counts and 7-day actives, plus MCP OAuth client, consent, and 24h access-token counts, with client names whitelisted to known MCP hosts. All fields are additive aggregates read from existing tables; no per-call counter or new table.
