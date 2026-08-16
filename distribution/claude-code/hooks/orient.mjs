#!/usr/bin/env node
// K-DLC session orientation (FEAT-018). Dependency-free; prints a short
// plain-language bearing at session start and never fails the session.
import { existsSync, readdirSync } from "node:fs";
try {
  const lines = [];
  if (existsSync("knowledge-bases") || existsSync(".kdlc")) {
    lines.push("This project is governed by K-DLC.");
    try {
      const runs = readdirSync("workflow/runs").length;
      if (runs > 0) lines.push(`Workflow runs on record: ${runs} — "kdlc status --output human" shows where they stand.`);
    } catch { /* no runs yet */ }
    lines.push("Knowledge changes flow through proposals and review — never edit files under knowledge-bases/ directly; use the kdlc commands or agents.");
    lines.push("New here? The guides in distribution/*/guides/ walk through bringing knowledge in, reviewing, querying, and upkeep.");
  } else {
    lines.push("No K-DLC project detected in this directory. \"kdlc init\" starts one; \"kdlc adopt\" brings existing documents under governance.");
  }
  process.stdout.write(lines.join("\n") + "\n");
} catch { /* orientation is best-effort */ }
