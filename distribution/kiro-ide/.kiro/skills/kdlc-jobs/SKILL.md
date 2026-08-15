---
name: kdlc-jobs
description: Run the governed K-DLC jobs operation
user-invocable: true
---

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro-ide/run.mjs", "jobs", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
