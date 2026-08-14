import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("FEAT-002 job idempotency recovers after a crash between durable writes", async (context) => {
  const f = await fixture(context); const jobs = new JobRegistry({ ...f, ids: new IDs("crash") });
  const original = f.store.writeJsonAtomic.bind(f.store); let failed = false;
  f.store.writeJsonAtomic = async (path, value) => {
    if (!failed && /^workflow\/jobs\/job_/.test(path)) { failed = true; throw new Error("simulated job write crash"); }
    return original(path, value);
  };
  await assert.rejects(jobs.create(jobInput), /simulated job write crash/);
  const recovered = await jobs.create(jobInput);
  assert.equal(recovered.reused, true);
  assert.equal(recovered.job.job_id, "job_crash_2");
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

test("FEAT-002 transaction reservations canonicalize paths and finalization is retryable", async (context) => {
  const f = await fixture(context); await f.store.writeTextAtomic("knowledge/shared.md", "before");
  let auditFailures = 1;
  const audit = { append: async () => { if (auditFailures-- > 0) throw new Error("audit unavailable"); return {}; } };
  const first = new TransactionManager({ ...f, audit, ids: new IDs("final"), token: sha256Token });
  const second = new TransactionManager({ ...f, ids: new IDs("alias"), token: sha256Token });
  const prepared = await first.prepare({ workflowId: "wf", targets: [{ path: "knowledge/./shared.md", expectedToken: sha256Token("before"), content: "after" }] });
  await assert.rejects(second.prepare({ workflowId: "other", targets: [{ path: "knowledge/shared.md", expectedToken: sha256Token("before"), content: "lost" }] }), (error) => error.code === "KDLC_HASH_CONFLICT");
  await assert.rejects(first.commit("wf", prepared.transaction_id), (error) => error.code === "KDLC_TRANSACTION_FINALIZATION_PENDING");
  assert.equal((await f.store.readJson(first.path("wf", prepared.transaction_id))).state, "finalizing");
  const committed = await first.commit("wf", prepared.transaction_id);
  assert.equal(committed.state, "committed");
  const next = await second.prepare({ workflowId: "other", targets: [{ path: "knowledge/shared.md", expectedToken: sha256Token("after"), content: "next" }] });
  assert.equal(next.state, "prepared");
});

test("FEAT-002 filesystem identities follow volume case and Unicode normalization behavior", async (context) => {
  const f = await fixture(context); await mkdir(join(f.root, "knowledge"));
  await writeFile(join(f.root, "knowledge/Café.md"), "existing");
  const behavior = await f.store.filesystemBehavior();
  const canonical = await f.store.identity("knowledge/Café.md");
  const decomposed = await f.store.identity("knowledge/Cafe\u0301.md");
  assert.equal(canonical === decomposed, behavior.normalizationInsensitive);
  const upper = await f.store.identity("knowledge/Café.md");
  const lower = await f.store.identity("KNOWLEDGE/cAFÉ.MD");
  assert.equal(upper === lower, behavior.caseInsensitive);
  const futureUpper = await f.store.identity("knowledge/RÉSUMÉ.md");
  const futureLowerNfd = await f.store.identity("KNOWLEDGE/re\u0301sume\u0301.md");
  assert.equal(futureUpper === futureLowerNfd, behavior.caseInsensitive && behavior.normalizationInsensitive);
});

test("FEAT-002 finalizing publication recovers forward after audit without rollback", async (context) => {
  const f = await fixture(context); await f.store.writeTextAtomic("knowledge/final.md", "before");
  const ids = new IDs("publication"); const audit = new AuditWriter({ ...f, ids });
  const manager = new TransactionManager({ ...f, ids, audit, token: sha256Token });
  const journal = await manager.prepare({ workflowId: "wf", targets: [{ path: "knowledge/final.md", expectedToken: sha256Token("before"), content: "published" }] });
  const originalWrite = f.store.writeJsonAtomic.bind(f.store); let failCommittedJournal = true;
  f.store.writeJsonAtomic = async (path, value) => {
    if (failCommittedJournal && path === manager.path("wf", journal.transaction_id) && value.state === "committed") { failCommittedJournal = false; throw new Error("journal disk unavailable"); }
    return originalWrite(path, value);
  };
  await assert.rejects(manager.commit("wf", journal.transaction_id), /journal disk unavailable/);
  assert.equal((await f.store.readJson(manager.path("wf", journal.transaction_id))).state, "finalizing");
  assert.equal(await f.store.readText("knowledge/final.md"), "published");
  const recovered = await manager.recover("wf", journal.transaction_id, "rollback");
  assert.equal(recovered.state, "committed"); assert.equal(await f.store.readText("knowledge/final.md"), "published");
  const events = (await f.store.readText("workflow/runs/wf/audit.jsonl")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(({ action }) => action === "publication.committed").length, 1);
});

test("FEAT-002 audit idempotency conflicts when the same key carries another payload", async (context) => {
  const f = await fixture(context); const audit = new AuditWriter({ ...f, ids: new IDs("audit") });
  const first = await audit.append("wf", { actor: "process:test", action: "publication.committed", subject: "txn", result: "committed", idempotency_key: "publication:txn" });
  assert.equal((await audit.append("wf", { idempotency_key: "publication:txn", result: "committed", subject: "txn", action: "publication.committed", actor: "process:test" })).event_id, first.event_id);
  await assert.rejects(audit.append("wf", { actor: "process:test", action: "publication.committed", subject: "other", result: "committed", idempotency_key: "publication:txn" }), (error) => error.code === "KDLC_HASH_CONFLICT");
});

test("FEAT-002 expired same-process mutex holders are fenced from later writes", async (context) => {
  const f = await fixture(context); let releaseOld; const wait = new Promise((resolve) => { releaseOld = resolve; });
  const old = f.store.withMutex("workflow/fenced", { owner: "old", clock: f.clock, leaseMs: 20, timeoutMs: 100 }, async () => {
    await wait; await f.store.writeTextAtomic("state/value", "stale");
  });
  await new Promise((resolve) => setTimeout(resolve, 5)); f.clock.advance(21);
  await f.store.withMutex("workflow/fenced", { owner: "successor", clock: f.clock, leaseMs: 20, timeoutMs: 100 }, () => f.store.writeTextAtomic("state/value", "successor"));
  releaseOld(); await assert.rejects(old, /lease was lost/);
  assert.equal(await f.store.readText("state/value"), "successor");
});

test("FEAT-002 nested mutexes preserve enclosing fences after outer takeover", async (context) => {
  const f = await fixture(context);
  let innerEntered; const entered = new Promise((resolve) => { innerEntered = resolve; });
  let resumeInner; const gate = new Promise((resolve) => { resumeInner = resolve; });
  const old = f.store.withMutex("workflow/outer", { owner: "old-outer", clock: f.clock, leaseMs: 20, timeoutMs: 100 }, () =>
    f.store.withMutex("workflow/inner", { owner: "old-inner", clock: f.clock, leaseMs: 100, timeoutMs: 100 }, async () => {
      innerEntered(); await gate; await f.store.writeTextAtomic("state/nested", "stale");
    }));
  await entered; f.clock.advance(21);
  await f.store.withMutex("workflow/outer", { owner: "successor", clock: f.clock, leaseMs: 20, timeoutMs: 100 }, () =>
    f.store.writeTextAtomic("state/nested", "successor"));
  resumeInner();
  await assert.rejects(old, (error) => error.code === "KDLC_HASH_CONFLICT" && /lease was lost/.test(error.message));
  assert.equal(await f.store.readText("state/nested"), "successor");
});

test("FEAT-002 delayed old-owner cleanup cannot remove or release a successor lease", async (context) => {
  const f = await fixture(context);
  const originalMark = f.store.markMutexReleased.bind(f.store);
  let cleanupReached; const atCleanup = new Promise((resolve) => { cleanupReached = resolve; });
  let resumeCleanup; const cleanupGate = new Promise((resolve) => { resumeCleanup = resolve; });
  f.store.markMutexReleased = async (path, token, owner) => {
    if (owner === "old") { cleanupReached(); await cleanupGate; }
    return originalMark(path, token, owner);
  };

  const old = f.store.withMutex("workflow/cleanup-race", { owner: "old", clock: f.clock, leaseMs: 20, timeoutMs: 100 }, async () => "old-result");
  await atCleanup; f.clock.advance(21);
  let successorEntered; const entered = new Promise((resolve) => { successorEntered = resolve; });
  let releaseSuccessor; const successorGate = new Promise((resolve) => { releaseSuccessor = resolve; });
  const successor = f.store.withMutex("workflow/cleanup-race", { owner: "successor", clock: f.clock, leaseMs: 20, timeoutMs: 100 }, async () => {
    successorEntered(); await successorGate; return "successor-result";
  });
  await entered;
  resumeCleanup(); assert.equal(await old, "old-result");
  await assert.rejects(
    f.store.withMutex("workflow/cleanup-race", { owner: "third", clock: f.clock, leaseMs: 20, timeoutMs: 20 }, async () => "incorrect"),
    (error) => error.code === "KDLC_HASH_CONFLICT" && /timed out/.test(error.message)
  );
  releaseSuccessor(); assert.equal(await successor, "successor-result");
  assert.equal(await f.store.withMutex("workflow/cleanup-race", { owner: "third", clock: f.clock, leaseMs: 20, timeoutMs: 100 }, async () => "third-result"), "third-result");
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
