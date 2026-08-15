import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { descriptors } from "../packages/normalizers/index.mjs";
import { artifactHash } from "../packages/core/index.mjs";
import { readTrustedFile } from "./supply-chain-validation.mjs";
import { conformanceModules, mandatoryProfileRequirements, mandatoryReleaseCases } from "./release-evidence-definition.mjs";
import { validateStatisticalEvidence } from "./statistical-evidence-validation.mjs";

const files = Object.freeze({
  conformance: "distribution/release/conformance-statement.json",
  corpus: "distribution/release/evaluation-corpus.json",
  profile: "distribution/release/evaluation-profile.json",
  run: "distribution/release/recorded-run.json",
  report: "distribution/release/evaluation-report.json",
});
const schemas = Object.freeze({
  common: "core/schemas/common.schema.json",
  conformance: "core/schemas/release/conformance-statement.schema.json",
  corpus: "core/schemas/release/evaluation-corpus.schema.json",
  profile: "core/schemas/release/evaluation-profile.schema.json",
  run: "core/schemas/release/recorded-run.schema.json",
  report: "core/schemas/release/evaluation-report.schema.json",
});

export async function validateReleaseCandidateEvidence(root, { version, headSha, matrixResults, trustedRepositorySnapshot, trustedReviewRecord, precheck = false } = {}) {
  const failures = []; let evidence; let schema;
  try { schema = await json(root, "core/schemas/release/release-candidate-evidence.schema.json"); evidence = await json(root, "distribution/release/release-candidate-evidence.json"); }
  catch (error) { return [`release-candidate evidence is unavailable: ${error.message}`]; }
  const ajv = new Ajv2020({ allErrors: true, strict: true }); addFormats(ajv); ajv.addSchema(await json(root, schemas.common)); const validate = ajv.compile(schema);
  if (!validate(evidence)) return [`release-candidate evidence contract: ${ajv.errorsText(validate.errors)}`];
  if (evidence.version !== version) failures.push("release-candidate evidence does not exact-bind the package version");
  for (const item of [evidence.changelog]) {
    try { if (digest(await bytes(root, item.path)) !== item.sha256) failures.push(`release-candidate evidence hash drift: ${item.path}`); }
    catch (error) { failures.push(`release-candidate evidence unavailable: ${item.path} (${error.message})`); }
  }
  try { if (!(await bytes(root, evidence.changelog.path)).toString("utf8").includes(version)) failures.push("changelog does not declare the candidate version"); } catch {}
  if (precheck) return failures;
  if (!headSha || !Array.isArray(matrixResults) || matrixResults.length !== 6) failures.push("trusted exact-head six-cell matrix evidence is unavailable");
  else {
    const observed = matrixResults.map(({ head_sha, observed_evidence }) => ({ head_sha, observed_evidence }));
    if (observed.some(({ head_sha }) => head_sha !== headSha)) failures.push("matrix artifacts do not exact-bind the candidate head");
    const packages = matrixResults.map(({ platform, observed_evidence }) => ({ os: platform?.os, value: observed_evidence?.package }));
    if (packages.some(({ value }) => !value || value.first_sha256 !== value.second_sha256)) failures.push("two-build package bytes are not identical within every release cell");
    for (const os of ["linux", "win32", "darwin"]) { const group = packages.filter((item) => item.os === os).map(({ value }) => value); if (group.length !== 2 || !group.every((item) => same(item, group[0]))) failures.push(`${os} package evidence differs across supported Node runtimes`); }
    if (!packages.every(({ value }) => value?.content_sha256 === packages[0].value?.content_sha256 && value?.file_count === packages[0].value?.file_count)) failures.push("package paths/content/size differ across release platforms");
    const supply = observed.map(({ observed_evidence }) => observed_evidence?.supply_chain);
    if (supply.some((item) => !item) || !supply.every((item) => same(item, supply[0]))) failures.push("verified SBOM/notices bytes differ across release cells");
    if (observed.some(({ observed_evidence }) => observed_evidence?.smoke?.cli !== true || observed_evidence?.smoke?.imports !== true)) failures.push("installed package CLI/import smoke was not observed in every release cell");
  }
  const expectedChecks = ["Candidate tests", "CodeQL (JavaScript/TypeScript)", "Dependency review", "Pull request traceability", "Release matrix", "Repository policy", "Secret history scan", "Supply-chain verification"].sort();
  try {
    const settings = JSON.parse(await readFile(trustedRepositorySnapshot, "utf8")); const ruleset = settings.ruleset;
    if (settings.visibility !== "public" || settings.actions?.default_workflow_permissions !== "read" || settings.actions.can_approve_pull_request_reviews !== false || settings.release_blocking_issues_closed !== true || ruleset?.active !== true || ruleset.default_branch !== true || ruleset.prevents_deletion !== true || ruleset.prevents_non_fast_forward !== true || ruleset.linear_history !== true || ruleset.strict_status_checks !== true || ruleset.direct_push_bypass !== false || ruleset.pull_request?.required_approvals < 1 || ruleset.pull_request.require_code_owner_review !== true || ruleset.pull_request.dismiss_stale_reviews !== true || ruleset.pull_request.require_last_push_approval !== true || ruleset.pull_request.require_thread_resolution !== true || !same(ruleset.pull_request.allowed_merge_methods, ["squash"]) || !same(ruleset.required_checks, expectedChecks)) failures.push("trusted live repository ruleset is not release-ready");
  } catch { failures.push("trusted live repository ruleset is unavailable or invalid"); }
  try {
    const review = JSON.parse(await readFile(trustedReviewRecord, "utf8"));
    if (review.decision !== "approved" || review.head_sha !== headSha || !["independent-agent-comment", "formal-review"].includes(review.evidence_kind) || !Number.isInteger(review.evidence_id) || typeof review.evidence_url !== "string" || !review.actor) failures.push("trusted live independent review is not an exact-head approval");
  } catch { failures.push("trusted live independent review is unavailable or invalid"); }
  return failures;
}

function digest(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

async function bytes(root, path) { return readTrustedFile(root, path); }
async function json(root, path) { return JSON.parse((await bytes(root, path)).toString("utf8")); }

export function validateReleaseLifecycle({ manifest, lock, conformance, report, rel, statisticalPhase }) {
  const failures = [];
  const exactVersions = lock?.version === manifest?.version && lock?.packages?.[""]?.version === manifest?.version && conformance?.implementation?.version === manifest?.version && report?.implementation_version === manifest?.version;
  const prerelease = manifest?.private === true && manifest?.version === "0.0.0-private" && exactVersions && conformance?.implementation?.private === true && conformance?.release_status === "not-ready" && report?.release_status === "not-ready" && report?.statistical_suite?.status === "pending" && report?.statistical_suite?.release_blocking === true && report?.pending_release_evidence?.length > 0 && rel?.status === "in-progress" && conformance?.pending_requirements?.some(({ id }) => id === "REL-001") && statisticalPhase === "pending";
  const candidate = manifest?.private === false && /^[1-9][0-9]*\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(manifest?.version ?? "") && exactVersions && conformance?.implementation?.private === false && conformance?.release_status === "release-candidate" && conformance?.pending_requirements?.length === 0 && report?.release_status === "release-candidate" && report?.statistical_suite?.status === "qualified" && report?.statistical_suite?.release_blocking === false && report?.pending_release_evidence?.length === 0 && report?.summary?.structural_gate === "passed" && rel?.status === "verified" && statisticalPhase === "qualified";
  if (!prerelease && !candidate) failures.push("release lifecycle phase is inconsistent or attempts an unsupported publication/released state");
  return failures;
}

export async function validateReleaseEvidence(root = resolve(import.meta.dirname, ".."), runtimeEvidence = {}) {
  const failures = [];
  const statistical = await validateStatisticalEvidence(root); failures.push(...statistical.failures);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const loadedSchemas = {};
  for (const [name, path] of Object.entries(schemas)) {
    try { loadedSchemas[name] = await json(root, path); ajv.addSchema(loadedSchemas[name]); }
    catch (error) { failures.push(`${name} schema is unavailable or invalid: ${error.message}`); }
  }
  const documents = {}; const documentBytes = {};
  for (const [name, path] of Object.entries(files)) {
    try {
      documentBytes[name] = await bytes(root, path);
      documents[name] = JSON.parse(documentBytes[name].toString("utf8"));
      const validate = loadedSchemas[name] && ajv.getSchema(loadedSchemas[name].$id);
      if (!validate || !validate(documents[name])) failures.push(`${name} contract: ${ajv.errorsText(validate?.errors, { separator: "; " })}`);
    } catch (error) { failures.push(`${name} evidence is unavailable or invalid: ${error.message}`); }
  }
  const { conformance, corpus, profile, run, report } = documents;
  if (!conformance || !corpus || !profile || !run || !report) return failures;

  if (profile.corpus.sha256 !== digest(documentBytes.corpus)) failures.push("evaluation profile does not bind the exact corpus bytes");
  if (run.corpus_hash !== digest(documentBytes.corpus) || run.profile_hash !== digest(documentBytes.profile)) failures.push("recorded run does not bind exact corpus/profile bytes");
  if (report.run_hash !== digest(documentBytes.run)) failures.push("evaluation report does not bind the exact recorded run bytes");

  const caseIds = corpus.cases.map(({ id }) => id); const resultIds = run.results.map(({ case_id: id }) => id);
  const mandatoryCaseIds = Object.keys(mandatoryReleaseCases);
  if (new Set(caseIds).size !== caseIds.length || !same(caseIds, mandatoryCaseIds) || !same(resultIds, mandatoryCaseIds)) failures.push("corpus and run must preserve the exact mandatory release case set and order");
  if (new Set(resultIds).size !== resultIds.length) failures.push("recorded results contain duplicate case IDs");
  if (!same(profile.mandatory_requirements, mandatoryProfileRequirements)) failures.push("evaluation profile mandatory requirements are incomplete or substituted");
  for (const entry of corpus.cases) {
    const mandatory = mandatoryReleaseCases[entry.id];
    if (!mandatory || !same(entry.requirement_ids, mandatory.requirements) || entry.executable_evidence?.path !== mandatory.evidence || !same(entry.executable_evidence?.test_ids, mandatory.tests)) {
      failures.push(`${entry.id}: immutable requirements or executable evidence were substituted`);
    }
    if (mandatory?.fixtures && !same(entry.fixtures, mandatory.fixtures)) failures.push(`${entry.id}: committed clean-rebuild fixture set or hashes were substituted`);
    try {
      const evidenceBytes = await bytes(root, entry.executable_evidence.path);
      if (digest(evidenceBytes) !== entry.executable_evidence.sha256) failures.push(`${entry.id}: executable evidence hash drift`);
    } catch (error) { failures.push(`${entry.id}: executable evidence is unavailable (${error.message})`); }
    const result = run.results.find(({ case_id: id }) => id === entry.id);
    if (!result || result.case_hash !== artifactHash(entry) || result.evidence_hash !== entry.executable_evidence.sha256) failures.push(`${entry.id}: recorded result does not exact-bind its corpus case and executable evidence`);
    for (const fixture of entry.fixtures) {
    try {
      const fixtureBytes = await bytes(root, fixture.path);
      if (digest(fixtureBytes) !== fixture.sha256) failures.push(`${entry.id}: fixture hash drift: ${fixture.path}`);
      if (fixture.path.startsWith("tests/fixtures/models/")) {
        const recording = JSON.parse(fixtureBytes.toString("utf8"));
        if (recording.model?.provider !== "recorded") failures.push(`${entry.id}: release model fixture is not recorded-only`);
      }
    } catch (error) { failures.push(`${entry.id}: fixture is unavailable: ${fixture.path} (${error.message})`); }
    }
  }

  const passed = run.results.filter(({ status }) => status === "passed").length;
  const failed = run.results.length - passed;
  const securityIds = new Set(corpus.cases.filter(({ security }) => security).map(({ id }) => id));
  const securityFailures = run.results.filter(({ case_id: id, status }) => securityIds.has(id) && status !== "passed").length;
  const thresholdPassed = passed / run.results.length >= profile.structural_thresholds.minimum_pass_rate &&
    securityFailures <= profile.structural_thresholds.security_failures_allowed && run.live_model_calls <= profile.structural_thresholds.live_model_calls_allowed;
  const expectedSummary = { total: run.results.length, passed, failed, security_failures: securityFailures, structural_gate: thresholdPassed ? "passed" : "failed" };
  if (!same(report.summary, expectedSummary)) failures.push("evaluation report summary is not derived from the recorded results/profile");
  if (run.external_network_calls !== 0 || run.live_model_calls !== 0 || profile.mode !== "recorded-only") failures.push("release structural evidence must be recorded and externally offline");

  const moduleNames = conformance.modules.map(({ name }) => name); const expectedModuleNames = Object.keys(conformanceModules);
  if (!same(moduleNames, expectedModuleNames)) failures.push("conformance modules must preserve the exact implemented module set and order");
  const governed = conformance.modules.find(({ name }) => name === "Governed");
  if (governed?.status !== "implemented" || !governed.requirement_ids.includes("FEAT-009") || conformance.pending_requirements.some(({ id }) => id === "FEAT-009")) failures.push("Governed implementation must bind merged FEAT-009 evidence");
  if (!same([...Object.keys(descriptors)].sort(), [...conformance.format_profiles].sort())) failures.push("conformance format profiles differ from the shipped normalizer descriptors");
  for (const module of conformance.modules) {
    const expected = conformanceModules[module.name];
    if (!expected || module.status !== "implemented" || !same(module.requirement_ids, expected.requirements) || !same(module.evidence.map(({ path }) => path), expected.evidence)) failures.push(`${module.name}: conformance claim differs from its allowlisted trace/evidence definition`);
    for (const item of module.evidence) {
      try { if (digest(await bytes(root, item.path)) !== item.sha256) failures.push(`${module.name}: conformance evidence hash drift: ${item.path}`); }
      catch (error) { failures.push(`${module.name}: conformance evidence is unavailable: ${item.path} (${error.message})`); }
    }
  }
  for (const item of conformance.evidence) {
    try { if (digest(await bytes(root, item.path)) !== item.sha256) failures.push(`conformance evidence hash drift: ${item.path}`); }
    catch (error) { failures.push(`conformance evidence is unavailable: ${item.path} (${error.message})`); }
  }

  try {
    const advertised = await json(root, "distribution/conformance.json");
    if (!same(advertised.tools, conformance.tools) || !same(advertised.transports, conformance.transports) || !same(advertised.modules, moduleNames) || !same(advertised.formats, conformance.format_profiles)) failures.push("release statement differs from exact generated distribution conformance");
  } catch (error) { failures.push(`generated distribution conformance is unavailable: ${error.message}`); }
  let manifest; let lock;
  try { manifest = await json(root, "package.json"); lock = await json(root, "package-lock.json"); }
  catch (error) { failures.push(`package metadata is unavailable: ${error.message}`); }
  try {
    const traceability = await json(root, "docs/traceability.json");
    const rel = traceability.requirements?.find(({ id }) => id === "REL-001");
    const erasure = traceability.requirements?.find(({ id }) => id === "FEAT-009");
    if (rel?.issue !== 10) failures.push("REL-001 traceability must remain bound to issue #10");
    failures.push(...validateReleaseLifecycle({ manifest, lock, conformance, report, rel, statisticalPhase: statistical.phase }));
    if (conformance.release_status === "release-candidate") failures.push(...await validateReleaseCandidateEvidence(root, { version: manifest?.version, headSha: runtimeEvidence.headSha ?? process.env.KDLC_HEAD_SHA, matrixResults: runtimeEvidence.matrixResults, trustedRepositorySnapshot: runtimeEvidence.trustedRepositorySnapshot ?? process.env.KDLC_TRUSTED_REPOSITORY_SNAPSHOT, trustedReviewRecord: runtimeEvidence.trustedReviewRecord ?? process.env.KDLC_TRUSTED_REVIEW_RECORD, precheck: runtimeEvidence.precheck ?? process.env.KDLC_RELEASE_MATRIX_PRECHECK === "1" }));
    if (erasure?.issue !== 24 || !["implemented", "verified", "released"].includes(erasure.status) || !erasure.evidence?.tests?.includes("tests/governance/revocation-erasure.test.mjs")) failures.push("Governed conformance requires traceable merged FEAT-009 erasure evidence");
    for (const module of conformance.modules) for (const id of module.requirement_ids) {
      const traced = traceability.requirements?.find((entry) => entry.id === id);
      const claimed = module.evidence.map(({ path }) => path).filter((path) => traced?.evidence?.tests?.includes(path));
      if (!traced || !["implemented", "verified", "released"].includes(traced.status) || claimed.length === 0) failures.push(`${module.name}: ${id} is not implemented with exact traceable test evidence`);
    }
  } catch (error) { failures.push(`traceability is unavailable: ${error.message}`); }
  return failures;
}

export const releaseEvidenceFiles = files;
export const releaseEvidenceSchemas = schemas;
