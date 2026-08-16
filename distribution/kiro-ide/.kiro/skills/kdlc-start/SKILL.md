---
name: kdlc-start
description: Start or resume K-DLC work — assesses state and offers the right next step
user-invocable: true
---

**When to use:** You want to work on this knowledge base and don't want to
learn the command palette — start here, or say "pick up where we left off".

**What happens:** The assistant assesses where things stand and offers the
right next step; you choose in plain language.

Follow this routine (read-only assessment first — never mutate while assessing):

1. Invoke the `status`, `jobs`, and `sources` operations (JSON output)
   by invoking ["node", "distribution/kiro-ide/run.mjs", <operation>, "--output", "json"] directly without a shell.
2. Route by what they show, offering at most three next actions:
   - Project not initialized → offer to run `init`.
   - Jobs still running → report progress and what they will produce.
   - Evidence exists but nothing proposed → offer conductor-driven proposal
     drafting from that evidence.
   - Proposals pending review → present the review packet and its hash; the
     user's decision goes through the governed `review` operation.
   - Approved but unpublished → offer `publish`.
   - Published knowledge present → offer `query`, `refresh`, or `gaps`.
   - Remote connectors configured but not ready → point at the
     connector-setup agent and `sources` readiness.
3. Do the chosen step, then repeat the assessment and offer what's next.

Never bypass review, routing, or publication policy; approval decisions are
never inferred from conversation.
