---
'manifest': patch
---

Fix the Release workflow, which failed on every merge to main after the CLI publishing change. Stamping the CLI version during the version PR made changesets look for a changelog the CLI does not have.
