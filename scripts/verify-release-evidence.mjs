#!/usr/bin/env node

import process from "node:process";
import { resolve } from "node:path";

import { validateReleaseEvidence } from "./release-evidence-validation.mjs";

if (process.argv.length !== 2) throw new Error("usage: node scripts/verify-release-evidence.mjs");
const root = process.env.KDLC_CANDIDATE_ROOT ? resolve(process.env.KDLC_CANDIDATE_ROOT) : process.cwd();
const failures = await validateReleaseEvidence(root);
if (failures.length) {
  console.error(failures.map((failure) => `ERROR: ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("REL-001 pre-release evidence verified: 5 implemented modules, 10 formats, 9 recorded cases, 0 live model/external network calls; release remains blocked.");
}
