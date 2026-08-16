---
name: kdlc-jobs
description: Run the governed K-DLC jobs operation
user-invocable: true
---

**When to use:** You want to see or manage long-running background work.

**What you give it:** Nothing to list jobs, or a job ID to inspect or cancel.

**What you get back:** Job states, progress, and outcomes.

**Usually next:** kdlc status for the wider picture.

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro-ide/run.mjs", "jobs", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
