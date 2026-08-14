import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AuditWriter, JobRegistry, LeaseLockManager, LifecycleError, NodeFileStore, SensorRunner,
  StageGraph, TransactionManager, WorkflowEngine, sha256Token
} from "../../packages/lifecycle/src/index.mjs";
import { createContractValidator } from "../../packages/contracts/index.mjs";

class Clock {
  constructor(value = Date.parse("2026-08-14T15:30:00Z")) { this.value = value; }
  now = () => new Date(this.value).toISOString();
  millis = () => this.value;
  advance(ms) { this.value += ms; }
}
class IDs { constructor() { this.value = 0; } next(prefix) { this.value += 1; return `${prefix}_${String(this.value).padStart(4, "0")}`; } }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kdlc-lifecycle-"));
  const store = new NodeFileStore(root); const clock = new Clock(); const ids = new IDs(); const audit = new AuditWriter({ store, clock, ids });
  return { root, store, clock, ids, audit, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const stages = () => new StageGraph([
  { name: "normalize", phase: "acquire", version: 1, lead_agent: "source-analyst", consumes: ["source"], produces: ["evidence"], permissions: { read: [], write: [] }, sensors: [], gates: { before: null, after: null }, retry: { safe: true }, deterministic: true },
  { name: "extract-claims", phase: "understand", version: 1, lead_agent: "source-analyst", consumes: ["evidence"], produces: ["claims"], permissions: { read: [], write: [] }, sensors: [], gates: { before: null, after: "policy-dependent" }, retry: { safe: false }, deterministic: false, depends_on: ["normalize"] },
  { name: "validate", phase: "govern", version: 1, lead_agent: "governance-reviewer", consumes: ["claims"], produces: ["report"], permissions: { read: [], write: [] }, sensors: ["required"], gates: { before: null, after: null }, retry: { safe: true }, deterministic: true, depends_on: ["extract-claims"] }
]);

test("FEAT-002 stage graph rejects cycles and unknown dependencies", () => {
  const definition = (name, depends_on) => ({ name, phase: "define", version: 1, lead_agent: "conductor", consumes: [], produces: [], permissions: { read: [], write: [] }, sensors: [], gates: { before: null, after: null }, retry: { safe: true }, depends_on });
  assert.throws(() => new StageGraph([definition("a", ["b"])]), /Unknown stage dependency/);
  assert.throws(() => new StageGraph([definition("a", ["b"]), definition("b", ["a"])]), /cycle/);
  assert.deepEqual(stages().order, ["normalize", "extract-claims", "validate"]);
});

test("FEAT-002 workflow transitions use optimistic revisions under concurrency", async (context) => {
  const f = await fixture(); context.after(f.cleanup);
  const engine = new WorkflowEngine({ ...f, graph: stages() }); const workflow = await engine.create({ projectId: "project", workflowId: "wf_test" });
  const attempts = await Promise.allSettled([engine.transition("wf_test", "running", workflow.revision), engine.transition("wf_test", "cancelled", workflow.revision)]);
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = attempts.find((item) => item.status === "rejected"); assert.equal(rejected.reason.code, "KDLC_HASH_CONFLICT");
  assert.equal((await engine.get("wf_test")).revision, 1);
});

test("FEAT-002 checkpoints are idempotent and changed inputs invalidate dependent stages", async (context) => {
  const f = await fixture(); context.after(f.cleanup); const engine = new WorkflowEngine({ ...f, graph: stages() }); await engine.create({ projectId: "p", workflowId: "wf" });
  const completion = (input, output) => ({ project_id: "p", project_version: "rev1", input_hashes: { source: input }, output_hashes: { evidence: output }, agent: { id: "kdlc-source-analyst/0.2.0" } });
  const first = await engine.completeStage("wf", "normalize", completion("a", "b"));
  assert.deepEqual(await engine.completeStage("wf", "normalize", completion("a", "b")), first);
  await assert.rejects(engine.completeStage("wf", "normalize", completion("a", "different")), (error) => error.code === "KDLC_HASH_CONFLICT");
  await engine.completeStage("wf", "extract-claims", { ...completion("b", "c"), attempt_id: "attempt_model_1" });
  await engine.completeStage("wf", "validate", completion("c", "d"));
  const resumed = await engine.resume("wf", { normalize: { source: "changed" } });
  assert.deepEqual(resumed.invalidated, ["normalize", "extract-claims", "validate"]);
});

test("FEAT-002 audit events remain append-only and monotonically sequenced despite clock rollback", async (context) => {
  const f = await fixture(); context.after(f.cleanup);
  await Promise.all(Array.from({ length: 12 }, (_, index) => f.audit.append("wf", { actor: "test", action: "event", result: String(index) })));
  f.clock.value -= 60_000; await f.audit.append("wf", { actor: "test", action: "clock.rollback", result: "recorded" });
  const events = (await f.store.readText("workflow/runs/wf/audit.jsonl")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: 13 }, (_, index) => index + 1));
  assert.equal(events.at(-1).action, "clock.rollback");
});

test("FEAT-002 jobs reuse unchanged idempotency keys and cancel cooperatively", async (context) => {
  const f = await fixture(); context.after(f.cleanup); const jobs = new JobRegistry(f);
  const input = { principal: "user:a", projectId: "p", workflowId: "wf", operation: "normalize", idempotencyKey: "same", inputHashes: { source: "h1" } };
  const first = await jobs.create(input); const reused = await jobs.create(input);
  assert.equal(reused.reused, true); assert.equal(reused.job.job_id, first.job.job_id);
  await assert.rejects(jobs.create({ ...input, inputHashes: { source: "h2" } }), (error) => error.code === "KDLC_HASH_CONFLICT");
  await jobs.transition(first.job.job_id, "running"); await jobs.requestCancellation(first.job.job_id, "user:a");
  assert.equal(await jobs.cancellationPoint(first.job.job_id, { output: "checkpoint" }), true);
  const cancelled = await jobs.get(first.job.job_id); assert.equal(cancelled.state, "cancelled"); assert.deepEqual(cancelled.checkpoints, [{ output: "checkpoint" }]);
});

test("FEAT-002 lease locks reject contenders and require audited stale recovery", async (context) => {
  const f = await fixture(); context.after(f.cleanup); const locks = new LeaseLockManager(f);
  await locks.acquire("kb:concept", { owner: "wf:a", process: "100", leaseMs: 1000 });
  await assert.rejects(locks.acquire("kb:concept", { owner: "wf:b", process: "101", leaseMs: 1000 }), (error) => error.code === "KDLC_HASH_CONFLICT");
  await assert.rejects(locks.breakStale("kb:concept", { actor: "admin", reason: "test", workflowId: "wf" }), (error) => error.code === "KDLC_HASH_CONFLICT");
  f.clock.advance(1001); await locks.breakStale("kb:concept", { actor: "admin", reason: "expired process", workflowId: "wf" });
  const event = JSON.parse((await f.store.readText("workflow/runs/wf/audit.jsonl")).trim()); assert.equal(event.action, "lock.broken");
});

test("FEAT-002 sensors fail closed, constrain waivers, and reject nondeterminism", async (context) => {
  const f = await fixture(); context.after(f.cleanup);
  const runner = new SensorRunner({ ...f, sensors: [{ id: "required", version: 1, blocking: true, evaluate: async () => ({ status: "failed", finding: "missing" }) }] });
  const ctx = { workflow_id: "wf", actor: "tester", stage: "validate", scope: "kb:a", policy_version: "policy@1" };
  const denied = await runner.run(["required"], ctx); assert.equal(denied.allowed, false); assert.throws(() => runner.assertAllowed(denied), (error) => error.code === "KDLC_POLICY_DENIED");
  const waived = await runner.run(["required"], ctx, [{ id: "waiver-1", sensor_id: "required", scope: "kb:a", authority: "security", reason: "bounded", expires_at: new Date(f.clock.millis() + 1000).toISOString() }]); assert.equal(waived.allowed, true);
  let changing = 0; const bad = new SensorRunner({ ...f, sensors: [{ id: "bad", version: 1, blocking: true, evaluate: async () => ({ status: "failed", value: changing++ }) }] });
  await assert.rejects(bad.run(["bad"], ctx), /nondeterministic/);
});

test("FEAT-002 transaction preflight prevents stale writes and crash recovery removes partial state", async (context) => {
  const f = await fixture(); context.after(f.cleanup); await f.store.writeTextAtomic("knowledge/a.md", "old-a"); await f.store.writeTextAtomic("knowledge/b.md", "old-b");
  const manager = new TransactionManager({ ...f, token: sha256Token, fault: ({ phase, index }) => { if (phase === "after-write-before-journal" && index === 0) throw new Error("simulated crash"); } });
  await assert.rejects(manager.prepare({ workflowId: "wf", targets: [{ path: "knowledge/a.md", expectedToken: "wrong", content: "new" }] }), (error) => error.code === "KDLC_HASH_CONFLICT");
  const journal = await manager.prepare({ workflowId: "wf", targets: [{ path: "knowledge/a.md", expectedToken: sha256Token("old-a"), content: "new-a" }, { path: "knowledge/b.md", expectedToken: sha256Token("old-b"), content: "new-b" }] });
  await assert.rejects(manager.commit("wf", journal.transaction_id), (error) => error.code === "KDLC_TRANSACTION_FAILED");
  assert.equal(await f.store.readText("knowledge/a.md"), "new-a"); assert.equal(await f.store.readText("knowledge/b.md"), "old-b");
  const recovered = await manager.recover("wf", journal.transaction_id, "rollback"); assert.equal(recovered.state, "rolled_back");
  assert.equal(await f.store.readText("knowledge/a.md"), "old-a"); assert.equal(await f.store.readText("knowledge/b.md"), "old-b");
});

test("FEAT-002 transaction recovery can roll forward a journaled mid-write crash", async (context) => {
  const f = await fixture(); context.after(f.cleanup); await f.store.writeTextAtomic("knowledge/a.md", "old-a"); await f.store.writeTextAtomic("knowledge/b.md", "old-b");
  const crashing = new TransactionManager({ ...f, token: sha256Token, fault: ({ phase, index }) => { if (phase === "after-write-before-journal" && index === 0) throw new Error("power loss"); } });
  const journal = await crashing.prepare({ workflowId: "wf", targets: [{ path: "knowledge/a.md", expectedToken: sha256Token("old-a"), content: "new-a" }, { path: "knowledge/b.md", expectedToken: sha256Token("old-b"), content: "new-b" }] });
  await assert.rejects(crashing.commit("wf", journal.transaction_id));
  const recovery = new TransactionManager({ ...f, token: sha256Token }); const result = await recovery.recover("wf", journal.transaction_id, "rollforward");
  assert.equal(result.state, "committed"); assert.equal(await f.store.readText("knowledge/a.md"), "new-a"); assert.equal(await f.store.readText("knowledge/b.md"), "new-b");
});

test("FEAT-002 storage rejects traversal outside the injected project root", async (context) => {
  const f = await fixture(); context.after(f.cleanup); assert.throws(() => f.store.path("../../escape"), (error) => error instanceof LifecycleError && error.code === "KDLC_INPUT_INVALID");
  const outside = await mkdtemp(join(tmpdir(), "kdlc-lifecycle-outside-"));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret"), "secret");
  await mkdir(join(f.root, "workflow"));
  await symlink(outside, join(f.root, "workflow", "escape"));
  await assert.rejects(f.store.readText("workflow/escape/secret"), (error) => error.code === "KDLC_INPUT_INVALID");
});

test("FEAT-002 lifecycle JSON schemas are valid JSON with stable identifiers", async () => {
  const contracts = await createContractValidator();
  for (const name of ["stage", "workflow", "checkpoint", "job", "transaction", "audit-event", "lease-lock", "sensor-result"]) {
    const schema = JSON.parse(await readFile(new URL(`../../core/schemas/lifecycle/${name}.schema.json`, import.meta.url), "utf8"));
    assert.match(schema.$id, /^https:\/\/kdlc\.dev\/schemas\/lifecycle\//);
  }
  assert.equal(contracts.validate("lifecycleStage", stages().get("normalize")).valid, true);
  assert.equal(contracts.validate("lifecycleStage", { ...stages().get("normalize"), phase: "unknown" }).valid, false);
});
