---
name: kdlc-setup
description: Run the governed K-DLC setup operation
user-invocable: true
---

**When to use:** A project exists and you need to configure profiles, policies, or mounts.

**What you give it:** The settings you want changed; everything else keeps its current value.

**What you get back:** An updated, validated project configuration.

**Usually next:** kdlc status to confirm the project is healthy.

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro-ide/run.mjs", "setup", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
