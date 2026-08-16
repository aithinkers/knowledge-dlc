---
name: kdlc-revisit
description: Run the governed K-DLC revisit operation
user-invocable: true
---

**When to use:** Auto mode published drafts without you — see what's awaiting your ratification, or ratify one.

**What you give it:** Nothing to list; or <proposal-id> --ratify "reason" to promote a draft to stable through a real reviewed update.

**What you get back:** Ratified concepts enter default query answers; unratified drafts stay at the draft trust tier (exploratory queries only).

**Usually next:** kdlc query to see promoted knowledge live.

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro/run.mjs", "revisit", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
