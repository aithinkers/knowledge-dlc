---
name: kdlc-publish
description: Run the governed K-DLC publish operation
user-invocable: true
---

**When to use:** Approved knowledge should become visible at its access level.

**What you give it:** The approved item to publish.

**What you get back:** Published, versioned knowledge — refused if approvals are missing.

**Usually next:** kdlc query to see it live; kdlc status for the audit trail.

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro-ide/run.mjs", "publish", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
