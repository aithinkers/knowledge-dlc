---
description: Run the governed K-DLC reconcile-edits operation
argument-hint: JSON string array
---

**When to use:** Files were edited outside the governed flow and must be reconciled.

**What you give it:** Nothing — it detects out-of-band edits itself.

**What you get back:** Each edit turned into reviewable work; nothing is silently accepted or lost.

**Usually next:** kdlc review to decide each reconciled edit.

The native Claude Code binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/claude-code/run.mjs", "reconcile-edits", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
