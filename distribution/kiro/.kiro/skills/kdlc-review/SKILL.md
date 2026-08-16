---
name: kdlc-review
description: Run the governed K-DLC review operation
user-invocable: true
---

**When to use:** A proposal or publication request needs an accountable decision.

**What you give it:** The review packet reference and your decision with reasons.

**What you get back:** A durable review receipt bound to exactly what you reviewed.

**Usually next:** kdlc publish for approved content; kdlc proposal to rework rejections.

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro/run.mjs", "review", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
