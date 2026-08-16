---
name: kdlc-query
description: Run the governed K-DLC query operation
user-invocable: true
---

**When to use:** You want an answer from the knowledge base with citations you can defend.

**What you give it:** Your question and, optionally, a query mode.

**What you get back:** An answer with qualified citations, plus trust, freshness, and conflict warnings.

**Usually next:** kdlc conflicts if a warning points at a recorded disagreement.

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro/run.mjs", "query", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
