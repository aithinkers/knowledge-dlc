#!/usr/bin/env node

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { validateReleaseEvidence } from "./release-evidence-validation.mjs";
import { scrubbedReleaseEnvironment } from "./release-evaluation-boundary.mjs";

if (process.argv.length !== 2) throw new Error("usage: node scripts/run-release-evaluation.mjs");
const execute = promisify(execFile);
const root = process.env.KDLC_CANDIDATE_ROOT ? resolve(process.env.KDLC_CANDIDATE_ROOT) : process.cwd();
const temporaryReadRoot = process.platform === "darwin" ? "/var" : tmpdir();
const temporaryReadArguments = [...new Set([temporaryReadRoot, realpathSync(tmpdir())])].map((path) => `--allow-fs-read=${path}`);
const temporaryWriteArguments = [...new Set([tmpdir(), realpathSync(tmpdir())])].map((path) => `--allow-fs-write=${path}`);
const failures = await validateReleaseEvidence(root);
if (failures.length) throw new Error(`release evidence failed validation: ${failures.join("; ")}`);
const run = JSON.parse(await readFile(resolve(root, "distribution/release/recorded-run.json"), "utf8"));
const corpus = JSON.parse(await readFile(resolve(root, "distribution/release/evaluation-corpus.json"), "utf8"));
const results = [];
let externalNetworkCalls = 0; let liveModelCalls = 0;
for (const recorded of run.results) {
  const releaseCase = corpus.cases.find(({ id }) => id === recorded.case_id);
  const allowNormalizer = recorded.case_id === "bounded-normalization";
  let status = "passed";
  const boundaryRoot = await mkdtemp(resolve(tmpdir(), "kdlc-release-boundary-"));
  const boundaryReport = resolve(boundaryRoot, "observations.json");
  try {
    const pattern = `^(?:${releaseCase.executable_evidence.test_ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`;
    const { stdout } = await execute(process.execPath, ["--permission", ...(allowNormalizer ? ["--allow-child-process"] : []), `--allow-fs-read=${root}`, ...temporaryReadArguments, ...temporaryWriteArguments, "--import", resolve(root, "scripts/release-offline-guard.mjs"), "--test", "--test-isolation=none", "--test-name-pattern", pattern, releaseCase.executable_evidence.path], {
      cwd: root,
      env: scrubbedReleaseEnvironment(boundaryReport, { root, allowNormalizer }),
      maxBuffer: 32 * 1024 * 1024,
    });
    const pass = Number(/(?:#|ℹ)\s*pass\s+(\d+)/.exec(stdout)?.[1] ?? -1); const skipped = Number(/(?:#|ℹ)\s*skipped\s+(\d+)/.exec(stdout)?.[1] ?? 0);
    if (pass !== releaseCase.executable_evidence.test_ids.length || skipped !== 0) throw new Error("zero, missing, or unrelated applicable tests");
  } catch { status = "failed"; }
  try {
    const observed = JSON.parse(await readFile(boundaryReport, "utf8"));
    externalNetworkCalls += observed.external_network_calls; liveModelCalls += observed.live_model_calls;
    if (observed.external_network_calls !== 0 || observed.live_model_calls !== 0 || observed.blocked_process_calls !== 0) status = "failed";
  } catch { status = "failed"; }
  await rm(boundaryRoot, { recursive: true, force: true });
  results.push({ case_id: recorded.case_id, status });
  if (status !== recorded.status) failures.push(`${recorded.case_id}: executed status ${status} differs from recorded status ${recorded.status}`);
}
if (externalNetworkCalls !== run.external_network_calls || liveModelCalls !== run.live_model_calls) failures.push("observed execution-boundary counters differ from the committed run");
if (failures.length) {
  console.error(failures.map((failure) => `ERROR: ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`REL-001 recorded evaluation replayed: ${results.length}/${results.length} cases passed with committed offline evidence; statistical and final release gates remain pending.`);
}
