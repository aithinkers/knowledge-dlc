import { conflict, denied } from "./errors.mjs";

export class LeaseLockManager {
  constructor({ store, clock, audit }) { Object.assign(this, { store, clock, audit }); }
  path(resource) { return `workflow/locks/${encodeURIComponent(resource)}`; }
  recordPath(resource) { return `${this.path(resource)}/lease.json`; }
  async acquire(resource, { owner, process, leaseMs, recovery = {} }) {
    const lockPath = this.path(resource);
    try { await this.store.createDirectoryExclusive(lockPath); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const held = await this.store.exists(this.recordPath(resource)) ? await this.store.readJson(this.recordPath(resource)) : null;
      throw conflict("Resource is locked", { resource, owner: held?.owner, expires_at: held?.expires_at });
    }
    const acquired = this.clock.now(); const expires = new Date(this.clock.millis() + leaseMs).toISOString();
    const record = { resource, owner, process, acquired_at: acquired, heartbeat_at: acquired, expires_at: expires, lease_ms: leaseMs, recovery };
    await this.store.writeJsonAtomic(this.recordPath(resource), record); return record;
  }
  async heartbeat(resource, owner) {
    const record = await this.store.readJson(this.recordPath(resource)); if (record.owner !== owner) throw denied("Only lock owner may heartbeat");
    record.heartbeat_at = this.clock.now(); record.expires_at = new Date(this.clock.millis() + record.lease_ms).toISOString(); await this.store.writeJsonAtomic(this.recordPath(resource), record); return record;
  }
  async release(resource, owner) {
    const record = await this.store.readJson(this.recordPath(resource)); if (record.owner !== owner) throw denied("Only lock owner may release");
    await this.store.remove(this.recordPath(resource)); await this.store.removeDirectory(this.path(resource));
  }
  async breakStale(resource, { actor, reason, workflowId }) {
    const record = await this.store.readJson(this.recordPath(resource)); if (Date.parse(record.expires_at) > this.clock.millis()) throw conflict("Lock lease is not stale");
    await this.store.remove(this.recordPath(resource)); await this.store.removeDirectory(this.path(resource));
    if (this.audit && workflowId) await this.audit.append(workflowId, { actor, action: "lock.broken", subject: resource, result: "stale", reason, prior_owner: record.owner });
    return record;
  }
}
