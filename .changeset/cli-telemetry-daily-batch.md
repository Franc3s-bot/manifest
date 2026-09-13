---
'manifest': patch
---

The mnfst CLI no longer sends a telemetry request per command. Commands are recorded in a local spool (`~/.config/manifest/telemetry-spool.jsonl`, mode 0600) and shipped in one anonymous request per install per day to `/v1/cli-report`, matching the self-hosted install report. The first command ever flushes immediately so a new install is counted the day it appears; the spool is capped at 500 events and a failed send is retried at most hourly. The wire payload is reshaped into one envelope per request: `schema_version`, `anon_id`, `cli_version`, and `os` now sit on the envelope with an `events` array beneath it (each event keeps `command`, `ok`, `duration_ms`, `agent_runtime`, plus a minute-precision `at`). No new data is collected, and the `MANIFEST_TELEMETRY_DISABLED=1` opt-out is unchanged.
