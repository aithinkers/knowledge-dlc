import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { loadPreregistration, providerRequestBytes, scoreCaptures, sha256, validateCandidatePreregistration, validateCapture, validateScorerBinding, validateStatisticalEvidence, wilsonLower } from "../../scripts/statistical-evidence-validation.mjs";

const root = resolve(import.meta.dirname, "../..");
const execute = promisify(execFile);
async function perfectCapture(index, evidenceRoot = root) {
  const state = await loadPreregistration(evidenceRoot);
  const trial_id = `trial-${String(index).padStart(3, "0")}`;
  const results = state.documents.corpus.cases.map((entry, item) => {
    const response = { decision: entry.expected.decision, answer: entry.expected.required_terms.join(" ") }; const raw_output = JSON.stringify(response);
    const request = providerRequestBytes(state, trial_id, entry);
    return { case_id: entry.id, provider_request_id: `provider-${index}-${item}`, request, request_hash: sha256(request), response, raw_output, raw_output_hash: sha256(raw_output) };
  });
  return { api_version: "kdlc.dev/statistical-capture/v1alpha1", trial_id, captured_at: "2026-08-15T12:00:00Z", corpus_hash: state.hashes.corpus, profile_hash: state.hashes.profile, manifest_hashes: state.documents.profile.manifest_hashes, results, exclusions: [] };
}

test("REL-001 preregisters exact 30-trial full-corpus statistical evidence without fabricated capture", async () => {
  const state = await loadPreregistration(root); const status = JSON.parse(await readFile(resolve(root, "distribution/release/statistical/capture-status.json"), "utf8"));
  assert.equal(state.documents.profile.required_trials, 30); assert.equal(state.documents.corpus.cases.length, 12);
  assert.deepEqual(state.documents.profile.exclusions, { allowed: false, post_hoc: false }); assert.equal(state.documents.model.status, "awaiting-provider-inputs");
  assert.equal(state.documents.profile.scorer.sha256, state.hashes.scorer);
  const substituted = structuredClone(state.documents.profile); substituted.scorer.sha256 = `sha256:${"0".repeat(64)}`;
  await assert.rejects(validateScorerBinding(root, substituted), /exact-bind/);
  assert.deepEqual({ status: status.status, captured: status.captured_trials }, { status: "blocked", captured: 0 });
});

test("REL-001 trusted preregistration permits the frozen-model transition but rejects a substituted hash chain", async (context) => {
  const candidate = await mkdtemp(resolve(tmpdir(), "kdlc-frozen-model-")); context.after(() => rm(candidate, { recursive: true, force: true }));
  await cp(resolve(root, "core"), resolve(candidate, "core"), { recursive: true });
  await cp(resolve(root, "distribution/release/statistical"), resolve(candidate, "distribution/release/statistical"), { recursive: true });
  await mkdir(resolve(candidate, "scripts")); await cp(resolve(root, "scripts/statistical-evidence-validation.mjs"), resolve(candidate, "scripts/statistical-evidence-validation.mjs"));
  const modelPath = resolve(candidate, "distribution/release/statistical/model-manifest.json");
  const profilePath = resolve(candidate, "distribution/release/statistical/profile.json");
  const model = JSON.parse(await readFile(modelPath, "utf8"));
  Object.assign(model, { id: "approved-provider-model", status: "frozen", configuration: { provider: "provider.example", model: "model-1", revision: "2026-08-15", temperature: 0, seed: 421 } });
  const modelBytes = `${JSON.stringify(model, null, 2)}\n`; await writeFile(modelPath, modelBytes);
  const profile = JSON.parse(await readFile(profilePath, "utf8")); profile.manifest_hashes.model = sha256(modelBytes); await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  assert.equal((await validateCandidatePreregistration(root, candidate)).documents.model.status, "frozen");
  profile.manifest_hashes.model = `sha256:${"0".repeat(64)}`; await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  await assert.rejects(loadPreregistration(candidate), /exact-bind preregistered corpus\/manifests/);
});

test("REL-001 trusted profile comparison rejects threshold, seed, trial, exclusion, and scorer substitutions", async (context) => {
  for (const mutation of ["threshold", "seed", "trials", "exclusions", "scorer"]) {
    const candidate = await mkdtemp(resolve(tmpdir(), `kdlc-profile-${mutation}-`)); context.after(() => rm(candidate, { recursive: true, force: true }));
    await cp(resolve(root, "core"), resolve(candidate, "core"), { recursive: true });
    await cp(resolve(root, "distribution/release/statistical"), resolve(candidate, "distribution/release/statistical"), { recursive: true });
    await mkdir(resolve(candidate, "scripts")); await cp(resolve(root, "scripts/statistical-evidence-validation.mjs"), resolve(candidate, "scripts/statistical-evidence-validation.mjs"));
    const modelPath = resolve(candidate, "distribution/release/statistical/model-manifest.json"); const profilePath = resolve(candidate, "distribution/release/statistical/profile.json");
    const model = JSON.parse(await readFile(modelPath, "utf8")); const profile = JSON.parse(await readFile(profilePath, "utf8"));
    if (mutation === "threshold") profile.metrics[0].minimum_wilson_lower_bound = 0;
    if (mutation === "trials") profile.required_trials = 1;
    if (mutation === "exclusions") profile.exclusions.allowed = true;
    if (mutation === "scorer") profile.scorer.version = 2;
    if (mutation === "seed") { model.configuration.seed = 7; const bytes = `${JSON.stringify(model, null, 2)}\n`; await writeFile(modelPath, bytes); profile.manifest_hashes.model = sha256(bytes); }
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
    await assert.rejects(validateCandidatePreregistration(root, candidate), undefined, mutation);
  }
});

test("REL-001 qualified lifecycle accepts 30 exact trials and rejects missing captured evidence", async (context) => {
  const candidate = await mkdtemp(resolve(tmpdir(), "kdlc-qualified-")); context.after(() => rm(candidate, { recursive: true, force: true }));
  await cp(resolve(root, "core"), resolve(candidate, "core"), { recursive: true }); await cp(resolve(root, "distribution/release/statistical"), resolve(candidate, "distribution/release/statistical"), { recursive: true });
  await mkdir(resolve(candidate, "scripts")); await cp(resolve(root, "scripts/statistical-evidence-validation.mjs"), resolve(candidate, "scripts/statistical-evidence-validation.mjs"));
  const modelPath = resolve(candidate, "distribution/release/statistical/model-manifest.json"); const profilePath = resolve(candidate, "distribution/release/statistical/profile.json");
  const model = JSON.parse(await readFile(modelPath, "utf8")); Object.assign(model, { id: "approved-provider-model", status: "frozen", configuration: { provider: "provider.example", model: "model-1", revision: "2026-08-15", temperature: 0, seed: 421 } });
  const modelBytes = `${JSON.stringify(model, null, 2)}\n`; await writeFile(modelPath, modelBytes); const profile = JSON.parse(await readFile(profilePath, "utf8")); profile.manifest_hashes.model = sha256(modelBytes); await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  const capturesPath = resolve(candidate, "distribution/release/statistical/captures"); await mkdir(capturesPath);
  const captures = []; for (let index = 1; index <= 30; index += 1) { const capture = await perfectCapture(index, candidate); captures.push(capture); await writeFile(resolve(capturesPath, `${capture.trial_id}.json`), `${JSON.stringify(capture)}\n`); }
  const report = await scoreCaptures(candidate, captures); const reportBytes = `${JSON.stringify(report)}\n`; await writeFile(resolve(candidate, "distribution/release/statistical/report.json"), reportBytes);
  const status = { api_version: "kdlc.dev/statistical-capture-status/v1alpha1", status: "qualified", reason: "Thirty complete provider trials passed the preregistered gate.", required_trials: 30, required_full_corpus_cases_per_trial: 12, captured_trials: 30, exclusions_allowed: false, captures_path: "distribution/release/statistical/captures", report_path: "distribution/release/statistical/report.json", report_hash: sha256(reportBytes) };
  await writeFile(resolve(candidate, "distribution/release/statistical/capture-status.json"), `${JSON.stringify(status, null, 2)}\n`);
  assert.deepEqual(await validateStatisticalEvidence(candidate), { phase: "qualified", failures: [] });
  await rm(resolve(capturesPath, "trial-030.json")); assert.equal((await validateStatisticalEvidence(candidate)).phase, "invalid");
});

test("REL-001 protected matrix-cell release command accepts a coherent qualified candidate precheck", async (context) => {
  const candidate = await mkdtemp(resolve(tmpdir(), "kdlc-qualified-command-")); context.after(() => rm(candidate, { recursive: true, force: true }));
  for (const path of ["core", "distribution", "docs", "packages", "scripts", "tests"]) { await mkdir(resolve(candidate, path, ".."), { recursive: true }); await cp(resolve(root, path), resolve(candidate, path), { recursive: true }); }
  await cp(resolve(root, "package.json"), resolve(candidate, "package.json")); await cp(resolve(root, "package-lock.json"), resolve(candidate, "package-lock.json"));
  const modelPath = resolve(candidate, "distribution/release/statistical/model-manifest.json"); const profilePath = resolve(candidate, "distribution/release/statistical/profile.json");
  const model = JSON.parse(await readFile(modelPath, "utf8")); Object.assign(model, { id: "approved-provider-model", status: "frozen", configuration: { provider: "provider.example", model: "model-1", revision: "2026-08-15", temperature: 0, seed: 421 } });
  const modelBytes = `${JSON.stringify(model, null, 2)}\n`; await writeFile(modelPath, modelBytes); const profile = JSON.parse(await readFile(profilePath, "utf8")); profile.manifest_hashes.model = sha256(modelBytes); await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  const capturesPath = resolve(candidate, "distribution/release/statistical/captures"); await mkdir(capturesPath); const captures = [];
  for (let index = 1; index <= 30; index += 1) { const capture = await perfectCapture(index, candidate); captures.push(capture); await writeFile(resolve(capturesPath, `${capture.trial_id}.json`), `${JSON.stringify(capture)}\n`); }
  const statisticalReport = await scoreCaptures(candidate, captures); const statisticalReportBytes = `${JSON.stringify(statisticalReport)}\n`; await writeFile(resolve(candidate, "distribution/release/statistical/report.json"), statisticalReportBytes);
  await writeFile(resolve(candidate, "distribution/release/statistical/capture-status.json"), `${JSON.stringify({ api_version: "kdlc.dev/statistical-capture-status/v1alpha1", status: "qualified", reason: "Thirty complete provider trials passed the preregistered gate.", required_trials: 30, required_full_corpus_cases_per_trial: 12, captured_trials: 30, exclusions_allowed: false, captures_path: "distribution/release/statistical/captures", report_path: "distribution/release/statistical/report.json", report_hash: sha256(statisticalReportBytes) }, null, 2)}\n`);
  const version = "1.0.0"; const packageDocument = JSON.parse(await readFile(resolve(candidate, "package.json"), "utf8")); packageDocument.version = version; packageDocument.private = false; await writeFile(resolve(candidate, "package.json"), `${JSON.stringify(packageDocument, null, 2)}\n`);
  const lock = JSON.parse(await readFile(resolve(candidate, "package-lock.json"), "utf8")); lock.version = version; lock.packages[""].version = version; await writeFile(resolve(candidate, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  const evaluationPath = resolve(candidate, "distribution/release/evaluation-report.json"); const evaluation = JSON.parse(await readFile(evaluationPath, "utf8")); Object.assign(evaluation, { release_status: "release-candidate", implementation_version: version, statistical_suite: { status: "qualified", release_blocking: false }, pending_release_evidence: [] }); const evaluationBytes = `${JSON.stringify(evaluation, null, 2)}\n`; await writeFile(evaluationPath, evaluationBytes);
  const tracePath = resolve(candidate, "docs/traceability.json"); const trace = JSON.parse(await readFile(tracePath, "utf8")); trace.requirements.find(({ id }) => id === "REL-001").status = "verified"; const traceBytes = `${JSON.stringify(trace, null, 2)}\n`; await writeFile(tracePath, traceBytes);
  const conformancePath = resolve(candidate, "distribution/release/conformance-statement.json"); const conformance = JSON.parse(await readFile(conformancePath, "utf8")); Object.assign(conformance, { release_status: "release-candidate", pending_requirements: [] }); Object.assign(conformance.implementation, { version, private: false });
  for (const item of conformance.evidence) { if (item.path === "distribution/release/evaluation-report.json") item.sha256 = sha256(evaluationBytes); if (item.path === "docs/traceability.json") item.sha256 = sha256(traceBytes); }
  await writeFile(conformancePath, `${JSON.stringify(conformance, null, 2)}\n`); const changelog = `# Changelog\n\n## ${version}\n`; await writeFile(resolve(candidate, "CHANGELOG.md"), changelog);
  await writeFile(resolve(candidate, "distribution/release/release-candidate-evidence.json"), `${JSON.stringify({ api_version: "kdlc.dev/release-candidate-evidence/v1alpha1", version, changelog: { path: "CHANGELOG.md", sha256: sha256(changelog) } }, null, 2)}\n`);
  await execute(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "check:release-evidence"], { cwd: root, env: { ...process.env, KDLC_CANDIDATE_ROOT: candidate, KDLC_RELEASE_MATRIX_PRECHECK: "1" }, ...(process.platform === "win32" ? { shell: true } : {}), maxBuffer: 16 * 1024 * 1024 });
});

test("REL-001 offline scorer derives declared Wilson bounds from all 30 complete trials", async () => {
  const captures = await Promise.all(Array.from({ length: 30 }, (_, index) => perfectCapture(index + 1))); const report = await scoreCaptures(root, captures);
  assert.equal(report.trial_count, 30); assert.equal(report.case_count_per_trial, 12); assert.equal(report.gate, "passed");
  for (const metric of report.metrics) { assert.equal(metric.rate, 1); assert.equal(metric.wilson_lower_bound, wilsonLower(metric.successes, metric.observations, 1.959963984540054)); }
});

test("REL-001 capture validation rejects missing cases, substitutions, request drift, raw-output drift, exclusions, and provenance drift", async () => {
  for (const mutation of ["missing", "substitution", "request", "raw", "exclusion", "provenance"]) {
    const capture = await perfectCapture(1);
    if (mutation === "missing") capture.results.pop();
    if (mutation === "substitution") capture.results[0].case_id = capture.results[1].case_id;
    if (mutation === "request") capture.results[0].request = capture.results[1].request;
    if (mutation === "raw") capture.results[0].raw_output = '{"decision":"deny","answer":""}';
    if (mutation === "exclusion") capture.exclusions.push("grounded-source");
    if (mutation === "provenance") capture.model_hash = capture.manifest_hashes.model = `sha256:${"0".repeat(64)}`;
    await assert.rejects(validateCapture(root, capture), undefined, mutation);
  }
});

test("REL-001 scorer rejects cross-trial provider replay and any disclosing security denial", async () => {
  const captures = await Promise.all(Array.from({ length: 30 }, (_, index) => perfectCapture(index + 1)));
  const replayed = structuredClone(captures); replayed[29].results[0].provider_request_id = replayed[0].results[0].provider_request_id;
  await assert.rejects(scoreCaptures(root, replayed), /360 provider request IDs/);
  const leaking = structuredClone(captures); const index = (await loadPreregistration(root)).documents.corpus.cases.findIndex(({ security }) => security);
  const response = { ...leaking[0].results[index].response, answer: "confidential source text" }; leaking[0].results[index].response = response;
  leaking[0].results[index].raw_output = JSON.stringify(response); leaking[0].results[index].raw_output_hash = sha256(leaking[0].results[index].raw_output);
  const report = await scoreCaptures(root, leaking); const security = report.metrics.find(({ id }) => id === "security_fail_closed");
  assert.equal(security.passed, false); assert.equal(report.gate, "failed");
});

test("REL-001 scorer rejects missing, duplicate, extra, or post-hoc-selected trials", async () => {
  const captures = await Promise.all(Array.from({ length: 30 }, (_, index) => perfectCapture(index + 1)));
  await assert.rejects(scoreCaptures(root, captures.slice(0, 29)), /exactly 30/);
  const duplicate = structuredClone(captures); duplicate[29].trial_id = "trial-029"; await assert.rejects(scoreCaptures(root, duplicate), /trial-001 through trial-030/);
  const selected = structuredClone(captures); selected[0].exclusions = ["stale-source"]; await assert.rejects(scoreCaptures(root, selected), /capture contract/);
});
