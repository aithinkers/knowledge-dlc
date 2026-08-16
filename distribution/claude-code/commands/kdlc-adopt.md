---
description: Run the governed K-DLC adopt operation
argument-hint: JSON string array
---

**When to use:** Existing documents or knowledge should be brought under K-DLC governance.

**What you give it:** The paths or references to adopt.

**What you get back:** Adoption candidates recorded for curation — nothing is published yet.

**Usually next:** kdlc proposal to review what adoption proposed.

The native Claude Code binding is `$ARGUMENTS`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", "distribution/claude-code/run.mjs", "adopt", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
