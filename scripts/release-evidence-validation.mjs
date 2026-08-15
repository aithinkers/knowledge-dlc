import { createHash } from "node:crypto";
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

export async function validateReleaseEvidence(root = resolve(import.meta.dirname, "..")) {
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
