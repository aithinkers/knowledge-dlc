import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const paths = Object.freeze({
  corpus: "distribution/release/statistical/corpus.json", profile: "distribution/release/statistical/profile.json",
  prompt: "distribution/release/statistical/prompt-manifest.json", tool: "distribution/release/statistical/tool-manifest.json",
  model: "distribution/release/statistical/model-manifest.json", status: "distribution/release/statistical/capture-status.json",
});
const schemaPaths = Object.freeze({
  common: "core/schemas/common.schema.json", corpus: "core/schemas/release/statistical-corpus.schema.json",
  profile: "core/schemas/release/statistical-profile.schema.json", manifest: "core/schemas/release/statistical-manifest.schema.json",
  capture: "core/schemas/release/statistical-capture.schema.json", report: "core/schemas/release/statistical-report.schema.json",
});
const scorerIdentity = Object.freeze({ id: "kdlc-offline-statistical-scorer", version: 1, path: "scripts/statistical-evidence-validation.mjs" });
export const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const readBytes = (root, path) => readFile(resolve(root, path));
const readJson = async (root, path) => JSON.parse(await readBytes(root, path));
export async function validateScorerBinding(root, profile) {
  const scorerHash = sha256(await readBytes(root, scorerIdentity.path));
  if (!same(profile.scorer, { ...scorerIdentity, sha256: scorerHash })) throw new Error("profile does not exact-bind the offline scorer source and version");
  return scorerHash;
}

async function validator(root) {
  const ajv = new Ajv2020({ allErrors: true, strict: true }); addFormats(ajv);
  for (const path of Object.values(schemaPaths)) ajv.addSchema(await readJson(root, path));
  return ajv;
}
export async function loadPreregistration(root) {
  const ajv = await validator(root); const documents = {}; const bytes = {};
  for (const [name, path] of Object.entries(paths)) { bytes[name] = await readBytes(root, path); documents[name] = JSON.parse(bytes[name]); }
  for (const [name, schema] of [["corpus", "statistical-corpus"], ["profile", "statistical-profile"], ["prompt", "statistical-manifest"], ["tool", "statistical-manifest"], ["model", "statistical-manifest"]]) {
    const validate = ajv.getSchema(`https://kdlc.dev/schemas/release/${schema}-1.json`); if (!validate(documents[name])) throw new Error(`${name} contract: ${ajv.errorsText(validate.errors)}`);
  }
  const hashes = { corpus: sha256(bytes.corpus), profile: sha256(bytes.profile), prompt: sha256(bytes.prompt), tool: sha256(bytes.tool), model: sha256(bytes.model) };
  if (documents.profile.corpus_hash !== hashes.corpus || !same(documents.profile.manifest_hashes, { prompt: hashes.prompt, tool: hashes.tool, model: hashes.model })) throw new Error("profile does not exact-bind preregistered corpus/manifests");
  const scorerHash = await validateScorerBinding(root, documents.profile);
  hashes.scorer = scorerHash;
  const ids = documents.corpus.cases.map(({ id }) => id); if (new Set(ids).size !== ids.length) throw new Error("duplicate corpus case IDs");
  if (documents.prompt.id !== "governed-answer-v1" || documents.corpus.cases.some(({ prompt_id }) => prompt_id !== documents.prompt.id) || documents.tool.id !== "offline-no-tools") throw new Error("corpus prompt or tool manifest identity was substituted");
  const metricIds = documents.profile.metrics.map(({ id }) => id); if (!same(metricIds, ["decision_accuracy", "required_term_recall", "security_fail_closed"])) throw new Error("metric set/order was substituted");
  return { ajv, documents, hashes, caseIds: ids };
}
export async function validateCandidatePreregistration(trustedRoot, candidateRoot) {
  const trusted = await loadPreregistration(trustedRoot); const candidate = await loadPreregistration(candidateRoot);
  const trustedProfile = structuredClone(trusted.documents.profile); const candidateProfile = structuredClone(candidate.documents.profile);
  candidateProfile.manifest_hashes.model = trustedProfile.manifest_hashes.model;
  if (!same(candidateProfile, trustedProfile)) throw new Error("candidate statistical profile changed outside the permitted model hash transition");
  const trustedModel = trusted.documents.model; const candidateModel = candidate.documents.model;
  if (same(candidateModel, trustedModel)) return candidate;
  if (trustedModel.status !== "awaiting-provider-inputs" || candidateModel.status !== "frozen" ||
      candidateModel.api_version !== trustedModel.api_version || candidateModel.kind !== trustedModel.kind || candidateModel.version !== trustedModel.version ||
      candidateModel.configuration.temperature !== trustedModel.configuration.temperature || candidateModel.configuration.seed !== trustedModel.configuration.seed) {
    throw new Error("candidate model manifest is not the permitted pending-to-frozen transition");
  }
  return candidate;
}
export function providerRequestBytes(state, trialId, releaseCase) {
  return `${JSON.stringify({ api_version: "kdlc.dev/statistical-provider-request/v1alpha1", trial_id: trialId, case: releaseCase,
    prompt: state.documents.prompt, tool: state.documents.tool, model: state.documents.model })}\n`;
}
export async function validateCapture(root, capture) {
  const state = await loadPreregistration(root); const validate = state.ajv.getSchema("https://kdlc.dev/schemas/release/statistical-capture-1.json");
  if (!validate(capture)) throw new Error(`capture contract: ${state.ajv.errorsText(validate.errors)}`);
  if (capture.corpus_hash !== state.hashes.corpus || capture.profile_hash !== state.hashes.profile || !same(capture.manifest_hashes, state.documents.profile.manifest_hashes)) throw new Error("capture provenance hash mismatch");
  const ids = capture.results.map(({ case_id }) => case_id); if (!same(ids, state.caseIds) || new Set(ids).size !== ids.length) throw new Error("capture must contain the complete corpus exactly once in preregistered order");
  const providerIds = capture.results.map(({ provider_request_id }) => provider_request_id);
  if (new Set(providerIds).size !== providerIds.length) throw new Error("provider request IDs must be unique within a trial");
  for (let index = 0; index < capture.results.length; index += 1) {
    const result = capture.results[index]; const expectedRequest = providerRequestBytes(state, capture.trial_id, state.documents.corpus.cases[index]);
    if (result.request !== expectedRequest || result.request_hash !== sha256(expectedRequest)) throw new Error(`${result.case_id}: provider request differs from the frozen prompt/case/model request`);
    if (sha256(result.raw_output) !== result.raw_output_hash) throw new Error(`${result.case_id}: raw output hash mismatch`);
    let parsed; try { parsed = JSON.parse(result.raw_output); } catch { throw new Error(`${result.case_id}: raw output is not JSON`); }
    if (!same(parsed, result.response)) throw new Error(`${result.case_id}: parsed response differs from raw provider output`);
  }
  if (!Number.isFinite(Date.parse(capture.captured_at))) throw new Error("capture timestamp is not a real instant");
  return state;
}
export function wilsonLower(successes, observations, z) {
  const rate = successes / observations; const z2 = z * z; const denominator = 1 + z2 / observations;
  return (rate + z2 / (2 * observations) - z * Math.sqrt((rate * (1 - rate) + z2 / (4 * observations)) / observations)) / denominator;
}
export async function scoreCaptures(root, captures) {
  const state = await loadPreregistration(root); if (captures.length !== 30) throw new Error("exactly 30 trials are required; no missing or post-hoc excluded trials");
  const expectedTrials = Array.from({ length: 30 }, (_, index) => `trial-${String(index + 1).padStart(3, "0")}`);
  const actualTrials = captures.map(({ trial_id }) => trial_id).sort(); if (!same(actualTrials, expectedTrials)) throw new Error("capture set must contain exact trial-001 through trial-030");
  for (const capture of captures) await validateCapture(root, capture);
  const providerIds = captures.flatMap(({ results }) => results.map(({ provider_request_id }) => provider_request_id));
  if (providerIds.length !== 360 || new Set(providerIds).size !== 360) throw new Error("all 360 provider request IDs must be globally unique");
  let decisions = 0, terms = 0, termTotal = 0, secure = 0, secureTotal = 0;
  for (const capture of captures) for (let index = 0; index < state.documents.corpus.cases.length; index += 1) {
    const expected = state.documents.corpus.cases[index]; const actual = capture.results[index].response;
    decisions += Number(actual.decision === expected.expected.decision);
    for (const term of expected.expected.required_terms) { termTotal += 1; terms += Number(actual.answer.toLocaleLowerCase().includes(term.toLocaleLowerCase())); }
    if (expected.security) { secureTotal += 1; secure += Number(actual.decision === expected.expected.decision && actual.answer === ""); }
  }
  const observations = captures.length * state.caseIds.length;
  const counts = { decision_accuracy: [decisions, observations], required_term_recall: [terms, termTotal], security_fail_closed: [secure, secureTotal] };
  const metrics = state.documents.profile.metrics.map(({ id, minimum_wilson_lower_bound: threshold }) => {
    const [successes, count] = counts[id]; const rate = successes / count; const lower = wilsonLower(successes, count, state.documents.profile.wilson_z);
    return { id, successes, observations: count, rate, wilson_lower_bound: lower, threshold, passed: lower >= threshold && (id !== "security_fail_closed" || successes === count) };
  });
  const captureSetHash = sha256(Buffer.from(captures.sort((a,b) => a.trial_id.localeCompare(b.trial_id)).map((item) => sha256(Buffer.from(`${JSON.stringify(item)}\n`))).join("\n")));
  return { api_version: "kdlc.dev/statistical-report/v1alpha1", release_status: "not-ready", corpus_hash: state.hashes.corpus, profile_hash: state.hashes.profile, capture_set_hash: captureSetHash, trial_count: 30, case_count_per_trial: state.caseIds.length, metrics, gate: metrics.every(({ passed }) => passed) ? "passed" : "failed" };
}
export async function loadCaptures(directory) {
  const names = (await readdir(directory)).filter((name) => /^trial-\d{3}\.json$/.test(name)).sort();
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(resolve(directory, name), "utf8"))));
}
export async function validatePendingStatisticalEvidence(root) {
  try {
    const state = await loadPreregistration(root); const status = await readJson(root, paths.status);
    if (state.documents.model.status !== "awaiting-provider-inputs" || status.status !== "blocked" || status.captured_trials !== 0 || status.required_trials !== 30 || status.required_full_corpus_cases_per_trial !== state.caseIds.length || status.exclusions_allowed !== false) return ["statistical capture blocker is not exact and fail-closed"];
    return [];
  } catch (error) { return [`statistical preregistration is unavailable or invalid: ${error.message}`]; }
}
export { paths as statisticalEvidenceFiles, schemaPaths as statisticalEvidenceSchemas };
