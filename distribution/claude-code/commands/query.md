---
description: You want an answer from the knowledge base with citations you can defend.
argument-hint: JSON string array
---

**When to use:** You want an answer from the knowledge base with citations you can defend.

**What you give it:** Your question and, optionally, a query mode.

**What you get back:** An answer with qualified citations, plus trust, freshness, and conflict warnings.

**Usually next:** kdlc conflicts if a warning points at a recorded disagreement.

The native Claude Code binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/claude-code/run.mjs", "query", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
