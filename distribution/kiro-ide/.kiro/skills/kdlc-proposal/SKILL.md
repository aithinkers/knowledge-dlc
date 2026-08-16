---
name: kdlc-proposal
description: Run the governed K-DLC proposal operation
user-invocable: true
---

**When to use:** You want to see, create, or update proposed knowledge changes awaiting review.

**What you give it:** A proposal action and its details, or nothing to list what's pending.

**What you get back:** The proposal record — proposals only become knowledge after review.

**Usually next:** kdlc review when a proposal is ready for a decision.

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro-ide/run.mjs", "proposal", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
