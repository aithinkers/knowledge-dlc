---
name: kdlc-status
description: Run the governed K-DLC status operation
user-invocable: true
---

**When to use:** You want to know where everything stands — runs, gates, pending work.

**What you give it:** Nothing, or a specific run to inspect.

**What you get back:** The current workflow state, what's blocked on whom, and what's next.

**Usually next:** Whatever it names as the next step.

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro-ide/run.mjs", "status", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
