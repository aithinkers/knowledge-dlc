---
name: kdlc-reconcile-edits
description: Run the governed K-DLC reconcile-edits operation
user-invocable: true
---

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro/run.mjs", "reconcile-edits", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
