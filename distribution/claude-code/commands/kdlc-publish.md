---
description: Run the governed K-DLC publish operation
argument-hint: JSON string array
---

**When to use:** Approved knowledge should become visible at its access level.

**What you give it:** The approved item to publish.

**What you get back:** Published, versioned knowledge — refused if approvals are missing.

**Usually next:** kdlc query to see it live; kdlc status for the audit trail.

The native Claude Code binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/claude-code/run.mjs", "publish", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
