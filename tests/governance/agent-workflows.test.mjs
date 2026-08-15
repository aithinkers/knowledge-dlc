import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { AGENT_WORKFLOW_SCHEMA_PATHS, AgentPolicyError, CapabilityRuntime, loadRoleDescriptors, PrincipalAuthority } from "../../packages/agents/index.mjs";
import { createContractValidator } from "../../packages/contracts/index.mjs";
import { artifactHash } from "../../packages/core/index.mjs";
import { assessPublication, verificationStatus } from "../../packages/governance/index.mjs";
import { GovernedAgentWorkflows, MemoryArtifactStore } from "../../packages/workflows/index.mjs";

const root = resolve(import.meta.dirname, "../..");
const digest = (character) => `sha256:${character.repeat(64)}`;
const clock = { now: () => "2026-08-14T15:20:00Z" };
const principals = new PrincipalAuthority([
  { id: "reviewer-123", actor: "human:reviewer-123", principal_mode: "served", issuer: "https://id.acme.example" },
  { id: "governor", actor: "human:governor", principal_mode: "local" },
  { id: "other", actor: "human:other", principal_mode: "local" }
]);

async function fixture(name) {
  return JSON.parse(await readFile(resolve(root, `tests/fixtures/models/${name}-recording.json`), "utf8"));
}
async function normalizedFixture(name) {
  return JSON.parse(await readFile(resolve(root, `tests/fixtures/workflows/${name}-normalized.json`), "utf8"));
}

function reviewContext(sourceHash = digest("a")) {
  return {
    evidence: [{ source_id: "src_alpha", source_hash: sourceHash, locator: { heading: "Token lifetime" }, excerpt: "Tokens expire after 60 minutes.", authority: "team:security", access: { classification: "public" }, rights: { use: "internal" }, extraction_quality: "high", warnings: [] }],
    sensors: [{ id: "source-anchor-valid", severity: "error", result: "passed" }],
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

async function approvedHarness() {
  const validator = await createContractValidator(root, AGENT_WORKFLOW_SCHEMA_PATHS);
  const store = new MemoryArtifactStore();
  const harness = await GovernedAgentWorkflows.create({ validator, store, clock, principals });
  const recording = await fixture("ingest");
  const output = await harness.runRecorded({ task: "ingest", workflowId: "wf_ingest", recording, normalizedEvidence: await normalizedFixture("ingest") });
  const context = reviewContext();
  const review = await harness.assembleReview({ workflowId: "wf_ingest", proposalId: "pr_alpha", claims: output.claims, ...context });
  const decision = await harness.decide({ role: "trust-reviewer", workflowId: "wf_ingest", proposalId: "pr_alpha", decision: "approved", principalId: "reviewer-123", receiptId: "rr_approved" });
  return { validator, store, harness, recording, output, context, review, receipt: decision.receipt };
}

test("FEAT-004 role and stage descriptors enforce runtime path capabilities", async () => {
  const validator = await createContractValidator(root, AGENT_WORKFLOW_SCHEMA_PATHS);
  await assert.rejects(() => createContractValidator(root, { claim: "core/schemas/artifacts/concept-proposal.schema.json" }), /cannot replace core contract/);
  const roles = await loadRoleDescriptors({ validator });
  assert.deepEqual([...roles.keys()].sort(), ["conductor", "governance-reviewer", "integrator", "librarian", "source-analyst", "trust-reviewer"]);
  const capabilities = new CapabilityRuntime(roles);
  assert.equal(capabilities.authorize("source-analyst", "write", "workflow/runs/wf_ingest/claims/clm_alpha.json"), true);
  assert.equal(capabilities.authorize("trust-reviewer", "write", "workflow/runs/wf_ingest/receipts/rr_alpha.json"), true);
  assert.throws(() => capabilities.authorize("trust-reviewer", "write", "workflow/runs/wf_ingest/proposals/pr_alpha.json"), (error) => error instanceof AgentPolicyError && error.code === "KDLC_REVIEWER_READ_ONLY");
  assert.throws(() => capabilities.authorize("conductor", "write", "../knowledge-bases/acme.docs/concept.md"), (error) => error.code === "KDLC_PATH_INVALID");
  assert.throws(() => capabilities.authorize("conductor", "write", "knowledge-bases/acme.docs/concept.md"), (error) => error.code === "KDLC_CAPABILITY_DENIED");
  let invoked = false;
  await assert.rejects(() => capabilities.run("trust-reviewer", [{ operation: "read", path: "workflow/runs/wf_ingest/reviews/pr_alpha/packet.json" }, { operation: "write", path: "workflow/runs/wf_ingest/proposals/pr_alpha.json" }], async () => { invoked = true; }), (error) => error.code === "KDLC_REVIEWER_READ_ONLY");
  assert.equal(invoked, false);

  for (const name of (await readdir(resolve(root, "packages/workflows/stages"))).sort()) {
    const stage = JSON.parse(await readFile(resolve(root, "packages/workflows/stages", name), "utf8"));
    assert.deepEqual(validator.validate("lifecycleStage", stage), { valid: true, errors: [] }, name);
  }
});

test("FEAT-004 ingest and adoption replay schema-valid recorded model outputs", async () => {
  const validator = await createContractValidator(root, AGENT_WORKFLOW_SCHEMA_PATHS);
  for (const [task, workflowId] of [["ingest", "wf_ingest"], ["adopt", "wf_adopt"]]) {
    const store = new MemoryArtifactStore();
    const harness = await GovernedAgentWorkflows.create({ validator, store, clock, principals });
    const recording = await fixture(task);
    const normalizedEvidence = await normalizedFixture(task);
    assert.equal(recording.input_hashes.normalized_evidence, artifactHash(normalizedEvidence));
    const output = await harness.runRecorded({ task, workflowId, recording, normalizedEvidence });
    assert.equal(output.claims.length, 1);
    assert.equal(validator.validate("claim", output.claims[0]).valid, true);
    assert.equal(validator.validate("conceptProposal", output.proposals[0]).valid, true);
    assert.equal(await store.has(`workflow/runs/${workflowId}/claims/${output.claims[0].id}.json`), true);
    assert.equal(await store.has(`workflow/runs/${workflowId}/proposals/${output.proposals[0].id}.json`), true);
  }
});

test("FEAT-004 invalid or drifted model recordings fail before emitting artifacts", async () => {
  const validator = await createContractValidator(root, AGENT_WORKFLOW_SCHEMA_PATHS);
  const store = new MemoryArtifactStore();
  const harness = await GovernedAgentWorkflows.create({ validator, store, clock, principals });
  const recording = await fixture("ingest");
  recording.claims[0].source_hash = "not-a-digest";
  const normalizedEvidence = await normalizedFixture("ingest");
  await assert.rejects(() => harness.runRecorded({ task: "ingest", workflowId: "wf_ingest", recording, normalizedEvidence }), (error) => error.code === "KDLC_MODEL_RECORDING_INVALID");
  assert.equal(store.artifacts.size, 0);

  const nonAtomicStore = { put: async () => {}, get: async () => {}, has: async () => false };
  const nonAtomicHarness = await GovernedAgentWorkflows.create({ validator, store: nonAtomicStore, clock, principals });
  const atomicRecording = await fixture("ingest");
  await assert.rejects(() => nonAtomicHarness.runRecorded({ task: "ingest", workflowId: "wf_ingest", recording: atomicRecording, normalizedEvidence }), (error) => error.code === "KDLC_STORE_ATOMIC_REQUIRED");

  const valid = await fixture("ingest");
  valid.input_hashes.normalized_evidence = digest("9");
  await assert.rejects(() => harness.runRecorded({ task: "ingest", workflowId: "wf_ingest", recording: valid, normalizedEvidence }), (error) => error.code === "KDLC_MODEL_RECORDING_DRIFT");
  const unanchored = await fixture("ingest");
  unanchored.claims[0].source_hash = digest("9");
  await assert.rejects(() => harness.runRecorded({ task: "ingest", workflowId: "wf_ingest", recording: unanchored, normalizedEvidence }), (error) => error.code === "KDLC_MODEL_SOURCE_DRIFT");
  assert.equal(store.artifacts.size, 0);
});

test("FEAT-004 approved human review binds the exact packet and permits stable publication intent", async () => {
  const { validator, harness, output, context, review, receipt } = await approvedHarness();
  assert.equal(validator.validate("reviewPacket", review.packet).valid, true);
  assert.equal(validator.validate("reviewReceipt", receipt).valid, true);
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
  await assert.rejects(() => harness.assembleReview({ workflowId: "wf_ingest", proposalId: "pr_alpha", claims: output.claims, ...context }), (error) => error.code === "KDLC_REVIEW_PACKET_IMMUTABLE");
  await assert.rejects(() => harness.decide({ role: "trust-reviewer", workflowId: "wf_ingest", proposalId: "pr_alpha", decision: "approved", principalId: "other", receiptId: "rr_approved" }), (error) => error.code === "KDLC_RECEIPT_IMMUTABLE");
});

test("FEAT-004 stable publication fails closed for missing, machine, rejected, and changes-requested receipts", async () => {
  const { validator, harness, output, context, review } = await approvedHarness();
  const current = { concept: output.proposals[0].concept.after, target_revision: "rev-1", source_hashes: [digest("a")], resolved_dependencies: context.resolved.dependencies, profile: context.resolved.profile, policies: context.resolved.policies };
  await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", current }), (error) => error.code === "KDLC_PUBLICATION_DENIED" && error.details.failures.includes("receipt-missing"));
  await assert.rejects(() => harness.decide({ role: "trust-reviewer", workflowId: "wf_ingest", proposalId: "pr_alpha", decision: "approved", principalId: "model-supplied-reviewer", receiptId: "rr_forged" }), (error) => error.code === "KDLC_PRINCIPAL_UNRESOLVED");

  for (const [decision, receiptId] of [["rejected", "rr_rejected"], ["changes-requested", "rr_changes"]]) {
    await harness.decide({ role: "governance-reviewer", workflowId: "wf_ingest", proposalId: "pr_alpha", decision, principalId: "governor", receiptId });
    await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId, current }), (error) => error.code === "KDLC_PUBLICATION_DENIED" && error.details.failures.includes(`receipt-${decision}`));
  }

  const machineReceipt = (await import("../../packages/governance/index.mjs")).createReviewReceipt({ packet: review.packet, decision: "approved", reviewer: { actor: "process:automatic-review", principal_mode: "automation" }, receiptId: "rr_machine", reviewedAt: clock.now(), validator });
  const assessment = assessPublication({ proposal: output.proposals[0], packet: review.packet, receipt: machineReceipt, current, validator, now: clock.now() });
  assert.equal(assessment.allowed, false);
  assert.equal(assessment.failures.includes("human-review-required"), true);
});

test("FEAT-004 review-covered drift invalidates verification and reconciles only through a proposal", async () => {
  const { validator, harness, output, context, review, receipt } = await approvedHarness();
  const reviewed = output.proposals[0].concept.after;
  const edited = structuredClone(reviewed);
  edited.frontmatter.description = "Directly edited policy description.";
  assert.equal(verificationStatus({ concept: edited, receipt }).status, "modified-after-review");

  const proposalResult = await harness.reconcileEdit({ workflowId: "wf_ingest", proposalId: "pr_reconcile", target: output.proposals[0].target, reviewedConcept: reviewed, currentConcept: edited, receipt });
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
});
