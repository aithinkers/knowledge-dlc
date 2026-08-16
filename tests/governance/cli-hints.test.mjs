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
