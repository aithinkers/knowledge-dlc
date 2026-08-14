import { stat } from "node:fs/promises";

import { conflict, denied } from "./errors.mjs";

export class LeaseLockManager {
  constructor({ store, clock, audit, ids, coordination = {} }) { Object.assign(this, { store, clock, audit, ids }); this.coordination = coordination; }
  path(resource) { return `workflow/locks/${encodeURIComponent(resource)}`; }
  recordPath(resource) { return `${this.path(resource)}/lease.json`; }
  adminPath(resource) { return `workflow/lock-admin/${encodeURIComponent(resource)}`; }
  owner(operation, resource) { return `${operation}:${resource}:${this.ids?.next?.("coord") ?? `${process.pid}-${Date.now()}`}`; }
  coordinated(resource, operation, action) {
    return this.store.withMutex(this.adminPath(resource), { owner: this.owner(operation, resource), clock: this.clock, ...this.coordination }, action);
  }
  async acquire(resource, { owner, process, leaseMs, recovery = {} }) {
    return this.coordinated(resource, "acquire", async () => {
      const lockPath = this.path(resource);
      try { await this.store.createDirectoryExclusive(lockPath); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        const held = await this.store.exists(this.recordPath(resource)) ? await this.store.readJson(this.recordPath(resource)) : null;
        throw conflict("Resource is locked", { resource, owner: held?.owner, expires_at: held?.expires_at, empty: !held });
      }
      const processId = Number(process);
      if (!Number.isSafeInteger(processId) || processId <= 0) throw conflict("Lock requires a valid local process ID", { resource });
      const acquired = this.clock.now(); const expires = new Date(this.clock.millis() + leaseMs).toISOString();
      const record = { resource, owner, process_id: processId, lease_id: this.ids?.next?.("lease") ?? `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`, acquired_at: acquired, heartbeat_at: acquired, expires_at: expires, lease_ms: leaseMs, recovery };
      try { await this.store.writeJsonAtomic(this.recordPath(resource), record); }
      catch (error) { await this.store.removeDirectory(lockPath).catch(() => {}); throw error; }
      return record;
    });
  }
  async heartbeat(resource, owner, leaseId) {
    return this.coordinated(resource, "heartbeat", async () => {
      const record = await this.store.readJson(this.recordPath(resource)); if (record.owner !== owner) throw denied("Only lock owner may heartbeat");
      if (leaseId && record.lease_id !== leaseId) throw conflict("Lock lease identity changed", { resource, owner });
      if (this.store.processIsAlive(record.process_id) !== true) throw conflict("Lock owner process is not live", { resource, owner });
      record.heartbeat_at = this.clock.now(); record.expires_at = new Date(this.clock.millis() + record.lease_ms).toISOString(); await this.store.writeJsonAtomic(this.recordPath(resource), record); return record;
    });
  }
  async validate(resource, owner, leaseId) {
    return this.coordinated(resource, "validate", async () => {
      const firstToken = await this.store.tokenOf(this.recordPath(resource));
      const record = await this.store.readJson(this.recordPath(resource));
      const secondToken = await this.store.tokenOf(this.recordPath(resource));
      if (firstToken !== secondToken || record.owner !== owner || record.lease_id !== leaseId) throw conflict("Lock lease identity changed", { resource, owner });
      if (this.store.processIsAlive(record.process_id) !== true) throw conflict("Lock owner process is not live", { resource, owner });
      return record;
    });
  }
  async reacquire(resource, { owner, priorLeaseId, process, leaseMs, recovery = {}, actor, reason, workflowId }) {
    return this.coordinated(resource, "recover", async () => {
      const lockPath = this.path(resource); const recordPath = this.recordPath(resource);
      let prior = null;
      if (await this.store.exists(recordPath)) {
        const firstToken = await this.store.tokenOf(recordPath); prior = await this.store.readJson(recordPath);
        const belongsToRecovery = prior.owner === owner
          && prior.lease_id === priorLeaseId
          && prior.recovery?.workflow_id === recovery.workflow_id
          && prior.recovery?.transaction_id === recovery.transaction_id;
        if (!belongsToRecovery) throw conflict("Recovery cannot take another lock owner's reservation", { resource, owner: prior.owner });
        if (Date.parse(prior.expires_at) > this.clock.millis() || this.store.processIsAlive(prior.process_id) !== false) {
          throw conflict("Recovery cannot take a live or unverifiable reservation", { resource, owner: prior.owner });
        }
        if (firstToken !== await this.store.tokenOf(recordPath)) throw conflict("Lock changed during recovery", { resource });
        await this.store.remove(recordPath); await this.store.removeDirectory(lockPath);
      } else if (await this.store.exists(lockPath)) {
        const metadata = await stat(await this.store.safePath(lockPath));
        const graceMs = this.coordination.emptyGraceMs ?? 30_000;
        if (this.clock.millis() - metadata.mtimeMs < graceMs) throw conflict("Empty lock is within recovery grace period", { resource });
        await this.store.removeDirectory(lockPath);
      }
      const processId = Number(process);
      if (!Number.isSafeInteger(processId) || processId <= 0) throw conflict("Lock requires a valid local process ID", { resource });
      await this.store.createDirectoryExclusive(lockPath);
      const acquired = this.clock.now();
      const record = {
        resource, owner, process_id: processId,
        lease_id: this.ids?.next?.("lease") ?? `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        acquired_at: acquired, heartbeat_at: acquired, expires_at: new Date(this.clock.millis() + leaseMs).toISOString(), lease_ms: leaseMs, recovery
      };
      try { await this.store.writeJsonAtomic(recordPath, record); }
      catch (error) { await this.store.removeDirectory(lockPath).catch(() => {}); throw error; }
      if (prior && this.audit && workflowId) await this.audit.append(workflowId, {
        actor, action: "lock.broken", subject: resource, result: "stale", reason, prior_owner: prior.owner
      });
      return record;
    });
  }
  async release(resource, owner, leaseId) {
    return this.coordinated(resource, "release", async () => {
      if (!(await this.store.exists(this.recordPath(resource)))) return null;
      const record = await this.store.readJson(this.recordPath(resource)); if (record.owner !== owner) throw denied("Only lock owner may release");
      if (leaseId && record.lease_id !== leaseId) throw conflict("Lock lease identity changed during release", { resource });
      const token = await this.store.tokenOf(this.recordPath(resource));
      if (token !== await this.store.tokenOf(this.recordPath(resource))) throw conflict("Lock changed during release", { resource });
      await this.store.remove(this.recordPath(resource)); await this.store.removeDirectory(this.path(resource));
      return record;
    });
  }
  async breakStale(resource, { actor, reason, workflowId }) {
    return this.coordinated(resource, "break", async () => {
      const recordPath = this.recordPath(resource);
      let record = null;
      if (await this.store.exists(recordPath)) {
        const firstToken = await this.store.tokenOf(recordPath); record = await this.store.readJson(recordPath);
        if (Date.parse(record.expires_at) > this.clock.millis()) throw conflict("Lock lease is not stale");
        if (this.store.processIsAlive(record.process_id) !== false) throw conflict("Live or unverifiable lock owner cannot be broken", { resource, owner: record.owner });
        const secondToken = await this.store.tokenOf(recordPath);
        if (firstToken !== secondToken) throw conflict("Lock changed during stale recovery", { resource });
        await this.store.remove(recordPath);
      } else {
        const metadata = await stat(await this.store.safePath(this.path(resource)));
        const graceMs = this.coordination.emptyGraceMs ?? 30_000;
        if (this.clock.millis() - metadata.mtimeMs < graceMs) throw conflict("Empty lock is within recovery grace period", { resource });
      }
      await this.store.removeDirectory(this.path(resource));
      if (this.audit && workflowId) await this.audit.append(workflowId, { actor, action: "lock.broken", subject: resource, result: record ? "stale" : "empty-stale", reason, prior_owner: record?.owner ?? null });
      return record;
    });
  }
}
