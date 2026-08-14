import { conflict, denied, invalid } from "./errors.mjs";
import { jsonEqual } from "./store.mjs";

const transitions = { queued: ["running", "cancelled"], running: ["completed", "failed", "cancelled", "parked", "awaiting_input"], awaiting_input: ["queued", "cancelled"], parked: ["queued", "cancelled"], completed: [], failed: [], cancelled: [] };

export class JobRegistry {
  constructor({ store, clock, ids, audit, coordination = {} }) { Object.assign(this, { store, clock, ids, audit }); this.coordination = coordination; }
  path(id) { return `workflow/jobs/${id}.json`; }
  indexPath() { return "workflow/jobs/idempotency.json"; }
  async get(id) { return this.store.readJson(this.path(id)); }
  coordinate(scope, action) {
    return this.store.withMutex(`workflow/job-coordination/${encodeURIComponent(scope)}`, {
      owner: `job:${scope}:${this.ids.next("coord")}`, clock: this.clock, ...this.coordination
    }, action);
  }

  create(input) {
    return this.coordinate("idempotency", async () => {
      const index = await this.store.exists(this.indexPath()) ? await this.store.readJson(this.indexPath()) : {};
      const identity = `${input.principal}\u0000${input.projectId}\u0000${input.operation}\u0000${input.idempotencyKey}`;
      if (index[identity]) {
        const existing = await this.get(index[identity]);
        if (!jsonEqual(existing.input_hashes, input.inputHashes)) throw conflict("Idempotency key reused with changed inputs");
        return { job: existing, reused: true };
      }
      const now = this.clock.now(); const jobId = this.ids.next("job");
      if (await this.store.exists(this.path(jobId))) throw conflict("Generated job ID already exists", { jobId });
      const job = { version: 1, job_id: jobId, principal: input.principal, project_id: input.projectId, workflow_id: input.workflowId, operation: input.operation, idempotency_key: input.idempotencyKey, input_hashes: input.inputHashes, dependencies: input.dependencies ?? {}, state: "queued", progress: { completed: 0, total: input.total ?? 0 }, checkpoints: [], resource_budget: input.resourceBudget ?? {}, created_at: now, updated_at: now, error: null, cancellation_requested: false };
      await this.store.writeJsonAtomic(this.path(jobId), job); index[identity] = jobId; await this.store.writeJsonAtomic(this.indexPath(), index);
      return { job, reused: false };
    });
  }
  transition(id, next, patch = {}, { expectedToken } = {}) {
    return this.coordinate(`job:${id}`, async () => {
      const actualToken = await this.store.tokenOf(this.path(id));
      if (expectedToken !== undefined && actualToken !== expectedToken) throw conflict("Job changed before transition", { id, expectedToken, actualToken });
      const job = await this.get(id); if (!(transitions[job.state] ?? []).includes(next)) throw invalid(`Invalid job transition ${job.state} -> ${next}`);
      const updated = { ...job, ...patch, state: next, updated_at: this.clock.now() };
      await this.store.writeJsonAtomic(this.path(id), updated); return updated;
    });
  }
  requestCancellation(id, principal) {
    return this.coordinate(`job:${id}`, async () => {
      const job = await this.get(id); if (job.principal !== principal) throw denied("Job principal mismatch");
      if (["completed", "failed", "cancelled"].includes(job.state)) return job;
      const updated = { ...job, cancellation_requested: true, updated_at: this.clock.now() };
      if (job.state === "queued") updated.state = "cancelled";
      await this.store.writeJsonAtomic(this.path(id), updated); return updated;
    });
  }
  cancellationPoint(id, checkpoint) {
    return this.coordinate(`job:${id}`, async () => {
      const job = await this.get(id); const checkpoints = checkpoint === undefined ? job.checkpoints : [...job.checkpoints, checkpoint];
      if (!job.cancellation_requested) { const updated = { ...job, checkpoints, updated_at: this.clock.now() }; await this.store.writeJsonAtomic(this.path(id), updated); return false; }
      const updated = { ...job, checkpoints, state: "cancelled", updated_at: this.clock.now() }; await this.store.writeJsonAtomic(this.path(id), updated); return true;
    });
  }
}
