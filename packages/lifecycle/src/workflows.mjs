import { canonicalJson } from "../../core/index.mjs";

import { assertIdentifier, conflict, invalid, LifecycleError } from "./errors.mjs";

const transitions = {
  planned: ["running", "cancelled"], running: ["awaiting_approval", "completed", "failed", "cancelled", "parked"],
  awaiting_approval: ["running", "rejected", "cancelled"], failed: ["retrying", "cancelled"], retrying: ["running", "failed", "cancelled"],
  parked: ["running", "cancelled"], completed: [], rejected: [], cancelled: []
};

const missing = Object.freeze({ missing: true });

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function assertJson(value, label) {
  try { canonicalJson(value); }
  catch { throw invalid(`${label} must be canonical JSON data`); }
  return value;
}
function assertString(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== "string" || value.length === 0) throw invalid(`${label} must be a non-empty string${nullable ? " or null" : ""}`);
  return value;
}
function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) throw invalid(`${label} must be an array of non-empty strings`);
  assertJson(value, label);
  return value;
}
function assertStringRecord(value, label) {
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string" || item.length === 0)) throw invalid(`${label} must be an object of non-empty strings`);
  assertJson(value, label);
  return value;
}
function validateCompletion(stageName, completion) {
  if (!isRecord(completion) || !isRecord(completion.input_hashes) || !isRecord(completion.output_hashes)) {
    throw invalid(`Stage ${stageName} completion requires input_hashes and output_hashes objects`);
  }
  assertJson(completion.input_hashes, `Stage ${stageName} input_hashes`);
  assertJson(completion.output_hashes, `Stage ${stageName} output_hashes`);
  assertIdentifier(completion.project_id, "project ID");
  if (completion.project_hash === undefined && completion.project_version === undefined) throw invalid(`Stage ${stageName} completion requires project context`);
  if (completion.project_hash !== undefined) assertString(completion.project_hash, `Stage ${stageName} project_hash`);
  if (completion.project_version !== undefined) assertString(completion.project_version, `Stage ${stageName} project_version`);
  for (const field of ["dependency_hashes", "dependency_versions", "tool_hashes", "tool_versions"]) {
    if (completion[field] !== undefined) assertStringRecord(completion[field], `Stage ${stageName} ${field}`);
  }
  for (const field of ["policy_hashes", "policy_versions", "profile_hashes", "profile_versions"]) {
    if (completion[field] !== undefined) assertStringArray(completion[field], `Stage ${stageName} ${field}`);
  }
  if (completion.settings_hash !== undefined) assertString(completion.settings_hash, `Stage ${stageName} settings_hash`, { nullable: true });
  if (!isRecord(completion.agent)) throw invalid(`Stage ${stageName} completion requires an agent identity`);
  assertString(completion.agent.id, `Stage ${stageName} agent.id`); assertJson(completion.agent, `Stage ${stageName} agent`);
  if (completion.model !== undefined && completion.model !== null && !isRecord(completion.model)) throw invalid(`Stage ${stageName} model must be an object or null`);
  if (completion.model !== undefined) assertJson(completion.model, `Stage ${stageName} model`);
  if (completion.sensors !== undefined) {
    if (!Array.isArray(completion.sensors)) throw invalid(`Stage ${stageName} sensors must be an array`);
    assertJson(completion.sensors, `Stage ${stageName} sensors`);
  }
  if (completion.approval_receipts !== undefined) assertStringArray(completion.approval_receipts, `Stage ${stageName} approval_receipts`);
  if (completion.attempt_id !== undefined) assertIdentifier(completion.attempt_id, "attempt ID");
}
function sameJson(left, right) {
  try { return canonicalJson(left) === canonicalJson(right); }
  catch { return false; }
}

function completionFingerprint(stage, completion) {
  return {
    stage_version: stage.version,
    input_hashes: completion.input_hashes,
    project_hash: completion.project_hash ?? completion.project_version ?? null,
    dependency_hashes: completion.dependency_hashes ?? completion.dependency_versions ?? {},
    policy_hashes: completion.policy_hashes ?? completion.policy_versions ?? [],
    profile_hashes: completion.profile_hashes ?? completion.profile_versions ?? [],
    tool_hashes: completion.tool_hashes ?? completion.tool_versions ?? {},
    settings_hash: completion.settings_hash ?? null
  };
}

function checkpointFingerprint(checkpoint) {
  return {
    stage_version: checkpoint.stage_version,
    input_hashes: checkpoint.input_hashes,
    project_hash: checkpoint.project_hash ?? checkpoint.project_version ?? null,
    dependency_hashes: checkpoint.dependency_hashes ?? checkpoint.dependency_versions ?? {},
    policy_hashes: checkpoint.policy_hashes ?? checkpoint.policy_versions ?? [],
    profile_hashes: checkpoint.profile_hashes ?? checkpoint.profile_versions ?? [],
    tool_hashes: checkpoint.tool_hashes ?? checkpoint.tool_versions ?? {},
    settings_hash: checkpoint.settings_hash ?? null
  };
}

function currentFingerprint(stage, current) {
  if (!isRecord(current)) return null;
  const expanded = Object.hasOwn(current, "input_hashes")
    || Object.hasOwn(current, "project_hash")
    || Object.hasOwn(current, "project_version")
    || Object.hasOwn(current, "dependency_hashes")
    || Object.hasOwn(current, "dependency_versions")
    || Object.hasOwn(current, "policy_hashes")
    || Object.hasOwn(current, "policy_versions")
    || Object.hasOwn(current, "profile_hashes")
    || Object.hasOwn(current, "profile_versions")
    || Object.hasOwn(current, "tool_hashes")
    || Object.hasOwn(current, "tool_versions")
    || Object.hasOwn(current, "settings_hash");
  if (!expanded) return {
    stage_version: stage.version,
    input_hashes: current,
    project_hash: missing,
    dependency_hashes: missing,
    policy_hashes: missing,
    profile_hashes: missing,
    tool_hashes: missing,
    settings_hash: missing
  };
  const value = (preferred, legacy) => Object.hasOwn(current, preferred) ? current[preferred]
    : legacy && Object.hasOwn(current, legacy) ? current[legacy] : missing;
  return {
    stage_version: stage.version,
    input_hashes: value("input_hashes"),
    project_hash: value("project_hash", "project_version"),
    dependency_hashes: value("dependency_hashes", "dependency_versions"),
    policy_hashes: value("policy_hashes", "policy_versions"),
    profile_hashes: value("profile_hashes", "profile_versions"),
    tool_hashes: value("tool_hashes", "tool_versions"),
    settings_hash: value("settings_hash")
  };
}

function changedFingerprintFields(expected, current) {
  if (!current) return Object.keys(expected);
  return Object.keys(expected).filter((key) => !sameJson(expected[key], current[key]));
}

function historicalAttempt(checkpoint, supersededAt, supersededBy) {
  const { attempt_history: ignoredHistory, audit_pending: ignoredAudit, ...attempt } = checkpoint;
  return { ...attempt, superseded_at: supersededAt, superseded_by: supersededBy };
}

export class WorkflowEngine {
  constructor({ store, clock, ids, graph, audit }) { Object.assign(this, { store, clock, ids, graph, audit }); this.queues = new Map(); this.mutexSequence = 0; }
  path(id) { return `workflow/runs/${assertIdentifier(id, "workflow ID")}/state.json`; }
  checkpointPath(id, stage) { return `workflow/runs/${assertIdentifier(id, "workflow ID")}/checkpoints/${assertIdentifier(stage, "stage name")}.json`; }

  #withWorkflowMutex(id, operation, action) {
    assertIdentifier(id, "workflow ID");
    if (typeof this.store.withMutex !== "function") throw invalid("Workflow store must support coordinated mutation");
    this.mutexSequence += 1;
    return this.store.withMutex(`workflow/locks/engine-${encodeURIComponent(id)}`, {
      owner: `workflow-engine:${process.pid}:${operation}:${this.mutexSequence}`,
      clock: this.clock
    }, action);
  }

  async #flushAudit(state) {
    if (!state.audit_pending) return state;
    await this.audit.append(state.workflow_id, state.audit_pending);
    const updated = { ...state };
    delete updated.audit_pending;
    await this.store.writeJsonAtomic(this.path(state.workflow_id), updated);
    return updated;
  }

  #resumeAuditPath(id) { return `workflow/runs/${assertIdentifier(id, "workflow ID")}/resume-audit.json`; }

  async #flushCheckpointAudit(id, path, checkpoint) {
    if (!checkpoint.audit_pending) return checkpoint;
    await this.audit.append(id, checkpoint.audit_pending);
    const updated = { ...checkpoint };
    delete updated.audit_pending;
    await this.store.writeJsonAtomic(path, updated);
    return updated;
  }

  async #readAuditedCheckpoint(id, path) {
    if (!(await this.store.exists(path))) return null;
    const checkpoint = await this.store.readJson(path);
    if (!checkpoint.audit_pending) return checkpoint;
    try { return await this.#flushCheckpointAudit(id, path, checkpoint); }
    catch { throw new LifecycleError("KDLC_AUDIT_PENDING", "audit-failure", "Stage checkpoint audit is pending", { retryable: true, details: { workflow_id: id, stage: checkpoint.stage, attempt_id: checkpoint.attempt_id } }); }
  }

  async #recoverResumeAudit(id) {
    const path = this.#resumeAuditPath(id);
    if (!(await this.store.exists(path))) return null;
    const outbox = await this.store.readJson(path);
    if (outbox?.version !== 1 || outbox.workflow_id !== id || !Array.isArray(outbox.mutations) || !Array.isArray(outbox.invalidated) || !isRecord(outbox.event)) {
      throw invalid("Resume audit outbox is invalid");
    }
    try {
      for (const mutation of outbox.mutations) {
        if (!isRecord(mutation) || typeof mutation.path !== "string" || !isRecord(mutation.checkpoint)) throw invalid("Resume audit mutation is invalid");
        await this.store.writeJsonAtomic(mutation.path, mutation.checkpoint);
      }
      await this.audit.append(id, outbox.event);
      await this.store.remove(path);
      return { invalidated: outbox.invalidated };
    } catch (error) {
      if (error instanceof LifecycleError && error.code === "KDLC_INPUT_INVALID") throw error;
      throw new LifecycleError("KDLC_AUDIT_PENDING", "audit-failure", "Workflow resume audit is pending", { retryable: true, details: { workflow_id: id } });
    }
  }

  async create({ projectId, workflowId = this.ids.next("wf") }) {
    return this.#withWorkflowMutex(workflowId, "create", async () => {
      const path = this.path(workflowId);
      if (await this.store.exists(path)) {
        const existing = await this.store.readJson(path);
        if (existing.project_id === projectId && existing.audit_pending?.action === "workflow.created") return this.#flushAudit(existing);
        throw conflict(`Workflow already exists: ${workflowId}`);
      }
      const now = this.clock.now();
      const event = { project: projectId, actor: "process:kdlc-engine", action: "workflow.created", result: "planned", idempotency_key: `workflow:${workflowId}:created` };
      const state = { version: 1, workflow_id: workflowId, project_id: projectId, state: "planned", revision: 0, created_at: now, updated_at: now, current_stage: null, audit_pending: event };
      await this.store.writeJsonAtomic(path, state);
      try { return await this.#flushAudit(state); }
      catch { throw new LifecycleError("KDLC_AUDIT_PENDING", "audit-failure", "Workflow creation audit is pending", { retryable: true }); }
    });
  }
  async get(id) { return this.store.readJson(this.path(id)); }
  transition(id, next, expectedRevision) {
    const prior = this.queues.get(id) ?? Promise.resolve();
    const running = prior.then(() => this.#withWorkflowMutex(id, "transition", async () => {
      const state = await this.#flushAudit(await this.get(id));
      if (state.revision !== expectedRevision) throw conflict("Workflow revision changed", { expectedRevision, actualRevision: state.revision });
      if (!(transitions[state.state] ?? []).includes(next)) throw invalid(`Invalid workflow transition ${state.state} -> ${next}`);
      const event = { project: state.project_id, actor: "process:kdlc-engine", action: `workflow.${next}`, result: next, idempotency_key: `workflow:${id}:revision:${state.revision + 1}` };
      const updated = { ...state, state: next, revision: state.revision + 1, updated_at: this.clock.now(), audit_pending: event };
      await this.store.writeJsonAtomic(this.path(id), updated);
      try { return await this.#flushAudit(updated); }
      catch { throw new LifecycleError("KDLC_AUDIT_PENDING", "audit-failure", "Workflow transition audit is pending", { retryable: true, details: { workflow_id: id, revision: updated.revision } }); }
    }));
    this.queues.set(id, running.catch(() => {}));
    return running;
  }

  async completeStage(id, stageName, completion) {
    return this.#withWorkflowMutex(id, `complete-${stageName}`, () => this.#completeStage(id, stageName, completion));
  }

  async #completeStage(id, stageName, completion) {
    const stage = this.graph.get(stageName);
    validateCompletion(stageName, completion);
    await this.#recoverResumeAudit(id);
    const path = this.checkpointPath(id, stage.name);
    const existing = await this.#readAuditedCheckpoint(id, path);
    const fingerprint = completionFingerprint(stage, completion);
    const reusable = stage.deterministic !== false && existing && !existing.invalidated_at
      && sameJson(checkpointFingerprint(existing), fingerprint);
    if (reusable) {
      if (!sameJson(existing.output_hashes, completion.output_hashes)) throw conflict("Deterministic stage produced different output hashes", { stage: stageName });
      return existing;
    }

    const attemptId = completion.attempt_id ?? this.ids.next("attempt");
    const priorAttemptIds = new Set([
      ...(existing?.attempt_id ? [existing.attempt_id] : []),
      ...(existing?.attempt_history ?? []).map(({ attempt_id: priorAttemptId }) => priorAttemptId)
    ]);
    if (priorAttemptIds.has(attemptId)) throw conflict("Stage retry must use a new attempt ID", { stage: stageName, attempt_id: attemptId });

    const now = this.clock.now();
    const history = existing ? [
      ...(existing.attempt_history ?? []),
      historicalAttempt(existing, now, attemptId)
    ] : [];
    const checkpoint = {
      version: 1,
      workflow_id: id,
      stage: stage.name,
      stage_version: stage.version,
      attempt_id: attemptId,
      ...(existing ? { supersedes_attempt_id: existing.attempt_id } : {}),
      attempt_history: history,
      project_version: completion.project_version ?? fingerprint.project_hash,
      dependency_versions: completion.dependency_versions ?? fingerprint.dependency_hashes,
      input_hashes: completion.input_hashes,
      output_hashes: completion.output_hashes,
      policy_versions: completion.policy_versions ?? fingerprint.policy_hashes,
      profile_versions: completion.profile_versions ?? fingerprint.profile_hashes,
      project_hash: fingerprint.project_hash,
      dependency_hashes: fingerprint.dependency_hashes,
      policy_hashes: fingerprint.policy_hashes,
      profile_hashes: fingerprint.profile_hashes,
      tool_hashes: fingerprint.tool_hashes,
      settings_hash: fingerprint.settings_hash,
      agent: completion.agent,
      model: completion.model ?? null,
      sensors: completion.sensors ?? [],
      approval_receipts: completion.approval_receipts ?? [],
      deterministic: stage.deterministic !== false,
      completed_at: now,
      audit_pending: {
        project: completion.project_id,
        stage: stage.name,
        actor: completion.agent.id,
        action: "stage.completed",
        input_hash: canonicalJson(completion.input_hashes),
        result: "completed",
        idempotency_key: `stage:${id}:${stage.name}:${attemptId}:completed`
      }
    };
    await this.store.writeJsonAtomic(path, checkpoint);
    try { return await this.#flushCheckpointAudit(id, path, checkpoint); }
    catch { throw new LifecycleError("KDLC_AUDIT_PENDING", "audit-failure", "Stage checkpoint audit is pending", { retryable: true, details: { workflow_id: id, stage: stage.name, attempt_id: attemptId } }); }
  }

  async resume(id, currentInputs) {
    return this.#withWorkflowMutex(id, "resume", () => this.#resume(id, currentInputs));
  }

  async #resume(id, currentInputs) {
    if (!isRecord(currentInputs)) throw invalid("Resume requires current stage inputs");
    const recovered = await this.#recoverResumeAudit(id);
    if (recovered) return recovered;
    assertJson(currentInputs, "Resume current stage inputs");
    const checkpoints = new Map();
    for (const stageName of this.graph.order) {
      const path = this.checkpointPath(id, stageName);
      const checkpoint = await this.#readAuditedCheckpoint(id, path);
      if (checkpoint) checkpoints.set(stageName, checkpoint);
    }
    const invalidated = [];
    for (const stageName of this.graph.order) {
      const checkpoint = checkpoints.get(stageName); if (!checkpoint || checkpoint.invalidated_at) continue;
      const stage = this.graph.get(stageName);
      const changed = changedFingerprintFields(checkpointFingerprint(checkpoint), currentFingerprint(stage, currentInputs[stageName]));
      if (changed.length === 0) continue;
      for (const affected of this.graph.dependentsOf(stageName)) {
        const target = checkpoints.get(affected); if (!target || target.invalidated_at) continue;
        const updated = {
          ...target,
          invalidated_at: this.clock.now(),
          invalidation_reason: `checkpoint drift at ${stageName}: ${changed.join(", ")}`
        };
        checkpoints.set(affected, updated); invalidated.push(affected);
      }
    }
    const uniqueInvalidated = [...new Set(invalidated)];
    const resumeAttempt = this.ids.next("resume");
    const outbox = {
      version: 1,
      workflow_id: id,
      invalidated: uniqueInvalidated,
      mutations: uniqueInvalidated.map((stageName) => ({
        path: this.checkpointPath(id, stageName),
        checkpoint: checkpoints.get(stageName)
      })),
      event: {
        actor: "process:kdlc-engine",
        action: "workflow.resumed",
        result: uniqueInvalidated.length ? "invalidated" : "unchanged",
        invalidated: uniqueInvalidated,
        idempotency_key: `workflow:${id}:resume:${resumeAttempt}`
      }
    };
    await this.store.writeJsonAtomic(this.#resumeAuditPath(id), outbox);
    return this.#recoverResumeAudit(id);
  }
}
