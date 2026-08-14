import { conflict } from "./errors.mjs";

export class AuditWriter {
  constructor({ store, clock, ids, coordination = {} }) { this.store = store; this.clock = clock; this.ids = ids; this.coordination = coordination; }

  append(workflowId, event) {
    for (const field of ["event_id", "sequence", "timestamp", "workflow_id"]) {
      if (Object.hasOwn(event, field)) throw conflict(`Audit caller cannot set reserved field: ${field}`);
    }
    return this.store.withMutex(`workflow/runs/${workflowId}/audit.lock`, {
      owner: `audit:${workflowId}:${this.ids.next("coord")}`, clock: this.clock, ...this.coordination
    }, async () => {
      const sequencePath = `workflow/runs/${workflowId}/audit.sequence`;
      const auditPath = `workflow/runs/${workflowId}/audit.jsonl`;
      let logSequence = 0;
      if (await this.store.exists(auditPath)) {
        const lines = (await this.store.readText(auditPath)).split("\n").filter(Boolean);
        for (const line of lines) {
          let record;
          try { record = JSON.parse(line); } catch { throw conflict("Audit log contains an incomplete or invalid event"); }
          if (!Number.isSafeInteger(record.sequence) || record.sequence !== logSequence + 1) throw conflict("Audit log sequence is not contiguous");
          logSequence = record.sequence;
        }
      }
      const checkpoint = (await this.store.exists(sequencePath)) ? Number(await this.store.readText(sequencePath)) : 0;
      if (!Number.isSafeInteger(checkpoint) || checkpoint < 0 || checkpoint > logSequence) throw conflict("Invalid audit sequence checkpoint");
      const sequence = logSequence + 1;
      if (!Number.isSafeInteger(sequence)) throw conflict("Invalid audit sequence");
      const record = { ...event, event_id: this.ids.next("evt"), sequence, timestamp: this.clock.now(), workflow_id: workflowId };
      await this.store.appendExclusive(auditPath, `${JSON.stringify(record)}\n`);
      await this.store.writeTextAtomic(sequencePath, String(sequence));
      return record;
    });
  }
}
