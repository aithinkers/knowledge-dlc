---
description: Run the governed K-DLC doctor operation
argument-hint: JSON string array
---

**When to use:** Something is off and you want diagnosis plus safe, guided repair.

**What you give it:** Nothing — it inspects the project itself.

**What you get back:** What's wrong in plain terms and which repairs it can apply safely.

**Usually next:** kdlc status once repairs are applied.

The native Claude Code binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/claude-code/run.mjs", "doctor", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
