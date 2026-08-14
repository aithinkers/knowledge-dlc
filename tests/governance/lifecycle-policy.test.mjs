import assert from "node:assert/strict";
import test from "node:test";

import { fromNativeError, SensorRunner, StageGraph, WorkflowEngine } from "../../packages/lifecycle/src/index.mjs";

class MemoryStore {
  values = new Map();
  mutexes = new Map();
  async exists(path) { return this.values.has(path); }
  async readJson(path) { return structuredClone(this.values.get(path)); }
  async writeJsonAtomic(path, value) { this.values.set(path, structuredClone(value)); }
  async withMutex(path, _options, action) {
    const prior = this.mutexes.get(path) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queued = prior.then(() => gate);
    this.mutexes.set(path, queued);
    await prior;
    try { return await action(); }
    finally { release(); if (this.mutexes.get(path) === queued) this.mutexes.delete(path); }
  }
}

class Clock {
  value = Date.parse("2026-08-14T15:30:00Z");
  now = () => new Date(this.value++).toISOString();
  millis = () => this.value;
}

class IDs {
  value = 0;
  next(prefix) { this.value += 1; return `${prefix}_${this.value}`; }
}

class Audit {
  events = [];
  async append(workflowId, event) { this.events.push({ workflowId, ...structuredClone(event) }); }
}

function stage(name = "normalize", overrides = {}) {
  return {
    name,
    phase: "acquire",
    version: 1,
    lead_agent: "source-analyst",
    consumes: ["source"],
    produces: ["evidence"],
    permissions: { read: ["sources/**"], write: ["workflow/**"] },
    sensors: [],
    gates: { before: null, after: null },
    retry: { safe: true },
    deterministic: true,
    ...overrides
  };
}

function fixture(definitions = [stage()]) {
  const store = new MemoryStore(); const clock = new Clock(); const ids = new IDs(); const audit = new Audit();
  const graph = new StageGraph(definitions);
  return { store, clock, ids, audit, graph, engine: new WorkflowEngine({ store, clock, ids, audit, graph }) };
}

const baseCompletion = () => ({
  project_id: "project",
  project_hash: "sha256:project",
  dependency_hashes: { "acme.security": "sha256:dependency" },
  policy_hashes: ["sha256:policy"],
  profile_hashes: ["sha256:profile"],
  tool_hashes: { parser: "sha256:tool" },
  settings_hash: "sha256:settings",
  input_hashes: { source: "sha256:input" },
  output_hashes: { evidence: "sha256:output" },
  agent: { id: "kdlc-source-analyst/0.2.0" }
});

function currentInputs(completion = baseCompletion()) {
  return {
    input_hashes: completion.input_hashes,
    project_hash: completion.project_hash,
    dependency_hashes: completion.dependency_hashes,
    policy_hashes: completion.policy_hashes,
    profile_hashes: completion.profile_hashes,
    tool_hashes: completion.tool_hashes,
    settings_hash: completion.settings_hash
  };
}

test("FEAT-002 stage contracts reject unsafe paths and schema-invalid definitions before use", () => {
  for (const name of ["../escape", "a/b", ".hidden", "Uppercase", "a..b", "a_b", ""] ) {
    assert.throws(() => new StageGraph([stage(name)]), /stage name/i);
  }
  assert.throws(() => new StageGraph([stage("valid", { phase: "unknown" })]), /phase/);
  assert.throws(() => new StageGraph([stage("valid", { version: 0 })]), /version/);
  assert.throws(() => new StageGraph([stage("valid", { sensors: ["same", "same"] })]), /duplicates/);
  assert.throws(() => new StageGraph([stage("valid", { permissions: { read: [], write: [], execute: [] } })]), /unsupported field/);
  assert.throws(() => new StageGraph([{ ...stage("valid"), untrusted: true }]), /unsupported field/);
  assert.throws(() => new StageGraph([stage("valid", { depends_on: ["../escape"] })]), /unsafe dependency/);
  assert.throws(() => fixture().graph.get("../escape"), /stage name/i);
});

test("FEAT-002 sensors preserve trusted identity and fail closed for failed and error results", async () => {
  const clock = new Clock(); const audit = new Audit();
  const context = { workflow_id: "wf", actor: "tester", stage: "validate", scope: "kb:a", policy_version: "policy@1" };
  const tampering = new SensorRunner({
    clock,
    audit,
    sensors: [{
      id: "required",
      version: 7,
      blocking: true,
      evaluate: async () => ({
        sensor_id: "attacker",
        version: 999,
        blocking: false,
        blocks: false,
        waiver: { id: "forged" },
        status: "failed",
        finding: "missing"
      })
    }]
  });
  const report = await tampering.run(["required"], context);
  assert.equal(report.allowed, false);
  assert.deepEqual({
    sensor_id: report.results[0].sensor_id,
    version: report.results[0].version,
    blocking: report.results[0].blocking,
    blocks: report.results[0].blocks,
    waiver: report.results[0].waiver
  }, { sensor_id: "required", version: 7, blocking: true, blocks: true, waiver: undefined });

  const errorRunner = new SensorRunner({ clock, audit, sensors: [{ id: "broken", version: 1, blocking: true, evaluate: async () => ({ status: "error" }) }] });
  const errorReport = await errorRunner.run(["broken"], context, [{ id: "w", sensor_id: "broken", scope: "kb:a", authority: "admin", reason: "ignore", expires_at: "2099-01-01T00:00:00Z" }]);
  assert.equal(errorReport.allowed, false);
  assert.equal(errorReport.results[0].blocks, true);
  assert.equal(errorReport.results[0].waiver, undefined);
});

test("FEAT-002 sensor failures are structured and redacted and nondeterminism is denied", async () => {
  const clock = new Clock(); const audit = new Audit();
  const context = { workflow_id: "wf", actor: "tester", stage: "validate", scope: "kb:a", policy_version: "policy@1" };
  const throwing = new SensorRunner({ clock, audit, sensors: [{ id: "throws", version: 1, blocking: true, evaluate: async () => { throw new Error("token=top-secret"); } }] });
  const report = await throwing.run(["throws"], context);
  assert.equal(report.allowed, false);
  assert.equal(report.results[0].status, "error");
  assert.equal(report.results[0].finding.code, "KDLC_SENSOR_FAILED");
  assert.doesNotMatch(JSON.stringify(report), /top-secret/);

  let changing = 0;
  const nondeterministic = new SensorRunner({ clock, audit, sensors: [{ id: "changing", version: 1, blocking: true, evaluate: async () => ({ status: "failed", value: changing++ }) }] });
  await assert.rejects(nondeterministic.run(["changing"], context), (error) => error.code === "KDLC_POLICY_DENIED" && /nondeterministic/.test(error.message));

  const converted = fromNativeError(new Error("password=secret"), { details: { operation: "read" } }).structured("corr-1");
  assert.equal(converted.code, "KDLC_INTERNAL_ERROR");
  assert.deepEqual(converted.details, { operation: "read" });
  assert.doesNotMatch(JSON.stringify(converted), /password|secret/);
});

test("FEAT-002 deterministic checkpoint reuse binds every execution-context hash", async () => {
  const f = fixture(); const completion = baseCompletion();
  const first = await f.engine.completeStage("wf", "normalize", completion);
  const reused = await f.engine.completeStage("wf", "normalize", structuredClone(completion));
  assert.equal(reused.attempt_id, first.attempt_id);

  const changed = structuredClone(completion); changed.tool_hashes.parser = "sha256:different";
  const rerun = await f.engine.completeStage("wf", "normalize", changed);
  assert.notEqual(rerun.attempt_id, first.attempt_id);
  assert.equal(rerun.supersedes_attempt_id, first.attempt_id);
  assert.deepEqual(rerun.attempt_history.map(({ attempt_id }) => attempt_id), [first.attempt_id]);

  const versionTwo = new WorkflowEngine({ ...f, graph: new StageGraph([stage("normalize", { version: 2 })]) });
  const upgraded = await versionTwo.completeStage("wf", "normalize", completion);
  assert.equal(upgraded.stage_version, 2);
  assert.equal(upgraded.attempt_history.length, 2);
});

test("FEAT-002 workflow revision CAS is coordinated across engine instances", async () => {
  const f = fixture(); const other = new WorkflowEngine({ ...f, graph: f.graph });
  const workflow = await f.engine.create({ projectId: "project", workflowId: "wf_cross_instance" });
  const results = await Promise.allSettled([
    f.engine.transition(workflow.workflow_id, "running", workflow.revision),
    other.transition(workflow.workflow_id, "cancelled", workflow.revision)
  ]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = results.find(({ status }) => status === "rejected");
  assert.equal(rejected.reason.code, "KDLC_HASH_CONFLICT");
  assert.equal((await f.engine.get(workflow.workflow_id)).revision, 1);
});

test("FEAT-002 resume invalidates on every context drift and missing current input", async () => {
  const mutations = {
    input_hashes: (value) => { value.source = "sha256:changed"; },
    project_hash: () => "sha256:changed",
    dependency_hashes: (value) => { value["acme.security"] = "sha256:changed"; },
    policy_hashes: (value) => { value[0] = "sha256:changed"; },
    profile_hashes: (value) => { value[0] = "sha256:changed"; },
    tool_hashes: (value) => { value.parser = "sha256:changed"; },
    settings_hash: () => "sha256:changed"
  };
  for (const [field, mutate] of Object.entries(mutations)) {
    const f = fixture(); const completion = baseCompletion(); await f.engine.completeStage("wf", "normalize", completion);
    const current = currentInputs();
    const replacement = mutate(current[field]); if (replacement !== undefined) current[field] = replacement;
    assert.deepEqual((await f.engine.resume("wf", { normalize: current })).invalidated, ["normalize"], field);
  }

  const missingCurrent = fixture(); await missingCurrent.engine.completeStage("wf", "normalize", baseCompletion());
  assert.deepEqual((await missingCurrent.engine.resume("wf", {})).invalidated, ["normalize"]);

  const oldVersion = fixture(); await oldVersion.engine.completeStage("wf", "normalize", baseCompletion());
  const upgraded = new WorkflowEngine({ ...oldVersion, graph: new StageGraph([stage("normalize", { version: 2 })]) });
  assert.deepEqual((await upgraded.resume("wf", { normalize: currentInputs() })).invalidated, ["normalize"]);
});

test("FEAT-002 model retries require unique attempts and retain supersession history", async () => {
  const model = stage("model-stage", { deterministic: false, retry: { safe: false } });
  const f = fixture([model]);
  const completion = { ...baseCompletion(), attempt_id: "attempt_model_1", model: { id: "recorded-model" } };
  const first = await f.engine.completeStage("wf", "model-stage", completion);
  await assert.rejects(f.engine.completeStage("wf", "model-stage", completion), (error) => error.code === "KDLC_HASH_CONFLICT");

  const second = await f.engine.completeStage("wf", "model-stage", { ...completion, attempt_id: "attempt_model_2" });
  assert.equal(second.supersedes_attempt_id, first.attempt_id);
  assert.deepEqual(second.attempt_history.map(({ attempt_id, superseded_by }) => ({ attempt_id, superseded_by })), [
    { attempt_id: "attempt_model_1", superseded_by: "attempt_model_2" }
  ]);

  const third = await f.engine.completeStage("wf", "model-stage", { ...completion, attempt_id: "attempt_model_3" });
  assert.deepEqual(third.attempt_history.map(({ attempt_id }) => attempt_id), ["attempt_model_1", "attempt_model_2"]);
  assert.equal(third.supersedes_attempt_id, "attempt_model_2");
});
