import { AGENT_WORKFLOW_SCHEMA_PATHS, CapabilityRuntime, RecordedModelRuntime, RuntimeTrustAuthority, resolveAuthenticatedReviewSession, resolveTrustedReviewContext } from "../agents/index.mjs";
import { createContractValidator } from "../contracts/index.mjs";
import { artifactHash, canonicalJson } from "../core/index.mjs";
import { assessPublication, createReviewPacket, createReviewReceipt, GovernanceError, reconcileDirectEdit } from "../governance/index.mjs";
import { NodeFileStore } from "../lifecycle/src/store.mjs";

const PUT = Symbol("put");
const PUT_MANY = Symbol("put-many");
const STORE_REVIEW = Symbol("store-review");
const STORE_DECISION = Symbol("store-decision");
const STORE_FRESHNESS = Symbol("store-freshness");

export class MemoryArtifactStore {
  constructor() { memoryStoreStates.set(this, new Map()); }
  async get(path) {
    const artifacts = memoryState(this);
    if (!artifacts.has(path)) throw new GovernanceError("KDLC_ARTIFACT_MISSING", `Missing workflow artifact: ${path}`);
    return structuredClone(artifacts.get(path));
  }
  async has(path) { return memoryState(this).has(path); }
  async [PUT](path, value) { storePut(this, path, value); }
  async [PUT_MANY](entries) { storePutMany(this, entries); }
  async [STORE_REVIEW](input) { return storeReviewPacket(this, input); }
  async [STORE_DECISION](input) { return storeDecision(this, input); }
  async [STORE_FRESHNESS](input) { return storeFreshness(this, input); }
  get size() { return memoryState(this).size; }
}

export class DurableArtifactStore {
  constructor(root, { clock = { now: () => new Date().toISOString(), millis: () => Date.now() } } = {}) {
    this.files = new NodeFileStore(root);
    this.clock = clock;
  }
  async get(path) {
    if (!await this.files.exists(path)) throw new GovernanceError("KDLC_ARTIFACT_MISSING", `Missing workflow artifact: ${path}`);
    return this.files.readJson(path);
  }
  async has(path) { return this.files.exists(path); }
  async #coordinate(key, action) {
    return this.files.withMutex(`.coordination/${artifactHash(key).slice(7)}`, { owner: `workflow:${process.pid}`, clock: this.clock }, action);
  }
  async [PUT](path, value) { return this.#coordinate(path, () => this.files.writeJsonAtomic(path, value)); }
  async [PUT_MANY](entries) {
    return this.#coordinate("workflow-artifacts", async () => {
      for (const { path, value } of entries) await this.files.writeJsonAtomic(path, value);
    });
  }
  async [STORE_REVIEW]({ path, value, receiptPrefix, proposalId }) {
    return this.#coordinate(`proposal:${proposalId}`, async () => {
      if (await this.has(path)) return false;
      const decisionPath = path.replace(/packet\.json$/, "decision.json");
      if (await this.has(decisionPath)) return false;
      await this.files.writeJsonAtomic(path, value);
      return true;
    });
  }
  async #journaled(kind, key, operations) {
    const journalPath = `.transactions/${kind}-${artifactHash(key).slice(7)}.json`;
    let journal = await this.has(journalPath) ? await this.get(journalPath) : null;
    if (!journal) {
      journal = { api_version: "kdlc.dev/artifact-transaction/v1alpha1", kind, key, operations };
      await this.files.writeJsonAtomic(journalPath, journal);
    } else if (artifactHash(journal.operations) !== artifactHash(operations)) {
      throw new GovernanceError("KDLC_ARTIFACT_TRANSACTION_CONFLICT", "A durable artifact transaction has different content");
    }
    for (const operation of journal.operations) {
      if (await this.has(operation.path)) {
        if (artifactHash(await this.get(operation.path)) !== artifactHash(operation.value)) throw new GovernanceError("KDLC_ARTIFACT_IMMUTABLE", `Artifact already differs: ${operation.path}`);
      } else await this.files.writeJsonAtomic(operation.path, operation.value);
    }
    return { status: "stored" };
  }
  async [STORE_DECISION]({ receiptPath, receipt, decisionPath, decision, expectedReceiptId }) {
    return this.#coordinate(`decision-cas:${decision.proposal_id}`, async () => {
      if (await this.has(decisionPath) && await this.has(receiptPath)
        && artifactHash(await this.get(decisionPath)) === artifactHash(decision)
        && artifactHash(await this.get(receiptPath)) === artifactHash(receipt)) return { status: "stored" };
      const current = await this.has(decisionPath) ? (await this.get(decisionPath)).receipt_id : null;
      if (current !== expectedReceiptId) return { status: "conflict", current };
      const journalPath = `.transactions/decision-${artifactHash(`${decision.proposal_id}:${receipt.id}`).slice(7)}.json`;
      if (await this.has(receiptPath) && !await this.has(journalPath)) return { status: "receipt-exists" };
      return this.#journaled("decision", `${decision.proposal_id}:${receipt.id}`, [{ path: receiptPath, value: receipt }, { path: decisionPath, value: decision }]);
    });
  }
  async [STORE_FRESHNESS]({ authorizationPath, authorization, decisionPath, decision, expectedAuthorizationHash }) {
    return this.#coordinate(`freshness-cas:${decision.proposal_id}`, async () => {
      const current = await this.has(decisionPath) ? (await this.get(decisionPath)).authorization_hash : null;
      if (current !== expectedAuthorizationHash) return { status: "conflict", current };
      return this.#journaled("freshness", `${decision.proposal_id}:${artifactHash(authorization)}`, [{ path: authorizationPath, value: authorization }, { path: decisionPath, value: decision }]);
    });
  }
}

const memoryStoreStates = new WeakMap();
const storeTrustAuthorities = new WeakMap();
function memoryState(store) {
  const state = memoryStoreStates.get(store);
  if (!state) throw new GovernanceError("KDLC_STORE_ATOMIC_REQUIRED", "Governed workflows require a capability-scoped artifact store");
  return state;
}
function storePut(store, path, value) { memoryState(store).set(path, structuredClone(value)); }
function storePutMany(store, entries) {
  const updated = new Map(memoryState(store));
  for (const { path, value } of entries) updated.set(path, structuredClone(value));
  memoryStoreStates.set(store, updated);
}
function storeReviewPacket(store, { path, value, receiptPrefix, proposalId }) {
  const artifacts = memoryState(store);
  if (artifacts.has(path)) return false;
  for (const [candidate, receipt] of artifacts) if (candidate.startsWith(receiptPrefix) && receipt.proposal_id === proposalId) return false;
  artifacts.set(path, structuredClone(value));
  return true;
}
function storeDecision(store, { receiptPath, receipt, decisionPath, decision, expectedReceiptId }) {
  const artifacts = memoryState(store); const current = artifacts.get(decisionPath)?.receipt_id ?? null;
  if (current !== expectedReceiptId) return { status: "conflict", current };
  if (artifacts.has(receiptPath)) return { status: "receipt-exists" };
  const updated = new Map(artifacts); updated.set(receiptPath, structuredClone(receipt)); updated.set(decisionPath, structuredClone(decision)); memoryStoreStates.set(store, updated);
  return { status: "stored" };
}
function storeFreshness(store, { authorizationPath, authorization, decisionPath, decision, expectedAuthorizationHash }) {
  const artifacts = memoryState(store); const current = artifacts.get(decisionPath)?.authorization_hash ?? null;
  if (current !== expectedAuthorizationHash) return { status: "conflict", current };
  const updated = new Map(artifacts); updated.set(authorizationPath, structuredClone(authorization)); updated.set(decisionPath, structuredClone(decision)); memoryStoreStates.set(store, updated);
  return { status: "stored" };
}
function resolveTrustAuthority(store, authority) {
  const established = storeTrustAuthorities.get(store);
  if (established && authority && established !== authority) throw new GovernanceError("KDLC_TRUST_AUTHORITY_CONFLICT", "Artifact store is already bound to another runtime trust authority");
  if (established) return established;
  const selected = authority ?? new RuntimeTrustAuthority();
  if (!(selected instanceof RuntimeTrustAuthority)) throw new GovernanceError("KDLC_TRUST_AUTHORITY_INVALID", "Governed workflows require a trusted runtime proof authority");
  storeTrustAuthorities.set(store, selected);
  return selected;
}

export class GovernedAgentWorkflows {
  #store;
  #capabilities;
  #models;
  #session;
  #reviewRequirements;
  #reviewContextSession;
  #validator;
  #clock;
  #trustAuthority;

  constructor({ store, capabilities, models, session, reviewRequirements, reviewContextSession, validator, trustAuthority, clock = { now: () => new Date().toISOString() } }) {
    this.#store = store;
    this.#capabilities = capabilities;
    this.#models = models;
    this.#session = session;
    this.#reviewRequirements = structuredClone(reviewRequirements);
    this.#reviewContextSession = reviewContextSession;
    this.#validator = validator;
    this.#trustAuthority = trustAuthority;
    this.#clock = clock;
  }

  static async create({ store = new MemoryArtifactStore(), capabilities, models, session, reviewRequirements = { sensor_ids: ["source-anchor-valid"], policy_ids: ["team-policy"], substantive_fields: [], freshness: { mode: "reviewed" } }, reviewContextSession, validator, trustAuthority, clock } = {}) {
    const contracts = validator ?? await createContractValidator(undefined, AGENT_WORKFLOW_SCHEMA_PATHS);
    return new GovernedAgentWorkflows({
      store,
      capabilities: capabilities ?? await CapabilityRuntime.create({ validator: contracts }),
      models: models ?? await RecordedModelRuntime.create({ validator: contracts }),
      session,
      reviewRequirements,
      reviewContextSession,
      validator: contracts,
      trustAuthority: resolveTrustAuthority(store, trustAuthority),
      clock
    });
  }

  async #put(role, path, value) {
    this.#capabilities.authorize(role, "write", path);
    if (typeof this.#store?.[PUT] !== "function") throw new GovernanceError("KDLC_STORE_ATOMIC_REQUIRED", "Governed workflows require a capability-scoped atomic artifact store");
    await this.#store[PUT](path, value);
  }

  async #putMany(entries) {
    for (const { role, path } of entries) this.#capabilities.authorize(role, "write", path);
    if (typeof this.#store?.[PUT_MANY] !== "function") throw new GovernanceError("KDLC_STORE_ATOMIC_REQUIRED", "Governed workflows require a capability-scoped atomic artifact store");
    await this.#store[PUT_MANY](entries.map(({ path, value }) => ({ path, value })));
  }

  async #get(role, path) {
    this.#capabilities.authorize(role, "read", path);
    return this.#store.get(path);
  }

  #validateReviewContext(context, normalizedEvidence) {
    const validation = this.#validator.validate("reviewContext", context);
    if (!validation.valid) throw new GovernanceError("KDLC_REVIEW_CONTEXT_INVALID", "Trusted review context failed schema validation", { errors: validation.errors });
    if (context.sensors.some((sensor) => sensor.producer !== "kdlc-sensor-runtime/0.2.0" || !/^sha256:[a-f0-9]{64}$/.test(sensor.execution_hash ?? ""))) throw new GovernanceError("KDLC_SENSOR_UNTRUSTED", "Review context contains a sensor result without trusted execution provenance");
    if (context.evidence.some((item) => item.source_id !== normalizedEvidence.source_id || item.source_hash !== normalizedEvidence.source_hash || !normalizedEvidence.units.some((unit) => canonicalJson(unit.locator) === canonicalJson(item.locator) && unit.text === item.excerpt))) throw new GovernanceError("KDLC_EVIDENCE_UNTRUSTED", "Review evidence is not an exact persisted normalized unit");
  }

  async #loadBoundReviewInputs(workflowId, proposal) {
    const claims = await Promise.all(proposal.claim_ids.map((id) => this.#get("conductor", `workflow/runs/${workflowId}/claims/${id}.json`)));
    const context = await this.#get("conductor", `workflow/runs/${workflowId}/state/review-context.json`);
    const normalizedEvidence = await this.#get("conductor", `workflow/runs/${workflowId}/state/normalized-evidence.json`);
    if (proposal.input_hashes?.claims !== artifactHash(claims) || proposal.input_hashes?.review_context !== artifactHash(context) || proposal.input_hashes?.normalized_evidence !== artifactHash(normalizedEvidence)) throw new GovernanceError("KDLC_REVIEW_INPUT_DRIFT", "Persisted review inputs do not match proposal bindings");
    this.#validateReviewContext(context, normalizedEvidence);
    return { claims, context, normalizedEvidence };
  }

  async runRecorded({ task, workflowId, recording, normalizedEvidence }) {
    if (task !== "ingest" && task !== "adopt") throw new GovernanceError("KDLC_WORKFLOW_TASK_INVALID", `Unsupported recorded workflow task: ${task}`);
    const normalizedValidation = this.#validator.validate("recordedNormalizedFixture", normalizedEvidence);
    if (!normalizedValidation.valid) throw new GovernanceError("KDLC_NORMALIZED_FIXTURE_INVALID", "Recorded normalized fixture failed schema validation", { errors: normalizedValidation.errors });
    const inputHashes = { normalized_evidence: artifactHash(normalizedEvidence) };
    const output = this.#models.replay(recording, { task, inputHashes });
    const reviewContext = resolveTrustedReviewContext(this.#reviewContextSession, workflowId);
    this.#validateReviewContext(reviewContext, normalizedEvidence);
    const anchors = new Set(normalizedEvidence.units.map(({ locator }) => canonicalJson(locator)));
    for (const claim of output.claims) {
      if (claim.source_id !== normalizedEvidence.source_id || claim.source_hash !== normalizedEvidence.source_hash || !claim.locator || !anchors.has(canonicalJson(claim.locator))) {
        throw new GovernanceError("KDLC_MODEL_SOURCE_DRIFT", `Claim ${claim.id} is not anchored to the recorded normalized fixture`);
      }
    }
    const claimsHash = artifactHash(output.claims);
    const contextHash = artifactHash(reviewContext);
    const proposals = output.proposals.map((proposal) => ({ ...proposal, input_hashes: { normalized_evidence: inputHashes.normalized_evidence, claims: claimsHash, review_context: contextHash } }));
    for (const proposal of proposals) {
      if (proposal.workflow_id !== workflowId) throw new GovernanceError("KDLC_MODEL_RECORDING_DRIFT", `Proposal ${proposal.id} belongs to another workflow`);
      const validation = this.#validator.validate("conceptProposal", proposal);
      if (!validation.valid) throw new GovernanceError("KDLC_MODEL_RECORDING_INVALID", `Bound proposal ${proposal.id} failed schema validation`, { errors: validation.errors });
    }
    await this.#putMany([
      { role: "conductor", path: `workflow/runs/${workflowId}/state/normalized-evidence.json`, value: normalizedEvidence },
      { role: "conductor", path: `workflow/runs/${workflowId}/state/review-context.json`, value: reviewContext },
      ...output.claims.map((claim) => ({ role: "source-analyst", path: `workflow/runs/${workflowId}/claims/${claim.id}.json`, value: claim })),
      ...proposals.map((proposal) => ({ role: "integrator", path: `workflow/runs/${workflowId}/proposals/${proposal.id}.json`, value: proposal }))
    ]);
    return Object.freeze({ claims: structuredClone(output.claims), proposals: structuredClone(proposals), model: structuredClone(output.model) });
  }

  async assembleReview({ workflowId, proposalId }) {
    const proposalPath = `workflow/runs/${workflowId}/proposals/${proposalId}.json`;
    const proposal = await this.#get("conductor", proposalPath);
    const { claims, context } = await this.#loadBoundReviewInputs(workflowId, proposal);
    const result = createReviewPacket({ proposal, claims, ...context, requirements: this.#reviewRequirements, validator: this.#validator });
    const packetPath = `workflow/runs/${workflowId}/reviews/${proposalId}/packet.json`;
    const stored = await this.#store[STORE_REVIEW]({ path: packetPath, value: result.packet, receiptPrefix: `workflow/runs/${workflowId}/receipts/`, proposalId });
    if (!stored) throw new GovernanceError("KDLC_REVIEW_PACKET_IMMUTABLE", `Proposal ${proposalId} already has a decision`);
    return Object.freeze({ ...result, path: packetPath });
  }

  async decide({ workflowId, proposalId, decision, receiptId, expectedReceiptId = null }) {
    const { role } = resolveAuthenticatedReviewSession(this.#session);
    const packet = await this.#get(role, `workflow/runs/${workflowId}/reviews/${proposalId}/packet.json`);
    const receipt = createReviewReceipt({ packet, decision, session: this.#session, receiptId, reviewedAt: this.#clock.now(), validator: this.#validator });
    const path = `workflow/runs/${workflowId}/receipts/${receiptId}.json`;
    const decisionPath = `workflow/runs/${workflowId}/reviews/${proposalId}/decision.json`;
    const unsignedDecision = { api_version: "kdlc.dev/review-decision/v1alpha1", proposal_id: proposalId, packet_hash: artifactHash(packet), receipt_id: receiptId, receipt_hash: artifactHash(receipt), decision, decided_at: this.#clock.now() };
    const activeDecision = { ...unsignedDecision, trust_proof: this.#trustAuthority.issueReviewProof({ workflowId, receipt, decision: unsignedDecision, session: this.#session }) };
    const validation = this.#validator.validate("reviewDecision", activeDecision);
    if (!validation.valid) throw new GovernanceError("KDLC_ARTIFACT_INVALID", "Review decision failed schema validation", { errors: validation.errors });
    const stored = await this.#store[STORE_DECISION]({ receiptPath: path, receipt, decisionPath, decision: activeDecision, expectedReceiptId });
    if (stored.status === "receipt-exists") throw new GovernanceError("KDLC_RECEIPT_IMMUTABLE", `Receipt already exists: ${receiptId}`);
    if (stored.status === "conflict") throw new GovernanceError("KDLC_DECISION_CONFLICT", "Active decision changed before this decision was recorded", { expected: expectedReceiptId, current: stored.current });
    this.#trustAuthority.activateReview({ workflowId, receipt, decision: activeDecision });
    return Object.freeze({ receipt, decision: structuredClone(activeDecision), path });
  }

  async authorizeFreshness({ workflowId, proposalId, concept, expectedAuthorizationHash = null }) {
    const { role, reviewer } = resolveAuthenticatedReviewSession(this.#session);
    if (role !== "governance-reviewer") throw new GovernanceError("KDLC_FRESHNESS_AUTHORITY_DENIED", "Only an authenticated governance reviewer may authorize separate freshness");
    const packet = await this.#get(role, `workflow/runs/${workflowId}/reviews/${proposalId}/packet.json`);
    if (packet.governance_requirements.freshness.mode !== "separate") throw new GovernanceError("KDLC_FRESHNESS_AUTHORITY_DENIED", "The applicable profile does not use separate freshness authorization");
    const policy = packet.resolved.policies.find(({ id }) => id === packet.governance_requirements.freshness.policy_id);
    const authorization = { api_version: "kdlc.dev/freshness-authorization/v1alpha1", subject: packet.target.subject, field: "stale_after", value_hash: artifactHash(concept?.frontmatter?.stale_after), packet_hash: artifactHash(packet), policy: structuredClone(policy), authorized_by: reviewer.actor, authorized_at: this.#clock.now() };
    const validation = this.#validator.validate("freshnessAuthorization", authorization);
    if (!validation.valid) throw new GovernanceError("KDLC_ARTIFACT_INVALID", "Freshness authorization failed schema validation", { errors: validation.errors });
    const path = `workflow/runs/${workflowId}/reviews/${proposalId}/freshness-authorization.json`;
    const decisionPath = `workflow/runs/${workflowId}/reviews/${proposalId}/freshness-decision.json`;
    const unsignedDecision = { api_version: "kdlc.dev/freshness-decision/v1alpha1", proposal_id: proposalId, packet_hash: artifactHash(packet), authorization_hash: artifactHash(authorization), value_hash: authorization.value_hash, policy: structuredClone(policy), authorized_by: reviewer.actor, activated_at: this.#clock.now() };
    const freshnessDecision = { ...unsignedDecision, trust_proof: this.#trustAuthority.issueFreshnessProof({ workflowId, authorization, decision: unsignedDecision, session: this.#session }) };
    const decisionValidation = this.#validator.validate("freshnessDecision", freshnessDecision);
    if (!decisionValidation.valid) throw new GovernanceError("KDLC_ARTIFACT_INVALID", "Freshness decision failed schema validation", { errors: decisionValidation.errors });
    const stored = await this.#store[STORE_FRESHNESS]({ authorizationPath: path, authorization, decisionPath, decision: freshnessDecision, expectedAuthorizationHash });
    if (stored.status === "conflict") throw new GovernanceError("KDLC_FRESHNESS_CONFLICT", "Freshness authorization changed before update", { expected: expectedAuthorizationHash, current: stored.current });
    this.#trustAuthority.activateFreshness({ workflowId, authorization, decision: freshnessDecision });
    return Object.freeze({ authorization: structuredClone(authorization), decision: structuredClone(freshnessDecision), path });
  }

  async preparePublication({ workflowId, proposalId, receiptId, current }) {
    const proposal = await this.#get("conductor", `workflow/runs/${workflowId}/proposals/${proposalId}.json`);
    const packet = await this.#get("conductor", `workflow/runs/${workflowId}/reviews/${proposalId}/packet.json`);
    const { claims, context } = await this.#loadBoundReviewInputs(workflowId, proposal);
    const regenerated = createReviewPacket({ proposal, claims, ...context, requirements: this.#reviewRequirements, validator: this.#validator });
    if (regenerated.packet_hash !== artifactHash(packet)) throw new GovernanceError("KDLC_REVIEW_INPUT_DRIFT", "Persisted packet no longer exactly matches its approved inputs");
    const receipt = receiptId ? await this.#get("conductor", `workflow/runs/${workflowId}/receipts/${receiptId}.json`) : null;
    const decisionState = await this.#store.has(`workflow/runs/${workflowId}/reviews/${proposalId}/decision.json`) ? await this.#get("conductor", `workflow/runs/${workflowId}/reviews/${proposalId}/decision.json`) : null;
    const freshnessPath = `workflow/runs/${workflowId}/reviews/${proposalId}/freshness-authorization.json`;
    const freshnessAuthorization = await this.#store.has(freshnessPath) ? await this.#get("conductor", freshnessPath) : null;
    const freshnessDecisionPath = `workflow/runs/${workflowId}/reviews/${proposalId}/freshness-decision.json`;
    const freshnessDecision = await this.#store.has(freshnessDecisionPath) ? await this.#get("conductor", freshnessDecisionPath) : null;
    const runtimeTrust = {
      review: receipt && decisionState ? this.#trustAuthority.verifyReview({ workflowId, receipt, decision: decisionState }) : false,
      freshness: freshnessAuthorization && freshnessDecision ? this.#trustAuthority.verifyFreshness({ workflowId, authorization: freshnessAuthorization, decision: freshnessDecision }) : false
    };
    const assessment = assessPublication({ proposal, packet, receipt, decisionState, freshnessAuthorization, freshnessDecision, runtimeTrust, current, validator: this.#validator, now: this.#clock.now() });
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

  async reconcileEdit({ workflowId, proposalId, reviewedProposalId, target, reviewedConcept, currentConcept, receiptId }) {
    const packet = await this.#get("integrator", `workflow/runs/${workflowId}/reviews/${reviewedProposalId}/packet.json`);
    const receipt = await this.#get("integrator", `workflow/runs/${workflowId}/receipts/${receiptId}.json`);
    const decision = await this.#get("integrator", `workflow/runs/${workflowId}/reviews/${reviewedProposalId}/decision.json`);
    if (decision.decision !== "approved" || decision.receipt_id !== receipt.id || decision.receipt_hash !== artifactHash(receipt) || decision.packet_hash !== artifactHash(packet) || !this.#trustAuthority.verifyReview({ workflowId, receipt, decision })) throw new GovernanceError("KDLC_RECONCILE_BINDING_INVALID", "Reconciliation requires the active authenticated approval");
    const proposal = reconcileDirectEdit({ proposalId, workflowId, target, reviewedConcept, currentConcept, packet, receipt, validator: this.#validator });
    const path = `workflow/runs/${workflowId}/proposals/${proposalId}.json`;
    await this.#put("integrator", path, proposal);
    return Object.freeze({ proposal, path });
  }
}
