#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { validateReleaseEvidence } from "./release-evidence-validation.mjs";

if (process.argv.length !== 2) throw new Error("usage: node scripts/run-release-evaluation.mjs");
const execute = promisify(execFile);
const root = process.env.KDLC_CANDIDATE_ROOT ? resolve(process.env.KDLC_CANDIDATE_ROOT) : process.cwd();
const failures = await validateReleaseEvidence(root);
if (failures.length) throw new Error(`release evidence failed validation: ${failures.join("; ")}`);
const run = JSON.parse(await readFile(resolve(root, "distribution/release/recorded-run.json"), "utf8"));
const results = [];
for (const recorded of run.results) {
  let status = "passed";
  try {
    await execute(process.execPath, ["--test", ...recorded.evidence], {
      cwd: root,
      env: { ...process.env, KDLC_RELEASE_EVALUATION_MODE: "recorded-offline" },
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch { status = "failed"; }
  results.push({ case_id: recorded.case_id, status });
  if (status !== recorded.status) failures.push(`${recorded.case_id}: executed status ${status} differs from recorded status ${recorded.status}`);
}
if (failures.length) {
  console.error(failures.map((failure) => `ERROR: ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`REL-001 recorded evaluation replayed: ${results.length}/${results.length} cases passed with committed offline evidence; statistical and final release gates remain pending.`);
}
