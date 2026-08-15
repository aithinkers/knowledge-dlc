import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { chmod, lstat, mkdtemp, opendir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { distributionDefinition } from "../../packages/adapters/index.mjs";
import { artifactHash } from "../../packages/core/index.mjs";
import { NodeFileStore } from "../../packages/lifecycle/src/store.mjs";
import {
  CLI_COMMANDS,
  createLocalProjectEngine,
  EXIT,
  KdlcEngine,
  parseCli,
  renderEnvelope,
} from "../../packages/cli/index.mjs";
import {
  createStreamableHttpServer,
  MCP_TOOLS,
  McpProjectServer,
  ServedPrincipalMapper,
  serveStdio,
} from "../../packages/mcp/index.mjs";

const repository = process.cwd();
const temporary = async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "kdlc-distribution-"));
  t.after(async () => {
    const writable = async (path) => {
      let metadata; try { metadata = await lstat(path); } catch { return; }
      if (metadata.isDirectory()) {
        await chmod(path, 0o700);
        let directory; try { directory = await opendir(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
        for await (const entry of directory) await writable(resolve(path, entry.name));
      }
      else if (!metadata.isSymbolicLink()) await chmod(path, 0o600);
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await writable(root);
      try { await rm(root, { recursive: true, force: true }); break; }
      catch (error) { if (error.code !== "ENOTEMPTY" || attempt === 4) throw error; await new Promise((resolveDelay) => setTimeout(resolveDelay, 20)); }
    }
  });
  return root;
};
const clock = { now: () => "2026-08-15T00:00:00.000Z" };

test("FEAT-006 CLI commands share stable JSON envelopes and exit classes", async (t) => {
  const root = await temporary(t);
  const engine = new KdlcEngine({ root, clock });
  const initialized = await engine.envelope("init", {
    project_id: "fixture.project",
  });
  assert.equal(initialized.ok, true);
  const conflict = await engine.envelope("init", {
    project_id: "fixture.project",
  });
  assert.equal(conflict.error.class, EXIT.conflict);
  const invalid = await engine.envelope("ingest", {});
  assert.equal(invalid.error.class, EXIT.input);
  const denied = await engine.envelope("publish", {});
  assert.equal(denied.error.class, EXIT.policy);
  for (const envelope of [initialized, conflict, invalid, denied])
    assert.deepEqual(Object.keys(envelope), [
      "api_version",
      "ok",
      "operation",
      "correlation_id",
      "result",
      "warnings",
      "error",
    ]);
  assert.equal(
    renderEnvelope(initialized, "json"),
    renderEnvelope(initialized, "json"),
  );
  assert.match(renderEnvelope(denied, "text"), /KDLC_POLICY_DENIED/);
  assert.deepEqual(parseCli(["status", "--output", "json"]), {
    operation: "status",
    input: { args: [] },
    output: "json",
  });
  assert.deepEqual(distributionDefinition.cli_commands, CLI_COMMANDS);
});

test("FEAT-006 durable jobs are idempotent, principal-bound, restart-safe, and cancellable", async (t) => {
  const root = await temporary(t);
  const first = new KdlcEngine({
    root,
    clock,
    principal: { actor: "human:alice", scopes: ["read", "mutate"] },
  });
  await first.execute("init", { project_id: "fixture.project" });
  const job = await first.execute("ingest", {
    args: ["source.md"],
    idempotency_key: "run-1",
  });
  assert.equal(job.state, "queued");
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, () =>
      first.execute("refresh", { idempotency_key: "parallel-1" }),
    ),
  );
  assert(concurrent.every(({ id }) => id === concurrent[0].id));
  const restarted = new KdlcEngine({
    root,
    clock,
    principal: { actor: "human:alice", scopes: ["read", "mutate"] },
  });
  assert.deepEqual(await restarted.execute("job_status", { id: job.id }), job);
  assert.deepEqual(
    await restarted.execute("ingest", {
      args: ["source.md"],
      idempotency_key: "run-1",
    }),
    job,
  );
  await assert.rejects(
    () =>
      restarted.execute("ingest", {
        args: ["changed.md"],
        idempotency_key: "run-1",
      }),
    (error) => error.exitClass === EXIT.conflict,
  );
  assert.equal(
    (await restarted.execute("job_cancel", { id: job.id })).state,
    "cancelled",
  );
  const other = new KdlcEngine({
    root,
    clock,
    principal: { actor: "human:bob", scopes: ["read"] },
  });
  await assert.rejects(
    () => other.execute("job_status", { id: job.id }),
    (error) => error.exitClass === EXIT.policy,
  );
});

test("FEAT-006 durable workers resume once and expose deterministic drain", async (t) => {
  const root = await temporary(t);
  const initial = new KdlcEngine({
    root,
    clock,
    principal: { actor: "human:alice", scopes: ["read", "mutate"] },
  });
  await initial.execute("init", { project_id: "fixture.project" });
  const queued = await initial.execute("ingest", {
    sources: ["source.md"],
    idempotency_key: "resume-1",
  });
  await initial.close();
  let calls = 0;
  const resumed = new KdlcEngine({
    root,
    clock,
    principal: { actor: "human:alice", scopes: ["read", "mutate"] },
    handlers: {
      ingest: async () => {
        calls += 1;
        return { accepted: true };
      },
    },
  });
  await resumed.execute("jobs");
  await resumed.drain();
  const completed = await resumed.execute("job_status", { id: queued.id });
  assert.equal(completed.state, "completed");
  assert.equal(calls, 1);
  assert.equal(
    (
      await resumed.execute("ingest", {
        sources: ["source.md"],
        idempotency_key: "resume-1",
      })
    ).state,
    "completed",
  );
  assert.equal(calls, 1);
  await resumed.close();
});

test("FEAT-006 running cancellation wins the completion race", async (t) => {
  const root = await temporary(t);
  let enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const engine = new KdlcEngine({
    root,
    clock,
    handlers: {
      ingest: async (_input, { cancellationPoint }) => {
        enter();
        await blocked;
        await cancellationPoint();
        return { late: true };
      },
    },
  });
  await engine.execute("init", { project_id: "fixture.project" });
  const job = await engine.execute("ingest", {
    sources: ["source.md"],
    idempotency_key: "cancel-race",
  });
  await entered;
  const cancellation = await engine.execute("job_cancel", { id: job.id });
  assert.equal(cancellation.cancellation_requested, true);
  release();
  await engine.drain();
  const final = await engine.execute("job_status", { id: job.id });
  assert.equal(final.state, "cancelled");
  assert.equal(final.result, null);
  await engine.close();
});

test("FEAT-006 two engines claim one queued attempt exactly once", async (t) => {
  const root = await temporary(t);
  const setup = new KdlcEngine({ root, clock });
  await setup.execute("init", { project_id: "fixture.project" });
  const queued = await setup.execute("ingest", {
    sources: ["source.md"],
    idempotency_key: "two-engine",
  });
  await setup.close();
  let calls = 0,
    release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const handler = async () => {
    calls++;
    entered();
    await blocked;
    return { ok: true };
  };
  const first = new KdlcEngine({ root, clock, handlers: { ingest: handler } });
  const second = new KdlcEngine({ root, clock, handlers: { ingest: handler } });
  await Promise.all([first.execute("jobs"), second.execute("jobs")]);
  await started;
  release();
  await Promise.all([first.drain(), second.drain()]);
  const final = await first.execute("job_status", { id: queued.id });
  assert.equal(final.state, "completed");
  assert.equal(calls, 1);
  assert.equal(final.attempts.length, 1);
  await Promise.all([first.close(), second.close()]);
});

test("FEAT-006 cooperative cancellation exception finalizes cancelled", async (t) => {
  const root = await temporary(t);
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const engine = new KdlcEngine({
    root,
    clock,
    handlers: {
      ingest: async () => {
        enter();
        await blocked;
        throw Object.assign(new Error("stop"), { code: "KDLC_CANCELLED" });
      },
    },
  });
  await engine.execute("init", { project_id: "fixture.project" });
  const job = await engine.execute("ingest", {
    sources: ["source.md"],
    idempotency_key: "cancel-throw",
  });
  await entered;
  await engine.execute("job_cancel", { id: job.id });
  release();
  await engine.drain();
  const final = await engine.execute("job_status", { id: job.id });
  assert.equal(final.state, "cancelled");
  assert.equal(final.error, null);
  await engine.close();
});

test("FEAT-006 engine scopes deny direct read-only mutation and review paths", async (t) => {
  const root = await temporary(t);
  const admin = new KdlcEngine({ root, clock });
  await admin.execute("init", { project_id: "fixture.project" });
  const readOnly = new KdlcEngine({
    root,
    clock,
    principal: { actor: "human:reader", scopes: ["read"] },
    handlers: {
      ingest: () => ({}),
      review_submit: () => ({}),
      publish_request: () => ({}),
    },
  });
  for (const [operation, input] of [
    ["ingest", { sources: ["x"], idempotency_key: "x" }],
    ["review_submit", {}],
    ["publish_request", {}],
  ]) {
    const envelope = await readOnly.envelope(operation, input);
    assert.equal(envelope.error.code, "KDLC_POLICY_DENIED");
  }
  await readOnly.close();
  await admin.close();
});

test("FEAT-006 dead worker lease recovers with one externally idempotent effect", async (t) => {
  const root = await temporary(t);
  const setup = new KdlcEngine({ root });
  await setup.execute("init", { project_id: "fixture.project" });
  await setup.close();
  const moduleUrl = pathToFileURL(
    resolve(repository, "packages/cli/index.mjs"),
  ).href;
  const effect = resolve(root, "effect.txt");
  const source = `import {KdlcEngine} from ${JSON.stringify(moduleUrl)};import {writeFile} from 'node:fs/promises';const e=new KdlcEngine({root:${JSON.stringify(root)},handlers:{ingest:async(_i,{durableIdempotencyKey})=>{try{await writeFile(${JSON.stringify(effect)},durableIdempotencyKey,{flag:'wx'})}catch(x){if(x.code!=='EEXIST')throw x}process.stdout.write('effect\\n');await new Promise(()=>{})}}});await e.execute('ingest',{sources:['source.md'],idempotency_key:'crash-key'});await e.drain();`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  await once(child, "exit");
  let replayCalls = 0;
  const recovered = new KdlcEngine({
    root,
    handlers: {
      ingest: async (_i, { durableIdempotencyKey }) => {
        replayCalls++;
        try {
          await import("node:fs/promises").then(({ writeFile }) =>
            writeFile(effect, durableIdempotencyKey, { flag: "wx" }),
          );
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
        return { recovered: true };
      },
    },
  });
  await recovered.execute("jobs");
  await recovered.drain();
  assert.equal(await readFile(effect, "utf8"), "crash-key");
  assert.equal(replayCalls, 1);
  const jobs = (await recovered.execute("jobs")).jobs;
  assert.equal(jobs[0].state, "completed");
  assert.equal(jobs[0].attempts.length, 2);
  await recovered.close();
});

test("FEAT-006 one engine produces equivalent direct, MCP, and generated-adapter outcomes", async (t) => {
  const root = await temporary(t);
  const base = new KdlcEngine({ root, clock });
  await base.execute("init", { project_id: "fixture.project" });
  const handlers = {
    kb_search: (input, { principal }) => ({
      query: input.query,
      actor: principal.actor,
      hits: [{ uri: "kb://fixture/base" }],
    }),
    kb_fetch: ({ uri }) => ({ uri, body: "fixture" }),
  };
  const engineFactory = ({ root: selectedRoot, principal }) =>
    new KdlcEngine({ root: selectedRoot, principal, clock, handlers });
  const server = new McpProjectServer({
    root,
    projectId: "fixture.project",
    engineFactory,
    capabilities: ["kb_search", "kb_fetch"],
  });
  const direct = await engineFactory({
    root,
    principal: { actor: "process:local", scopes: ["read"] },
  }).envelope("kb_search", { query: "alpha" });
  const response = await server.request({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "kb_search", arguments: { query: "alpha" } },
  });
  assert.deepEqual(response.result.structuredContent.result, direct.result);
  const mcpRoot = await temporary(t);
  const initializingServer = new McpProjectServer({
    root: mcpRoot,
    projectId: "mcp.project",
    engineFactory,
  });
  const initialized = await initializingServer.request({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "project_init", arguments: { project_id: "mcp.project" } },
  });
  assert.equal(initialized.result.structuredContent.ok, true);
  assert.equal(
    (
      await readFile(resolve(mcpRoot, "knowledge-project.yaml"), "utf8")
    ).includes("kind: Project"),
    true,
  );
  const templates = await server.request({
    jsonrpc: "2.0",
    id: 2,
    method: "resources/templates/list",
  });
  assert.deepEqual(
    templates.result.resourceTemplates.map(({ uriTemplate }) => uriTemplate),
    ["kdlc://jobs/{job_id}", "kb://{knowledge_base_id}/{concept_id}"],
  );
  const input = new PassThrough();
  const output = new PassThrough();
  let stdio = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    stdio += chunk;
  });
  const serving = serveStdio(server, { input, output });
  input.end(
    `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "kb_search", arguments: { query: "alpha" } } })}\n`,
  );
  await serving;
  assert.deepEqual(
    JSON.parse(stdio).result.structuredContent.result,
    direct.result,
  );
  assert.equal(server.serverInfo().tools.includes("repository_analyze"), false);
  assert.equal(server.serverInfo().capabilities.repository_analysis, false);
  const claude = await readFile(
    resolve(repository, "distribution/claude-code/COMMANDS.md"),
    "utf8",
  );
  const codex = await readFile(
    resolve(repository, "distribution/codex/SKILL.md"),
    "utf8",
  );
  for (const command of CLI_COMMANDS) {
    assert.match(claude, new RegExp(`kdlc:${command.replace("-", "\\-")}`));
    assert.match(codex, new RegExp(command));
  }
});

test("FEAT-006 generated Claude and Codex adapter fixtures execute the governed CLI", async (t) => {
  const root = await temporary(t);
  const engine = new KdlcEngine({ root, clock });
  await engine.execute("init", { project_id: "fixture.project" });
  const fixtures = [
    { path: resolve(repository, "packages/cli/bin.mjs"), structured: false },
    { path: resolve(repository, "distribution/claude-code/run.mjs"), structured: true },
    { path: resolve(repository, "distribution/codex/run.mjs"), structured: true },
  ];
  const userArguments = ["absent; $(touch SHOULD_NOT_EXIST)"];
  const envelopes = [];
  for (const fixture of fixtures) {
    const child = spawn(
      process.execPath,
      [fixture.path, "query", "--output", "json", ...(fixture.structured ? ["--host-args-json", JSON.stringify(userArguments)] : userArguments)],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
    const envelope = JSON.parse(stdout);
    envelopes.push(envelope);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.operation, "query");
    assert.equal(envelope.result.status, "not_found");
  }
  assert.deepEqual(envelopes[0], envelopes[1]);
  assert.deepEqual(envelopes[1], envelopes[2]);
  await assert.rejects(() => readFile(resolve(root, "SHOULD_NOT_EXIST")), (error) => error.code === "ENOENT");
  const policyPath = resolve(root, ".kdlc/principal-policy.json");
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  policy.principals.push({ id: "served-fixture", actor: "human:served-fixture", principal_mode: "served", issuer: "https://id.example", subject: "served-fixture", review_roles: [], scopes: ["read"], clearance: "public", compartments: [] });
  await writeFile(policyPath, `${JSON.stringify(policy)}\n`, { mode: 0o600 });
  const server = new McpProjectServer({ root, projectId: "fixture.project", engineFactory: createLocalProjectEngine });
  const input = new PassThrough(), output = new PassThrough(); let stdio = "";
  output.setEncoding("utf8"); output.on("data", (chunk) => { stdio += chunk; });
  const serving = serveStdio(server, { input, output });
  input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 70, method: "tools/call", params: { name: "kb_search", arguments: { query: userArguments[0] } } })}\n`);
  await serving;
  const stdioEnvelope = JSON.parse(stdio).result.structuredContent;
  assert.deepEqual(stdioEnvelope.result, envelopes[0].result);
  const mapper = new ServedPrincipalMapper([{ token: "fixture-token", actor: "human:served-fixture", issuer: "https://id.example", subject: "served-fixture", scopes: ["read"] }]);
  const http = await createStreamableHttpServer({ server, principalMapper: mapper });
  const endpoint = `http://127.0.0.1:${http.address().port}/mcp`;
  const response = await fetch(endpoint, { method: "POST", headers: { authorization: "Bearer fixture-token", "content-type": "application/json", accept: "application/json", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 71, method: "tools/call", params: { name: "kb_search", arguments: { query: userArguments[0] } } }) });
  const httpEnvelope = (await response.json()).result.structuredContent;
  assert.deepEqual(httpEnvelope.result, envelopes[0].result);
  await new Promise((resolveClose) => http.close(resolveClose));
  await server.close();
});

test("FEAT-006 served HTTP maps principals and scopes server-side before disclosure", async (t) => {
  const root = await temporary(t);
  const base = new KdlcEngine({ root, clock });
  await base.execute("init", { project_id: "fixture.project" });
  const mapper = new ServedPrincipalMapper([
    {
      token: "read-token",
      actor: "human:reader",
      scopes: ["read"],
      issuer: "https://id.example",
    },
  ]);
  const server = new McpProjectServer({
    root,
    projectId: "fixture.project",
    engineFactory: createLocalProjectEngine,
  });
  await assert.rejects(
    () =>
      createStreamableHttpServer({
        server,
        principalMapper: mapper,
        host: "0.0.0.0",
      }),
    /requires injected TLS/,
  );
  const http = await createStreamableHttpServer({
    server,
    principalMapper: mapper,
  });
  t.after(() => http.close());
  const { port } = http.address();
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "mcp-protocol-version": "2025-06-18",
  };
  const method = await fetch(endpoint, {
    method: "GET",
    headers: { accept: "text/event-stream" },
  });
  assert.equal(method.status, 405);
  const initialization = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer read-token",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "fixture", version: "1" },
      },
    }),
  });
  assert.equal(initialization.status, 200);
  const unauthorized = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(unauthorized.status, 401);
  const authorized = await fetch(endpoint, {
    method: "POST",
    headers: { ...headers, authorization: "Bearer read-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  const payload = await authorized.json();
  assert(
    payload.result.tools.every(
      ({ name }) =>
        ![
          "ingest_start",
          "publish_request",
          "review_submit",
          "job_cancel",
        ].includes(name),
    ),
  );
  const denied = await fetch(endpoint, {
    method: "POST",
    headers: { ...headers, authorization: "Bearer read-token" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "publish_request",
        arguments: { principal: { actor: "human:admin" } },
      },
    }),
  });
  assert.equal((await denied.json()).error.message, "Resource unavailable");
});

test("FEAT-006 transports fail closed on malformed, unauthorized, and remote-path requests", async (t) => {
  const root = await temporary(t);
  const base = new KdlcEngine({ root, clock });
  await base.execute("init", { project_id: "fixture.project" });
  const server = new McpProjectServer({ root, projectId: "fixture.project" });
  const input = new PassThrough(),
    output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    text += chunk;
  });
  const serving = serveStdio(server, { input, output });
  input.end(
    "{bad json}\n" +
      JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }) +
      "\n",
  );
  await serving;
  const lines = text.trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].error.code, -32700);
  const denied = await server.request(
    { jsonrpc: "2.0", id: 1, method: "resources/list" },
    { actor: "human:none", scopes: [] },
  );
  assert.equal(denied.error.code, -32004);
  const remote = new KdlcEngine({
    root,
    clock,
    principal: {
      actor: "human:r",
      scopes: ["mutate"],
      principal_mode: "served",
    },
    handlers: { ingest: () => ({ ok: true }) },
    remoteSources: { objectIds: ["upload_safe"] },
  });
  await assert.rejects(
    () =>
      remote.execute("ingest_start", {
        sources: ["../../etc/passwd"],
        idempotency_key: "x",
      }),
    (error) => error.exitClass === EXIT.policy,
  );
  const accepted = await remote.execute("ingest_start", {
    sources: ["upload_safe"],
    idempotency_key: "y",
  });
  assert.equal(accepted.state, "queued");
  await remote.close();
});

test("FEAT-006 CLI and doctor reject empty or corrupt inputs", async (t) => {
  assert.throws(
    () => parseCli(["query"]),
    (error) => error.exitClass === EXIT.input,
  );
  assert.throws(
    () => parseCli(["ingest"]),
    (error) => error.exitClass === EXIT.input,
  );
  const root = await temporary(t);
  const engine = new KdlcEngine({ root, clock });
  await engine.execute("init", { project_id: "fixture.project" });
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(resolve(root, "knowledge.lock"), "not-json"),
  );
  const result = await engine.execute("doctor");
  assert.equal(result.healthy, false);
  assert.equal(
    result.diagnostics.find(({ id }) => id === "mounts.lock").status,
    "fail",
  );
});

test("FEAT-006 MCP derives capabilities from callable handlers and validates initialization", async (t) => {
  const root = await temporary(t);
  const engine = new KdlcEngine({ root, clock });
  await engine.execute("init", { project_id: "fixture.project" });
  const factory = ({ root: selectedRoot, principal }) =>
    new KdlcEngine({
      root: selectedRoot,
      principal,
      clock,
      handlers: { kb_search: ({ query }) => ({ query, results: [] }) },
    });
  const server = new McpProjectServer({
    root,
    projectId: "fixture.project",
    engineFactory: factory,
    capabilities: ["publish_request"],
  });
  assert(server.serverInfo().tools.includes("kb_search"));
  assert(!server.serverInfo().tools.includes("publish_request"));
  const invalid = await server.request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  assert.equal(invalid.error.code, -32602);
  const initialized = await server.request({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fixture", version: "1" },
    },
  });
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
});

test("FEAT-006 MCP resources, schemas, metadata, doctor, and generated drift are accurate", async (t) => {
  const root = await temporary(t);
  const engine = new KdlcEngine({ root, clock });
  await engine.execute("init", { project_id: "fixture.project" });
  const job = await engine.execute("refresh", { idempotency_key: "refresh-1" });
  const server = new McpProjectServer({
    root,
    projectId: "fixture.project",
    engineFactory: createLocalProjectEngine,
  });
  assert.equal((await server.resource("kdlc://server/info")).label, "kdlc");
  assert.equal((await server.resource(`kdlc://jobs/${job.id}`)).id, job.id);
  assert.equal(
    (await engine.execute("doctor")).healthy,
    Number(process.versions.node.split(".")[0]) < 25,
  );
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  for (const name of ["engine-envelope", "job"]) {
    const schema = JSON.parse(
      await readFile(
        resolve(repository, `core/schemas/distribution/${name}.schema.json`),
        "utf8",
      ),
    );
    const validate = ajv.compile(schema);
    const value = name === "job" ? job : await engine.envelope("status");
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
  }
  const conformance = JSON.parse(
    await readFile(
      resolve(repository, "distribution/conformance.json"),
      "utf8",
    ),
  );
  assert.deepEqual(conformance.tools, server.serverInfo().tools);
  assert.equal(conformance.repository_analysis, false);
  const child = spawn(
    process.execPath,
    [resolve(repository, "packages/adapters/generate.mjs"), "--check"],
    { cwd: repository, stdio: ["ignore", "pipe", "pipe"] },
  );
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  await server.close();
});

test("FEAT-006 local CLI bootstrap is init-only and remote principals cannot self-bootstrap", async (t) => {
  const root = await temporary(t);
  const run = async (...args) => {
    const child = spawn(process.execPath, [resolve(repository, "packages/cli/bin.mjs"), ...args, "--output", "json"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    const [code] = await once(child, "exit");
    return { code, envelope: JSON.parse(stdout || stderr) };
  };
  const first = await run("init");
  assert.equal(first.code, 0);
  assert.equal(first.envelope.ok, true);
  const query = await run("query", "absent");
  assert.equal(query.envelope.ok, true);
  assert.equal(query.envelope.result.status, "not_found");
  const second = await run("init");
  assert.equal(second.code, EXIT.conflict);
  const remoteRoot = await temporary(t);
  const remote = createLocalProjectEngine({ root: remoteRoot, principal: { actor: "human:remote", principal_mode: "served", issuer: "https://issuer.invalid", scopes: ["mutate"] } });
  const denied = await remote.envelope("project_init", { project_id: "remote.project" });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "KDLC_POLICY_DENIED");
  const ownerPolicy = JSON.parse(await readFile(resolve(root, ".kdlc/principal-policy.json"), "utf8"));
  const owner = ownerPolicy.principals[0];
  for (const spoof of [
    { actor: owner.actor, principal_mode: "served", issuer: "https://evil.invalid", subject: owner.subject, scopes: owner.scopes },
    { actor: owner.actor, principal_mode: "served", issuer: "https://issuer.invalid", subject: "evil", scopes: owner.scopes },
  ]) {
    const attempted = createLocalProjectEngine({ root, principal: spoof });
    assert.equal((await attempted.envelope("status")).error.code, "KDLC_POLICY_DENIED");
  }
  const defaultRemoteRoot = await temporary(t);
  const defaultServer = new McpProjectServer({ root: defaultRemoteRoot, projectId: "remote.default", principal: { actor: "human:remote", principal_mode: "served", issuer: "https://issuer.invalid", subject: "remote", scopes: ["mutate"] } });
  const remoteInit = await defaultServer.request({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "project_init", arguments: { project_id: "remote.default" } } });
  assert.equal(remoteInit.result.structuredContent.error.code, "KDLC_POLICY_DENIED");
  await defaultServer.close();
});

test("FEAT-006 governed packet, decision, and publication survive engine restart", async (t) => {
  const root = await temporary(t);
  const bootstrap = createLocalProjectEngine({ root });
  assert.equal((await bootstrap.envelope("project_init", { project_id: "governed.project" })).ok, true);
  const recording = JSON.parse(await readFile(resolve(repository, "tests/fixtures/models/ingest-recording.json"), "utf8"));
  const normalized_evidence = JSON.parse(await readFile(resolve(repository, "tests/fixtures/workflows/ingest-normalized.json"), "utf8"));
  const untrustedContext = createLocalProjectEngine({ root });
  await assert.rejects(() => untrustedContext.execute("proposal_create", { proposal: { workflow_id: "wf_ingest", task: "ingest", recording, normalized_evidence } }), (error) => error.code === "KDLC_DEPENDENCY_MISSING");
  await untrustedContext.close();
  const policyPath = resolve(root, ".kdlc/principal-policy.json");
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  policy.review_contexts.push({ workflow_id: "wf_ingest", context: {
    evidence: normalized_evidence.units.map((unit) => ({ source_id: normalized_evidence.source_id, source_hash: normalized_evidence.source_hash, locator: unit.locator, excerpt: unit.text, authority: "trusted:test", access: { classification: "public" }, rights: { use: "internal" }, extraction_quality: "deterministic", warnings: [] })),
    sensors: [{ id: "source-anchor-valid", severity: "error", result: "passed", producer: "kdlc-sensor-runtime/0.2.0", execution_hash: artifactHash("sensor") }],
    impact: { links: [], dependents: [], freshness_change: null, unresolved_conflicts: [] },
    resolved: { profile: { id: "kdlc-base", version: "0.2.0", hash: artifactHash("profile") }, policies: [{ id: "team-policy", version: "1", hash: artifactHash("policy") }], dependencies: {} },
    provenance: { models: [{ id: "fixture-model-1" }], tools: [{ id: "kdlc-harness/0.2.0" }] }, budget: { model_tokens: 0, model_cost_usd: 0 },
  } });
  await writeFile(policyPath, `${JSON.stringify(policy)}\n`, { mode: 0o600 });
  const first = createLocalProjectEngine({ root });
  const created = await first.execute("proposal_create", { proposal: { workflow_id: "wf_ingest", task: "ingest", recording, normalized_evidence } });
  const proposal = created.proposals[0];
  assert.equal((await first.execute("review_packet", { proposal_id: proposal.proposal.id })).packet_hash, proposal.packet_hash);
  await first.execute("review_submit", { proposal_id: proposal.proposal.id, decision: "approved", receipt_id: "rr_restart" });
  await first.close();
  const restarted = createLocalProjectEngine({ root });
  const current = { concept: proposal.proposal.concept.after, target_revision: proposal.proposal.target.revision, source_hashes: [normalized_evidence.source_hash], resolved_dependencies: proposal.packet.resolved.dependencies, profile: proposal.packet.resolved.profile, policies: proposal.packet.resolved.policies };
  const publication = await restarted.execute("publish_request", { proposal_id: proposal.proposal.id, receipt_id: "rr_restart", current });
  assert.equal(publication.intent.receipt_id, "rr_restart");
  await restarted.close();
});

test("FEAT-006 durable coordination fails bounded when its configured root is absent", async (t) => {
  const root = await temporary(t);
  const missingRoot = resolve(root, "absent");
  const store = new NodeFileStore(missingRoot);
  await assert.rejects(() => store.withMutex("lock", { owner: "fixture", clock: { now: () => new Date().toISOString(), millis: () => Date.now() }, timeoutMs: 20 }, async () => {}), (error) => error.code === "KDLC_INPUT_INVALID");
});
