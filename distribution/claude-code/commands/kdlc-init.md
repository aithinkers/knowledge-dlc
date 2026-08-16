---
description: Run the governed K-DLC init operation
argument-hint: JSON string array
---

**When to use:** You're starting a brand-new K-DLC project in this repository.

**What you give it:** A project name and, optionally, a scope profile.

**What you get back:** A governed project skeleton with its policy, state, and knowledge-base layout.

**Usually next:** kdlc setup to configure it, then kdlc ingest to bring in your first sources.

The native Claude Code binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/claude-code/run.mjs", "init", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
