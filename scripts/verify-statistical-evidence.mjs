#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadCaptures, loadPreregistration, scoreCaptures, validateStatisticalEvidence } from "./statistical-evidence-validation.mjs";

const args = process.argv.slice(2);
if (!(args.length === 0 || (args.length === 5 && args[0] === "--require-captures" && args[1] === "--captures" && args[3] === "--report"))) throw new Error("usage: node scripts/verify-statistical-evidence.mjs [--require-captures --captures <directory> --report <report.json>]");
const root = process.cwd(); const state = await loadPreregistration(root);
const required = args.includes("--require-captures");
if (!required) {
  const result = await validateStatisticalEvidence(root); if (result.failures.length) throw new Error(result.failures.join("; "));
  console.log(result.phase === "pending" ? "REL-001 statistical preregistration verified; provider capture remains explicitly blocked at 0/30 trials." : "REL-001 statistical evidence verified as qualified from 30 complete full-corpus trials.");
} else {
  const directory = args[args.indexOf("--captures") + 1]; const reportPath = args[args.indexOf("--report") + 1]; if (!directory || !reportPath) throw new Error("required captures and report paths are missing");
  const derived = await scoreCaptures(root, await loadCaptures(resolve(directory))); const report = JSON.parse(await readFile(resolve(reportPath), "utf8"));
  if (JSON.stringify(report) !== JSON.stringify(derived)) throw new Error("statistical report is not exactly derived from captures/profile");
  console.log(`REL-001 statistical evidence verified: 30/30 complete trials; gate ${derived.gate}.`);
}
