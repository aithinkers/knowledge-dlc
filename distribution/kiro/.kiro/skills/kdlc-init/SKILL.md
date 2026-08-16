---
name: kdlc-init
description: Run the governed K-DLC init operation
user-invocable: true
---

**When to use:** You're starting a brand-new K-DLC project in this repository.

**What you give it:** A project name and, optionally, a scope profile.

**What you get back:** A governed project skeleton with its policy, state, and knowledge-base layout.

**Usually next:** kdlc ingest to bring in your first sources.

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro/run.mjs", "init", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
