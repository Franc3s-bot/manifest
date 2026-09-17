---
'manifest': patch
---

Fix the per-harness Overview and Requests pages being slow on workspaces with a lot of traffic. The filter that hides Playground traffic re-read the agents table once per row, which on a busy harness meant tens of thousands of sequential scans. It now reads it once per query. Measured on production, the timeseries behind the Overview went from 24.7s to 0.3s and the requests chart from 26.2s to 0.7s, with identical results.
