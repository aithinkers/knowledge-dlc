---
name: kdlc-adopt
description: Run the governed K-DLC adopt operation
user-invocable: true
---

**When to use:** Existing documents or knowledge should be brought under K-DLC governance.

**What you give it:** The paths or references to adopt.

**What you get back:** Adoption candidates recorded for curation — nothing is published yet.

**Usually next:** kdlc proposal to review what adoption proposed.

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro/run.mjs", "adopt", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
