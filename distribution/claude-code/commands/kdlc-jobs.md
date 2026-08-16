---
description: Run the governed K-DLC jobs operation
argument-hint: JSON string array
---

**When to use:** You want to see or manage long-running background work.

**What you give it:** Nothing to list jobs, or a job ID to inspect or cancel.

**What you get back:** Job states, progress, and outcomes.

**Usually next:** kdlc status for the wider picture.

The native Claude Code binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/claude-code/run.mjs", "jobs", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
