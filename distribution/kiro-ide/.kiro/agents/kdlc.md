<!-- generated: packages/adapters/generate.mjs -->
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
   - Evidence exists but nothing proposed → offer the drafting path: run the
     `proposal` operation with `--scaffold <ingest-job-id>` (asking the
     user for --access and --license — governance decisions), then follow the
     kit README under `.kdlc/drafting/<workflow>/` to draft and submit.
     Work in the foreground and report the returned packet hashes.
   - Proposals pending review → run `publish` bare to list them, present
     each packet and hash, and record the user's decision with
     `publish <proposal-id> --approve|--reject|--request-changes` — on
     approval the concept lands atomically and query answers immediately.
   - Published knowledge present → offer `query`, `refresh`, or `gaps`.
   - Remote connectors configured but not ready → point at the
     connector-setup agent and `sources` readiness.
3. Do the chosen step, then repeat the assessment and offer what's next.

Never bypass review, routing, or publication policy; approval decisions are
never inferred from conversation.
