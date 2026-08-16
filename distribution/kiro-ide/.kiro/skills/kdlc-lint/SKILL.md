---
name: kdlc-lint
description: Run the governed K-DLC lint operation
user-invocable: true
---

**When to use:** You want the project checked for structural or policy problems.

**What you give it:** Nothing — it checks the whole project.

**What you get back:** Findings with what each one means and how to fix it; no changes are made.

**Usually next:** kdlc doctor for guided repair of anything it flags.

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro-ide/run.mjs", "lint", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
