---
'manifest': patch
---

The mnfst CLI's daily telemetry batch now carries `target`: `cloud` or `self-hosted`, the class of Manifest the install points at (same precedence as command resolution: `MANIFEST_URL`, then the active config host, then Cloud). Never the URL. Lets Peacock's CLI usage page split the two populations. Opt-out unchanged.
