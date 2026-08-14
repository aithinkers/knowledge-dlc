import { canonicalJson } from "../../core/index.mjs";

import { conflict, invalid } from "./errors.mjs";

const transitions = {
  planned: ["running", "cancelled"], running: ["awaiting_approval", "completed", "failed", "cancelled", "parked"],
  awaiting_approval: ["running", "rejected", "cancelled"], failed: ["retrying", "cancelled"], retrying: ["running", "failed", "cancelled"],
  parked: ["running", "cancelled"], completed: [], rejected: [], cancelled: []
};

const missing = Object.freeze({ missing: true });

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
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
  const { attempt_history: ignoredHistory, ...attempt } = checkpoint;
  return { ...attempt, superseded_at: supersededAt, superseded_by: supersededBy };
}

export class WorkflowEngine {
  constructor({ store, clock, ids, graph, audit }) { Object.assign(this, { store, clock, ids, graph, audit }); this.queues = new Map(); this.mutexSequence = 0; }
  path(id) { return `workflow/runs/${id}/state.json`; }
  checkpointPath(id, stage) { return `workflow/runs/${id}/checkpoints/${stage}.json`; }

  #withWorkflowMutex(id, operation, action) {
    if (typeof this.store.withMutex !== "function") throw invalid("Workflow store must support coordinated mutation");
    this.mutexSequence += 1;
    return this.store.withMutex(`workflow/locks/engine-${encodeURIComponent(id)}`, {
      owner: `workflow-engine:${process.pid}:${operation}:${this.mutexSequence}`,
      clock: this.clock
    }, action);
  }

  async create({ projectId, workflowId = this.ids.next("wf") }) {
    return this.#withWorkflowMutex(workflowId, "create", async () => {
      const path = this.path(workflowId); if (await this.store.exists(path)) throw conflict(`Workflow already exists: ${workflowId}`);
      const now = this.clock.now(); const state = { version: 1, workflow_id: workflowId, project_id: projectId, state: "planned", revision: 0, created_at: now, updated_at: now, current_stage: null };
      await this.store.writeJsonAtomic(path, state); await this.audit.append(workflowId, { project: projectId, actor: "process:kdlc-engine", action: "workflow.created", result: "planned" }); return state;
    });
  }
  async get(id) { return this.store.readJson(this.path(id)); }
  transition(id, next, expectedRevision) {
    const prior = this.queues.get(id) ?? Promise.resolve();
    const running = prior.then(() => this.#withWorkflowMutex(id, "transition", async () => {
      const state = await this.get(id);
      if (state.revision !== expectedRevision) throw conflict("Workflow revision changed", { expectedRevision, actualRevision: state.revision });
      if (!(transitions[state.state] ?? []).includes(next)) throw invalid(`Invalid workflow transition ${state.state} -> ${next}`);
      const updated = { ...state, state: next, revision: state.revision + 1, updated_at: this.clock.now() };
      await this.store.writeJsonAtomic(this.path(id), updated); await this.audit.append(id, { project: state.project_id, actor: "process:kdlc-engine", action: `workflow.${next}`, result: next }); return updated;
    }));
    this.queues.set(id, running.catch(() => {}));
    return running;
  }

  async completeStage(id, stageName, completion) {
    return this.#withWorkflowMutex(id, `complete-${stageName}`, () => this.#completeStage(id, stageName, completion));
  }

  async #completeStage(id, stageName, completion) {
    const stage = this.graph.get(stageName);
    if (!isRecord(completion) || !isRecord(completion.input_hashes) || !isRecord(completion.output_hashes)) {
      throw invalid(`Stage ${stageName} completion requires input_hashes and output_hashes objects`);
    }
    const path = this.checkpointPath(id, stage.name);
    const existing = await this.store.exists(path) ? await this.store.readJson(path) : null;
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
      completed_at: now
    };
    await this.store.writeJsonAtomic(path, checkpoint);
    await this.audit.append(id, { project: completion.project_id, stage: stage.name, actor: completion.agent?.id ?? "process:kdlc-engine", action: "stage.completed", input_hash: canonicalJson(completion.input_hashes), result: "completed" });
    return checkpoint;
  }

  async resume(id, currentInputs) {
    return this.#withWorkflowMutex(id, "resume", () => this.#resume(id, currentInputs));
  }

  async #resume(id, currentInputs) {
    if (!isRecord(currentInputs)) throw invalid("Resume requires current stage inputs");
    const invalidated = [];
    for (const stageName of this.graph.order) {
      const path = this.checkpointPath(id, stageName); if (!(await this.store.exists(path))) continue;
      const checkpoint = await this.store.readJson(path); if (checkpoint.invalidated_at) continue;
      const stage = this.graph.get(stageName);
      const changed = changedFingerprintFields(checkpointFingerprint(checkpoint), currentFingerprint(stage, currentInputs[stageName]));
      if (changed.length === 0) continue;
      for (const affected of this.graph.dependentsOf(stageName)) {
        const affectedPath = this.checkpointPath(id, affected); if (!(await this.store.exists(affectedPath))) continue;
        const target = await this.store.readJson(affectedPath); if (target.invalidated_at) continue;
        target.invalidated_at = this.clock.now();
        target.invalidation_reason = `checkpoint drift at ${stageName}: ${changed.join(", ")}`;
        await this.store.writeJsonAtomic(affectedPath, target); invalidated.push(affected);
      }
    }
    await this.audit.append(id, { actor: "process:kdlc-engine", action: "workflow.resumed", result: invalidated.length ? "invalidated" : "unchanged" });
    return { invalidated: [...new Set(invalidated)] };
  }
}
