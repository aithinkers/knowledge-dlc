import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { KdlcEngine } from "../cli/index.mjs";
export const MCP_PROTOCOL = "2025-06-18";
const definitions = {
  project_init: [
    "project_init",
    ["mutate"],
    { project_id: "string", title: "string" },
    ["project_id"],
  ],
  project_get: ["status", ["read"], {}, []],
  project_list_mounts: ["project_list_mounts", ["read"], {}, []],
  kb_search: ["kb_search", ["read"], { query: "string" }, ["query"]],
  kb_fetch: ["kb_fetch", ["read"], { uri: "string" }, ["uri"]],
  kb_trace: ["kb_trace", ["read"], { uri: "string" }, ["uri"]],
  kb_conflicts: ["kb_conflicts", ["read"], {}, []],
  kb_gaps: ["kb_gaps", ["read"], {}, []],
  source_excerpt: [
    "source_excerpt",
    ["read"],
    { source_id: "string", locator: "object" },
    ["source_id", "locator"],
  ],
  job_status: ["job_status", ["read"], { id: "string" }, ["id"]],
  ingest_start: [
    "ingest_start",
    ["mutate"],
    { sources: "array", idempotency_key: "string" },
    ["sources", "idempotency_key"],
  ],
  proposal_create: [
    "proposal_create",
    ["mutate"],
    { proposal: "object" },
    ["proposal"],
  ],
  review_submit: [
    "review_submit",
    ["review"],
    { proposal_id: "string", decision: "string", receipt_id: "string" },
    ["proposal_id", "decision", "receipt_id"],
  ],
  publish_request: [
    "publish_request",
    ["publish"],
    { proposal_id: "string", receipt_id: "string", current: "object" },
    ["proposal_id", "receipt_id", "current"],
  ],
  job_cancel: ["job_cancel", ["mutate"], { id: "string" }, ["id"]],
};
const builtins = new Set([
    "project_init",
    "project_get",
    "project_list_mounts",
    "job_status",
    "job_cancel",
  ]),
  handlerFor = { ingest_start: "ingest" };
export const MCP_TOOLS = Object.freeze(
  Object.entries(definitions).map(
    ([name, [operation, scopes, inputs, required]]) =>
      Object.freeze({
        name,
        operation,
        scopes,
        description: `${name} through the governed K-DLC engine`,
        inputSchema: {
          type: "object",
          properties: Object.fromEntries(
            Object.entries(inputs).map(([key, type]) => [
              key,
              type === "array" ? { type, items: { type: "string" } } : { type },
            ]),
          ),
          required,
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: scopes.includes("read"),
          destructiveHint: name === "job_cancel",
          idempotentHint: scopes.includes("read") || name.endsWith("_start"),
          openWorldHint: false,
        },
      }),
  ),
);
function validInput(tool, input) {
  const types = definitions[tool.name][2],
    required = definitions[tool.name][3];
  return (
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    !Object.keys(input).some((key) => !Object.hasOwn(types, key)) &&
    required.every((key) => Object.hasOwn(input, key)) &&
    Object.entries(input).every(([key, value]) =>
      types[key] === "array"
        ? Array.isArray(value) && value.every((v) => typeof v === "string")
        : types[key] === "object"
          ? value && typeof value === "object" && !Array.isArray(value)
          : typeof value === types[key],
    )
  );
}
export class ServedPrincipalMapper {
  #tokens = new Map();
  constructor(records) {
    if (!Array.isArray(records))
      throw new TypeError("Trusted served principal mappings are required");
    for (const record of records) {
      if (
        !record ||
        typeof record.token !== "string" ||
        typeof record.actor !== "string" ||
        !Array.isArray(record.scopes) ||
        this.#tokens.has(record.token)
      )
        throw new TypeError("Invalid or duplicate served principal mapping");
      this.#tokens.set(record.token, {
        actor: record.actor,
        scopes: [...new Set(record.scopes)].sort(),
        issuer: record.issuer ?? null,
        principal_mode: "served",
      });
    }
  }
  authenticate(headers) {
    const value = headers?.authorization;
    if (typeof value !== "string" || !value.startsWith("Bearer ")) return null;
    const principal = this.#tokens.get(value.slice(7));
    return principal ? structuredClone(principal) : null;
  }
}
export class McpProjectServer {
  constructor({
    root,
    projectId,
    principal = {
      actor: "process:local",
      scopes: ["read", "mutate", "review", "publish"],
    },
    engineFactory = (options) => new KdlcEngine(options),
  } = {}) {
    this.root = root;
    this.projectId = projectId;
    this.principal = structuredClone(principal);
    this.engineFactory = engineFactory;
    this.engines = new Map();
  }
  engine(principal = this.principal) {
    const key = JSON.stringify({
      actor: principal.actor,
      scopes: [...principal.scopes].sort(),
      mode: principal.principal_mode ?? null,
    });
    if (!this.engines.has(key))
      this.engines.set(key, this.engineFactory({ root: this.root, principal }));
    return this.engines.get(key);
  }
  async close() {
    await Promise.all(
      [...this.engines.values()].map((engine) => engine.close?.()),
    );
  }
  available(tool, principal = this.principal) {
    return (
      builtins.has(tool.name) ||
      typeof this.engine(principal).handlers[
        handlerFor[tool.name] ?? tool.operation
      ] === "function"
    );
  }
  listTools(principal = this.principal) {
    return MCP_TOOLS.filter(
      (tool) =>
        this.available(tool, principal) &&
        tool.scopes.every((scope) => principal.scopes.includes(scope)),
    ).map(({ operation: _o, scopes: _s, ...tool }) => tool);
  }
  serverInfo(principal = this.principal) {
    const tools = this.listTools(principal).map(({ name }) => name);
    return {
      label: "kdlc",
      specification_version: "0.2.0",
      canonicalization: "kdlc-c14n-1",
      mcp_protocol: MCP_PROTOCOL,
      transports: ["stdio", "streamable-http"],
      project_id: this.projectId,
      conformance_modules: [
        "Core",
        ...(tools.includes("ingest_start") ? ["Lifecycle"] : []),
        ...(tools.includes("proposal_create") ? ["Governed"] : []),
        ...(tools.includes("kb_search") ? ["Federated"] : []),
        "Served",
      ],
      format_profiles: [],
      capabilities: {
        resources: principal.scopes.includes("read"),
        tools: tools.length > 0,
        prompts: false,
        repository_analysis: false,
      },
      tools,
    };
  }
  async resource(uri, principal = this.principal) {
    if (!principal.scopes.includes("read"))
      throw Object.assign(new Error("Resource unavailable"), { code: -32004 });
    if (uri === "kdlc://server/info") return this.serverInfo(principal);
    if (uri === `kdlc://projects/${this.projectId}`)
      return this.engine(principal).execute("project_get");
    if (uri === `kdlc://projects/${this.projectId}/mounts`)
      return this.engine(principal).execute("project_list_mounts");
    const job = /^kdlc:\/\/jobs\/(job_[a-f0-9]{16})$/.exec(uri);
    if (job)
      return this.engine(principal).execute("job_status", { id: job[1] });
    const review = /^kdlc:\/\/reviews\/([A-Za-z0-9._-]+)\/packet$/.exec(uri);
    if (review) {
      if (
        !principal.scopes.includes("review") ||
        typeof this.engine(principal).handlers.review_packet !== "function"
      )
        throw Object.assign(new Error("Resource unavailable"), {
          code: -32004,
        });
      return this.engine(principal).execute("review_packet", {
        proposal_id: review[1],
      });
    }
    const fetch = MCP_TOOLS.find(({ name }) => name === "kb_fetch");
    if (/^kb:\/\/[a-z0-9.-]+\/.+/.test(uri) && this.available(fetch, principal))
      return this.engine(principal).execute("kb_fetch", { uri });
    throw Object.assign(new Error("Resource unavailable"), { code: -32004 });
  }
  async request(message, principal = this.principal) {
    const notification = message?.id === undefined,
      id = message?.id ?? null;
    try {
      if (
        !message ||
        typeof message !== "object" ||
        Array.isArray(message) ||
        message.jsonrpc !== "2.0" ||
        typeof message.method !== "string"
      )
        throw Object.assign(new Error("Invalid JSON-RPC request"), {
          code: -32600,
        });
      let result;
      if (message.method === "initialize") {
        const params = message.params;
        if (
          !params ||
          typeof params !== "object" ||
          Array.isArray(params) ||
          params.protocolVersion !== MCP_PROTOCOL ||
          !params.capabilities ||
          typeof params.capabilities !== "object" ||
          Array.isArray(params.capabilities) ||
          typeof params.clientInfo?.name !== "string" ||
          typeof params.clientInfo?.version !== "string"
        )
          throw Object.assign(
            new Error("Initialize params failed schema validation"),
            { code: -32602 },
          );
        result = {
          protocolVersion: MCP_PROTOCOL,
          capabilities: { resources: {}, tools: {} },
          serverInfo: { name: "kdlc", version: "0.2.0" },
        };
      } else if (message.method === "tools/list")
        result = { tools: this.listTools(principal) };
      else if (message.method === "tools/call") {
        const tool = MCP_TOOLS.find(
          ({ name }) => name === message.params?.name,
        );
        if (
          !tool ||
          !this.available(tool, principal) ||
          !tool.scopes.every((scope) => principal.scopes.includes(scope))
        )
          throw Object.assign(new Error("Tool unavailable"), { code: -32004 });
        const input = message.params.arguments ?? {};
        if (!validInput(tool, input))
          throw Object.assign(
            new Error("Tool input failed schema validation"),
            { code: -32602 },
          );
        const envelope = await this.engine(principal).envelope(
          tool.operation,
          input,
        );
        result = {
          content: [{ type: "text", text: JSON.stringify(envelope) }],
          structuredContent: envelope,
          isError: !envelope.ok,
        };
      } else if (message.method === "resources/read") {
        const value = await this.resource(message.params?.uri, principal);
        result = {
          contents: [
            {
              uri: message.params.uri,
              mimeType: "application/json",
              text: JSON.stringify(value),
            },
          ],
        };
      } else if (message.method === "resources/list") {
        if (!principal.scopes.includes("read"))
          throw Object.assign(new Error("Resource unavailable"), {
            code: -32004,
          });
        result = {
          resources: [
            {
              uri: "kdlc://server/info",
              name: "Server information",
              mimeType: "application/json",
            },
            {
              uri: `kdlc://projects/${this.projectId}`,
              name: "Project",
              mimeType: "application/json",
            },
            {
              uri: `kdlc://projects/${this.projectId}/mounts`,
              name: "Mounts",
              mimeType: "application/json",
            },
          ],
        };
      } else if (message.method === "resources/templates/list") {
        if (!principal.scopes.includes("read"))
          throw Object.assign(new Error("Resource unavailable"), {
            code: -32004,
          });
        result = {
          resourceTemplates: [
            {
              uriTemplate: "kdlc://jobs/{job_id}",
              name: "Durable job",
              mimeType: "application/json",
            },
            ...(this.available(
              MCP_TOOLS.find(({ name }) => name === "kb_fetch"),
              principal,
            )
              ? [
                  {
                    uriTemplate: "kb://{knowledge_base_id}/{concept_id}",
                    name: "Knowledge concept",
                    mimeType: "application/json",
                  },
                ]
              : []),
            ...(principal.scopes.includes("review") &&
            typeof this.engine(principal).handlers.review_packet === "function"
              ? [
                  {
                    uriTemplate: "kdlc://reviews/{proposal_id}/packet",
                    name: "Governed review packet",
                    mimeType: "application/json",
                  },
                ]
              : []),
          ],
        };
      } else
        throw Object.assign(new Error("Method not found"), { code: -32601 });
      return notification ? null : { jsonrpc: "2.0", id, result };
    } catch (error) {
      return notification
        ? null
        : {
            jsonrpc: "2.0",
            id,
            error: {
              code: error.code ?? -32603,
              message: [-32004, -32003].includes(error.code)
                ? "Resource unavailable"
                : error.message,
            },
          };
    }
  }
}
export async function serveStdio(
  server,
  {
    input = process.stdin,
    output = process.stdout,
    maxLineBytes = 1_000_000,
  } = {},
) {
  input.setEncoding("utf8");
  let pending = "";
  const processLine = async (line) => {
    let response;
    try {
      if (Buffer.byteLength(line) > maxLineBytes) throw new Error();
      response = await server.request(JSON.parse(line));
    } catch {
      response = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      };
    }
    if (response) output.write(`${JSON.stringify(response)}\n`);
  };
  for await (const chunk of input) {
    pending += chunk;
    if (Buffer.byteLength(pending) > maxLineBytes && !pending.includes("\n")) {
      await processLine(pending);
      pending = "";
      continue;
    }
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim()) await processLine(line);
    }
  }
  if (pending.trim()) await processLine(pending);
}
export async function createStreamableHttpServer({
  server,
  principalMapper,
  host = "127.0.0.1",
  port = 0,
  tls,
  allowedOrigins = [],
} = {}) {
  if (
    !(server instanceof McpProjectServer) ||
    !(principalMapper instanceof ServedPrincipalMapper)
  )
    throw new TypeError(
      "HTTP MCP requires a project server and trusted principal mapper",
    );
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(host);
  if (!loopback && (!tls?.key || !tls?.cert))
    throw new TypeError(
      "Non-loopback Streamable HTTP requires injected TLS credentials",
    );
  const listener = async (request, response) => {
    const reject = (status, error) => {
      if (!response.writableEnded) {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error }));
      }
    };
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.includes(origin))
      return reject(403, "origin-denied");
    if (request.url !== "/mcp") return reject(404, "not-found");
    if (request.method !== "POST") return reject(405, "method-not-allowed");
    if (
      request.headers["content-type"]?.split(";", 1)[0] !== "application/json"
    )
      return reject(415, "content-type");
    if (
      !String(request.headers.accept ?? "")
        .split(",")
        .some((v) => ["application/json", "*/*"].includes(v.trim()))
    )
      return reject(406, "accept");
    const principal = principalMapper.authenticate(request.headers);
    if (!principal) return reject(401, "unauthorized");
    let body = "",
      tooLarge = false;
    request.on("data", (chunk) => {
      if (!tooLarge) {
        body += chunk;
        if (Buffer.byteLength(body) > 1_000_000) {
          tooLarge = true;
          reject(413, "request-too-large");
          request.destroy();
        }
      }
    });
    request.on("end", async () => {
      if (tooLarge) return;
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        return reject(400, "invalid-json");
      }
      if (
        message?.method !== "initialize" &&
        request.headers["mcp-protocol-version"] !== MCP_PROTOCOL
      )
        return reject(400, "protocol-version");
      const result = await server.request(message, principal);
      if (result === null) {
        response.writeHead(202);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    });
  };
  const transport = loopback
    ? createHttpServer(listener)
    : createHttpsServer(tls, listener);
  await new Promise((resolve, reject) => {
    transport.once("error", reject);
    transport.listen(port, host, resolve);
  });
  return transport;
}
