---
name: kdlc-doctor
description: Run the governed K-DLC doctor operation
user-invocable: true
---

**When to use:** Something is off and you want diagnosis plus safe, guided repair.

**What you give it:** Nothing — it inspects the project itself.

**What you get back:** What's wrong in plain terms and which repairs it can apply safely.

**Usually next:** kdlc status once repairs are applied.

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro-ide/run.mjs", "doctor", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
