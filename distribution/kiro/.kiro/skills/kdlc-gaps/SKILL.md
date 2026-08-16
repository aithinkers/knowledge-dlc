---
name: kdlc-gaps
description: Run the governed K-DLC gaps operation
user-invocable: true
---

**When to use:** You want to know what the knowledge base should cover but doesn't.

**What you give it:** Nothing, or a scope to examine.

**What you get back:** Identified coverage gaps as reviewable findings.

**Usually next:** kdlc ingest to fill a gap from a new source.

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro/run.mjs", "gaps", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
