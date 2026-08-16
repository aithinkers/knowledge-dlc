---
description: Auto mode published drafts without you — see what's awaiting your ratification, or ratify one.
argument-hint: JSON string array
---

**When to use:** Auto mode published drafts without you — see what's awaiting your ratification, or ratify one.

**What you give it:** Nothing to list; or <proposal-id> --ratify "reason" to promote a draft to stable through a real reviewed update.

**What you get back:** Ratified concepts enter default query answers; unratified drafts stay at the draft trust tier (exploratory queries only).

**Usually next:** kdlc query to see promoted knowledge live.

The native Claude Code binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/claude-code/run.mjs", "revisit", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
