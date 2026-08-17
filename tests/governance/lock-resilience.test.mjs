import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LeaseLockManager } from "../../packages/lifecycle/src/locks.mjs";
import { NodeFileStore } from "../../packages/lifecycle/src/index.mjs";

const clock = { now: () => new Date().toISOString(), millis: () => Date.now() };

test("FEAT-043: deep target paths never overflow the lock filename limit (#146)", async () => {
  const root = await mkdtemp(join(tmpdir(), "kdlc-locknames-"));
  const store = new NodeFileStore(root);
  const locks = new LeaseLockManager({ store, clock });
  // The live failure: a nested concept path whose encoded resource, doubled
  // into the recovery marker, exceeded 255 bytes and ENAMETOOLONG'd publish.
  const resource = "transaction-target:knowledge/primary/concepts/supplier/triumph-insulation-systems/and-some/considerably/deeper/nesting/lead-time-forecast-with-a-long-name.md";
  const lease = await locks.acquire(resource, { owner: "txn_test", process: process.pid, leaseMs: 60_000 });
  assert.ok(lease.lease_id);
  for (const directory of ["workflow/locks", "workflow/lock-admin"]) {
    for (const name of await readdir(join(root, directory))) {
      assert.ok(Buffer.byteLength(name) <= 200, `${directory}/${name} stays clear of the 255-byte filename limit`);
    }
  }
  // Distinct long resources must not collide after truncation-with-hash.
  const sibling = resource.replace("lead-time-forecast", "different-forecast");
  const other = await locks.acquire(sibling, { owner: "txn_other", process: process.pid, leaseMs: 60_000 });
  assert.notEqual(locks.path(resource), locks.path(sibling));
  await locks.release(resource, "txn_test", lease.lease_id);
  await locks.release(sibling, "txn_other", other.lease_id);
});

test("FEAT-043: an orphaned lease (expired, dead owner, no journal) is reclaimed instead of wedging the target (#146)", async () => {
  const root = await mkdtemp(join(tmpdir(), "kdlc-orphan-"));
  const store = new NodeFileStore(root);
  const events = [];
  const audit = { append: async (workflowId, event) => { events.push({ workflowId, ...event }); } };
  const past = { now: () => new Date(Date.now() - 3_600_000).toISOString(), millis: () => Date.now() - 3_600_000 };
  const resource = "transaction-target:knowledge/primary/concepts/x.md";
  // A holder that crashed an hour ago: expired lease, provably dead pid.
  const stale = new LeaseLockManager({ store, clock: past, audit });
  await stale.acquire(resource, { owner: "txn_dead", process: 999999, leaseMs: 1_000, recovery: { workflow_id: "wf_dead", transaction_id: "txn_dead" } });

  const live = new LeaseLockManager({ store, clock, audit });
  const lease = await live.acquire(resource, { owner: "txn_live", process: process.pid, leaseMs: 60_000 });
  assert.equal(lease.owner, "txn_live", "the orphan is broken and the new holder proceeds");
  const broken = events.find(({ action }) => action === "lock.broken");
  assert.ok(broken, "breaking an orphan is audited");
  assert.equal(broken.prior_owner, "txn_dead");

  // A LIVE holder still conflicts fail-closed.
  await assert.rejects(
    live.acquire(resource, { owner: "txn_second", process: process.pid, leaseMs: 60_000 }),
    (error) => /locked/i.test(error.message)
  );
  // An expired lease whose owner process is STILL ALIVE also conflicts —
  // liveness is the fail-closed side of the orphan test.
  await live.release(resource, "txn_live", lease.lease_id);
  const expiredAlive = new LeaseLockManager({ store, clock: past, audit });
  await expiredAlive.acquire(resource, { owner: "txn_expired_alive", process: process.pid, leaseMs: 1_000 });
  await assert.rejects(
    live.acquire(resource, { owner: "txn_third", process: process.pid, leaseMs: 60_000 }),
    (error) => /locked/i.test(error.message)
  );
});
