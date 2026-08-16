---
description: Run the governed K-DLC gaps operation
argument-hint: JSON string array
---

**When to use:** You want to know what the knowledge base should cover but doesn't.

**What you give it:** Nothing, or a scope to examine.

**What you get back:** Identified coverage gaps as reviewable findings.

**Usually next:** kdlc ingest to fill a gap from a new source.

The native Claude Code binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/claude-code/run.mjs", "gaps", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
