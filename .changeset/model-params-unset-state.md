---
'manifest': patch
---

Model parameters dialog now saves any value you set, even when it equals the provider default, and shows unset params as "Not set" so the client's value is used. Fixes a `max_tokens` set in the dashboard being ignored (#3022).
