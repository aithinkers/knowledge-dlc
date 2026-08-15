---
description: Run the governed K-DLC trace operation
argument-hint: JSON string array
---

Invoke the argument vector ["node", "distribution/claude-code/run.mjs", "trace", "--output", "json", "--host-args-json", {{host.arguments_json}}] directly without a shell. The host MUST bind `{{host.arguments_json}}` to JSON.stringify(userArgumentVector) as one argv element. Return the exact versioned envelope and do not infer success when `ok` is false.
