import assert from "node:assert/strict";
import test from "node:test";

import { KdlcEngine, renderEnvelope } from "../../packages/cli/index.mjs";

const ingestEnvelope = {
  api_version: "kdlc.dev/engine-envelope/v1",
  ok: true,
  operation: "ingest",
  result: { api_version: "kdlc.dev/job/v1", id: "job_0123456789abcdef", state: "queued" },
  warnings: [],
  error: null
};
const emptyQuery = {
  api_version: "kdlc.dev/engine-envelope/v1",
  ok: true,
  operation: "query",
  result: { status: "not_found", results: [], citations: [], conflicts: [], warnings: [] },
  warnings: [],
  error: null
};

test("FEAT-027: ingest text/human output explains the background job and the path to answers", () => {
  for (const output of ["text", "human"]) {
    const rendered = renderEnvelope(ingestEnvelope, output);
    assert.match(rendered, /background job \(job_0123456789abcdef\)/, output);
    assert.match(rendered, /kdlc jobs/, output);
    assert.match(rendered, /proposal → review → publish/, output);
    assert.match(rendered, /kdlc setup <claude-code\|codex\|kiro\|kiro-ide\|mcp>/, output);
  }
});

test("FEAT-027: empty query text/human output explains why and points at the harness", () => {
  for (const output of ["text", "human"]) {
    const rendered = renderEnvelope(emptyQuery, output);
    assert.match(rendered, /No published knowledge yet/, output);
    assert.match(rendered, /kdlc setup <tool>/, output);
  }
});

test("FEAT-027: the JSON envelope stays byte-identical — no hints in the machine contract", () => {
  for (const envelope of [ingestEnvelope, emptyQuery]) {
    const json = renderEnvelope(envelope, "json");
    assert.ok(!/background job|No published knowledge|kdlc setup/.test(json));
    assert.deepEqual(JSON.parse(json), envelope);
  }
});

test("FEAT-027: hints appear only where confusion lives — populated queries and other operations stay clean", () => {
  const populated = { ...emptyQuery, result: { status: "ok", results: [{ concept: "x" }], citations: [], conflicts: [], warnings: [] } };
  assert.ok(!renderEnvelope(populated, "text").includes("No published knowledge"));
  const status = { ...ingestEnvelope, operation: "status", result: { project: { id: "p" }, state: "ready" } };
  assert.ok(!renderEnvelope(status, "text").includes("background job"));
  const failed = { ...ingestEnvelope, ok: false, result: null, error: { code: "KDLC_POLICY_DENIED", message: "no", class: 3, details: {} } };
  assert.ok(!renderEnvelope(failed, "text").includes("background job"));
});

test("FEAT-028: claude-code setup prints the two-step marketplace install", async () => {
  const { runSetup } = await import("../../packages/cli/setup.mjs");
  const { instructions } = await runSetup({ tool: "claude-code", project: "." });
  const install = instructions.find((line) => line.includes("claude plugin"));
  assert.match(install, /claude plugin marketplace add .+ && claude plugin install kdlc@kdlc/);
  assert.ok(!install.includes("claude plugin install /"), "no bare-path install instruction remains");
});

test("FEAT-031: governed refusals surface their real code and details through the envelope", async () => {
  const { GovernanceError } = await import("../../packages/governance/index.mjs");
  const engine = new KdlcEngine({ handlers: { status: () => { throw new GovernanceError("KDLC_MODEL_RECORDING_INVALID", "Recorded model output failed schema validation", { errors: [{ instancePath: "/claims/0/id" }] }); } } });
  const envelope = await engine.envelope("status", {});
  assert.equal(envelope.error.code, "KDLC_MODEL_RECORDING_INVALID");
  assert.equal(envelope.error.details.errors[0].instancePath, "/claims/0/id");
  assert.match(renderEnvelope(envelope, "human"), /Specifics: .*instancePath/);
  assert.match(renderEnvelope(envelope, "text"), /KDLC_MODEL_RECORDING_INVALID: Recorded model output failed schema validation\n\{/);
  // Unknown errors stay scrubbed.
  const opaque = new KdlcEngine({ handlers: { status: () => { throw new Error("secret internals: /etc/passwd"); } } });
  const masked = await opaque.envelope("status", {});
  assert.equal(masked.error.code, "KDLC_INTERNAL");
  assert.ok(!JSON.stringify(masked).includes("secret internals"));
});

test("FEAT-031: federation refusals pass through with their real code instead of masking as internal (#138)", async () => {
  const { FederationError } = await import("../../packages/federation/src/errors.mjs");
  const engine = new KdlcEngine({ handlers: { status: () => { throw new FederationError("KDLC_PROJECT_INVALID", "Project manifest is invalid", { contract: [{ message: "must have required property 'priority'" }] }); } } });
  const envelope = await engine.envelope("status", {});
  assert.equal(envelope.error.code, "KDLC_PROJECT_INVALID");
  assert.match(JSON.stringify(envelope.error.details), /priority/, "the actionable detail reaches the user");
});

test("FEAT-039: a mistyped mount URI never echoes an embedded credential through the envelope (review MEDIUM)", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { FederationResolver } = await import("../../packages/federation/src/resolver.mjs");
  const resolver = new FederationResolver({ projectRoot: await mkdtemp(join(tmpdir(), "kdlc-scheme-")) });
  for (const uri of ["git+ftp://user:supersecrettoken@host/repo.git", "https://user:supersecrettoken@host/repo.git"]) {
    await assert.rejects(
      resolver.resolveMount({ name: "oops", uri, ref: "main", mode: "read-only" }),
      (error) => typeof error.code === "string" && error.code.startsWith("KDLC_") && !error.message.includes("supersecrettoken") && !JSON.stringify(error.details ?? {}).includes("supersecrettoken")
    );
  }
});

test("FEAT-031: coded refusals keep the exit-class taxonomy and never break the envelope", async () => {
  const { GovernanceError } = await import("../../packages/governance/index.mjs");
  const make = (code, extra = {}) => new KdlcEngine({ handlers: { status: () => { throw Object.assign(new GovernanceError(code, "m"), extra); } } });
  assert.equal((await make("KDLC_DECISION_CONFLICT").envelope("status", {})).error.class, 4, "conflicts exit 4");
  assert.equal((await make("KDLC_RECEIPT_IMMUTABLE").envelope("status", {})).error.class, 4, "immutability is a conflict");
  assert.equal((await make("KDLC_GOVERNANCE_CONTROLS_REQUIRED").envelope("status", {})).error.class, 5, "missing controls are a dependency");
  assert.equal((await make("KDLC_MODEL_RECORDING_INVALID").envelope("status", {})).error.class, 3, "refusals stay policy");
  // Uncloneable details never break the envelope contract.
  const hostile = await make("KDLC_MODEL_RECORDING_INVALID", { details: { fn: () => {} } }).envelope("status", {});
  assert.equal(hostile.ok, false);
  assert.equal(hostile.error.code, "KDLC_MODEL_RECORDING_INVALID");
  assert.deepEqual(hostile.error.details, {});
});

test("FEAT-035: the bare front door is a pure-filesystem assessment — correct next steps, zero mutation", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtemp, writeFile: writeFsFile, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const bin = resolve("packages/cli/bin.mjs");
  const empty = await mkdtemp(join(tmpdir(), "kdlc-bare-"));
  const emptyOut = execFileSync(process.execPath, [bin], { cwd: empty }).toString();
  assert.match(emptyOut, /No K-DLC project here yet/);
  assert.match(emptyOut, /kdlc init/);
  assert.deepEqual(await readdir(empty), [], "assessment creates nothing");

  // Corrupt project record → doctor, not a fake "ready".
  const broken = await mkdtemp(join(tmpdir(), "kdlc-broken-"));
  const { mkdir: mkdirFs } = await import("node:fs/promises");
  await mkdirFs(join(broken, ".kdlc"), { recursive: true });
  await writeFsFile(join(broken, ".kdlc/project.json"), "{not json");
  assert.match(execFileSync(process.execPath, [bin], { cwd: broken }).toString(), /cannot be read[\s\S]*kdlc doctor/);

  // A queued job on disk is REPORTED, never resumed (review HIGH).
  const queued = await mkdtemp(join(tmpdir(), "kdlc-queued-"));
  await new KdlcEngine({ root: queued }).execute("init", { project_id: "queued.fixture" });
  await mkdirFs(join(queued, ".kdlc/jobs"), { recursive: true });
  const jobRecord = { api_version: "kdlc.dev/job/v1", id: "job_00000000000000aa", operation: "ingest", state: "queued", principal: "human:someone", request: { sources: ["x.md"] }, attempts: [], progress: { completed: 0, total: 0 }, created_at: "2026-08-16T00:00:00Z", updated_at: "2026-08-16T00:00:00Z", revision: 0, checkpoints: [], dependencies: {}, error: null, result: null, idempotency_key: "k", input_hashes: {}, resource_budget: {}, cancellation_requested: false, workflow_id: null };
  await writeFsFile(join(queued, ".kdlc/jobs/job_00000000000000aa.json"), JSON.stringify(jobRecord));
  const queuedOut = execFileSync(process.execPath, [bin], { cwd: queued }).toString();
  assert.match(queuedOut, /1 in flight/);
  assert.match(queuedOut, /kdlc jobs/);
  const after = JSON.parse(await (await import("node:fs/promises")).readFile(join(queued, ".kdlc/jobs/job_00000000000000aa.json"), "utf8"));
  assert.equal(after.state, "queued", "bare kdlc must not resume jobs");

  // resume alias + JSON output.
  const json = JSON.parse(execFileSync(process.execPath, [bin, "resume", "--output", "json"], { cwd: queued }).toString());
  assert.match(json.state, /1 in flight/);
});
