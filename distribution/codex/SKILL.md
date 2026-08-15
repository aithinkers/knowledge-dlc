---
name: kdlc
description: Operate a K-DLC project through its governed CLI engine.
argument-hint: JSON string array
---

# K-DLC

The native host binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/codex/run.mjs", operation, "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Do not bypass review, routing, or publication policy. Supported operations: init, adopt, ingest, query, review, publish, status, lint, refresh, trace, conflicts, gaps, migrate, doctor, reconcile-edits, jobs.
