---
name: kdlc-setup
description: Run the governed K-DLC setup operation
user-invocable: true
---

**When to use:** You want to install K-DLC's surface into ANOTHER tool (codex, kiro, kiro-ide, an MCP client) — from inside an already-installed harness like this one, there is nothing to set up.

**What you give it:** A target tool and a project directory: setup <tool> <dir>.

**What you get back:** That tool's commands/agents written into the project (or install instructions).

**Usually next:** kdlc status — or just start working; this harness is already set up.

Interpret the user arguments as a JSON string array and invoke ["node", "distribution/kiro/run.mjs", "setup", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when `ok` is false.
