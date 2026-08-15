---
name: kdlc
description: Operate a K-DLC project through its governed CLI engine.
---

# K-DLC

Invoke ["node", "distribution/codex/run.mjs", operation, "--output", "json", "--host-args-json", {{host.arguments_json}}] directly without a shell, binding the placeholder to JSON.stringify(userArgumentVector) as one argv element. Do not bypass review, routing, or publication policy. Supported operations: init, adopt, ingest, query, review, publish, status, lint, refresh, trace, conflicts, gaps, migrate, doctor, reconcile-edits, jobs.
