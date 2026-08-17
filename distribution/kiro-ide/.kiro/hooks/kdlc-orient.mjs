#!/usr/bin/env node
// K-DLC session orientation for Kiro IDE (FEAT-040). Fires on promptSubmit,
// so a marker file dedupes it to at most once per 4 hours. Best-effort: it
// never fails the session.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
try {
  const marker = ".kdlc/tmp/kiro-oriented";
  try {
    if (Date.now() - Number(readFileSync(marker, "utf8")) < 4 * 3600 * 1000) process.exit(0);
  } catch { /* not yet oriented */ }
  const lines = [];
  if (existsSync("knowledge-bases") || existsSync(".kdlc")) {
    lines.push("This project is governed by K-DLC.");
    try {
      const runs = readdirSync("workflow/runs").length;
      if (runs > 0) lines.push(`Workflow runs on record: ${runs} — "kdlc status --output human" shows where they stand.`);
    } catch { /* no runs yet */ }
    lines.push("Knowledge changes flow through proposals and review — never edit files under knowledge-bases/ directly; use the kdlc skills or agents.");
    lines.push("New here? The distribution ships plain-language guides (guides/) covering bringing knowledge in, reviewing, querying, and upkeep.");
  } else {
    lines.push("No K-DLC project detected in this directory. The kdlc-init skill starts one; kdlc-adopt brings existing documents under governance.");
  }
  try { mkdirSync(".kdlc/tmp", { recursive: true }); writeFileSync(marker, String(Date.now())); } catch { /* dedup is best-effort */ }
  process.stdout.write(lines.join("\n") + "\n");
} catch { /* orientation is best-effort */ }
