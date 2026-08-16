---
description: Run the governed K-DLC migrate operation
argument-hint: JSON string array
---

**When to use:** The project needs moving to a newer K-DLC format or profile version.

**What you give it:** The target version; run it before anything else after an upgrade.

**What you get back:** A migrated project, or a precise report of what blocks migration.

**Usually next:** kdlc status to confirm health on the new version.

The native Claude Code binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/claude-code/run.mjs", "migrate", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
