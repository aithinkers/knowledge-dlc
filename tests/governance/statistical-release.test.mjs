import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { loadPreregistration, providerRequestBytes, scoreCaptures, sha256, validateCapture, validateScorerBinding, wilsonLower } from "../../scripts/statistical-evidence-validation.mjs";

const root = resolve(import.meta.dirname, "../..");
async function perfectCapture(index) {
  const state = await loadPreregistration(root);
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
  assert.equal((await loadPreregistration(candidate)).documents.model.status, "frozen");
  profile.manifest_hashes.model = `sha256:${"0".repeat(64)}`; await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  await assert.rejects(loadPreregistration(candidate), /exact-bind preregistered corpus\/manifests/);
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
