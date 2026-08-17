---
name: kdlc-auto
description: Batch auto mode — a whole folder to published drafts, one summary, ratify later
user-invocable: true
---

**When to use:** You have a folder (or a big drop) of documents and want them
taken all the way to published draft knowledge without a conversation per
file. This is batch auto mode: machine-approved, draft-tier, ratified later.

**What you give it:** a directory or file list, e.g. `/kdlc:auto docs/`.

**What you get back:** one summary — documents processed, concepts published
as drafts, anything skipped or failed with reasons — and a ratification queue
(`revisit`) you review on your own schedule.

Run the whole flow by invoking ["node", "distribution/kiro/run.mjs", <operation>, "--output", "json"] directly without a shell without stopping to report
between documents (the conductor playbook's batch auto mode step governs the
loop, including its circuit breaker):

1. **Defaults first**: if `.kdlc/source-defaults.json` is missing, ask the
   user ONCE for access classification and license, then persist them (the
   `init` operation accepts `--access`/`--license`, or add
   `--save-defaults` on the first scaffold). Never ask again mid-batch.
2. **Ingest the folder**: run the `ingest` operation with the directory
   path — it expands to every supported file underneath and automatically
   skips files unchanged since their last ingest (`--force` re-normalizes).
3. **Scaffold everything**: `proposal` with `--scaffold <job-id>
   --all-sources` — one kit per document, resumable; already-scaffolded
   documents skip, undraftable ones are reported.
4. **Draft, submit, repeat**: for each open kit, fill the recording template
   with proposals that EXPLICITLY declare `status: "draft"`, submit with
   `proposal --submit <workflow-id> --auto` (it refuses non-draft), and
   move to the next kit without reporting. If several consecutive documents
   fail the same way, stop and report the pattern.
5. **One summary**: processed / published-as-draft / skipped / failed, and
   remind the user that `revisit` lists every machine approval awaiting
   ratification, promotable with `revisit <proposal-id> --ratify`.
