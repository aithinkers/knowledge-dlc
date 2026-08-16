---
description: You want to see what's waiting on your decision, or decide it — this is the human gate.
argument-hint: JSON string array
---

**When to use:** You want to see what's waiting on your decision, or decide it — this is the human gate.

**What you give it:** Nothing to list pending review packets; or <proposal-id> --approve "reason" (or --reject / --request-changes) to decide and land it in one step.

**What you get back:** On approval: the concept file, index, and retrieval catalog updated atomically — kdlc query answers with citations immediately. Refusals and rejections change nothing.

**Usually next:** kdlc query to see it live; kdlc status for the audit trail.

The native Claude Code binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/claude-code/run.mjs", "publish", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
