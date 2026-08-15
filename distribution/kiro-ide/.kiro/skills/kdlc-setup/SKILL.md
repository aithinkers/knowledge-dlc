---
name: kdlc-setup
description: Run the governed K-DLC setup operation
user-invocable: true
---

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro-ide/run.mjs", "setup", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
