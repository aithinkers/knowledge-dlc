---
name: kdlc-trace
description: Run the governed K-DLC trace operation
user-invocable: true
---

**When to use:** You need the full history of a piece of knowledge: sources, claims, decisions.

**What you give it:** The concept or claim to trace.

**What you get back:** Its complete provenance chain, end to end.

**Usually next:** kdlc query to explore related knowledge.

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro/run.mjs", "trace", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
