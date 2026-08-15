import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  byteHash,
  canonicalJson,
  materializeScaffold,
  parseMarkdownConcept,
  scaffoldProject,
} from "../core/index.mjs";
import {
  createContractValidator,
  parseYamlArtifact,
} from "../contracts/index.mjs";
import { FederationResolver } from "../federation/index.mjs";
import { NodeFileStore } from "../lifecycle/src/index.mjs";
import { FederatedRetriever } from "../retrieval/index.mjs";

export const CLI_COMMANDS = Object.freeze([
  "init",
  "adopt",
  "ingest",
  "query",
  "review",
  "publish",
  "status",
  "lint",
  "refresh",
  "trace",
  "conflicts",
  "gaps",
  "migrate",
  "doctor",
  "reconcile-edits",
  "jobs",
]);
export const EXIT = Object.freeze({
  success: 0,
  input: 2,
  policy: 3,
  conflict: 4,
  dependency: 5,
  transient: 6,
  internal: 7,
});
const longOperations = new Set(["adopt", "ingest", "refresh"]);
const operationScopes = Object.freeze({
  init: "mutate",
  project_init: "mutate",
  adopt: "mutate",
  ingest: "mutate",
  refresh: "mutate",
  ingest_start: "mutate",
  job_cancel: "mutate",
  reconcile_edits: "mutate",
  "reconcile-edits": "mutate",
  migrate: "mutate",
  review: "review",
  proposal_create: "mutate",
  review_submit: "review",
  review_packet: "review",
  publish: "publish",
  publish_request: "publish",
  query: "read",
  status: "read",
  lint: "read",
  trace: "read",
  conflicts: "read",
  gaps: "read",
  doctor: "read",
  jobs: "read",
  project_get: "read",
  project_list_mounts: "read",
  kb_search: "read",
  kb_fetch: "read",
  kb_trace: "read",
  kb_conflicts: "read",
  kb_gaps: "read",
  source_excerpt: "read",
  job_status: "read",
});
const digest = (value) =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const portable = (value) =>
  typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);

export class EngineError extends Error {
  constructor(code, message, exitClass, details = {}) {
    super(message);
    Object.assign(this, { code, exitClass, details });
  }
}
const inputError = (message, details) =>
  new EngineError("KDLC_INPUT_INVALID", message, EXIT.input, details);
const missing = (message, details) =>
  new EngineError("KDLC_DEPENDENCY_MISSING", message, EXIT.dependency, details);

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${canonicalJson(value)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, path);
}
async function createJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${canonicalJson(value)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

export class KdlcEngine {
  constructor({
    root = process.cwd(),
    principal = {
      actor: "process:local",
      scopes: ["read", "mutate"],
    },
    clock = { now: () => new Date().toISOString() },
    handlers = {},
    remoteSources = { objectIds: [], uris: [] },
  } = {}) {
    this.root = resolve(root);
    this.principal = structuredClone(principal);
    this.clock = clock;
    this.handlers = { ...handlers };
    this.remoteSources = {
      objectIds: new Set(remoteSources.objectIds ?? []),
      uris: new Set(remoteSources.uris ?? []),
    };
    this.inFlight = new Map();
    this.resumed = false;
    this.closed = false;
    this.store = new NodeFileStore(this.root);
    this.coordinationClock = {
      now: () => this.clock.now(),
      millis: () => Date.parse(this.clock.now()),
    };
  }
  path(...parts) {
    return resolve(this.root, ".kdlc", ...parts);
  }
  async project() {
    const path = this.path("project.json");
    if (!(await exists(path))) throw missing("Project is not initialized");
    return JSON.parse(await readFile(path, "utf8"));
  }
  correlation(operation, input) {
    return `cor_${digest({ operation, input }).slice(7, 23)}`;
  }
  async envelope(operation, input = {}) {
    const correlation_id = this.correlation(operation, input);
    try {
      return {
        api_version: "kdlc.dev/engine-envelope/v1",
        ok: true,
        operation,
        correlation_id,
        result: await this.execute(operation, input),
        warnings: [],
        error: null,
      };
    } catch (error) {
      const known =
        error instanceof EngineError
          ? error
          : new EngineError(
              "KDLC_INTERNAL",
              "Internal operation failure",
              EXIT.internal,
            );
      return {
        api_version: "kdlc.dev/engine-envelope/v1",
        ok: false,
        operation,
        correlation_id,
        result: null,
        warnings: [],
        error: {
          code: known.code,
          message: known.message,
          class: known.exitClass,
          details: known.details,
        },
      };
    }
  }
  async execute(operation, input = {}) {
    await this.resumeJobs();
    if (
      !CLI_COMMANDS.includes(operation) &&
      ![
        "project_init",
        "project_get",
        "project_list_mounts",
        "kb_search",
        "kb_fetch",
        "kb_trace",
        "kb_conflicts",
        "kb_gaps",
        "source_excerpt",
        "job_status",
        "job_cancel",
        "ingest_start",
        "proposal_create",
        "review_submit",
        "publish_request",
        "review_packet",
      ].includes(operation)
    )
      throw inputError(`Unknown operation: ${operation}`);
    const requiredScope = operationScopes[operation];
    if (requiredScope && !this.principal.scopes.includes(requiredScope))
      throw new EngineError(
        "KDLC_POLICY_DENIED",
        "Principal lacks the required operation scope",
        EXIT.policy,
      );
    if (
      this.principal.principal_mode === "served" &&
      ["ingest", "adopt", "ingest_start"].includes(operation)
    )
      this.validateRemoteSources(input.sources);
    if (operation === "init" || operation === "project_init")
      return this.init(input);
    if (longOperations.has(operation)) return this.startJob(operation, input);
    if (operation === "ingest_start") return this.startJob("ingest", input);
    if (this.handlers[operation])
      return this.handlers[operation](structuredClone(input), {
        engine: this,
        principal: structuredClone(this.principal),
      });
    if (operation === "job_status") return this.job(input.id);
    if (operation === "job_cancel") return this.cancelJob(input.id);
    if (operation === "jobs") return this.jobs();
    if (operation === "doctor") return this.doctor();
    const project = await this.project();
    if (operation === "status" || operation === "project_get")
      return { project, state: "ready" };
    if (operation === "project_list_mounts")
      return { project_id: project.id, mounts: project.mounts };
    if (
      [
        "query",
        "kb_search",
        "trace",
        "kb_trace",
        "conflicts",
        "kb_conflicts",
        "gaps",
        "kb_gaps",
        "lint",
        "review",
        "reconcile-edits",
        "migrate",
      ].includes(operation)
    )
      throw missing(
        `Operation ${operation} requires an installed authoritative handler`,
      );
    if (
      [
        "publish",
        "publish_request",
        "review_submit",
        "proposal_create",
      ].includes(operation)
    )
      throw new EngineError(
        "KDLC_POLICY_DENIED",
        "Governed mutation requires an installed workflow handler and valid authority",
        EXIT.policy,
      );
    if (["kb_fetch", "source_excerpt"].includes(operation))
      throw missing("Requested resource is unavailable");
    throw inputError(`Unsupported operation: ${operation}`);
  }
  validateRemoteSources(sources) {
    if (
      !Array.isArray(sources) ||
      sources.length === 0 ||
      sources.some(
        (source) =>
          typeof source !== "string" ||
          (!this.remoteSources.objectIds.has(source) &&
            !this.remoteSources.uris.has(source)),
      )
    )
      throw new EngineError(
        "KDLC_POLICY_DENIED",
        "Served ingestion accepts only registered upload objects or allowlisted source URIs",
        EXIT.policy,
      );
  }
  async init(input) {
    const id =
      input.project_id ??
      basename(this.root)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-");
    if (!portable(id)) throw inputError("Project ID must be portable");
    const path = this.path("project.json");
    if (await exists(path))
      throw new EngineError(
        "KDLC_STATE_CONFLICT",
        "Project is already initialized",
        EXIT.conflict,
      );
    const name = id.replace(/[._]+/g, "-");
    const knowledgeBaseId = id.includes(".") ? id : `local.${id}`;
    const files = await materializeScaffold(
      this.root,
      scaffoldProject({ name, title: input.title ?? id, knowledgeBaseId }),
    );
    const project = {
      api_version: "kdlc.dev/project-runtime/v1",
      id,
      specification_version: "0.2.0",
      canonicalization: "kdlc-c14n-1",
      mounts: [
        {
          alias: "primary",
          id: knowledgeBaseId,
          mode: "maintain",
          role: "primary",
        },
      ],
    };
    await atomicJson(path, project);
    await atomicJson(this.path("principal-policy.json"), {
      api_version: "kdlc.dev/local-principal-policy/v1",
      principals: [
        {
          actor: "process:local",
          scopes: ["read", "mutate"],
          clearance: "public",
          compartments: [],
        },
      ],
      minimum_trust: "unverified",
      stale_behavior: "warn",
    });
    return { ...project, files };
  }
  async startJob(operation, input) {
    const project = await this.project();
    const idempotency = input.idempotency_key;
    if (
      typeof idempotency !== "string" ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(idempotency)
    )
      throw inputError("Long operations require a portable idempotency_key");
    const inputHash = digest(input);
    const id = `job_${digest({ actor: this.principal.actor, project: project.id, operation, idempotency }).slice(7, 23)}`;
    const path = this.path("jobs", `${id}.json`);
    const now = this.clock.now();
    const job = {
      api_version: "kdlc.dev/job/v1",
      id,
      project_id: project.id,
      workflow_id: input.workflow_id ?? null,
      principal: this.principal.actor,
      operation,
      idempotency_key: idempotency,
      input_hashes: { request: inputHash },
      dependencies: {},
      state: "queued",
      progress: { completed: 0, total: 0 },
      checkpoints: [],
      resource_budget: {},
      created_at: now,
      updated_at: now,
      result: null,
      error: null,
      cancellation_requested: false,
      request: structuredClone(input),
      revision: 0,
      attempts: [],
    };
    try {
      await createJson(path, job);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const current = JSON.parse(await readFile(path, "utf8"));
      if (current.input_hashes?.request !== inputHash)
        throw new EngineError(
          "KDLC_STATE_CONFLICT",
          "Idempotency key was reused with changed input",
          EXIT.conflict,
        );
      return current;
    }
    this.scheduleJob(job, input);
    return job;
  }
  scheduleJob(job, input) {
    if (
      this.closed ||
      typeof this.handlers[job.operation] !== "function" ||
      this.inFlight.has(job.id)
    )
      return;
    const running = this.runClaimedJob(job, input).finally(() =>
      this.inFlight.delete(job.id),
    );
    this.inFlight.set(job.id, running);
  }
  async runClaimedJob(job, input) {
    const leaseId = `attempt-${job.id}-${randomUUID()}`;
    return this.store.withMutex(
      `.kdlc/job-leases/${job.id}`,
      {
        owner: `${job.principal}:${leaseId}`,
        clock: this.coordinationClock,
        leaseMs: 1_000,
      },
      () => this.runJob(job, input, leaseId),
    );
  }
  mutateJob(id, action) {
    return this.store.withMutex(
      `.kdlc/job-state/${id}`,
      {
        owner: `job-state:${id}:${randomUUID()}`,
        clock: this.coordinationClock,
      },
      action,
    );
  }
  async resumeJobs() {
    if (this.resumed || this.closed) return;
    this.resumed = true;
    const directory = this.path("jobs");
    if (!(await exists(directory))) return;
    for (const name of (await readdir(directory))
      .filter((item) => /^job_[a-f0-9]{16}\.json$/.test(item))
      .sort()) {
      const job = JSON.parse(await readFile(resolve(directory, name), "utf8"));
      if (
        ["queued", "running"].includes(job.state) &&
        job.principal === this.principal.actor &&
        typeof this.handlers[job.operation] === "function"
      ) {
        this.scheduleJob({ ...job, state: "queued" }, job.request);
      }
    }
  }
  async drain() {
    await Promise.allSettled([...this.inFlight.values()]);
  }
  async close() {
    this.closed = true;
    await this.drain();
  }
  async runJob(job, input, leaseId) {
    const path = this.path("jobs", `${job.id}.json`);
    const attempt = {
      lease_id: leaseId,
      process_id: process.pid,
      started_at: this.clock.now(),
      state: "running",
      result_hash: null,
    };
    let claimed = false;
    let current = await this.mutateJob(job.id, async () => {
      const value = await this.job(job.id);
      if (["completed", "failed", "cancelled", "parked"].includes(value.state))
        return value;
      if (!["queued", "running"].includes(value.state)) return value;
      if (value.cancellation_requested) return value;
      const updated = {
        ...value,
        state: "running",
        revision: (value.revision ?? 0) + 1,
        attempts: [...(value.attempts ?? []), attempt],
        updated_at: this.clock.now(),
      };
      await atomicJson(path, updated);
      claimed = true;
      return updated;
    });
    if (!claimed || current.cancellation_requested) return current;
    try {
      const result = await this.handlers[job.operation](
        structuredClone(input),
        {
          engine: this,
          principal: structuredClone(this.principal),
          durableIdempotencyKey: job.idempotency_key,
          lifecycleContract: "JobRegistry",
          cancellationPoint: async () =>
            (await this.job(job.id)).cancellation_requested,
        },
      );
      current = await this.mutateJob(job.id, async () => {
        const value = await this.job(job.id);
        const cancelled = value.cancellation_requested;
        const updated = {
          ...value,
          revision: (value.revision ?? 0) + 1,
          attempts: value.attempts.map((entry) =>
            entry.lease_id === leaseId
              ? {
                  ...entry,
                  state: cancelled ? "cancelled" : "completed",
                  finished_at: this.clock.now(),
                  result_hash: cancelled ? null : digest(result),
                }
              : entry,
          ),
          state: cancelled ? "cancelled" : "completed",
          progress: { completed: 1, total: 1 },
          result: cancelled ? null : structuredClone(result),
          updated_at: this.clock.now(),
        };
        await atomicJson(path, updated);
        return updated;
      });
    } catch (error) {
      current = await this.mutateJob(job.id, async () => {
        const value = await this.job(job.id);
        const cancelled =
          value.cancellation_requested || error?.code === "KDLC_CANCELLED";
        const updated = {
          ...value,
          revision: (value.revision ?? 0) + 1,
          attempts: value.attempts.map((entry) =>
            entry.lease_id === leaseId
              ? {
                  ...entry,
                  state: cancelled ? "cancelled" : "failed",
                  finished_at: this.clock.now(),
                }
              : entry,
          ),
          state: cancelled ? "cancelled" : "failed",
          error: cancelled
            ? null
            : {
                code: error.code ?? "KDLC_INTERNAL",
                message: "Job execution failed",
              },
          updated_at: this.clock.now(),
        };
        await atomicJson(path, updated);
        return updated;
      });
    }
    return current;
  }
  async job(id) {
    if (typeof id !== "string" || !/^job_[a-f0-9]{16}$/.test(id))
      throw inputError("Invalid job ID");
    const path = this.path("jobs", `${id}.json`);
    if (!(await exists(path))) throw missing("Job does not exist");
    const job = JSON.parse(await readFile(path, "utf8"));
    if (
      job.principal !== this.principal.actor &&
      !this.principal.scopes.includes("jobs:all")
    )
      throw new EngineError(
        "KDLC_POLICY_DENIED",
        "Job principal mismatch",
        EXIT.policy,
      );
    return job;
  }
  async cancelJob(id) {
    return this.mutateJob(id, async () => {
      const job = await this.job(id);
      if (["completed", "failed", "cancelled"].includes(job.state)) return job;
      const updated = {
        ...job,
        revision: (job.revision ?? 0) + 1,
        state: job.state === "queued" ? "cancelled" : job.state,
        cancellation_requested: true,
        updated_at: this.clock.now(),
      };
      await atomicJson(this.path("jobs", `${id}.json`), updated);
      return updated;
    });
  }
  async jobs() {
    const directory = this.path("jobs");
    if (!(await exists(directory))) return { jobs: [] };
    const records = [];
    for (const name of (await readdir(directory))
      .filter((item) => /^job_[a-f0-9]{16}\.json$/.test(item))
      .sort()) {
      const value = JSON.parse(
        await readFile(resolve(directory, name), "utf8"),
      );
      if (
        value.principal === this.principal.actor ||
        this.principal.scopes.includes("jobs:all")
      )
        records.push(value);
    }
    return { jobs: records };
  }
  async doctor() {
    const projectPresent = await exists(this.path("project.json"));
    const lockPath = resolve(this.root, "knowledge.lock");
    const packageLock = await exists(resolve(this.root, "package-lock.json"));
    const now = this.clock.now();
    const contracts = await createContractValidator();
    const parseDiagnostic = async (id, path, validate) => {
      if (!(await exists(path)))
        return { id, status: "warn", detail: "missing" };
      try {
        const value = JSON.parse(await readFile(path, "utf8"));
        if (!validate)
          return {
            id,
            status: "warn",
            detail: "unavailable: no produced integrity contract",
          };
        if (!validate(value))
          return { id, status: "fail", detail: "contract-invalid JSON" };
        return { id, status: "pass", detail: "contract-valid JSON" };
      } catch {
        return { id, status: "fail", detail: "corrupt JSON" };
      }
    };
    const diagnostics = [
      {
        id: "runtime.node",
        status:
          Number(process.versions.node.split(".")[0]) >= 22 &&
          Number(process.versions.node.split(".")[0]) < 25
            ? "pass"
            : "fail",
        detail: process.versions.node,
      },
      {
        id: "project.manifest",
        status: projectPresent ? "pass" : "fail",
        detail: projectPresent ? "initialized" : "missing",
      },
      {
        id: "dependencies.lock",
        status: packageLock ? "pass" : "warn",
        detail: packageLock ? "package-lock.json" : "missing",
      },
      await parseDiagnostic(
        "mounts.lock",
        lockPath,
        (value) => contracts.validate("knowledgeLock", value).valid,
      ),
      await parseDiagnostic(
        "cache.integrity",
        this.path("cache-integrity.json"),
      ),
      {
        id: "clock",
        status: Number.isFinite(Date.parse(now)) ? "pass" : "fail",
        detail: now,
      },
      await parseDiagnostic("policies.compatibility", this.path("policy.json")),
    ];
    return {
      healthy: diagnostics.every(({ status }) => status !== "fail"),
      diagnostics,
    };
  }
}

export function parseCli(argv) {
  const args = [...argv];
  let output = "text";
  const index = args.indexOf("--output");
  if (index !== -1) {
    output = args[index + 1];
    args.splice(index, 2);
  }
  if (!new Set(["text", "json"]).has(output))
    throw inputError("--output must be text or json");
  const operation = args.shift();
  if (!CLI_COMMANDS.includes(operation))
    throw inputError("A supported command is required");
  const positionals = [];
  let idempotency;
  for (let cursor = 0; cursor < args.length; cursor += 1) {
    if (args[cursor] === "--idempotency-key") idempotency = args[++cursor];
    else positionals.push(args[cursor]);
  }
  const input = { args: positionals };
  if (["adopt", "ingest", "refresh"].includes(operation)) {
    if (["adopt", "ingest"].includes(operation) && positionals.length === 0)
      throw inputError(`${operation} requires at least one source`);
    input.sources = positionals;
    input.idempotency_key =
      idempotency ??
      `cli-${createHash("sha256").update(canonicalJson(positionals)).digest("hex").slice(0, 16)}`;
  }
  if (operation === "query") {
    input.question = positionals.join(" ").trim();
    if (!input.question)
      throw inputError("query requires a non-empty question");
  }
  if (operation === "trace") input.concept = positionals[0];
  return { operation, input, output };
}
export function renderEnvelope(envelope, output = "text") {
  if (output === "json") return `${canonicalJson(envelope)}\n`;
  if (envelope.ok)
    return `${envelope.operation}: ok\n${canonicalJson(envelope.result)}\n`;
  return `${envelope.operation}: ${envelope.error.code}: ${envelope.error.message}\n`;
}

export function createLocalProjectEngine(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const requestedPrincipal = options.principal ?? {
    actor: "process:local",
    scopes: [],
  };
  let policy = null,
    principal = requestedPrincipal;
  const policyPath = resolve(root, ".kdlc/principal-policy.json");
  if (existsSync(policyPath)) {
    const candidate = JSON.parse(readFileSync(policyPath, "utf8"));
    const record =
      candidate?.api_version === "kdlc.dev/local-principal-policy/v1" &&
      Array.isArray(candidate.principals)
        ? candidate.principals.find(
            ({ actor }) => actor === requestedPrincipal.actor,
          )
        : null;
    if (
      record &&
      Array.isArray(record.scopes) &&
      ["public", "internal", "confidential", "restricted"].includes(
        record.clearance,
      ) &&
      Array.isArray(record.compartments) &&
      ["unverified", "machine-confirmed", "human-reviewed"].includes(
        candidate.minimum_trust,
      ) &&
      ["warn", "exclude", "fail"].includes(candidate.stale_behavior)
    ) {
      principal = {
        ...requestedPrincipal,
        scopes: [...record.scopes],
        clearance: record.clearance,
        compartments: [...record.compartments],
      };
      policy = candidate;
    }
  }
  const resolveMounts = async () => {
    const project = parseYamlArtifact(
      await readFile(resolve(root, "knowledge-project.yaml"), "utf8"),
    );
    return new FederationResolver({ projectRoot: root }).resolveProject(
      project,
    );
  };
  const search = async (input) => {
    const { mounts } = await resolveMounts();
    const order = { public: 0, internal: 1, confidential: 2, restricted: 3 };
    const allowed = (access) =>
      access &&
      order[access.classification] <= order[principal.clearance] &&
      (access.compartments ?? []).every((item) =>
        principal.compartments.includes(item),
      );
    const pdp = {
      authorizeMount: async ({ mount }) => allowed(mount.access),
      authorizeConcept: async ({ concept }) => allowed(concept.access),
      authorizeSource: async ({ source }) => allowed(source.access),
    };
    const retriever = new FederatedRetriever({
      mounts,
      policy: pdp,
      minimumDurationMs: 0,
    });
    const authorization = await retriever.prepareAuthorization({ principal });
    return retriever.search({
      authorization,
      principal,
      query: input.query ?? input.question,
      mode: input.mode ?? "wiki-only",
      minimumTrust: policy.minimum_trust,
      staleBehavior: policy.stale_behavior,
      includeSources: true,
    });
  };
  const fetchConcept = async ({ uri }) => {
    const match = /^kb:\/\/([a-z0-9.-]+)\/(.+)$/.exec(uri ?? "");
    if (!match) throw inputError("A canonical kb URI is required");
    const authorization = await search({ query: match[2], mode: "audit" });
    if (
      !authorization.results.some(
        ({ id }) => id === `kb://${match[1]}/${match[2]}`,
      )
    )
      throw missing("Requested concept is unavailable");
    const { mounts } = await resolveMounts();
    const mount = mounts.find(({ id }) => id === match[1]);
    const record = mount?.retrieval_catalog.find(({ id }) => id === match[2]);
    if (!mount || !record) throw missing("Requested concept is unavailable");
    const bytes = await readFile(resolve(mount.root, record.path));
    if (byteHash(bytes) !== record.byte_hash)
      throw new EngineError(
        "KDLC_HASH_CONFLICT",
        "Concept bytes drifted",
        EXIT.conflict,
      );
    const concept = parseMarkdownConcept(bytes);
    return {
      uri,
      knowledge_base_id: mount.id,
      revision: mount.resolved_ref,
      concept: {
        id: record.id,
        frontmatter: concept.frontmatter,
        body: concept.body,
      },
      citations: [
        {
          concept: `kb://${mount.id}@${mount.resolved_ref}/${record.id}`,
          knowledge_base_id: mount.id,
          revision: mount.resolved_ref,
          tree_hash: mount.tree_hash,
        },
      ],
    };
  };
  const handlers = policy
    ? {
        query: search,
        kb_search: search,
        kb_fetch: fetchConcept,
        trace: fetchConcept,
        kb_trace: fetchConcept,
        refresh: async () => {
          const resolved = await resolveMounts();
          return {
            lock: resolved.lock,
            mounts: resolved.mounts.map(({ alias, id, resolved_ref }) => ({
              alias,
              id,
              resolved_ref,
            })),
          };
        },
      }
    : {};
  return new KdlcEngine({
    ...options,
    root,
    principal,
    handlers: { ...handlers, ...(options.handlers ?? {}) },
  });
}
