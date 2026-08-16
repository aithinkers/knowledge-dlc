---
description: Run the governed K-DLC refresh operation
argument-hint: JSON string array
---

**When to use:** Published knowledge may be stale and should be re-checked against its sources.

**What you give it:** The concepts or scope to refresh, or nothing for a full sweep.

**What you get back:** Refresh proposals for anything out of date — existing content is untouched.

**Usually next:** kdlc review to act on the refresh proposals.

The native Claude Code binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/claude-code/run.mjs", "refresh", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
