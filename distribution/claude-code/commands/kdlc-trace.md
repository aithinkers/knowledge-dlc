---
description: Run the governed K-DLC trace operation
argument-hint: JSON string array
---

**When to use:** You need the full history of a piece of knowledge: sources, claims, decisions.

**What you give it:** The concept or claim to trace.

**What you get back:** Its complete provenance chain, end to end.

**Usually next:** kdlc query to explore related knowledge.

The native Claude Code binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/claude-code/run.mjs", "trace", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
