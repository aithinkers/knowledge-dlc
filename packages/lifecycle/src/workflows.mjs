import { conflict, invalid } from "./errors.mjs";
import { jsonEqual } from "./store.mjs";

const transitions = {
  planned: ["running", "cancelled"], running: ["awaiting_approval", "completed", "failed", "cancelled", "parked"],
  awaiting_approval: ["running", "rejected", "cancelled"], failed: ["retrying", "cancelled"], retrying: ["running", "failed", "cancelled"],
  parked: ["running", "cancelled"], completed: [], rejected: [], cancelled: []
};

export class WorkflowEngine {
  constructor({ store, clock, ids, graph, audit }) { Object.assign(this, { store, clock, ids, graph, audit }); this.queues = new Map(); }
  path(id) { return `workflow/runs/${id}/state.json`; }
  checkpointPath(id, stage) { return `workflow/runs/${id}/checkpoints/${stage}.json`; }

  async create({ projectId, workflowId = this.ids.next("wf") }) {
    const path = this.path(workflowId); if (await this.store.exists(path)) throw conflict(`Workflow already exists: ${workflowId}`);
    const now = this.clock.now(); const state = { version: 1, workflow_id: workflowId, project_id: projectId, state: "planned", revision: 0, created_at: now, updated_at: now, current_stage: null };
    await this.store.writeJsonAtomic(path, state); await this.audit.append(workflowId, { project: projectId, actor: "process:kdlc-engine", action: "workflow.created", result: "planned" }); return state;
  }
  async get(id) { return this.store.readJson(this.path(id)); }
  transition(id, next, expectedRevision) {
    const prior = this.queues.get(id) ?? Promise.resolve();
    const running = prior.then(async () => {
      const state = await this.get(id);
      if (state.revision !== expectedRevision) throw conflict("Workflow revision changed", { expectedRevision, actualRevision: state.revision });
      if (!(transitions[state.state] ?? []).includes(next)) throw invalid(`Invalid workflow transition ${state.state} -> ${next}`);
      const updated = { ...state, state: next, revision: state.revision + 1, updated_at: this.clock.now() };
      await this.store.writeJsonAtomic(this.path(id), updated); await this.audit.append(id, { project: state.project_id, actor: "process:kdlc-engine", action: `workflow.${next}`, result: next }); return updated;
    });
    this.queues.set(id, running.catch(() => {}));
    return running;
  }
  async completeStage(id, stageName, completion) {
    const stage = this.graph.get(stageName); const existing = await this.store.exists(this.checkpointPath(id, stageName)) ? await this.store.readJson(this.checkpointPath(id, stageName)) : null;
    if (stage.deterministic !== false && existing && !existing.invalidated_at && jsonEqual(existing.input_hashes, completion.input_hashes)) {
      if (!jsonEqual(existing.output_hashes, completion.output_hashes)) throw conflict("Deterministic stage produced different output hashes", { stage: stageName });
      return existing;
    }
    const checkpoint = { version: 1, workflow_id: id, stage: stageName, stage_version: stage.version, attempt_id: completion.attempt_id ?? this.ids.next("attempt"), project_version: completion.project_version, dependency_versions: completion.dependency_versions ?? {}, input_hashes: completion.input_hashes, output_hashes: completion.output_hashes, policy_versions: completion.policy_versions ?? [], profile_versions: completion.profile_versions ?? [], agent: completion.agent, model: completion.model ?? null, sensors: completion.sensors ?? [], approval_receipts: completion.approval_receipts ?? [], deterministic: stage.deterministic !== false, completed_at: this.clock.now() };
    await this.store.writeJsonAtomic(this.checkpointPath(id, stageName), checkpoint); await this.audit.append(id, { project: completion.project_id, stage: stageName, actor: completion.agent?.id ?? "process:kdlc-engine", action: "stage.completed", input_hash: JSON.stringify(completion.input_hashes), result: "completed" }); return checkpoint;
  }
  async resume(id, currentInputHashes) {
    const invalidated = [];
    for (const stageName of this.graph.order) {
      const path = this.checkpointPath(id, stageName); if (!(await this.store.exists(path))) continue;
      const checkpoint = await this.store.readJson(path);
      if (!checkpoint.invalidated_at && currentInputHashes[stageName] && !jsonEqual(checkpoint.input_hashes, currentInputHashes[stageName])) {
        for (const affected of this.graph.dependentsOf(stageName)) {
          const affectedPath = this.checkpointPath(id, affected); if (!(await this.store.exists(affectedPath))) continue;
          const target = await this.store.readJson(affectedPath); if (target.invalidated_at) continue;
          target.invalidated_at = this.clock.now(); target.invalidation_reason = `inputs changed at ${stageName}`;
          await this.store.writeJsonAtomic(affectedPath, target); invalidated.push(affected);
        }
      }
    }
    await this.audit.append(id, { actor: "process:kdlc-engine", action: "workflow.resumed", result: invalidated.length ? "invalidated" : "unchanged" });
    return { invalidated: [...new Set(invalidated)] };
  }
}
