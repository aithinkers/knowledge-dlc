import { AGENT_WORKFLOW_SCHEMA_PATHS, CapabilityRuntime, RecordedModelRuntime, resolveAuthenticatedReviewSession } from "../agents/index.mjs";
import { createContractValidator } from "../contracts/index.mjs";
import { artifactHash, canonicalJson } from "../core/index.mjs";
import { assessPublication, createReviewPacket, createReviewReceipt, GovernanceError, reconcileDirectEdit } from "../governance/index.mjs";

export class MemoryArtifactStore {
  constructor() { this.artifacts = new Map(); }
  async put(path, value) { this.artifacts.set(path, structuredClone(value)); }
  async putMany(entries) {
    const updated = new Map(this.artifacts);
    for (const { path, value } of entries) updated.set(path, structuredClone(value));
    this.artifacts = updated;
  }
  async putIfAbsent(path, value) {
    if (this.artifacts.has(path)) return false;
    this.artifacts.set(path, structuredClone(value));
    return true;
  }
  async commitDecision({ receiptPath, receipt, decisionPath, decision, expectedReceiptId }) {
    const current = this.artifacts.get(decisionPath)?.receipt_id ?? null;
    if (current !== expectedReceiptId) return { status: "conflict", current };
    if (this.artifacts.has(receiptPath)) return { status: "receipt-exists" };
    const updated = new Map(this.artifacts);
    updated.set(receiptPath, structuredClone(receipt));
    updated.set(decisionPath, structuredClone(decision));
    this.artifacts = updated;
    return { status: "stored" };
  }
  async putReviewPacket({ path, value, receiptPrefix, proposalId }) {
    for (const [candidate, receipt] of this.artifacts) {
      if (candidate.startsWith(receiptPrefix) && receipt.proposal_id === proposalId) return false;
    }
    this.artifacts.set(path, structuredClone(value));
    return true;
  }
  async get(path) {
    if (!this.artifacts.has(path)) throw new GovernanceError("KDLC_ARTIFACT_MISSING", `Missing workflow artifact: ${path}`);
    return structuredClone(this.artifacts.get(path));
  }
  async has(path) { return this.artifacts.has(path); }
}

export class GovernedAgentWorkflows {
  #store;
  #capabilities;
  #models;
  #session;
  #reviewRequirements;
  #validator;
  #clock;

  constructor({ store, capabilities, models, session, reviewRequirements, validator, clock = { now: () => new Date().toISOString() } }) {
    this.#store = store;
    this.#capabilities = capabilities;
    this.#models = models;
    this.#session = session;
    this.#reviewRequirements = structuredClone(reviewRequirements);
    this.#validator = validator;
    this.#clock = clock;
  }

  static async create({ store = new MemoryArtifactStore(), capabilities, models, session, reviewRequirements = { sensor_ids: ["source-anchor-valid"], policy_ids: ["team-policy"], substantive_fields: [], freshness: { mode: "reviewed" } }, validator, clock } = {}) {
    const contracts = validator ?? await createContractValidator(undefined, AGENT_WORKFLOW_SCHEMA_PATHS);
    return new GovernedAgentWorkflows({
      store,
      capabilities: capabilities ?? await CapabilityRuntime.create({ validator: contracts }),
      models: models ?? await RecordedModelRuntime.create({ validator: contracts }),
      session,
      reviewRequirements,
      validator: contracts,
      clock
    });
  }

  async #put(role, path, value) {
    this.#capabilities.authorize(role, "write", path);
    await this.#store.put(path, value);
  }

  async #putMany(entries) {
    for (const { role, path } of entries) this.#capabilities.authorize(role, "write", path);
    if (typeof this.#store.putMany !== "function") throw new GovernanceError("KDLC_STORE_ATOMIC_REQUIRED", "Recorded model workflows require an atomic putMany store operation");
    await this.#store.putMany(entries.map(({ path, value }) => ({ path, value })));
  }

  async #get(role, path) {
    this.#capabilities.authorize(role, "read", path);
    return this.#store.get(path);
  }

  async runRecorded({ task, workflowId, recording, normalizedEvidence }) {
    if (task !== "ingest" && task !== "adopt") throw new GovernanceError("KDLC_WORKFLOW_TASK_INVALID", `Unsupported recorded workflow task: ${task}`);
    const normalizedValidation = this.#validator.validate("recordedNormalizedFixture", normalizedEvidence);
    if (!normalizedValidation.valid) throw new GovernanceError("KDLC_NORMALIZED_FIXTURE_INVALID", "Recorded normalized fixture failed schema validation", { errors: normalizedValidation.errors });
    const inputHashes = { normalized_evidence: artifactHash(normalizedEvidence) };
    const output = this.#models.replay(recording, { task, inputHashes });
    const anchors = new Set(normalizedEvidence.units.map(({ locator }) => canonicalJson(locator)));
    for (const claim of output.claims) {
      if (claim.source_id !== normalizedEvidence.source_id || claim.source_hash !== normalizedEvidence.source_hash || !claim.locator || !anchors.has(canonicalJson(claim.locator))) {
        throw new GovernanceError("KDLC_MODEL_SOURCE_DRIFT", `Claim ${claim.id} is not anchored to the recorded normalized fixture`);
      }
    }
    for (const proposal of output.proposals) {
      if (proposal.workflow_id !== workflowId) throw new GovernanceError("KDLC_MODEL_RECORDING_DRIFT", `Proposal ${proposal.id} belongs to another workflow`);
    }
    await this.#putMany([
      ...output.claims.map((claim) => ({ role: "source-analyst", path: `workflow/runs/${workflowId}/claims/${claim.id}.json`, value: claim })),
      ...output.proposals.map((proposal) => ({ role: "integrator", path: `workflow/runs/${workflowId}/proposals/${proposal.id}.json`, value: proposal }))
    ]);
    return Object.freeze({ claims: structuredClone(output.claims), proposals: structuredClone(output.proposals), model: structuredClone(output.model) });
  }

  async assembleReview({ workflowId, proposalId, claims, evidence, sensors, impact, resolved, provenance, budget }) {
    const proposalPath = `workflow/runs/${workflowId}/proposals/${proposalId}.json`;
    const proposal = await this.#get("conductor", proposalPath);
    const result = createReviewPacket({ proposal, claims, evidence, sensors, impact, resolved, provenance, budget, requirements: this.#reviewRequirements, validator: this.#validator });
    const packetPath = `workflow/runs/${workflowId}/reviews/${proposalId}/packet.json`;
    this.#capabilities.authorize("conductor", "write", packetPath);
    if (typeof this.#store.putReviewPacket !== "function") throw new GovernanceError("KDLC_STORE_ATOMIC_REQUIRED", "Review packet immutability requires atomic store support");
    const stored = await this.#store.putReviewPacket({ path: packetPath, value: result.packet, receiptPrefix: `workflow/runs/${workflowId}/receipts/`, proposalId });
    if (!stored) throw new GovernanceError("KDLC_REVIEW_PACKET_IMMUTABLE", `Proposal ${proposalId} already has a decision`);
    return Object.freeze({ ...result, path: packetPath });
  }

  async decide({ workflowId, proposalId, decision, receiptId, expectedReceiptId = null }) {
    const { role, reviewer } = resolveAuthenticatedReviewSession(this.#session);
    const packet = await this.#get(role, `workflow/runs/${workflowId}/reviews/${proposalId}/packet.json`);
    const receipt = createReviewReceipt({ packet, decision, reviewer, receiptId, reviewedAt: this.#clock.now(), validator: this.#validator });
    const path = `workflow/runs/${workflowId}/receipts/${receiptId}.json`;
    const decisionPath = `workflow/runs/${workflowId}/reviews/${proposalId}/decision.json`;
    this.#capabilities.authorize(role, "write", path);
    this.#capabilities.authorize(role, "write", decisionPath);
    const activeDecision = { api_version: "kdlc.dev/review-decision/v1alpha1", proposal_id: proposalId, packet_hash: artifactHash(packet), receipt_id: receiptId, decision, decided_at: this.#clock.now() };
    const validation = this.#validator.validate("reviewDecision", activeDecision);
    if (!validation.valid) throw new GovernanceError("KDLC_ARTIFACT_INVALID", "Review decision failed schema validation", { errors: validation.errors });
    if (typeof this.#store.commitDecision !== "function") throw new GovernanceError("KDLC_STORE_ATOMIC_REQUIRED", "Review decisions require an atomic compare-and-set store operation");
    const stored = await this.#store.commitDecision({ receiptPath: path, receipt, decisionPath, decision: activeDecision, expectedReceiptId });
    if (stored.status === "receipt-exists") throw new GovernanceError("KDLC_RECEIPT_IMMUTABLE", `Receipt already exists: ${receiptId}`);
    if (stored.status === "conflict") throw new GovernanceError("KDLC_DECISION_CONFLICT", "Active decision changed before this decision was recorded", { expected: expectedReceiptId, current: stored.current });
    return Object.freeze({ receipt, decision: structuredClone(activeDecision), path });
  }

  async authorizeFreshness({ workflowId, proposalId, concept }) {
    const { role, reviewer } = resolveAuthenticatedReviewSession(this.#session);
    if (role !== "governance-reviewer") throw new GovernanceError("KDLC_FRESHNESS_AUTHORITY_DENIED", "Only an authenticated governance reviewer may authorize separate freshness");
    const packet = await this.#get(role, `workflow/runs/${workflowId}/reviews/${proposalId}/packet.json`);
    if (packet.governance_requirements.freshness.mode !== "separate") throw new GovernanceError("KDLC_FRESHNESS_AUTHORITY_DENIED", "The applicable profile does not use separate freshness authorization");
    const policy = packet.resolved.policies.find(({ id }) => id === packet.governance_requirements.freshness.policy_id);
    const authorization = { api_version: "kdlc.dev/freshness-authorization/v1alpha1", subject: packet.target.subject, field: "stale_after", value_hash: artifactHash(concept?.frontmatter?.stale_after), packet_hash: artifactHash(packet), policy: structuredClone(policy), authorized_by: reviewer.actor, authorized_at: this.#clock.now() };
    const validation = this.#validator.validate("freshnessAuthorization", authorization);
    if (!validation.valid) throw new GovernanceError("KDLC_ARTIFACT_INVALID", "Freshness authorization failed schema validation", { errors: validation.errors });
    const path = `workflow/runs/${workflowId}/reviews/${proposalId}/freshness-authorization.json`;
    await this.#put(role, path, authorization);
    return Object.freeze({ authorization: structuredClone(authorization), path });
  }

  async preparePublication({ workflowId, proposalId, receiptId, current }) {
    const proposal = await this.#get("conductor", `workflow/runs/${workflowId}/proposals/${proposalId}.json`);
    const packet = await this.#get("conductor", `workflow/runs/${workflowId}/reviews/${proposalId}/packet.json`);
    const receipt = receiptId ? await this.#get("conductor", `workflow/runs/${workflowId}/receipts/${receiptId}.json`) : null;
    const decisionState = await this.#store.has(`workflow/runs/${workflowId}/reviews/${proposalId}/decision.json`) ? await this.#get("conductor", `workflow/runs/${workflowId}/reviews/${proposalId}/decision.json`) : null;
    const freshnessPath = `workflow/runs/${workflowId}/reviews/${proposalId}/freshness-authorization.json`;
    const freshnessAuthorization = await this.#store.has(freshnessPath) ? await this.#get("conductor", freshnessPath) : null;
    const assessment = assessPublication({ proposal, packet, receipt, decisionState, freshnessAuthorization, current, validator: this.#validator, now: this.#clock.now() });
    if (!assessment.allowed) throw new GovernanceError("KDLC_PUBLICATION_DENIED", "Publication policy gates failed", { failures: assessment.failures });
    const intent = {
      api_version: "kdlc.dev/publication-intent/v1alpha1",
      workflow_id: workflowId,
      proposal_id: proposalId,
      receipt_id: receipt.id,
      packet_hash: receipt.packet_hash,
      review_hash: receipt.review.hash,
      subject: proposal.target.subject,
      prepared_at: this.#clock.now()
    };
    const intentValidation = this.#validator.validate("publicationIntent", intent);
    if (!intentValidation.valid) throw new GovernanceError("KDLC_ARTIFACT_INVALID", "Publication intent failed schema validation", { errors: intentValidation.errors });
    const path = `workflow/runs/${workflowId}/publication/${proposalId}.json`;
    await this.#put("conductor", path, intent);
    return Object.freeze({ intent: structuredClone(intent), path });
  }

  async reconcileEdit({ workflowId, proposalId, reviewedProposalId, target, reviewedConcept, currentConcept, receipt }) {
    const packet = await this.#get("integrator", `workflow/runs/${workflowId}/reviews/${reviewedProposalId}/packet.json`);
    const proposal = reconcileDirectEdit({ proposalId, workflowId, target, reviewedConcept, currentConcept, packet, receipt, validator: this.#validator });
    const path = `workflow/runs/${workflowId}/proposals/${proposalId}.json`;
    await this.#put("integrator", path, proposal);
    return Object.freeze({ proposal, path });
  }
}
