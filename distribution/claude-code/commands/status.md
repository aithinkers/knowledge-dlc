---
description: You want to know where everything stands — runs, gates, pending work.
argument-hint: JSON string array
---

**When to use:** You want to know where everything stands — runs, gates, pending work.

**What you give it:** Nothing, or a specific run to inspect.

**What you get back:** The current workflow state, what's blocked on whom, and what's next.

**Usually next:** Whatever it names as the next step.

The native Claude Code binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/claude-code/run.mjs", "status", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
