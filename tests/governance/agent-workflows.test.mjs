import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { AGENT_WORKFLOW_SCHEMA_PATHS, AgentPolicyError, CapabilityRuntime, loadRoleDescriptors, MediatedAgentRuntime, PrincipalAuthority, RepositoryFileStore, ReviewContextAuthority } from "../../packages/agents/index.mjs";
import { createContractValidator } from "../../packages/contracts/index.mjs";
import { artifactHash } from "../../packages/core/index.mjs";
import { assessPublication, createReviewReceipt, GovernanceControlAuthority, GovernanceControlEngine, verificationStatus } from "../../packages/governance/index.mjs";
import { GovernedAgentWorkflows, MemoryArtifactStore } from "../../packages/workflows/index.mjs";

const root = resolve(import.meta.dirname, "../..");
const digest = (character) => `sha256:${character.repeat(64)}`;
const clock = { now: () => "2026-08-14T15:20:00Z" };
const principals = new PrincipalAuthority([
  { id: "reviewer-123", actor: "human:reviewer-123", principal_mode: "served", issuer: "https://id.acme.example", review_roles: ["trust-reviewer"] },
  { id: "governor", actor: "human:governor", principal_mode: "local", review_roles: ["governance-reviewer"] },
  { id: "other", actor: "human:other", principal_mode: "local", review_roles: [] }
]);

async function fixture(name) {
  return JSON.parse(await readFile(resolve(root, `tests/fixtures/models/${name}-recording.json`), "utf8"));
}
async function normalizedFixture(name) {
  return JSON.parse(await readFile(resolve(root, `tests/fixtures/workflows/${name}-normalized.json`), "utf8"));
}

function reviewContext(sourceHash = digest("a")) {
  return {
    evidence: [{ source_id: "src_alpha", source_hash: sourceHash, locator: { heading: "Token lifetime" }, excerpt: "Production API tokens expire after 60 minutes.", authority: "team:security", access: { classification: "public" }, rights: { license: "LicenseRef-Internal", redistribution: "prohibited", derivative_use: "allowed", commercial_use: "prohibited" }, extraction_quality: "high", warnings: [] }],
    sensors: [{ id: "source-anchor-valid", severity: "error", result: "passed", producer: "kdlc-sensor-runtime/0.2.0", execution_hash: digest("7") }],
    impact: { links: [], dependents: [], freshness_change: "2030-01-01", unresolved_conflicts: [] },
    resolved: {
      profile: { id: "kdlc-base", version: "0.2.0", hash: digest("e") },
      policies: [{ id: "team-policy", version: "7", hash: digest("f") }],
      dependencies: { "acme.security": { version: "2.4.0", tree_hash: digest("1") } }
    },
    provenance: { models: [{ id: "fixture-model-1" }], tools: [{ id: "kdlc-harness/0.2.0" }] },
    budget: { model_tokens: 240, model_cost_usd: 0 }
  };
}

function trustedReviewContext(workflowId, context) {
  return new ReviewContextAuthority([{ workflow_id: workflowId, context }]).establish(workflowId);
}

class SubstitutingStore extends MemoryArtifactStore {
  substitutions = new Map();
  substitute(path, value) { this.substitutions.set(path, structuredClone(value)); }
  clearSubstitution(path) { this.substitutions.delete(path); }
  async get(path) { return this.substitutions.has(path) ? structuredClone(this.substitutions.get(path)) : super.get(path); }
}

async function approvedHarness() {
  const validator = await createContractValidator(root, AGENT_WORKFLOW_SCHEMA_PATHS);
  const store = new SubstitutingStore();
  const session = principals.establishReviewSession("reviewer-123", "trust-reviewer");
  const context = reviewContext();
  const harness = await GovernedAgentWorkflows.create({ validator, store, clock, session, reviewContextSession: trustedReviewContext("wf_ingest", context) });
  const recording = await fixture("ingest");
  const output = await harness.runRecorded({ task: "ingest", workflowId: "wf_ingest", recording, normalizedEvidence: await normalizedFixture("ingest") });
  const review = await harness.assembleReview({ workflowId: "wf_ingest", proposalId: "pr_alpha" });
  const decision = await harness.decide({ workflowId: "wf_ingest", proposalId: "pr_alpha", decision: "approved", receiptId: "rr_approved" });
  return { validator, store, harness, recording, output, context, review, receipt: decision.receipt, decision: decision.decision };
}

test("FEAT-008 workflow profiles requiring built-in controls fail closed without the trusted engine", async () => {
  const validator = await createContractValidator(root, AGENT_WORKFLOW_SCHEMA_PATHS);
  const context = reviewContext();
  const harness = await GovernedAgentWorkflows.create({
    validator,
    clock,
    session: principals.establishReviewSession("reviewer-123", "trust-reviewer"),
    reviewContextSession: trustedReviewContext("wf_ingest", context),
    reviewRequirements: { sensor_ids: ["secret-pattern"], policy_ids: ["team-policy"], substantive_fields: [], freshness: { mode: "reviewed" } }
  });
  await assert.rejects(harness.runRecorded({ task: "ingest", workflowId: "wf_ingest", recording: await fixture("ingest"), normalizedEvidence: await normalizedFixture("ingest") }), (error) => error.code === "KDLC_GOVERNANCE_CONTROLS_REQUIRED");
});

test("FEAT-008 workflow integrates trusted ingest, retrieval, model-route, erasure, and claim propagation gates", async () => {
  const events = [];
  const audit = { append: async (event) => { events.push(structuredClone(event)); } };
  const authority = new GovernanceControlAuthority({
    authenticate: async (credential) => credential === "records" ? { actor: "human:records", roles: ["records"] } : null,
    clock,
    audit
  });
  const policy = {
    api_version: "kdlc.dev/governance-policy/v1alpha1", id: "workflow-controls", version: 1, minimum_independent_sources: 1,
    required_erasure_surfaces: ["original", "normalized", "claim", "concept", "quote", "cache", "index", "embedding", "graph", "export", "log", "backup"],
    waiver_authorities: { "secret-pattern": { publication: ["security"] } }, declassification_authorities: {}, erasure_authorities: ["records"],
    external_models: { "local/recorded": { allowed: true, max_classification: "restricted" }, "outside/general": { allowed: true, max_classification: "public" } }
  };
  const governanceControls = await GovernanceControlEngine.create({ policy, clock, audit, authority });
  const context = reviewContext();
  const harness = await GovernedAgentWorkflows.create({
    clock, governanceControls,
    session: principals.establishReviewSession("reviewer-123", "trust-reviewer"),
    reviewContextSession: trustedReviewContext("wf_ingest", context),
    reviewRequirements: { sensor_ids: ["secret-pattern"], policy_ids: ["team-policy"], substantive_fields: [], freshness: { mode: "reviewed" } }
  });
  const recording = await fixture("ingest");
  recording.claims[0].access = { classification: "restricted" };
  recording.claims[0].rights = { license: "LicenseRef-Attacker", redistribution: "allowed" };
  const output = await harness.runRecorded({ task: "ingest", workflowId: "wf_ingest", recording, normalizedEvidence: await normalizedFixture("ingest") });
  assert.deepEqual(output.claims[0].access, context.evidence[0].access);
  assert.deepEqual(output.claims[0].rights, context.evidence[0].rights);
  assert.equal((await harness.authorizeRetrieval({ workflowId: "wf_ingest", proposalId: "pr_alpha", principal: { clearance: "public", compartments: [] } })).allowed, true);
  assert.equal((await harness.authorizeModelRoute({ workflowId: "wf_ingest", proposalId: "pr_alpha", provider: "outside", model: "general" })).allowed, true);
  const inventory = policy.required_erasure_surfaces.map((surface) => ({ surface, known_copy: true, status: "purged" }));
  const session = await authority.openSession("records");
  const evidence = await authority.issueErasureEvidence(session, { id: "erase-workflow", subject: output.proposals[0].target.subject, legal_hold: false, inventory, propagation_verified: true, reason: "verified purge", expires_at: "2026-08-15T12:00:00Z" });
  assert.equal((await harness.authorizeErasure({ workflowId: "wf_ingest", proposalId: "pr_alpha", erasureEvidence: evidence })).allowed, true);
  assert.deepEqual(new Set(events.filter(({ action }) => action === "governance.gate.completed").map(({ gate }) => gate)), new Set(["ingest", "model-route", "retrieval", "erasure"]));
});

test("FEAT-008 invalid trusted access or rights cannot reach persisted claims", async () => {
  const context = reviewContext();
  context.evidence[0].rights = { use: "caller-defined" };
  const harness = await GovernedAgentWorkflows.create({ clock, reviewContextSession: trustedReviewContext("wf_ingest", context) });
  await assert.rejects(harness.runRecorded({ task: "ingest", workflowId: "wf_ingest", recording: await fixture("ingest"), normalizedEvidence: await normalizedFixture("ingest") }), (error) => error.code === "KDLC_CLAIM_GOVERNANCE_METADATA_INVALID");
});

test("FEAT-004 role and stage descriptors enforce runtime path capabilities", async (t) => {
  const validator = await createContractValidator(root, AGENT_WORKFLOW_SCHEMA_PATHS);
  await assert.rejects(() => createContractValidator(root, { claim: "core/schemas/artifacts/concept-proposal.schema.json" }), /cannot replace core contract/);
  const roles = await loadRoleDescriptors({ validator });
  assert.deepEqual([...roles.keys()].sort(), ["conductor", "governance-reviewer", "integrator", "librarian", "source-analyst", "trust-reviewer"]);
  const capabilities = new CapabilityRuntime(roles);
  assert.equal(capabilities.authorize("source-analyst", "write", "workflow/runs/wf_ingest/claims/clm_alpha.json"), true);
  assert.throws(() => capabilities.authorize("trust-reviewer", "write", "workflow/runs/wf_ingest/receipts/rr_alpha.json"), (error) => error.code === "KDLC_REVIEWER_READ_ONLY");
  assert.throws(() => capabilities.authorize("trust-reviewer", "write", "workflow/runs/wf_ingest/proposals/pr_alpha.json"), (error) => error instanceof AgentPolicyError && error.code === "KDLC_REVIEWER_READ_ONLY");
  assert.throws(() => capabilities.authorize("conductor", "write", "../knowledge-bases/acme.docs/concept.md"), (error) => error.code === "KDLC_PATH_INVALID");
  assert.throws(() => capabilities.authorize("conductor", "write", "knowledge-bases/acme.docs/concept.md"), (error) => error.code === "KDLC_CAPABILITY_DENIED");
  assert.equal(capabilities.run, undefined);
  const values = new Map([["workflow/runs/wf_ingest/reviews/pr_alpha/packet.json", { safe: true }]]);
  let ambientCallbackInvoked = false;
  const mediated = new MediatedAgentRuntime({ capabilities, store: { get: async (path) => values.get(path), put: async (path, value) => values.set(path, value) }, tools: new Map([["ambient", async () => { ambientCallbackInvoked = true; await fetch("https://example.invalid"); }]]) });
  await assert.rejects(() => mediated.write("trust-reviewer", "workflow/runs/wf_ingest/proposals/pr_alpha.json", { forged: true }), (error) => error.code === "KDLC_REVIEWER_READ_ONLY");
  assert.equal(values.has("workflow/runs/wf_ingest/proposals/pr_alpha.json"), false);
  assert.equal(mediated.invoke, undefined);
  await assert.rejects(() => mediated.write("conductor", "workflow/runs/wf_ingest/reviews/pr_alpha/packet.json", { overwritten: true }), (error) => error.code === "KDLC_CAPABILITY_DENIED");
  assert.deepEqual(values.get("workflow/runs/wf_ingest/reviews/pr_alpha/packet.json"), { safe: true });
  assert.equal(ambientCallbackInvoked, false);
  const repositoryRoot = await mkdtemp(resolve(tmpdir(), "kdlc-capability-"));
  const outsideRoot = await mkdtemp(resolve(tmpdir(), "kdlc-outside-"));
  t.after(async () => { await rm(repositoryRoot, { recursive: true, force: true }); await rm(outsideRoot, { recursive: true, force: true }); });
  await mkdir(resolve(repositoryRoot, "workflow/runs/wf_ingest/state"), { recursive: true });
  await writeFile(resolve(repositoryRoot, "workflow/runs/wf_ingest/state/safe.json"), '{"safe":true}\n');
  await writeFile(resolve(outsideRoot, "safe.json"), '{"outside":true}\n');
  await symlink(outsideRoot, resolve(repositoryRoot, "workflow/runs/wf_ingest/state/link"));
  await assert.rejects(() => RepositoryFileStore.create(repositoryRoot, ["workflow/runs/wf_ingest/state/link/safe.json"]), (error) => error.code === "KDLC_PATH_SYMLINK");
  const pinnedStore = await RepositoryFileStore.create(repositoryRoot, [{ path: "workflow/runs/wf_ingest/state/safe.json", write: true }]); t.after(() => pinnedStore.close());
  const fileRuntime = new MediatedAgentRuntime({ capabilities, store: pinnedStore });
  await rename(resolve(repositoryRoot, "workflow/runs/wf_ingest/state"), resolve(repositoryRoot, "workflow/runs/wf_ingest/state-original"));
  await symlink(outsideRoot, resolve(repositoryRoot, "workflow/runs/wf_ingest/state"));
  assert.deepEqual(await fileRuntime.read("conductor", "workflow/runs/wf_ingest/state/safe.json"), { safe: true });
  await fileRuntime.write("conductor", "workflow/runs/wf_ingest/state/safe.json", { updated: true });
  assert.deepEqual(JSON.parse(await readFile(resolve(repositoryRoot, "workflow/runs/wf_ingest/state-original/safe.json"), "utf8")), { updated: true });
  assert.deepEqual(JSON.parse(await readFile(resolve(outsideRoot, "safe.json"), "utf8")), { outside: true });

  for (const name of (await readdir(resolve(root, "packages/workflows/stages"))).sort()) {
    const stage = JSON.parse(await readFile(resolve(root, "packages/workflows/stages", name), "utf8"));
    assert.deepEqual(validator.validate("lifecycleStage", stage), { valid: true, errors: [] }, name);
  }
});

test("FEAT-004 repository file capabilities reject parent races and close failed opens", async (t) => {
  const repositoryRoot = await mkdtemp(resolve(tmpdir(), "kdlc-capability-race-"));
  const outsideRoot = await mkdtemp(resolve(tmpdir(), "kdlc-capability-outside-"));
  t.after(async () => { await rm(repositoryRoot, { recursive: true, force: true }); await rm(outsideRoot, { recursive: true, force: true }); });
  const parent = resolve(repositoryRoot, "workflow/runs/wf_ingest/state");
  await mkdir(parent, { recursive: true });
  await writeFile(resolve(parent, "safe.json"), '{"safe":true}\n');
  await writeFile(resolve(outsideRoot, "safe.json"), '{"outside":true}\n');
  await assert.rejects(() => RepositoryFileStore.create(repositoryRoot, ["workflow/runs/wf_ingest/state/safe.json"], { hooks: { afterValidation: async () => {
    await rename(parent, `${parent}-original`);
    await symlink(outsideRoot, parent);
  } } }), (error) => error.code === "KDLC_PATH_RACE");

  const leakRoot = await mkdtemp(resolve(tmpdir(), "kdlc-capability-leak-"));
  t.after(() => rm(leakRoot, { recursive: true, force: true }));
  await writeFile(resolve(leakRoot, "safe.json"), '{"safe":true}\n');
  let failedHandle;
  await assert.rejects(() => RepositoryFileStore.create(leakRoot, ["safe.json"], { hooks: { afterOpen: ({ handle }) => { failedHandle = handle; throw new Error("injected post-open failure"); } } }), /injected post-open failure/);
  await assert.rejects(() => failedHandle.stat(), (error) => error.code === "EBADF");
});

test("FEAT-004 ingest and adoption replay schema-valid recorded model outputs", async () => {
  const validator = await createContractValidator(root, AGENT_WORKFLOW_SCHEMA_PATHS);
  for (const [task, workflowId] of [["ingest", "wf_ingest"], ["adopt", "wf_adopt"]]) {
    const store = new MemoryArtifactStore();
    const context = reviewContext(task === "ingest" ? digest("a") : digest("c"));
    if (task === "adopt") { context.evidence[0].source_id = "src_beta"; context.evidence[0].locator = { heading: "Ownership" }; context.evidence[0].excerpt = "The service is maintained by the platform team."; }
    const harness = await GovernedAgentWorkflows.create({ validator, store, clock, reviewContextSession: trustedReviewContext(workflowId, context) });
    const recording = await fixture(task);
    const normalizedEvidence = await normalizedFixture(task);
    assert.equal(recording.input_hashes.normalized_evidence, artifactHash(normalizedEvidence));
    const output = await harness.runRecorded({ task, workflowId, recording, normalizedEvidence });
    assert.equal(output.claims.length, 1);
    assert.equal(validator.validate("claim", output.claims[0]).valid, true);
    assert.equal(validator.validate("conceptProposal", output.proposals[0]).valid, true);
    assert.equal(output.proposals[0].input_hashes.normalized_evidence, artifactHash(normalizedEvidence));
    assert.equal(output.proposals[0].input_hashes.claims, artifactHash(output.claims));
    assert.equal(output.proposals[0].input_hashes.review_context, artifactHash(context));
    assert.equal(await store.has(`workflow/runs/${workflowId}/claims/${output.claims[0].id}.json`), true);
    assert.equal(await store.has(`workflow/runs/${workflowId}/proposals/${output.proposals[0].id}.json`), true);
  }
});

test("FEAT-004 invalid or drifted model recordings fail before emitting artifacts", async () => {
  const validator = await createContractValidator(root, AGENT_WORKFLOW_SCHEMA_PATHS);
  const store = new MemoryArtifactStore();
  const harness = await GovernedAgentWorkflows.create({ validator, store, clock, reviewContextSession: trustedReviewContext("wf_ingest", reviewContext()) });
  const recording = await fixture("ingest");
  recording.claims[0].source_hash = "not-a-digest";
  const normalizedEvidence = await normalizedFixture("ingest");
  await assert.rejects(() => harness.runRecorded({ task: "ingest", workflowId: "wf_ingest", recording, normalizedEvidence }), (error) => error.code === "KDLC_MODEL_RECORDING_INVALID");
  assert.equal(store.size, 0);
  assert.equal(store.put, undefined);
  assert.equal(store.putMany, undefined);
  assert.equal(store.commitDecision, undefined);

  const nonAtomicStore = { put: async () => {}, get: async () => {}, has: async () => false };
  const nonAtomicHarness = await GovernedAgentWorkflows.create({ validator, store: nonAtomicStore, clock, reviewContextSession: trustedReviewContext("wf_ingest", reviewContext()) });
  const atomicRecording = await fixture("ingest");
  await assert.rejects(() => nonAtomicHarness.runRecorded({ task: "ingest", workflowId: "wf_ingest", recording: atomicRecording, normalizedEvidence }), (error) => error.code === "KDLC_STORE_ATOMIC_REQUIRED");

  const valid = await fixture("ingest");
  valid.input_hashes.normalized_evidence = digest("9");
  await assert.rejects(() => harness.runRecorded({ task: "ingest", workflowId: "wf_ingest", recording: valid, normalizedEvidence }), (error) => error.code === "KDLC_MODEL_RECORDING_DRIFT");
  const unanchored = await fixture("ingest");
  unanchored.claims[0].source_hash = digest("9");
  await assert.rejects(() => harness.runRecorded({ task: "ingest", workflowId: "wf_ingest", recording: unanchored, normalizedEvidence }), (error) => error.code === "KDLC_MODEL_SOURCE_DRIFT");
  assert.equal(store.size, 0);
});

test("FEAT-004 approved human review binds the exact packet and permits stable publication intent", async () => {
  const { validator, harness, output, context, review, receipt, decision } = await approvedHarness();
  assert.equal(validator.validate("governedReviewPacket", review.packet).valid, true);
  assert.equal(validator.validate("reviewReceipt", receipt).valid, true);
  assert.equal(validator.validate("reviewDecision", decision).valid, true);
  assert.equal(receipt.packet_hash, artifactHash(review.packet));
  assert.equal(receipt.review.hash, review.packet.review.hash);
  assert.deepEqual(receipt.source_hashes, [digest("a")]);
  assert.deepEqual(receipt.resolved_dependencies, context.resolved.dependencies);
  assert.deepEqual(receipt.profile, context.resolved.profile);
  assert.deepEqual(receipt.policies, context.resolved.policies);

  const current = { concept: output.proposals[0].concept.after, target_revision: "rev-1", source_hashes: [digest("a")], resolved_dependencies: context.resolved.dependencies, profile: context.resolved.profile, policies: context.resolved.policies };
  const publication = await harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: "rr_approved", current });
  assert.equal(publication.intent.packet_hash, receipt.packet_hash);
  assert.equal(publication.intent.review_hash, receipt.review.hash);
  assert.equal(validator.validate("publicationIntent", publication.intent).valid, true);
  for (const reviewedAt of ["2028-02-29T00:00:00-00:00", "2028-02-29T00:00:00+14:01", "2028-02-29T00:00:00+23:59"]) {
    assert.throws(() => createReviewReceipt({ packet: review.packet, decision: "approved", session: principals.establishReviewSession("reviewer-123", "trust-reviewer"), receiptId: "rr_invalid_time", reviewedAt, validator }), (error) => error.code === "KDLC_ARTIFACT_INVALID" && error.details.field === "reviewed_at");
  }
  const timestampBefore = structuredClone(output.proposals[0]); timestampBefore.concept.before = structuredClone(timestampBefore.concept.after); timestampBefore.concept.before.frontmatter.stale_after = "2030-01-01T00:00:00Z";
  assert.equal(validator.validate("conceptProposal", timestampBefore).valid, false);
  for (const side of ["before", "after"]) {
    const invalidPacket = structuredClone(review.packet); invalidPacket.concept[side] = structuredClone(review.packet.concept.after); invalidPacket.concept[side].frontmatter.stale_after = "2030-02-30";
    assert.equal(validator.validate("governedReviewPacket", invalidPacket).valid, false);
  }
  const impossible = structuredClone(current); impossible.concept.frontmatter.stale_after = "2030-02-30";
  await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: "rr_approved", current: impossible }), (error) => error.code === "KDLC_PUBLICATION_DENIED" && error.details.failures.includes("missing-future-freshness"));
  const timestampShaped = structuredClone(output.proposals[0]); timestampShaped.concept.after.frontmatter.stale_after = "2030-01-01T00:00:00Z";
  assert.equal(validator.validate("conceptProposal", timestampShaped).valid, false);
  const invalidGeneration = structuredClone(current); invalidGeneration.concept.frontmatter.generated.at = "2026-02-30T00:00:00Z";
  await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: "rr_approved", current: invalidGeneration }), (error) => error.code === "KDLC_PUBLICATION_DENIED" && error.details.failures.includes("missing-generation"));
  await assert.rejects(() => harness.assembleReview({ workflowId: "wf_ingest", proposalId: "pr_alpha" }), (error) => error.code === "KDLC_REVIEW_PACKET_IMMUTABLE");
  await assert.rejects(() => harness.decide({ workflowId: "wf_ingest", proposalId: "pr_alpha", decision: "approved", receiptId: "rr_approved", expectedReceiptId: "rr_approved" }), (error) => error.code === "KDLC_RECEIPT_IMMUTABLE");
  assert.throws(() => createReviewReceipt({ packet: review.packet, decision: "approved", reviewer: { actor: "human:forged", principal_mode: "local" }, receiptId: "rr_forged", reviewedAt: clock.now(), validator }), (error) => error.code === "KDLC_SESSION_INVALID");
  await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receipt: { ...receipt, id: "rr_forged" }, current }), (error) => error.code === "KDLC_PUBLICATION_DENIED" && error.details.failures.includes("receipt-missing"));
});

test("FEAT-004 workflow event creation rejects unknown and out-of-profile offsets", async () => {
  for (const instant of ["2028-02-29T00:00:00-00:00", "2028-02-29T00:00:00+14:01", "2028-02-29T00:00:00+23:59"]) {
    const validator = await createContractValidator(root, AGENT_WORKFLOW_SCHEMA_PATHS);
    const context = reviewContext();
    const harness = await GovernedAgentWorkflows.create({ validator, clock: { now: () => instant }, session: principals.establishReviewSession("reviewer-123", "trust-reviewer"), reviewContextSession: trustedReviewContext("wf_ingest", context) });
    await harness.runRecorded({ task: "ingest", workflowId: "wf_ingest", recording: await fixture("ingest"), normalizedEvidence: await normalizedFixture("ingest") });
    await harness.assembleReview({ workflowId: "wf_ingest", proposalId: "pr_alpha" });
    await assert.rejects(() => harness.decide({ workflowId: "wf_ingest", proposalId: "pr_alpha", decision: "approved", receiptId: "rr_bad_clock" }), (error) => error.code === "KDLC_WORKFLOW_CLOCK_INVALID" && error.details.field === "decided_at");
  }
});

test("FEAT-004 stable publication fails closed and later decisions revoke approval", async () => {
  const { harness, store, output, context, receipt: approvedReceipt, decision: approvedDecision } = await approvedHarness();
  const current = { concept: output.proposals[0].concept.after, target_revision: "rev-1", source_hashes: [digest("a")], resolved_dependencies: context.resolved.dependencies, profile: context.resolved.profile, policies: context.resolved.policies };
  await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", current }), (error) => error.code === "KDLC_PUBLICATION_DENIED" && error.details.failures.includes("receipt-missing"));
  const governanceHarness = await GovernedAgentWorkflows.create({ validator: await createContractValidator(root, AGENT_WORKFLOW_SCHEMA_PATHS), store, clock, session: principals.establishReviewSession("governor", "governance-reviewer") });
  await governanceHarness.decide({ workflowId: "wf_ingest", proposalId: "pr_alpha", decision: "rejected", receiptId: "rr_rejected", expectedReceiptId: "rr_approved" });
  await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: "rr_approved", current }), (error) => error.code === "KDLC_PUBLICATION_DENIED" && error.details.failures.includes("active-decision-drift"));
  await assert.rejects(() => governanceHarness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: "rr_rejected", current }), (error) => error.details.failures.includes("active-decision-rejected"));
  await assert.rejects(() => governanceHarness.decide({ workflowId: "wf_ingest", proposalId: "pr_alpha", decision: "changes-requested", receiptId: "rr_changes", expectedReceiptId: "rr_approved" }), (error) => error.code === "KDLC_DECISION_CONFLICT");
  await assert.rejects(() => GovernedAgentWorkflows.create({ store, clock, session: { role: "trust-reviewer", reviewer: { actor: "human:forged", principal_mode: "local" } } }).then((forged) => forged.decide({ workflowId: "wf_ingest", proposalId: "pr_alpha", decision: "approved", receiptId: "rr_forged", expectedReceiptId: "rr_rejected" })), (error) => error.code === "KDLC_SESSION_INVALID");
  store.substitute("workflow/runs/wf_ingest/receipts/rr_approved.json", approvedReceipt);
  store.substitute("workflow/runs/wf_ingest/reviews/pr_alpha/decision.json", approvedDecision);
  await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: "rr_approved", current }), (error) => error.code === "KDLC_PUBLICATION_DENIED" && error.details.failures.includes("review-trust-proof-invalid"));
});

test("FEAT-004 coordinated receipt and decision substitution cannot forge runtime trust", async () => {
  const { harness, store, output, context, receipt, decision } = await approvedHarness();
  const forgedReceipt = structuredClone(receipt);
  forgedReceipt.reviewer = { actor: "human:attacker", principal_mode: "local" };
  const forgedDecision = { ...structuredClone(decision), receipt_hash: artifactHash(forgedReceipt) };
  store.substitute("workflow/runs/wf_ingest/receipts/rr_approved.json", forgedReceipt);
  store.substitute("workflow/runs/wf_ingest/reviews/pr_alpha/decision.json", forgedDecision);
  const current = { concept: output.proposals[0].concept.after, target_revision: "rev-1", source_hashes: [digest("a")], resolved_dependencies: context.resolved.dependencies, profile: context.resolved.profile, policies: context.resolved.policies };
  await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: "rr_approved", current }), (error) => error.code === "KDLC_PUBLICATION_DENIED" && error.details.failures.includes("review-trust-proof-invalid"));
});

test("FEAT-004 review-covered drift invalidates verification and reconciles only through a proposal", async () => {
  const { validator, harness, output, context, review, receipt } = await approvedHarness();
  const reviewed = output.proposals[0].concept.after;
  const edited = structuredClone(reviewed);
  edited.frontmatter.description = "Directly edited policy description.";
  assert.equal(verificationStatus({ concept: edited, receipt }).status, "modified-after-review");

  const proposalResult = await harness.reconcileEdit({ workflowId: "wf_ingest", proposalId: "pr_reconcile", reviewedProposalId: "pr_alpha", target: output.proposals[0].target, reviewedConcept: reviewed, currentConcept: edited, receiptId: receipt.id });
  assert.equal(proposalResult.proposal.task, "reconcile-direct-edit");
  assert.equal(proposalResult.proposal.state, "candidate");
  assert.equal(proposalResult.proposal.direct_edit.structural_diff[0].path, "frontmatter.description");

  const current = { concept: edited, target_revision: "rev-1", source_hashes: [digest("a")], resolved_dependencies: context.resolved.dependencies, profile: context.resolved.profile, policies: context.resolved.policies };
  await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: "rr_approved", current }), (error) => error.code === "KDLC_PUBLICATION_DENIED" && error.details.failures.includes("review-content-drift"));
  current.concept = reviewed;
  current.source_hashes = [digest("9")];
  current.policies = [{ ...context.resolved.policies[0], version: "8" }];
  current.resolved_dependencies = { "acme.security": { version: "2.5.0", tree_hash: digest("2") } };
  current.target_revision = "rev-2";
  await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: "rr_approved", current }), (error) => error.details.failures.includes("current-source-drift") && error.details.failures.includes("current-policy-drift") && error.details.failures.includes("current-dependency-drift") && error.details.failures.includes("target-revision-drift"));

  const forgedReceipt = structuredClone(receipt);
  forgedReceipt.packet_hash = digest("9");
  const validCurrent = { concept: reviewed, target_revision: "rev-1", source_hashes: [digest("a")], resolved_dependencies: context.resolved.dependencies, profile: context.resolved.profile, policies: context.resolved.policies };
  const forgedAssessment = assessPublication({ proposal: output.proposals[0], packet: review.packet, receipt: forgedReceipt, current: validCurrent, validator, now: clock.now() });
  assert.equal(forgedAssessment.allowed, false);
  assert.equal(forgedAssessment.failures.includes("packet-hash-drift"), true);
  const wrongTarget = { ...output.proposals[0].target, subject: "kb://acme.docs/other" };
  await assert.rejects(() => harness.reconcileEdit({ workflowId: "wf_ingest", proposalId: "pr_wrong", reviewedProposalId: "pr_alpha", target: wrongTarget, reviewedConcept: reviewed, currentConcept: edited, receiptId: receipt.id }), (error) => error.code === "KDLC_RECONCILE_BINDING_INVALID");
});

test("FEAT-004 review packets require exact claims, applicable governance, dynamic fields, and separate freshness authorization", async () => {
  const validator = await createContractValidator(root, AGENT_WORKFLOW_SCHEMA_PATHS);
  const store = new SubstitutingStore();
  const requirements = { sensor_ids: ["source-anchor-valid"], policy_ids: ["freshness-policy", "team-policy"], substantive_fields: ["risk"], freshness: { mode: "separate", policy_id: "freshness-policy" } };
  const context = reviewContext();
  context.resolved.policies.push({ id: "freshness-policy", version: "3", hash: digest("3") });
  const harness = await GovernedAgentWorkflows.create({ validator, store, clock, session: principals.establishReviewSession("reviewer-123", "trust-reviewer"), reviewRequirements: requirements, reviewContextSession: trustedReviewContext("wf_ingest", context) });
  const recording = await fixture("ingest");
  recording.proposals[0].concept.after.frontmatter.risk = "high";
  const output = await harness.runRecorded({ task: "ingest", workflowId: "wf_ingest", recording, normalizedEvidence: await normalizedFixture("ingest") });
  const claimPath = "workflow/runs/wf_ingest/claims/clm_alpha.json";
  const forgedClaim = structuredClone(output.claims[0]);
  forgedClaim.text = "Same ID, substituted claim body.";
  store.substitute(claimPath, forgedClaim);
  await assert.rejects(() => harness.assembleReview({ workflowId: "wf_ingest", proposalId: "pr_alpha" }), (error) => error.code === "KDLC_REVIEW_INPUT_DRIFT");
  store.clearSubstitution(claimPath);
  const contextPath = "workflow/runs/wf_ingest/state/review-context.json";
  const forgedSensor = structuredClone(context);
  forgedSensor.sensors[0] = { ...forgedSensor.sensors[0], result: "passed", execution_hash: digest("9") };
  store.substitute(contextPath, forgedSensor);
  await assert.rejects(() => harness.assembleReview({ workflowId: "wf_ingest", proposalId: "pr_alpha" }), (error) => error.code === "KDLC_REVIEW_INPUT_DRIFT");
  const forgedEvidence = structuredClone(context);
  forgedEvidence.evidence[0].excerpt = "Same source ID and hash, substituted evidence body.";
  store.substitute(contextPath, forgedEvidence);
  await assert.rejects(() => harness.assembleReview({ workflowId: "wf_ingest", proposalId: "pr_alpha" }), (error) => error.code === "KDLC_REVIEW_INPUT_DRIFT");
  const forgedPolicy = structuredClone(context);
  forgedPolicy.resolved.policies[0].hash = digest("9");
  store.substitute(contextPath, forgedPolicy);
  await assert.rejects(() => harness.assembleReview({ workflowId: "wf_ingest", proposalId: "pr_alpha" }), (error) => error.code === "KDLC_REVIEW_INPUT_DRIFT");
  const forgedProfile = structuredClone(context);
  forgedProfile.resolved.profile.hash = digest("9");
  store.substitute(contextPath, forgedProfile);
  await assert.rejects(() => harness.assembleReview({ workflowId: "wf_ingest", proposalId: "pr_alpha" }), (error) => error.code === "KDLC_REVIEW_INPUT_DRIFT");
  store.clearSubstitution(contextPath);
  const review = await harness.assembleReview({ workflowId: "wf_ingest", proposalId: "pr_alpha" });
  assert.equal(review.packet.review.fields.includes("risk"), true);
  assert.equal(review.packet.review.fields.includes("stale_after"), false);
  const { receipt } = await harness.decide({ workflowId: "wf_ingest", proposalId: "pr_alpha", decision: "approved", receiptId: "rr_dynamic" });
  const current = { concept: structuredClone(output.proposals[0].concept.after), target_revision: "rev-1", source_hashes: [digest("a")], resolved_dependencies: context.resolved.dependencies, profile: context.resolved.profile, policies: context.resolved.policies };
  store.substitute(claimPath, forgedClaim);
  await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: receipt.id, current }), (error) => error.code === "KDLC_REVIEW_INPUT_DRIFT");
  store.clearSubstitution(claimPath);
  store.substitute(contextPath, forgedSensor);
  await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: receipt.id, current }), (error) => error.code === "KDLC_REVIEW_INPUT_DRIFT");
  store.clearSubstitution(contextPath);
  for (const substitutedContext of [forgedEvidence, forgedPolicy, forgedProfile, { ...structuredClone(context), resolved: { ...structuredClone(context.resolved), dependencies: { "acme.security": { version: "2.4.0", tree_hash: digest("9") } } } }]) {
    store.substitute(contextPath, substitutedContext);
    await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: receipt.id, current }), (error) => error.code === "KDLC_REVIEW_INPUT_DRIFT");
  }
  store.clearSubstitution(contextPath);
  const normalizedPath = "workflow/runs/wf_ingest/state/normalized-evidence.json";
  const substitutedNormalized = await normalizedFixture("ingest"); substitutedNormalized.units[0].text = "Same source identity, substituted normalized body.";
  store.substitute(normalizedPath, substitutedNormalized);
  await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: receipt.id, current }), (error) => error.code === "KDLC_REVIEW_INPUT_DRIFT");
  store.clearSubstitution(normalizedPath);
  const packetPath = "workflow/runs/wf_ingest/reviews/pr_alpha/packet.json";
  const substitutedPacket = structuredClone(review.packet); substitutedPacket.impact.freshness_change = "forged";
  store.substitute(packetPath, substitutedPacket);
  await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: receipt.id, current }), (error) => error.code === "KDLC_REVIEW_INPUT_DRIFT");
  store.clearSubstitution(packetPath);
  const receiptPath = "workflow/runs/wf_ingest/receipts/rr_dynamic.json";
  const substitutedReceipt = structuredClone(receipt); substitutedReceipt.reviewer = { actor: "human:attacker", principal_mode: "local" };
  store.substitute(receiptPath, substitutedReceipt);
  await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: receipt.id, current }), (error) => error.code === "KDLC_PUBLICATION_DENIED" && error.details.failures.includes("active-decision-drift"));
  store.clearSubstitution(receiptPath);
  current.concept.frontmatter.stale_after = "2031-01-01";
  await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: receipt.id, current }), (error) => error.details.failures.includes("freshness-authorization-invalid"));
  const forgedAuthorization = { api_version: "kdlc.dev/freshness-authorization/v1alpha1", subject: output.proposals[0].target.subject, field: "stale_after", value_hash: artifactHash(current.concept.frontmatter.stale_after), packet_hash: artifactHash(review.packet), policy: context.resolved.policies[1], authorized_by: "human:attacker", authorized_at: clock.now() };
  assert.equal(validator.validate("freshnessAuthorization", forgedAuthorization).valid, true);
  await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: receipt.id, freshnessAuthorization: forgedAuthorization, current }), (error) => error.details.failures.includes("freshness-authorization-invalid"));
  await assert.rejects(() => harness.authorizeFreshness({ workflowId: "wf_ingest", proposalId: "pr_alpha", concept: current.concept }), (error) => error.code === "KDLC_FRESHNESS_AUTHORITY_DENIED");
  const governanceHarness = await GovernedAgentWorkflows.create({ validator, store, clock, session: principals.establishReviewSession("governor", "governance-reviewer"), reviewRequirements: requirements });
  const { authorization, decision: freshnessDecision } = await governanceHarness.authorizeFreshness({ workflowId: "wf_ingest", proposalId: "pr_alpha", concept: current.concept });
  assert.equal(authorization.authorized_by, "human:governor");
  assert.equal(validator.validate("freshnessDecision", freshnessDecision).valid, true);
  await assert.rejects(() => governanceHarness.authorizeFreshness({ workflowId: "wf_ingest", proposalId: "pr_alpha", concept: current.concept }), (error) => error.code === "KDLC_FRESHNESS_CONFLICT");
  const freshnessPath = "workflow/runs/wf_ingest/reviews/pr_alpha/freshness-authorization.json";
  store.substitute(freshnessPath, { ...authorization, authorized_by: "human:attacker" });
  await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: receipt.id, current }), (error) => error.code === "KDLC_PUBLICATION_DENIED" && error.details.failures.includes("freshness-authorization-invalid"));
  store.clearSubstitution(freshnessPath);
  const freshnessDecisionPath = "workflow/runs/wf_ingest/reviews/pr_alpha/freshness-decision.json";
  const forgedFreshness = { ...structuredClone(authorization), authorized_by: "human:attacker" };
  const forgedFreshnessDecision = { ...structuredClone(freshnessDecision), authorization_hash: artifactHash(forgedFreshness), authorized_by: "human:attacker" };
  store.substitute(freshnessPath, forgedFreshness);
  store.substitute(freshnessDecisionPath, forgedFreshnessDecision);
  await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: receipt.id, current }), (error) => error.code === "KDLC_PUBLICATION_DENIED" && error.details.failures.includes("freshness-trust-proof-invalid"));
  store.clearSubstitution(freshnessPath);
  store.clearSubstitution(freshnessDecisionPath);
  await harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: receipt.id, current });
  current.concept.frontmatter.risk = "low";
  await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: receipt.id, current }), (error) => error.details.failures.includes("review-content-drift"));
});
