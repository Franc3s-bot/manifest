---
'manifest': minor
---

Run Autofix on failed **fallback** attempts, not just the primary. Previously a fallback that failed with a repairable request-side 4xx (for example an unsupported `response_format`) was recorded as a dead hop even when Phoenix already had a patch for that model. Each failed fallback is now handed to Phoenix and its patched body is retried on the same fallback transport, so a request can be recovered without burning the rest of the chain. Consent is unchanged: Autofix only runs for agents that opted in.
