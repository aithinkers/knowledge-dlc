---
description: Run the governed K-DLC setup operation
argument-hint: JSON string array
---

**When to use:** A project exists and you need to configure profiles, policies, or mounts.

**What you give it:** The settings you want changed; everything else keeps its current value.

**What you get back:** An updated, validated project configuration.

**Usually next:** kdlc status to confirm the project is healthy.

The native Claude Code binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/claude-code/run.mjs", "setup", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
