---
name: kdlc-migrate
description: Run the governed K-DLC migrate operation
user-invocable: true
---

**When to use:** The project needs moving to a newer K-DLC format or profile version.

**What you give it:** The target version; run it before anything else after an upgrade.

**What you get back:** A migrated project, or a precise report of what blocks migration.

**Usually next:** kdlc status to confirm health on the new version.

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro/run.mjs", "migrate", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
