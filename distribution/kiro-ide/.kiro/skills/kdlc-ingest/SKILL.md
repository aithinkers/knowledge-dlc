---
name: kdlc-ingest
description: Run the governed K-DLC ingest operation
user-invocable: true
---

**When to use:** New source material should enter the pipeline (documents, pages, exports).

**What you give it:** The source location and any scoping hints.

**What you get back:** Normalized evidence with provenance, ready for claim extraction.

**Usually next:** kdlc status to watch progress; kdlc proposal when candidates appear.

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro-ide/run.mjs", "ingest", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
