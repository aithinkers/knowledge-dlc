import { conflict, LifecycleError } from "./errors.mjs";
import { LeaseLockManager } from "./locks.mjs";

export class TransactionManager {
  constructor({ store, clock, ids, token, audit, fault = () => {}, coordination = {}, transactionLeaseMs = 300_000 }) {
    Object.assign(this, { store, clock, ids, token, audit, fault, transactionLeaseMs });
    this.locks = new LeaseLockManager({ store, clock, ids, coordination });
  }
  path(workflowId, id) { return `workflow/runs/${workflowId}/transactions/${id}.json`; }
  resource(targetPath) { return `transaction-target:${targetPath}`; }
  async releaseTargets(journal) {
    for (const target of [...journal.targets].sort((left, right) => right.path.localeCompare(left.path))) {
      await this.locks.release(this.resource(target.path), journal.transaction_id);
    }
  }
  async verifyTargetsHeld(journal) {
    for (const target of journal.targets) await this.locks.heartbeat(this.resource(target.path), journal.transaction_id);
  }
  async prepare({ workflowId, targets }) {
    const id = this.ids.next("txn"); const now = this.clock.now(); const prepared = []; const acquired = [];
    if (await this.store.exists(this.path(workflowId, id))) throw conflict("Generated transaction ID already exists", { id });
    const ordered = [...targets].sort((left, right) => left.path.localeCompare(right.path));
    if (new Set(ordered.map(({ path }) => path)).size !== ordered.length) throw conflict("Transaction target paths must be unique");
    try {
      for (const target of ordered) {
        await this.locks.acquire(this.resource(target.path), { owner: id, process: `transaction:${workflowId}`, leaseMs: this.transactionLeaseMs, recovery: { workflow_id: workflowId, transaction_id: id } });
        acquired.push(target);
        const prior = await this.store.exists(target.path) ? await this.store.readText(target.path) : null;
        const actual = prior === null ? null : this.token(prior);
        if (actual !== target.expectedToken) throw conflict("Target changed before transaction preparation", { path: target.path, expected: target.expectedToken, actual });
        prepared.push({ path: target.path, expected_token: target.expectedToken, next_content: target.content, prior_content: prior, applying: false, applied: false });
      }
    } catch (error) {
      for (const target of acquired.reverse()) await this.locks.release(this.resource(target.path), id).catch(() => {});
      throw error;
    }
    const journal = { version: 1, transaction_id: id, workflow_id: workflowId, state: "prepared", targets: prepared, created_at: now, updated_at: now };
    try { await this.store.writeJsonAtomic(this.path(workflowId, id), journal); return journal; }
    catch (error) { await this.releaseTargets(journal).catch(() => {}); throw error; }
  }
  async commit(workflowId, id) {
    const path = this.path(workflowId, id); const journal = await this.store.readJson(path); if (journal.state === "committed") return journal;
    await this.verifyTargetsHeld(journal);
    for (const target of journal.targets) {
      const actual = await this.store.exists(target.path) ? this.token(await this.store.readText(target.path)) : null;
      if (target.applying && actual === this.token(target.next_content)) { target.applying = false; target.applied = true; }
      else if (!target.applied && actual !== target.expected_token) throw conflict("Target changed before transaction application", { path: target.path, expected: target.expected_token, actual });
    }
    journal.state = "applying"; journal.updated_at = this.clock.now(); await this.store.writeJsonAtomic(path, journal);
    try {
      for (let index = 0; index < journal.targets.length; index += 1) {
        const target = journal.targets[index]; if (target.applied) continue;
        target.applying = true; journal.updated_at = this.clock.now(); await this.store.writeJsonAtomic(path, journal);
        await this.fault({ phase: "before-write", index, journal: structuredClone(journal) });
        await this.store.writeTextAtomic(target.path, target.next_content);
        await this.fault({ phase: "after-write-before-journal", index, journal: structuredClone(journal) });
        target.applying = false; target.applied = true; journal.updated_at = this.clock.now(); await this.store.writeJsonAtomic(path, journal); await this.fault({ phase: "applied", index, journal: structuredClone(journal) });
      }
      journal.state = "committed"; journal.updated_at = this.clock.now(); await this.store.writeJsonAtomic(path, journal);
      if (this.audit) await this.audit.append(workflowId, { actor: "process:kdlc-engine", action: "publication.committed", subject: id, result: "committed" });
      await this.releaseTargets(journal); return journal;
    } catch (error) {
      if (journal.state === "committed") throw error;
      journal.state = "failed"; journal.error = error.message; journal.updated_at = this.clock.now(); await this.store.writeJsonAtomic(path, journal); throw new LifecycleError("KDLC_TRANSACTION_FAILED", "publication-transaction-failure", "Publication transaction failed", { retryable: true, details: { transaction_id: id } });
    }
  }
  async recover(workflowId, id, strategy = "rollback") {
    const path = this.path(workflowId, id); const journal = await this.store.readJson(path);
    if (journal.state === "committed" || journal.state === "rolled_back") return journal;
    if (strategy === "rollforward") { journal.state = "applying"; await this.store.writeJsonAtomic(path, journal); return this.commit(workflowId, id); }
    journal.state = "rolling_back"; await this.store.writeJsonAtomic(path, journal);
    for (const target of [...journal.targets].reverse()) if (target.applied || target.applying) {
      const actual = await this.store.exists(target.path) ? this.token(await this.store.readText(target.path)) : null;
      const nextToken = this.token(target.next_content);
      if (actual !== nextToken && actual !== target.expected_token) throw conflict("Cannot recover target changed by another writer", { path: target.path, actual });
      if (actual === nextToken) {
        if (target.prior_content === null) await this.store.remove(target.path); else await this.store.writeTextAtomic(target.path, target.prior_content);
      }
      target.applying = false; target.applied = false;
    }
    journal.state = "rolled_back"; journal.updated_at = this.clock.now(); await this.store.writeJsonAtomic(path, journal); await this.releaseTargets(journal); return journal;
  }
}
