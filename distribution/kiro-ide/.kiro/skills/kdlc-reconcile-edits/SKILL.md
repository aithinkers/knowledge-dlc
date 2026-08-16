---
name: kdlc-reconcile-edits
description: Run the governed K-DLC reconcile-edits operation
user-invocable: true
---

**When to use:** Files were edited outside the governed flow and must be reconciled.

**What you give it:** Nothing — it detects out-of-band edits itself.

**What you get back:** Each edit turned into reviewable work; nothing is silently accepted or lost.

**Usually next:** kdlc review to decide each reconciled edit.

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro-ide/run.mjs", "reconcile-edits", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
