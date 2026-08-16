---
description: Run the governed K-DLC review operation
argument-hint: JSON string array
---

**When to use:** A proposal or publication request needs an accountable decision.

**What you give it:** The review packet reference and your decision with reasons.

**What you get back:** A durable review receipt bound to exactly what you reviewed.

**Usually next:** kdlc publish for approved content; kdlc proposal to rework rejections.

The native Claude Code binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/claude-code/run.mjs", "review", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
