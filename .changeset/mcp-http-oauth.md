---
'manifest': minor
---

Add a remote MCP server at `POST /api/v1/mcp` with OAuth 2.1. Better Auth's MCP plugin provides the authorization server (PKCE, resource-bound JWT access tokens, CIMD client identity, RFC 8414/9728 discovery), and `requireMcpAuth` gates the route. Tools reuse the same services as the REST API and CLI — agents, provider connections (including custom providers), routing (status, fallbacks, Autofix, recording, custom/header tiers), models, pricing, the request ledger, and a dependency-ordered `doctor`. Read tools require `mcp:read`; write tools are hidden unless the token carries `mcp:write`. Adds a `/consent` page.
