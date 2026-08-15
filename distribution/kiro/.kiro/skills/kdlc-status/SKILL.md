---
name: kdlc-status
description: Run the governed K-DLC status operation
user-invocable: true
---

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro/run.mjs", "status", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
