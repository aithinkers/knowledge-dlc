import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createContractValidator } from "../../packages/contracts/index.mjs";
import { artifactHash } from "../../packages/core/index.mjs";
import {
  BUILT_IN_GOVERNANCE_SENSORS,
  GOVERNANCE_CONTROL_SCHEMA_PATHS,
  GovernanceControlAuthority,
  GovernanceControlEngine,
  propagateGovernanceMetadata
} from "../../packages/governance/index.mjs";

const fixture = JSON.parse(await readFile(new URL("../fixtures/governance/adversarial.json", import.meta.url)));
const instant = "2026-08-14T12:00:00.000Z";
const clock = { now: () => instant };
const policy = {
  api_version: "kdlc.dev/governance-policy/v1alpha1",
  id: "default-controls",
  version: 1,
  minimum_independent_sources: 2,
  required_erasure_surfaces: ["original", "normalized", "claim", "concept", "quote", "cache", "index", "embedding", "graph", "export", "log", "backup"],
  waiver_authorities: {
    "secret-pattern": { publication: ["security"] },
    "prompt-injection": { "model-route": ["security"] }
  },
  declassification_authorities: {
    "policy://classification/1": { roles: ["security", "governance"], from: ["restricted", "confidential", "internal"], to: ["public", "internal"] }
  },
  erasure_policy_refs: { "policy://retention/1": { roles: ["records"], actions: ["revoke", "erase"] } },
  external_models: {
    "local/recorded": { allowed: true, max_classification: "restricted" },
    "outside/general": { allowed: true, max_classification: "public" }
  }
};
const material = (overrides = {}) => ({
  id: "src_alpha",
  source_hash: `sha256:${"a".repeat(64)}`,
  source_class: "official",
  access: { classification: "internal", compartments: ["engineering"] },
  rights: { license: "Apache-2.0", redistribution: "allowed", derivative_use: "allowed", commercial_use: "allowed" },
  ...overrides
});
const claims = [{ id: "clm_ok", consequential: true, conflict: false, sources: [
  { source_id: "src_alpha", source_hash: `sha256:${"a".repeat(64)}`, source_class: "official" },
  { source_id: "src_beta", source_hash: `sha256:${"b".repeat(64)}`, source_class: "authoritative", authority_policy_ref: "policy://authority/1" }
] }];
const baseline = (extra = {}) => ({
  subject: "kb://example.team/concepts/control",
  content: "A factual, delimited source passage.",
  materials: [material()],
  derived_access: { classification: "internal" },
  target: { scope: "workspace", commercial: false },
  transformation: "derivative",
  claims,
  ...extra
});

async function runtime({ audit: suppliedAudit, erasureVerifier } = {}) {
  const events = [];
  const audit = suppliedAudit ?? { append: async (event) => { events.push(structuredClone(event)); } };
  const authority = new GovernanceControlAuthority({
    authenticate: async (credential) => credential === "trusted" ? { actor: "human:security@example.test", roles: ["security", "governance"] } : credential === "records" ? { actor: "human:records@example.test", roles: ["records"] } : null,
    clock,
    audit
  });
  const engine = await GovernanceControlEngine.create({ policy, clock, audit, authority, erasureVerifier });
  return { engine, authority, audit, events };
}

test("FEAT-008 publishes strict versioned descriptors and schema-valid deterministic reports", async () => {
  const validator = await createContractValidator(undefined, GOVERNANCE_CONTROL_SCHEMA_PATHS);
  assert.deepEqual(BUILT_IN_GOVERNANCE_SENSORS.map(({ id }) => id), [
    "secret-pattern", "classification-declassification", "rights-license", "external-model-route", "retention-legal-hold", "prompt-injection", "falsehood-provenance"
  ]);
  for (const descriptor of BUILT_IN_GOVERNANCE_SENSORS) assert.equal(validator.validate("governanceSensorDescriptor", descriptor).valid, true);
  const { engine } = await runtime();
  const first = await engine.evaluate("review", baseline());
  const second = await engine.evaluate("review", baseline());
  assert.equal(first.allowed, true);
  assert.equal(validator.validate("governanceControlReport", first).valid, true);
  assert.deepEqual(first.results.map(({ id, result, finding_codes }) => ({ id, result, finding_codes })), second.results.map(({ id, result, finding_codes }) => ({ id, result, finding_codes })));
  engine.assertAllowed(first);
  const tampered = structuredClone(first); tampered.allowed = false;
  assert.throws(() => engine.assertAllowed(tampered), (error) => error.code === "KDLC_GOVERNANCE_DENIED");
});

test("FEAT-008 secret and prompt-injection fixtures block before model routing without disclosure", async () => {
  const { engine, events } = await runtime();
  const input = baseline({ provider: "local", model: "recorded", content: fixture.secret_prompt });
  await assert.rejects(engine.authorizeExternalModel(input), (error) => {
    assert.equal(error.code, "KDLC_GOVERNANCE_DENIED");
    assert.deepEqual(error.details.finding_codes, ["KDLC_PROMPT_INJECTION", "KDLC_SECRET_BEARER"]);
    assert.doesNotMatch(JSON.stringify(error), /synthetic-example-token/);
    return true;
  });
  assert.doesNotMatch(JSON.stringify(events), /synthetic-example-token|authorization: Bearer/i);
});

test("FEAT-008 classification intersects access and requires an unforgeable declassification record", async () => {
  const { engine, authority, events } = await runtime();
  const restricted = baseline({ materials: [material({ access: { classification: "restricted", compartments: ["legal"] } })], derived_access: { classification: "public" } });
  await assert.rejects(engine.authorizeRetrieval({ ...restricted, principal: { clearance: "restricted", compartments: [] } }), (error) => error.code === "KDLC_GOVERNANCE_DENIED");
  const forged = { kind: "kdlc-declassification-1", id: "dc1" };
  const publication = await engine.evaluate("publication", { ...restricted, declassification: forged });
  assert.equal(publication.allowed, false);
  assert.deepEqual(publication.results.find(({ id }) => id === "classification-declassification").finding_codes, ["KDLC_DECLASSIFICATION_REQUIRED"]);
  const session = await authority.openSession("trusted");
  const authorization = await authority.issueDeclassification(session, { id: "dc1", subject: restricted.subject, from: "restricted", to: "public", policy_ref: "policy://classification/1", reason: "approved public summary", expires_at: "2026-08-15T12:00:00Z" });
  const allowed = await engine.authorizePublication({ ...restricted, declassification: authorization });
  assert.equal(allowed.allowed, true);
  assert.equal(events.some(({ action }) => action === "governance.declassification.issued"), true);
});

test("FEAT-008 rights ambiguity and incompatible external routes fail closed", async () => {
  const { engine } = await runtime();
  const protectedMaterial = material({ access: { classification: "confidential" }, rights: { redistribution: "unknown" } });
  const publication = await engine.evaluate("publication", baseline({ materials: [protectedMaterial], derived_access: { classification: "confidential" }, target: { scope: "public" } }));
  assert.equal(publication.allowed, false);
  assert.ok(publication.results.find(({ id }) => id === "rights-license").finding_codes.includes("KDLC_RIGHTS_LEGAL_REVIEW_REQUIRED"));
  await assert.rejects(engine.authorizeExternalModel(baseline({ provider: "outside", model: "general", materials: [protectedMaterial], derived_access: { classification: "confidential" } })), (error) => error.code === "KDLC_GOVERNANCE_DENIED");
});

test("FEAT-008 falsehood, authority spoofing, and duplicate-source laundering block review", async () => {
  const { engine } = await runtime();
  const report = await engine.evaluate("review", baseline({ claims: [fixture.plausible_false_claim] }));
  const finding = report.results.find(({ id }) => id === "falsehood-provenance");
  assert.equal(finding.blocks, true);
  assert.deepEqual(finding.finding_codes, ["KDLC_AUTHORITY_METADATA_UNTRUSTED", "KDLC_FALSEHOOD_CONFLICT_UNRESOLVED"]);
});

test("FEAT-008 consequential corroboration requires distinct source identities, not hash variants", async () => {
  const { engine } = await runtime();
  const sameSource = [{ id: "clm_laundered", consequential: true, conflict: false, sources: [
    { source_id: "src_alpha", source_hash: `sha256:${"a".repeat(64)}` },
    { source_id: "src_alpha", source_hash: `sha256:${"b".repeat(64)}` }
  ] }];
  const report = await engine.evaluate("review", baseline({ claims: sameSource }));
  assert.ok(report.results.find(({ id }) => id === "falsehood-provenance").finding_codes.includes("KDLC_FALSEHOOD_CORROBORATION_REQUIRED"));
});

test("FEAT-008 waivers are exact, authenticated, current, auditable, and cannot waive sensor errors by object forgery", async () => {
  const { engine, authority, events } = await runtime();
  await assert.rejects(authority.openSession("attacker"), (error) => error.code === "KDLC_AUTHENTICATION_DENIED");
  const session = await authority.openSession("trusted");
  const waiver = await authority.issueWaiver(session, { id: "wv1", sensor_id: "secret-pattern", gate: "publication", subject: baseline().subject, reason: "synthetic credential fixture", expires_at: "2026-08-15T12:00:00Z" });
  const secret = baseline({ content: "api_key=synthetic-value-000000" });
  assert.equal((await engine.evaluate("publication", secret, { waivers: [{ kind: "kdlc-governance-waiver-1", id: "wv1" }] })).allowed, false);
  const report = await engine.authorizePublication(secret, { waivers: [waiver] });
  assert.equal(report.results.find(({ id }) => id === "secret-pattern").result, "waived");
  assert.equal(events.some(({ action, waiver_id }) => action === "governance.sensor.waived" && waiver_id === "wv1"), true);
});

test("FEAT-008 authority sessions and grants cannot cross a runtime trust boundary", async () => {
  const first = await runtime(); const second = await runtime();
  const session = await first.authority.openSession("trusted");
  await assert.rejects(second.authority.issueWaiver(session, { id: "cross", sensor_id: "secret-pattern", gate: "publication", subject: baseline().subject, reason: "cross authority", expires_at: "2026-08-15T12:00:00Z" }), (error) => error.code === "KDLC_GOVERNANCE_AUTHORITY_DENIED");
  const waiver = await first.authority.issueWaiver(session, { id: "local", sensor_id: "secret-pattern", gate: "publication", subject: baseline().subject, reason: "local authority", expires_at: "2026-08-15T12:00:00Z" });
  assert.equal((await second.engine.evaluate("publication", baseline({ content: "api_key=synthetic-value-000000" }), { waivers: [waiver] })).allowed, false);
});

test("FEAT-008 waiver roles and declassification policies are exact and strict-calendar bound", async () => {
  const { engine, authority } = await runtime();
  const records = await authority.openSession("records");
  await assert.rejects(authority.issueWaiver(records, { id: "broad", sensor_id: "secret-pattern", gate: "publication", subject: baseline().subject, reason: "not security", expires_at: "2026-08-15T12:00:00Z" }), (error) => error.code === "KDLC_GOVERNANCE_AUTHORITY_DENIED");
  const trusted = await authority.openSession("trusted");
  await assert.rejects(authority.issueDeclassification(trusted, { id: "bad-date", subject: baseline().subject, from: "restricted", to: "public", policy_ref: "policy://classification/1", reason: "invalid date", expires_at: "2026-02-30T00:00:00Z" }), (error) => error.code === "KDLC_DECLASSIFICATION_INVALID");
  await assert.rejects(authority.issueDeclassification(trusted, { id: "bad-policy", subject: baseline().subject, from: "restricted", to: "public", policy_ref: "policy://invented/1", reason: "unknown policy", expires_at: "2026-08-15T12:00:00Z" }), (error) => ["KDLC_GOVERNANCE_AUTHORITY_DENIED", "KDLC_DECLASSIFICATION_INVALID"].includes(error.code));
  await assert.rejects(authority.issueDeclassification(trusted, { id: "bad-offset", subject: baseline().subject, from: "restricted", to: "public", policy_ref: "policy://classification/1", reason: "nonstandard offset", expires_at: "2026-08-15T12:00:00+23:59" }), (error) => error.code === "KDLC_DECLASSIFICATION_INVALID");
  await assert.rejects(authority.issueDeclassification(trusted, { id: "unknown-offset", subject: baseline().subject, from: "restricted", to: "public", policy_ref: "policy://classification/1", reason: "unknown offset", expires_at: "2026-08-15T12:00:00-00:00" }), (error) => error.code === "KDLC_DECLASSIFICATION_INVALID");
  await assert.rejects(engine.authorizePublication(baseline({ content: "api_key=synthetic-value-000000" }), { waivers: [{ kind: "kdlc-governance-waiver-1", id: "forged" }] }), (error) => error.code === "KDLC_GOVERNANCE_DENIED");
});

test("FEAT-008 retrieval proofs are opaque, exact-query and principal bound, and expire on the trusted clock", async () => {
  let now = "2026-08-14T12:00:00.000Z";
  const trustedClock = { now: () => now }; const audit = { append: async () => {} };
  const authority = new GovernanceControlAuthority({ authenticate: async () => null, clock: trustedClock, audit });
  const engine = await GovernanceControlEngine.create({ policy, clock: trustedClock, audit, authority });
  const input = baseline({
    principal: { id: "human:reader", clearance: "internal", compartments: ["engineering"] },
    mount: { id: "example.team", resolved_ref: "rev-1", tree_hash: artifactHash("tree"), access: material().access },
    concept: { id: "concepts/control", access: material().access }, query: "retention policy", query_mode: "wiki-only"
  });
  const proof = await engine.issueRetrievalProof(input, { ttlMs: 10 });
  assert.equal(engine.verifyRetrievalProof(proof, input), true);
  assert.equal(engine.verifyRetrievalProof({ kind: "kdlc-governance-retrieval-proof-1" }, input), false);
  assert.equal(engine.verifyRetrievalProof(proof, { ...input, query: "different query" }), false);
  assert.equal(engine.verifyRetrievalProof(proof, { ...input, principal: { ...input.principal, id: "human:other" } }), false);
  now = "2026-08-14T12:00:00.010Z";
  assert.equal(engine.verifyRetrievalProof(proof, input), false);
});

test("FEAT-008 erasure accepts only opaque completed-workflow verification and never actor assertions", async () => {
  const verified = new WeakMap();
  const erasureVerifier = { resolve: (token) => verified.get(token) };
  const { engine, authority } = await runtime({ erasureVerifier });
  const subject = artifactHash({ id: "src_alpha", hash: material().source_hash });
  await assert.rejects(engine.authorizeErasure({ subject, authority_authenticated: true, legal_hold: false, inventory: [], propagation_verified: true }), (error) => error.code === "KDLC_GOVERNANCE_DENIED");
  const session = await authority.openSession("records");
  const authorization = await authority.issueErasureAuthorization(session, { id: "erase-1", subject, action: "erase", policy_ref: "policy://retention/1", reason: "approved source erasure", expires_at: "2026-08-15T12:00:00Z" });
  assert.equal(authority.erasureAuthorization(authorization).subject, subject);
  const inventory = policy.required_erasure_surfaces.map((surface) => ({ surface, known_copy: true, status: surface === "concept" ? "tombstoned" : "purged" }));
  const verification = Object.freeze({ kind: "kdlc-erasure-workflow-verification-1" });
  verified.set(verification, Object.freeze({ subject, action: "erase", result: "erased", impact_hash: artifactHash("impact"), decision_hash: artifactHash("decision"), verification_hash: artifactHash("verification"), receipt_hash: artifactHash("receipt"), inventory, completed_at: instant }));
  assert.equal((await engine.authorizeErasure({ subject, erasure_verification: verification })).allowed, true);
  await assert.rejects(engine.authorizeErasure({ subject, erasure_verification: { kind: "kdlc-erasure-workflow-verification-1" } }), (error) => error.code === "KDLC_GOVERNANCE_DENIED");
});

test("FEAT-008 propagated metadata is most-restrictive and retains rights disposition", () => {
  const metadata = propagateGovernanceMetadata({ materials: [material(), material({ id: "src_beta", access: { classification: "confidential", compartments: ["legal"] }, rights: { redistribution: "unknown" } })], target: { scope: "public", transformation: "derivative" }, clock });
  assert.deepEqual(metadata.access, { classification: "confidential", compartments: ["engineering", "legal"] });
  assert.deepEqual(metadata.rights, { disposition: "legal-review-required", obligations: [], policy_refs: [], decision_refs: [], target_scope: "public" });
});

test("FEAT-008 rights expiry uses the trusted current clock", () => {
  const metadata = propagateGovernanceMetadata({ materials: [material({ rights: { license: "Apache-2.0", redistribution: "allowed", derivative_use: "allowed", expires_at: "2020-01-01T00:00:00Z" } })], clock });
  assert.equal(metadata.rights.disposition, "legal-review-required");
});

test("FEAT-008 malformed rights and trusted clock instants fail closed", async () => {
  const malformed = propagateGovernanceMetadata({ materials: [material({ rights: { license: "Apache-2.0", redistribution: "allowed", derivative_use: "allowed", expires_at: "not-an-instant" } })], clock });
  assert.equal(malformed.rights.disposition, "legal-review-required");
  const invalidClock = { now: () => "2026-02-30T00:00:00Z" };
  const audit = { append: async () => {} };
  const authority = new GovernanceControlAuthority({ authenticate: async () => ({ actor: "human:security", roles: ["security"] }), clock: invalidClock, audit });
  await assert.rejects(GovernanceControlEngine.create({ policy, clock: invalidClock, audit, authority }).then((engine) => engine.evaluate("review", baseline())), (error) => error.code === "KDLC_TRUSTED_CLOCK_INVALID");
});

test("FEAT-008 durable audit failure fails the gate closed", async () => {
  const { engine } = await runtime({ audit: { append: async () => { throw new Error("audit unavailable"); } } });
  await assert.rejects(engine.evaluate("review", baseline()), /audit unavailable/);
});
