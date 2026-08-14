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
      const acquired = this.clock.now(); const expires = new Date(this.clock.millis() + leaseMs).toISOString();
      const record = { resource, owner, process, acquired_at: acquired, heartbeat_at: acquired, expires_at: expires, lease_ms: leaseMs, recovery };
      try { await this.store.writeJsonAtomic(this.recordPath(resource), record); }
      catch (error) { await this.store.removeDirectory(lockPath).catch(() => {}); throw error; }
      return record;
    });
  }
  async heartbeat(resource, owner) {
    return this.coordinated(resource, "heartbeat", async () => {
      const record = await this.store.readJson(this.recordPath(resource)); if (record.owner !== owner) throw denied("Only lock owner may heartbeat");
      if (Date.parse(record.expires_at) <= this.clock.millis()) throw conflict("Expired lock cannot be renewed", { resource, owner });
      record.heartbeat_at = this.clock.now(); record.expires_at = new Date(this.clock.millis() + record.lease_ms).toISOString(); await this.store.writeJsonAtomic(this.recordPath(resource), record); return record;
    });
  }
  async release(resource, owner) {
    return this.coordinated(resource, "release", async () => {
      if (!(await this.store.exists(this.recordPath(resource)))) return null;
      const record = await this.store.readJson(this.recordPath(resource)); if (record.owner !== owner) throw denied("Only lock owner may release");
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
