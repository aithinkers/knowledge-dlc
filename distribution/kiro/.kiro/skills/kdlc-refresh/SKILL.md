---
name: kdlc-refresh
description: Run the governed K-DLC refresh operation
user-invocable: true
---

**When to use:** Published knowledge may be stale and should be re-checked against its sources.

**What you give it:** The concepts or scope to refresh, or nothing for a full sweep.

**What you get back:** Refresh proposals for anything out of date — existing content is untouched.

**Usually next:** kdlc review to act on the refresh proposals.

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro/run.mjs", "refresh", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
