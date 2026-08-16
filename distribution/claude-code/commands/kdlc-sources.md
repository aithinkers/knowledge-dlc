---
description: Run the governed K-DLC sources operation
argument-hint: JSON string array
---

**When to use:** You want to see the remote sources this project ingested — where each came from, which revision, and how it was acquired.

**What you give it:** Nothing — it lists the acquisition receipts.

**What you get back:** Each remote source's provider, revision identity, acquisition path, content hash, and access context.

**Usually next:** kdlc refresh to re-check published knowledge against its sources.

The native Claude Code binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/claude-code/run.mjs", "sources", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
