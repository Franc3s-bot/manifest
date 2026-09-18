---
'manifest': patch
---

Keep the API booting on a plain-HTTP origin when the remote-MCP OAuth plugins cannot be registered.

`@better-auth/mcp` validates its protected-resource URL at import time and throws unless it is HTTPS (loopback excepted). A self-hosted instance reached over plain HTTP on a LAN, Tailscale or docker address crashed on boot. MCP is now skipped for those origins with a warning, and the rest of the API keeps serving.
