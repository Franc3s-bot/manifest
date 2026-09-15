---
"manifest": patch
---

Show custom tiers in the Requests Tier filter. The log spans every harness unless one is picked, but the filter only listed custom tiers of a selected harness, so on the default view there were none to pick. Tier options now come from the tenant-scoped filter metadata, and same-named tiers on different harnesses share one option that matches all of them.
