---
description: Run the governed K-DLC lint operation
argument-hint: JSON string array
---

**When to use:** You want the project checked for structural or policy problems.

**What you give it:** Nothing — it checks the whole project.

**What you get back:** Findings with what each one means and how to fix it; no changes are made.

**Usually next:** kdlc doctor for guided repair of anything it flags.

The native Claude Code binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/claude-code/run.mjs", "lint", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
