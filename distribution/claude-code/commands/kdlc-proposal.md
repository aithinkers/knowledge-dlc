---
description: Run the governed K-DLC proposal operation
argument-hint: JSON string array
---

**When to use:** You want to see, create, or update proposed knowledge changes awaiting review.

**What you give it:** A proposal action and its details, or nothing to list what's pending.

**What you get back:** The proposal record — proposals only become knowledge after review.

**Usually next:** kdlc review when a proposal is ready for a decision.

The native Claude Code binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/claude-code/run.mjs", "proposal", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
