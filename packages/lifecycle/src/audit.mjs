import { conflict } from "./errors.mjs";

export class AuditWriter {
  constructor({ store, clock, ids }) { this.store = store; this.clock = clock; this.ids = ids; this.queues = new Map(); }

  append(workflowId, event) {
    const prior = this.queues.get(workflowId) ?? Promise.resolve();
    const next = prior.then(async () => {
      const sequencePath = `workflow/runs/${workflowId}/audit.sequence`;
      const auditPath = `workflow/runs/${workflowId}/audit.jsonl`;
      const sequence = (await this.store.exists(sequencePath)) ? Number(await this.store.readText(sequencePath)) + 1 : 1;
      if (!Number.isSafeInteger(sequence)) throw conflict("Invalid audit sequence");
      const record = { event_id: this.ids.next("evt"), sequence, timestamp: this.clock.now(), workflow_id: workflowId, ...event };
      await this.store.appendExclusive(auditPath, `${JSON.stringify(record)}\n`);
      await this.store.writeTextAtomic(sequencePath, String(sequence));
      return record;
    });
    this.queues.set(workflowId, next.catch(() => {}));
    return next;
  }
}
