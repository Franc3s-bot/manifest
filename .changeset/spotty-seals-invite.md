---
'manifest': minor
---

Requests log: filter by model, and isolate cancelled requests. The Model filter is multi-select and matches any provider attempt on the request, so filtering by the primary of a fallback chain still finds the request it was recovered on; a request Manifest blocked before any provider call matches on its requested model, which is what the Model column shows for those rows. `Cancelled` becomes its own status instead of being counted as `Failed`. The Min/Max $ inputs are gone — filtering by an absolute cost threshold required already knowing the distribution you were trying to find.
