---
description: Run the governed K-DLC conflicts operation
argument-hint: JSON string array
---

**When to use:** You want to see recorded disagreements between sources.

**What you give it:** Nothing, or a scope to filter.

**What you get back:** Each open conflict with the positions, sources, and applicable scopes.

**Usually next:** kdlc proposal to resolve one with an accountable change.

The native Claude Code binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/claude-code/run.mjs", "conflicts", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
