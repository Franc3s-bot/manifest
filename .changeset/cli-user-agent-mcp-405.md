---
'manifest': patch
---

The remote MCP endpoint answers GET and DELETE with 405 + `Allow: POST` as the Streamable HTTP spec requires for a stateless JSON transport, instead of a 404 that clients logged on every connect. `mnfst routing test` now sends `User-Agent: mnfst-cli/<version>` so the gateway's caller attribution can tell CLI test traffic apart.
