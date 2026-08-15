import { AGENT_WORKFLOW_SCHEMA_PATHS, CapabilityRuntime, PrincipalAuthority, RecordedModelRuntime } from "../agents/index.mjs";
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
  #principals;
  #validator;
  #clock;

  constructor({ store, capabilities, models, principals, validator, clock = { now: () => new Date().toISOString() } }) {
    this.#store = store;
    this.#capabilities = capabilities;
    this.#models = models;
    this.#principals = principals;
    this.#validator = validator;
    this.#clock = clock;
  }

  static async create({ store = new MemoryArtifactStore(), capabilities, models, principals = new PrincipalAuthority([]), validator, clock } = {}) {
    const contracts = validator ?? await createContractValidator(undefined, AGENT_WORKFLOW_SCHEMA_PATHS);
    return new GovernedAgentWorkflows({
      store,
      capabilities: capabilities ?? await CapabilityRuntime.create({ validator: contracts }),
      models: models ?? await RecordedModelRuntime.create({ validator: contracts }),
      principals,
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
    const result = createReviewPacket({ proposal, claims, evidence, sensors, impact, resolved, provenance, budget, validator: this.#validator });
    const packetPath = `workflow/runs/${workflowId}/reviews/${proposalId}/packet.json`;
    this.#capabilities.authorize("conductor", "write", packetPath);
    if (typeof this.#store.putReviewPacket !== "function") throw new GovernanceError("KDLC_STORE_ATOMIC_REQUIRED", "Review packet immutability requires atomic store support");
    const stored = await this.#store.putReviewPacket({ path: packetPath, value: result.packet, receiptPrefix: `workflow/runs/${workflowId}/receipts/`, proposalId });
    if (!stored) throw new GovernanceError("KDLC_REVIEW_PACKET_IMMUTABLE", `Proposal ${proposalId} already has a decision`);
    return Object.freeze({ ...result, path: packetPath });
  }

  async decide({ role, workflowId, proposalId, decision, principalId, receiptId }) {
    if (role !== "trust-reviewer" && role !== "governance-reviewer") throw new GovernanceError("KDLC_REVIEW_ROLE_INVALID", `Role ${role} cannot record review decisions`);
    const packet = await this.#get(role, `workflow/runs/${workflowId}/reviews/${proposalId}/packet.json`);
    const reviewer = this.#principals.resolve(principalId);
    const receipt = createReviewReceipt({ packet, decision, reviewer, receiptId, reviewedAt: this.#clock.now(), validator: this.#validator });
    const path = `workflow/runs/${workflowId}/receipts/${receiptId}.json`;
    this.#capabilities.authorize(role, "write", path);
    if (typeof this.#store.putIfAbsent !== "function") throw new GovernanceError("KDLC_STORE_ATOMIC_REQUIRED", "Review receipts require atomic create-if-absent store support");
    if (!await this.#store.putIfAbsent(path, receipt)) throw new GovernanceError("KDLC_RECEIPT_IMMUTABLE", `Receipt already exists: ${receiptId}`);
    return Object.freeze({ receipt, path });
  }

  async preparePublication({ workflowId, proposalId, receiptId, current }) {
    const proposal = await this.#get("conductor", `workflow/runs/${workflowId}/proposals/${proposalId}.json`);
    const packet = await this.#get("conductor", `workflow/runs/${workflowId}/reviews/${proposalId}/packet.json`);
    const receipt = receiptId ? await this.#get("conductor", `workflow/runs/${workflowId}/receipts/${receiptId}.json`) : null;
    const assessment = assessPublication({ proposal, packet, receipt, current, validator: this.#validator, now: this.#clock.now() });
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

  async reconcileEdit({ workflowId, proposalId, target, reviewedConcept, currentConcept, receipt }) {
    const proposal = reconcileDirectEdit({ proposalId, workflowId, target, reviewedConcept, currentConcept, receipt, validator: this.#validator });
    const path = `workflow/runs/${workflowId}/proposals/${proposalId}.json`;
    await this.#put("integrator", path, proposal);
    return Object.freeze({ proposal, path });
  }
}
