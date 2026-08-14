import { assertIdentifier, conflict, LifecycleError } from "./errors.mjs";
import { LeaseLockManager } from "./locks.mjs";

export class TransactionManager {
  constructor({ store, clock, ids, token, audit, fault = () => {}, coordination = {}, transactionLeaseMs = 300_000 }) {
    Object.assign(this, { store, clock, ids, token, audit, fault, transactionLeaseMs });
    this.locks = new LeaseLockManager({ store, clock, ids, coordination });
  }
  path(workflowId, id) { return `workflow/runs/${assertIdentifier(workflowId, "workflow ID")}/transactions/${assertIdentifier(id, "transaction ID")}.json`; }
  async resource(targetPath) { return `transaction-target:${await this.store.identity(targetPath)}`; }
  async releaseTargets(journal) {
    for (const target of [...journal.targets].sort((left, right) => right.path.localeCompare(left.path))) {
      const resource = await this.resource(target.path);
      if (!(await this.store.exists(this.locks.recordPath(resource)))) continue;
      const record = await this.store.readJson(this.locks.recordPath(resource));
      if (record.owner !== journal.transaction_id || record.lease_id !== target.lock_lease_id) throw conflict("Transaction target reservation belongs to another owner", { path: target.path });
      await this.locks.release(resource, journal.transaction_id, target.lock_lease_id);
    }
  }
  async verifyTargetsHeld(journal, { heartbeat = false } = {}) {
    for (const target of journal.targets) {
      if (!target.lock_lease_id) throw conflict("Transaction target reservation lacks a lease identity", { path: target.path });
      const resource = await this.resource(target.path);
      if (heartbeat) await this.locks.heartbeat(resource, journal.transaction_id, target.lock_lease_id);
      else await this.locks.validate(resource, journal.transaction_id, target.lock_lease_id);
    }
  }
  async whileHeartbeating(journal, action) {
    let stopped = false; let wake;
    let heartbeatError;
    const loop = (async () => {
      while (!stopped) {
        await new Promise((resolveDelay) => {
          const timer = setTimeout(resolveDelay, Math.max(1, Math.floor(this.transactionLeaseMs / 3)));
          wake = () => { clearTimeout(timer); resolveDelay(); };
        });
        wake = undefined;
        if (!stopped) {
          try { await this.verifyTargetsHeld(journal, { heartbeat: true }); }
          catch (error) { heartbeatError = error; break; }
        }
      }
    })();
    try { const result = await action(); if (heartbeatError) throw heartbeatError; return result; }
    finally { stopped = true; wake?.(); await loop; if (heartbeatError) throw heartbeatError; }
  }
  async fencedMutation(journal, action) {
    await this.verifyTargetsHeld(journal);
    const result = await action();
    await this.verifyTargetsHeld(journal);
    return result;
  }
  async prepare({ workflowId, targets }) {
    const id = this.ids.next("txn"); const now = this.clock.now(); const prepared = []; const acquired = [];
    if (await this.store.exists(this.path(workflowId, id))) throw conflict("Generated transaction ID already exists", { id });
    const ordered = await Promise.all(targets.map(async (target) => ({ ...target, path: await this.store.identity(target.path) })));
    ordered.sort((left, right) => left.path.localeCompare(right.path));
    if (new Set(ordered.map(({ path }) => path)).size !== ordered.length) throw conflict("Transaction target paths must be unique");
    try {
      for (const target of ordered) {
        const lease = await this.locks.acquire(await this.resource(target.path), { owner: id, process: process.pid, leaseMs: this.transactionLeaseMs, recovery: { workflow_id: workflowId, transaction_id: id } });
        acquired.push({ ...target, lock_lease_id: lease.lease_id });
        const prior = await this.store.exists(target.path) ? await this.store.readText(target.path) : null;
        const actual = prior === null ? null : this.token(prior);
        if (actual !== target.expectedToken) throw conflict("Target changed before transaction preparation", { path: target.path, expected: target.expectedToken, actual });
        prepared.push({ path: target.path, expected_token: target.expectedToken, next_content: target.content, prior_content: prior, lock_lease_id: lease.lease_id, applying: false, applied: false });
      }
    } catch (error) {
      for (const target of acquired.reverse()) await this.locks.release(await this.resource(target.path), id, target.lock_lease_id).catch(() => {});
      throw error;
    }
    const journal = { version: 1, transaction_id: id, workflow_id: workflowId, state: "prepared", targets: prepared, created_at: now, updated_at: now };
    try { await this.store.writeJsonAtomic(this.path(workflowId, id), journal); return journal; }
    catch (error) { await this.releaseTargets(journal).catch(() => {}); throw error; }
  }
  async commit(workflowId, id) {
    const path = this.path(workflowId, id); const journal = await this.store.readJson(path);
    if (journal.state === "committed") { await this.releaseTargets(journal); return journal; }
    if (journal.state === "finalizing") return this.finalize(journal, path);
    const applied = await this.whileHeartbeating(journal, async () => {
    await this.verifyTargetsHeld(journal, { heartbeat: true });
    for (const target of journal.targets) {
      const actual = await this.store.exists(target.path) ? this.token(await this.store.readText(target.path)) : null;
      if (target.applying && actual === this.token(target.next_content)) { target.applying = false; target.applied = true; }
      else if (!target.applied && actual !== target.expected_token) throw conflict("Target changed before transaction application", { path: target.path, expected: target.expected_token, actual });
    }
    journal.state = "applying"; journal.updated_at = this.clock.now(); await this.fencedMutation(journal, () => this.store.writeJsonAtomic(path, journal));
    try {
      for (let index = 0; index < journal.targets.length; index += 1) {
        const target = journal.targets[index]; if (target.applied) continue;
        target.applying = true; journal.updated_at = this.clock.now(); await this.fencedMutation(journal, () => this.store.writeJsonAtomic(path, journal));
        await this.fault({ phase: "before-write", index, journal: structuredClone(journal) });
        await this.fencedMutation(journal, () => this.store.writeTextAtomic(target.path, target.next_content));
        await this.fault({ phase: "after-write-before-journal", index, journal: structuredClone(journal) });
        target.applying = false; target.applied = true; journal.updated_at = this.clock.now(); await this.fencedMutation(journal, () => this.store.writeJsonAtomic(path, journal)); await this.fault({ phase: "applied", index, journal: structuredClone(journal) });
      }
      journal.state = "finalizing"; journal.updated_at = this.clock.now(); await this.fencedMutation(journal, () => this.store.writeJsonAtomic(path, journal));
      return journal;
    } catch (error) {
      if (journal.state === "committed") throw error;
      if (journal.state === "finalizing") throw new LifecycleError("KDLC_TRANSACTION_FINALIZATION_PENDING", "publication-transaction-failure", "Publication transaction finalization is pending", { retryable: true, details: { transaction_id: id } });
      journal.state = "failed"; journal.error = "KDLC_TRANSACTION_FAILED"; journal.updated_at = this.clock.now(); await this.fencedMutation(journal, () => this.store.writeJsonAtomic(path, journal)); throw new LifecycleError("KDLC_TRANSACTION_FAILED", "publication-transaction-failure", "Publication transaction failed", { retryable: true, details: { transaction_id: id } });
    }
    });
    try { return await this.finalize(applied, path); }
    catch (error) {
      if (applied.state === "committed") throw error;
      throw new LifecycleError("KDLC_TRANSACTION_FINALIZATION_PENDING", "publication-transaction-failure", "Publication transaction finalization is pending", { retryable: true, details: { transaction_id: id }, cause: error });
    }
  }
  async finalize(journal, path = this.path(journal.workflow_id, journal.transaction_id)) {
    await this.verifyTargetsHeld(journal);
    if (this.audit) await this.audit.append(journal.workflow_id, {
      actor: "process:kdlc-engine", action: "publication.committed", subject: journal.transaction_id,
      result: "committed", idempotency_key: `publication:${journal.transaction_id}`
    });
    await this.verifyTargetsHeld(journal);
    journal.state = "committed"; journal.updated_at = this.clock.now(); delete journal.error;
    await this.fencedMutation(journal, () => this.store.writeJsonAtomic(path, journal));
    await this.releaseTargets(journal);
    return journal;
  }
  async recover(workflowId, id, strategy = "rollback") {
    const path = this.path(workflowId, id); const journal = await this.store.readJson(path);
    if (journal.state === "committed") { await this.releaseTargets(journal); return journal; }
    if (journal.state === "finalizing") return this.finalize(journal, path);
    if (journal.state === "rolled_back") return journal;
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
