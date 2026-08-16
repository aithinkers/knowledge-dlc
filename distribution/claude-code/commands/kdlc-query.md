---
description: Alias of /kdlc:query
argument-hint: JSON string array
---

This command is a legacy alias. Interpret `$ARGUMENTS` exactly as /kdlc:query does and invoke ["node", "distribution/claude-code/run.mjs", "query", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
