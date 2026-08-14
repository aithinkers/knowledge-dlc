import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuditWriter, JobRegistry, LeaseLockManager, NodeFileStore, TransactionManager, sha256Token } from "../../packages/lifecycle/src/index.mjs";

class Clock {
  constructor(value = Date.now()) { this.value = value; }
  now = () => new Date(this.value).toISOString();
  millis = () => this.value;
  advance(ms) { this.value += ms; }
}
class IDs {
  constructor(namespace) { this.namespace = namespace; this.value = 0; }
  next(prefix) { this.value += 1; return `${prefix}_${this.namespace}_${this.value}`; }
}

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "kdlc-coordination-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new NodeFileStore(root), clock: new Clock() };
}

const jobInput = { principal: "human:a", projectId: "p", workflowId: "wf", operation: "normalize", idempotencyKey: "request-1", inputHashes: { source: "sha256:a" } };

test("FEAT-002 cross-instance job creation is filesystem-idempotent and collision-safe", async (context) => {
  const f = await fixture(context);
  const left = new JobRegistry({ ...f, ids: new IDs("left"), coordination: { timeoutMs: 1000 } });
  const right = new JobRegistry({ ...f, ids: new IDs("right"), coordination: { timeoutMs: 1000 } });
  const results = await Promise.all([left.create(jobInput), right.create(jobInput)]);
  assert.equal(new Set(results.map(({ job }) => job.job_id)).size, 1);
  assert.equal(results.filter(({ reused }) => reused).length, 1);

  const colliding = new JobRegistry({ ...f, ids: { next: (prefix) => prefix === "job" ? results[0].job.job_id : `${prefix}_collision` } });
  await assert.rejects(colliding.create({ ...jobInput, idempotencyKey: "request-2" }), (error) => error.code === "KDLC_HASH_CONFLICT");
});

test("FEAT-002 cross-instance job transitions compare the expected durable token", async (context) => {
  const f = await fixture(context); const first = new JobRegistry({ ...f, ids: new IDs("one") }); const second = new JobRegistry({ ...f, ids: new IDs("two") });
  const { job } = await first.create(jobInput); const expectedToken = await f.store.tokenOf(first.path(job.job_id));
  const outcomes = await Promise.allSettled([
    first.transition(job.job_id, "running", {}, { expectedToken }),
    second.transition(job.job_id, "cancelled", {}, { expectedToken })
  ]);
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(outcomes.find(({ status }) => status === "rejected").reason.code, "KDLC_HASH_CONFLICT");
});

test("FEAT-002 cross-instance audit allocation is contiguous, recoverable, and reserves identity fields", async (context) => {
  const f = await fixture(context);
  const writers = [new AuditWriter({ ...f, ids: new IDs("a") }), new AuditWriter({ ...f, ids: new IDs("b") })];
  await Promise.all(Array.from({ length: 20 }, (_, index) => writers[index % 2].append("wf", { actor: "test", action: "event", result: String(index) })));
  await f.store.writeTextAtomic("workflow/runs/wf/audit.sequence", "17");
  const recovered = await writers[0].append("wf", { actor: "test", action: "after-crash", result: "ok" });
  assert.equal(recovered.sequence, 21);
  const records = (await f.store.readText("workflow/runs/wf/audit.jsonl")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(records.map(({ sequence }) => sequence), Array.from({ length: 21 }, (_, index) => index + 1));
  assert.throws(() => writers[0].append("wf", { actor: "spoof", action: "event", result: "bad", sequence: 999 }), /reserved field/);
});

test("FEAT-002 prepared transactions reserve targets across workflows until commit", async (context) => {
  const f = await fixture(context); await f.store.writeTextAtomic("knowledge/shared.md", "before");
  const first = new TransactionManager({ ...f, ids: new IDs("one"), token: sha256Token });
  const second = new TransactionManager({ ...f, ids: new IDs("two"), token: sha256Token });
  const prepared = await first.prepare({ workflowId: "wf-one", targets: [{ path: "knowledge/shared.md", expectedToken: sha256Token("before"), content: "first" }] });
  await assert.rejects(second.prepare({ workflowId: "wf-two", targets: [{ path: "knowledge/shared.md", expectedToken: sha256Token("before"), content: "second" }] }), (error) => error.code === "KDLC_HASH_CONFLICT");
  await first.commit("wf-one", prepared.transaction_id);
  const next = await second.prepare({ workflowId: "wf-two", targets: [{ path: "knowledge/shared.md", expectedToken: sha256Token("first"), content: "second" }] });
  await second.commit("wf-two", next.transaction_id); assert.equal(await f.store.readText("knowledge/shared.md"), "second");
});

test("FEAT-002 stale lock recovery is serialized and can recover an abandoned empty lock", async (context) => {
  const f = await fixture(context); const locks = new LeaseLockManager({ ...f, ids: new IDs("locks"), coordination: { emptyGraceMs: 100, timeoutMs: 1000 } });
  const emptyResource = "empty"; await f.store.createDirectoryExclusive(locks.path(emptyResource)); f.clock.value = Date.now(); f.clock.advance(101);
  assert.equal(await locks.breakStale(emptyResource, { actor: "admin", reason: "creator crashed" }), null);

  await locks.acquire("leased", { owner: "wf:a", process: "1", leaseMs: 100 }); f.clock.advance(101);
  const outcomes = await Promise.allSettled([
    locks.heartbeat("leased", "wf:a"),
    locks.breakStale("leased", { actor: "admin", reason: "expired" })
  ]);
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(outcomes.find(({ status }) => status === "rejected").reason.code, "KDLC_HASH_CONFLICT");
});
