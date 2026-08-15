import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { distributionDefinition } from "../../packages/adapters/index.mjs";
import { CLI_COMMANDS, EXIT, KdlcEngine, parseCli, renderEnvelope } from "../../packages/cli/index.mjs";
import { createStreamableHttpServer, MCP_TOOLS, McpProjectServer, ServedPrincipalMapper, serveStdio } from "../../packages/mcp/index.mjs";

const repository = process.cwd();
const temporary = async (t) => { const root = await mkdtemp(resolve(tmpdir(), "kdlc-distribution-")); t.after(() => rm(root, { recursive: true, force: true })); return root; };
const clock = { now: () => "2026-08-15T00:00:00.000Z" };

test("FEAT-006 CLI commands share stable JSON envelopes and exit classes", async (t) => {
  const root = await temporary(t); const engine = new KdlcEngine({ root, clock });
  const initialized = await engine.envelope("init", { project_id: "fixture.project" }); assert.equal(initialized.ok, true);
  const conflict = await engine.envelope("init", { project_id: "fixture.project" }); assert.equal(conflict.error.class, EXIT.conflict);
  const invalid = await engine.envelope("ingest", {}); assert.equal(invalid.error.class, EXIT.input);
  const denied = await engine.envelope("publish", {}); assert.equal(denied.error.class, EXIT.policy);
  for (const envelope of [initialized, conflict, invalid, denied]) assert.deepEqual(Object.keys(envelope), ["api_version","ok","operation","correlation_id","result","warnings","error"]);
  assert.equal(renderEnvelope(initialized, "json"), renderEnvelope(initialized, "json")); assert.match(renderEnvelope(denied, "text"), /KDLC_POLICY_DENIED/);
  assert.deepEqual(parseCli(["status","--output","json"]), { operation: "status", input: { args: [] }, output: "json" });
  assert.deepEqual(distributionDefinition.cli_commands, CLI_COMMANDS);
});

test("FEAT-006 durable jobs are idempotent, principal-bound, restart-safe, and cancellable", async (t) => {
  const root = await temporary(t); const first = new KdlcEngine({ root, clock, principal: { actor: "human:alice", scopes: ["read","mutate"] } }); await first.execute("init", { project_id: "fixture.project" });
  const job = await first.execute("ingest", { args: ["source.md"], idempotency_key: "run-1" }); assert.equal(job.state, "queued");
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => first.execute("refresh", { idempotency_key: "parallel-1" }))); assert(concurrent.every(({ id }) => id === concurrent[0].id));
  const restarted = new KdlcEngine({ root, clock, principal: { actor: "human:alice", scopes: ["read","mutate"] } }); assert.deepEqual(await restarted.execute("job_status", { id: job.id }), job); assert.deepEqual(await restarted.execute("ingest", { args: ["source.md"], idempotency_key: "run-1" }), job);
  await assert.rejects(() => restarted.execute("ingest", { args: ["changed.md"], idempotency_key: "run-1" }), (error) => error.exitClass === EXIT.conflict);
  assert.equal((await restarted.execute("job_cancel", { id: job.id })).state, "cancelled");
  const other = new KdlcEngine({ root, clock, principal: { actor: "human:bob", scopes: ["read"] } }); await assert.rejects(() => other.execute("job_status", { id: job.id }), (error) => error.exitClass === EXIT.policy);
});

test("FEAT-006 one engine produces equivalent direct, MCP, and generated-adapter outcomes", async (t) => {
  const root = await temporary(t); const base = new KdlcEngine({ root, clock }); await base.execute("init", { project_id: "fixture.project" });
  const handlers = { kb_search: (input, { principal }) => ({ query: input.query, actor: principal.actor, hits: [{ uri: "kb://fixture/base" }] }) };
  const engineFactory = ({ root: selectedRoot, principal }) => new KdlcEngine({ root: selectedRoot, principal, clock, handlers });
  const server = new McpProjectServer({ root, projectId: "fixture.project", engineFactory });
  const direct = await engineFactory({ root, principal: { actor: "process:local", scopes: ["read"] } }).envelope("kb_search", { query: "alpha" });
  const response = await server.request({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kb_search", arguments: { query: "alpha" } } }); assert.deepEqual(response.result.structuredContent.result, direct.result);
  const mcpRoot = await temporary(t); const initializingServer = new McpProjectServer({ root: mcpRoot, projectId: "mcp.project", engineFactory }); const initialized = await initializingServer.request({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "project_init", arguments: { project_id: "mcp.project" } } }); assert.equal(initialized.result.structuredContent.ok, true); assert.equal((await readFile(resolve(mcpRoot, "knowledge-project.yaml"), "utf8")).includes("kind: Project"), true);
  const templates = await server.request({ jsonrpc: "2.0", id: 2, method: "resources/templates/list" }); assert.deepEqual(templates.result.resourceTemplates.map(({ uriTemplate }) => uriTemplate), ["kb://{knowledge_base_id}/{concept_id}","kdlc://jobs/{job_id}","kdlc://reviews/{proposal_id}/packet"]);
  const input = new PassThrough(); const output = new PassThrough(); let stdio = ""; output.setEncoding("utf8"); output.on("data", (chunk) => { stdio += chunk; }); const serving = serveStdio(server, { input, output }); input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "kb_search", arguments: { query: "alpha" } } })}\n`); await serving; assert.deepEqual(JSON.parse(stdio).result.structuredContent.result, direct.result);
  assert.equal(server.serverInfo().tools.includes("repository_analyze"), false); assert.equal(server.serverInfo().capabilities.repository_analysis, false);
  const claude = await readFile(resolve(repository, "distribution/claude-code/COMMANDS.md"), "utf8"); const codex = await readFile(resolve(repository, "distribution/codex/SKILL.md"), "utf8"); for (const command of CLI_COMMANDS) { assert.match(claude, new RegExp(`kdlc:${command.replace("-", "\\-")}`)); assert.match(codex, new RegExp(command)); }
});

test("FEAT-006 served HTTP maps principals and scopes server-side before disclosure", async (t) => {
  const root = await temporary(t); const base = new KdlcEngine({ root, clock }); await base.execute("init", { project_id: "fixture.project" });
  const mapper = new ServedPrincipalMapper([{ token: "read-token", actor: "human:reader", scopes: ["read"], issuer: "https://id.example" }]); const server = new McpProjectServer({ root, projectId: "fixture.project" });
  assert.throws(() => createStreamableHttpServer({ server, principalMapper: mapper, host: "0.0.0.0" }), /requires TLS/);
  const http = createStreamableHttpServer({ server, principalMapper: mapper }); http.listen(0, "127.0.0.1"); await once(http, "listening"); t.after(() => http.close()); const { port } = http.address(); const endpoint = `http://127.0.0.1:${port}/mcp`;
  const unauthorized = await fetch(endpoint, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }); assert.equal(unauthorized.status, 401);
  const authorized = await fetch(endpoint, { method: "POST", headers: { authorization: "Bearer read-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) }); const payload = await authorized.json(); assert(payload.result.tools.every(({ name }) => !["ingest_start","publish_request","review_submit","job_cancel"].includes(name)));
  const denied = await fetch(endpoint, { method: "POST", headers: { authorization: "Bearer read-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "publish_request", arguments: { principal: { actor: "human:admin" } } } }) }); assert.equal((await denied.json()).error.message, "Resource unavailable");
  const spoof = await fetch(endpoint, { method: "POST", headers: { authorization: "Bearer read-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "kb_search", arguments: { query: "alpha", principal: { actor: "human:admin" } } } }) }); assert.equal((await spoof.json()).error.code, -32602);
});

test("FEAT-006 MCP resources, schemas, metadata, doctor, and generated drift are accurate", async (t) => {
  const root = await temporary(t); const engine = new KdlcEngine({ root, clock }); await engine.execute("init", { project_id: "fixture.project" }); const job = await engine.execute("refresh", { idempotency_key: "refresh-1" }); const server = new McpProjectServer({ root, projectId: "fixture.project" });
  assert.equal((await server.resource("kdlc://server/info")).label, "kdlc"); assert.equal((await server.resource(`kdlc://jobs/${job.id}`)).id, job.id); assert.equal((await engine.execute("doctor")).healthy, true);
  const ajv = new Ajv2020({ strict: true, allErrors: true }); addFormats(ajv); for (const name of ["engine-envelope","job"]) { const schema = JSON.parse(await readFile(resolve(repository, `core/schemas/distribution/${name}.schema.json`), "utf8")); const validate = ajv.compile(schema); const value = name === "job" ? job : await engine.envelope("status"); assert.equal(validate(value), true, JSON.stringify(validate.errors)); }
  const conformance = JSON.parse(await readFile(resolve(repository, "distribution/conformance.json"), "utf8")); assert.deepEqual(conformance.tools, MCP_TOOLS.map(({ name }) => name)); assert.equal(conformance.repository_analysis, false);
  const child = spawn(process.execPath, [resolve(repository, "packages/adapters/generate.mjs"), "--check"], { cwd: repository, stdio: ["ignore","pipe","pipe"] }); const [code] = await once(child, "exit"); assert.equal(code, 0);
});
