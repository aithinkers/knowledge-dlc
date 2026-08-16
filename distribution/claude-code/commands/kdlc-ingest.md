---
description: Run the governed K-DLC ingest operation
argument-hint: JSON string array
---

**When to use:** New source material should enter the pipeline (documents, pages, exports).

**What you give it:** The source location and any scoping hints.

**What you get back:** Normalized evidence with provenance, ready for claim extraction.

**Usually next:** kdlc status to watch progress; kdlc proposal when candidates appear.

The native Claude Code binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/claude-code/run.mjs", "ingest", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
