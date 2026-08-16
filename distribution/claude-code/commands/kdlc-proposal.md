---
description: Run the governed K-DLC proposal operation
argument-hint: JSON string array
---

**When to use:** Evidence is ingested and you want it drafted into reviewable knowledge — or you want to submit a filled drafting kit.

**What you give it:** To begin: --scaffold <ingest-job-id> --access <public|internal|restricted> --license <license> (add --source <n>/--all-sources for multi-document jobs, --units a-b to slice a large document). To submit a filled kit: --submit <workflow-id>.

**What you get back:** A drafting kit (scaffold), or review packets with hashes (submit) — proposals only become knowledge after review.

**Usually next:** Fill the kit per its README, submit, then kdlc review for the decision.

The native Claude Code binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/claude-code/run.mjs", "proposal", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
