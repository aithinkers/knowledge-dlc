import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  artifactHash,
  canonicalJson,
  materializeScaffold,
  scaffoldProject,
} from "../core/index.mjs";
import {
  createContractValidator,
  parseYamlArtifact,
} from "../contracts/index.mjs";
import { FederationResolver } from "../federation/index.mjs";
import { createCoreSensors, scanLintContext, SensorRunner } from "../lifecycle/src/index.mjs";
import { guardRetriever, RevocationGuard } from "../erasure/index.mjs";
import { createExtensionValidator, previewMigration } from "../extensions/index.mjs";
import { PrincipalAuthority, ReviewContextAuthority, RuntimeTrustAuthority } from "../agents/index.mjs";
import { GovernanceControlAuthority, GovernanceControlEngine } from "../governance/index.mjs";
import { NodeFileStore } from "../lifecycle/src/index.mjs";
import { normalize } from "../normalizers/index.mjs";
import { FederatedRetriever } from "../retrieval/index.mjs";
import { DurableArtifactStore, GovernedAgentWorkflows } from "../workflows/index.mjs";

export const CLI_COMMANDS = Object.freeze([
  "init",
  "adopt",
  "ingest",
  "query",
  "proposal",
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
  proposal: "mutate",
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
export const localOwnerActor = () => {
  const identity = userInfo();
  const stable = `${identity.username}-${identity.uid}`.replace(/[^A-Za-z0-9._-]/g, "-");
  return `human:${stable}`;
};
const localOwnerIdentity = () => {
  const identity = userInfo();
  return { principal_mode: "local", subject: `${identity.username}:${identity.uid}`, os_uid: identity.uid, os_username: identity.username };
};

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
      actor: localOwnerActor(),
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
    if (this.principal.bootstrap_init_only && !["init", "project_init"].includes(operation)) throw new EngineError("KDLC_POLICY_DENIED", "Bootstrap principal is restricted to project initialization", EXIT.policy);
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
    await this.store.ensureDir(".kdlc/governed");
    await atomicJson(resolve(this.root, "knowledge/primary/retrieval-catalog.json"), { version: "kdlc-retrieval-catalog-1", concepts: [] });
    await atomicJson(path, project);
    await atomicJson(this.path("principal-policy.json"), {
      api_version: "kdlc.dev/local-principal-policy/v1",
      principals: [
        {
          id: localOwnerActor(),
          actor: localOwnerActor(),
          principal_mode: "local",
          ...localOwnerIdentity(),
          review_roles: ["trust-reviewer"],
          scopes: ["read", "mutate", "review", "publish"],
          clearance: "public",
          compartments: [],
        },
      ],
      review_contexts: [],
      minimum_trust: "unverified",
      stale_behavior: "warn",
    });
    await atomicJson(this.path("governance-authority.json"), {
      api_version: "kdlc.dev/runtime-authority/v1",
      key_id: `project-${id}`,
      key_base64: randomBytes(32).toString("base64"),
    });
    const projectManifest = parseYamlArtifact(await readFile(resolve(this.root, "knowledge-project.yaml"), "utf8"));
    await new FederationResolver({ projectRoot: this.root }).resolveProject(projectManifest);
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
  if (operation === "trace") {
    if (!positionals[0]) throw inputError("trace requires a concept reference, for example: kdlc trace kb://<knowledge-base-id>/<concept-id>");
    input.uri = positionals[0];
  }
  if (operation === "migrate" && !positionals[0]) {
    throw inputError("migrate requires a JSON argument object, for example: kdlc migrate '{\"target\": ...}'");
  }
  if (operation === "review") {
    [input.proposal_id, input.decision, input.receipt_id] = positionals;
  }
  if (operation === "publish") {
    [input.proposal_id, input.receipt_id] = positionals;
    if (positionals[2]) input.current = JSON.parse(positionals[2]);
  }
  if (["proposal", "reconcile-edits", "migrate"].includes(operation) && positionals[0]) Object.assign(input, JSON.parse(positionals[0]));
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
    actor: localOwnerActor(),
    ...localOwnerIdentity(),
    scopes: [],
  };
  let policy = null,
    principal = { ...requestedPrincipal, scopes: [] };
  const policyPath = resolve(root, ".kdlc/principal-policy.json");
  if (existsSync(policyPath)) {
    const candidate = JSON.parse(readFileSync(policyPath, "utf8"));
    const record =
      candidate?.api_version === "kdlc.dev/local-principal-policy/v1" &&
      Array.isArray(candidate.principals)
        ? candidate.principals.find((record) => {
            const requestedMode = requestedPrincipal.principal_mode ?? (requestedPrincipal.actor === localOwnerActor() ? "local" : null);
            if (record.actor !== requestedPrincipal.actor || record.principal_mode !== requestedMode) return false;
            if (requestedMode === "local") {
              const local = localOwnerIdentity();
              return record.subject === local.subject && record.os_uid === local.os_uid && record.os_username === local.os_username;
            }
            return requestedMode === "served" && record.issuer === requestedPrincipal.issuer && record.subject === requestedPrincipal.subject;
          })
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
        id: record.id ?? record.actor,
        actor: record.actor,
        principal_mode: record.principal_mode,
        subject: record.subject,
        ...(record.issuer ? { issuer: record.issuer } : {}),
        ...(record.principal_mode === "local" ? { os_uid: record.os_uid, os_username: record.os_username } : {}),
        scopes: [...record.scopes],
        clearance: record.clearance,
        compartments: [...record.compartments],
        review_roles: Array.isArray(record.review_roles) ? [...record.review_roles] : [],
      };
      policy = candidate;
    }
  } else if (options.principal === undefined && !existsSync(resolve(root, ".kdlc/project.json"))) {
    principal = { actor: localOwnerActor(), scopes: ["mutate"], bootstrap_init_only: true };
  }
  const resolveMounts = async () => {
    const project = parseYamlArtifact(
      await readFile(resolve(root, "knowledge-project.yaml"), "utf8"),
    );
    return new FederationResolver({ projectRoot: root }).resolveProject(
      project,
    );
  };
  const prepareRetriever = async (query, queryModes) => {
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
    const clock = { now: () => new Date().toISOString() };
    const auditStore = new NodeFileStore(root);
    let auditTail = Promise.resolve();
    const audit = { append: (event) => {
      const write = auditTail.then(() => auditStore.appendExclusive(".kdlc/audit/governance-retrieval.jsonl", `${canonicalJson(event)}\n`));
      auditTail = write.catch(() => {});
      return write;
    } };
    const governancePolicy = {
      api_version: "kdlc.dev/governance-policy/v1alpha1", id: "kdlc-local-retrieval", version: 1,
      minimum_independent_sources: 1, required_erasure_surfaces: [], waiver_authorities: {},
      declassification_authorities: {}, erasure_policy_refs: {}, external_models: {}
    };
    const authority = new GovernanceControlAuthority({ authenticate: async () => null, clock, audit });
    const governanceControls = await GovernanceControlEngine.create({ policy: governancePolicy, clock, audit, authority });
    const baseRetriever = new FederatedRetriever({
      mounts,
      policy: pdp,
      governanceControls,
      minimumDurationMs: 25,
      authorizationTtlMs: 300_000,
    });
    const authorization = await baseRetriever.prepareAuthorization({ principal, query, queryModes });
    const retriever = guardRetriever(
      baseRetriever,
      new RevocationGuard({ store: new NodeFileStore(root) }),
    );
    return { retriever, authorization };
  };
  const authorizedRetriever = async (query, queryModes) => {
    if (!policy) throw missing("Retrieval authorization requires an authenticated principal policy");
    return prepareRetriever(query, queryModes);
  };
  const search = async (input) => {
    const query = input.query ?? input.question;
    const mode = input.mode ?? "wiki-only";
    const { retriever, authorization } = await authorizedRetriever(query, [mode]);
    return retriever.search({
      authorization,
      principal,
      query,
      mode,
      minimumTrust: policy.minimum_trust,
      staleBehavior: policy.stale_behavior,
      includeSources: true,
    });
  };
  const fetchConcept = async ({ uri }) => {
    if (!/^kb:\/\/[^/]+\/.+/.test(uri ?? "")) throw inputError("A canonical kb URI is required");
    const { retriever, authorization } = await authorizedRetriever(uri, ["audit"]);
    const result = await retriever.fetch({ authorization, principal, uri, mode: "audit" });
    if (result.status !== "ok") throw missing("Requested concept is unavailable");
    return result;
  };
  const ingest = async (
    { sources },
    { durableIdempotencyKey, cancellationPoint },
  ) => {
    const canonicalRoot = await realpath(root);
    const normalized = [];
    for (const [index, source] of sources.entries()) {
      if (await cancellationPoint())
        throw Object.assign(new Error("cancelled"), { code: "KDLC_CANCELLED" });
      const candidate = await realpath(resolve(root, source));
      if (
        !(
          candidate === canonicalRoot ||
          candidate.startsWith(`${canonicalRoot}/`)
        )
      )
        throw new EngineError(
          "KDLC_POLICY_DENIED",
          "Source escapes the project root",
          EXIT.policy,
        );
      const bytes = await readFile(candidate);
      const sourceId = `src_${createHash("sha256").update(`${durableIdempotencyKey}:${index}:${source}`).digest("hex").slice(0, 16)}`;
      normalized.push(
        await normalize({
          bytes,
          filename: basename(candidate),
          sourceId,
          normalizedAt: new Date().toISOString(),
        }),
      );
    }
    return { idempotency_key: durableIdempotencyKey, normalized };
  };
  const sourceExcerpt = async ({ source_id: sourceId, locator }) => {
    if (typeof sourceId !== "string" || !portable(sourceId) || !locator || typeof locator !== "object" || Array.isArray(locator)) throw inputError("A portable source_id and locator object are required");
    const jobsPath = resolve(root, ".kdlc/jobs");
    if (!existsSync(jobsPath)) throw missing("Requested source excerpt is unavailable");
    for (const name of (await readdir(jobsPath)).filter((item) => /^job_[a-f0-9]{16}\.json$/.test(item)).sort()) {
      const job = JSON.parse(await readFile(resolve(jobsPath, name), "utf8"));
      if (job.state !== "completed" || job.principal !== principal.actor) continue;
      for (const artifact of job.result?.normalized ?? []) {
        if (artifact.manifest?.source_id !== sourceId) continue;
        const unit = artifact.units?.find((candidate) => canonicalJson(candidate.locator) === canonicalJson(locator));
        if (unit) return { source_id: sourceId, source_hash: unit.source_hash, locator: structuredClone(unit.locator), excerpt: unit.text, extraction_method: structuredClone(unit.extraction_method), job_id: job.id };
      }
    }
    throw missing("Requested source excerpt is unavailable");
  };
  const authorityPath = resolve(root, ".kdlc/governance-authority.json");
  let governed = {};
  if (policy && existsSync(authorityPath) && Array.isArray(policy.review_contexts)) {
    const authorityRecord = JSON.parse(readFileSync(authorityPath, "utf8"));
    const key = Buffer.from(authorityRecord.key_base64 ?? "", "base64");
    if (authorityRecord.api_version === "kdlc.dev/runtime-authority/v1" && key.byteLength >= 32 && portable(authorityRecord.key_id)) {
      const store = new DurableArtifactStore(resolve(root, ".kdlc/governed"));
      const trustAuthority = new RuntimeTrustAuthority({ key, keyId: authorityRecord.key_id });
      const principalAuthority = new PrincipalAuthority(policy.principals.map((record) => ({
        id: record.id ?? record.actor,
        actor: record.actor,
        principal_mode: record.principal_mode ?? "local",
        ...(record.issuer ? { issuer: record.issuer } : {}),
        review_roles: Array.isArray(record.review_roles) ? record.review_roles : [],
      })));
      const indexStore = new NodeFileStore(root);
      const indexPath = (proposalId) => `.kdlc/governed/proposal-index/${proposalId}.json`;
      const proposalIndex = async (proposalId) => {
        if (!portable(proposalId) || !await indexStore.exists(indexPath(proposalId))) throw missing("Requested proposal is unavailable");
        return indexStore.readJson(indexPath(proposalId));
      };
      const contextPath = (workflowId) => `.kdlc/governed/review-contexts/${workflowId}.json`;
      const contextSession = async (workflowId) => {
        const configured = policy.review_contexts.find((record) => record.workflow_id === workflowId);
        const record = configured ?? (await indexStore.exists(contextPath(workflowId)) ? await indexStore.readJson(contextPath(workflowId)) : null);
        if (!record) throw missing("Trusted review context is unavailable");
        return new ReviewContextAuthority([record]).establish(workflowId);
      };
      const harness = async (workflowId, review = false) => GovernedAgentWorkflows.create({
        store,
        trustAuthority,
        reviewContextSession: await contextSession(workflowId),
        ...(review ? { session: principalAuthority.establishReviewSession(principal.id, principal.review_roles[0]) } : {}),
      });
      governed = {
        proposal_create: async ({ proposal }) => {
          const workflowId = proposal?.workflow_id;
          if (!portable(workflowId) || !["ingest", "adopt"].includes(proposal?.task)) throw inputError("proposal requires a portable workflow_id and recorded ingest/adopt task");
          const runtime = await harness(workflowId);
          const output = await runtime.runRecorded({ task: proposal.task, workflowId, recording: proposal.recording, normalizedEvidence: proposal.normalized_evidence });
          const assembled = [];
          for (const item of output.proposals) {
            const packet = await runtime.assembleReview({ workflowId, proposalId: item.id });
            const path = indexPath(item.id);
            const value = { workflow_id: workflowId, proposal_id: item.id, packet_hash: packet.packet_hash };
            await indexStore.withMutex(`${path}.lock`, { owner: `proposal-index:${process.pid}`, clock: { now: () => new Date().toISOString(), millis: () => Date.now() } }, async () => {
              if (await indexStore.exists(path)) {
                if (canonicalJson(await indexStore.readJson(path)) !== canonicalJson(value)) throw new EngineError("KDLC_STATE_CONFLICT", "Proposal index conflicts", EXIT.conflict);
              } else await indexStore.writeJsonAtomic(path, value);
            });
            assembled.push({ proposal: item, packet: packet.packet, packet_hash: packet.packet_hash });
          }
          return { workflow_id: workflowId, proposals: assembled, model: output.model };
        },
        review_packet: async ({ proposal_id: proposalId }) => {
          if (!principal.review_roles.length) throw missing("Requested proposal is unavailable");
          const index = await proposalIndex(proposalId);
          const packet = await store.get(`workflow/runs/${index.workflow_id}/reviews/${proposalId}/packet.json`);
          if (artifactHash(packet) !== index.packet_hash) throw new EngineError("KDLC_HASH_CONFLICT", "Review packet drifted", EXIT.conflict);
          return { proposal_id: proposalId, workflow_id: index.workflow_id, packet_hash: index.packet_hash, packet };
        },
        review_submit: async ({ proposal_id: proposalId, decision, receipt_id: receiptId }) => {
          const index = await proposalIndex(proposalId);
          const runtime = await harness(index.workflow_id, true);
          return runtime.decide({ workflowId: index.workflow_id, proposalId, decision, receiptId });
        },
        publish_request: async ({ proposal_id: proposalId, receipt_id: receiptId, current }) => {
          const index = await proposalIndex(proposalId);
          const runtime = await harness(index.workflow_id, true);
          const receipt = await store.get(`workflow/runs/${index.workflow_id}/receipts/${receiptId}.json`);
          const decision = await store.get(`workflow/runs/${index.workflow_id}/reviews/${proposalId}/decision.json`);
          trustAuthority.activateReview({ workflowId: index.workflow_id, receipt, decision });
          return runtime.preparePublication({ workflowId: index.workflow_id, proposalId, receiptId, current });
        },
        reconcile_edits: async ({ proposal_id: proposalId, reviewed_proposal_id: reviewedProposalId, target, reviewed_concept: reviewedConcept, current_concept: currentConcept, receipt_id: receiptId }) => {
          const index = await proposalIndex(reviewedProposalId);
          const runtime = await harness(index.workflow_id, true);
          const receipt = await store.get(`workflow/runs/${index.workflow_id}/receipts/${receiptId}.json`);
          const decision = await store.get(`workflow/runs/${index.workflow_id}/reviews/${reviewedProposalId}/decision.json`);
          trustAuthority.activateReview({ workflowId: index.workflow_id, receipt, decision });
          return runtime.reconcileEdit({ workflowId: index.workflow_id, proposalId, reviewedProposalId, target, reviewedConcept, currentConcept, receiptId });
        },
      };
    }
  }
  const handlers = policy
    ? {
        query: search,
        kb_search: search,
        kb_fetch: fetchConcept,
        source_excerpt: sourceExcerpt,
        ...governed,
        ...(governed.proposal_create ? { proposal: governed.proposal_create } : {}),
        ...(governed.review_submit ? { review: governed.review_submit } : {}),
        ...(governed.publish_request ? { publish: governed.publish_request } : {}),
        ...(governed.reconcile_edits ? { "reconcile-edits": governed.reconcile_edits, reconcile_edits: governed.reconcile_edits } : {}),
        migrate: async ({ migration, files }) => previewMigration({ migration, files, validator: await createExtensionValidator() }),
        trace: fetchConcept,
        kb_trace: fetchConcept,
        ingest,
        adopt: ingest,
        lint: async () => {
          const contracts = await createContractValidator();
          const project = parseYamlArtifact(
            await readFile(resolve(root, "knowledge-project.yaml"), "utf8"),
          );
          const result = contracts.validate("project", project);
          // FEAT-015: run the §26 core sensors over the primary knowledge base.
          const sensors = createCoreSensors({ profile: null });
          const lintNow = new Date().toISOString();
          const runner = new SensorRunner({ sensors, clock: { now: () => lintNow, millis: () => Date.parse(lintNow) } });
          const context = await scanLintContext({ root, today: lintNow.slice(0, 10) });
          const report = await runner.run(sensors.map(({ id }) => id), { ...context, scope: "lint" });
          const sensorResults = report.results.map(({ sensor_id, version, status, findings }) => ({ sensor_id, version, status, findings: findings ?? [] }));
          const findings = sensorResults.flatMap(({ findings: sensorFindings }) => sensorFindings);
          return {
            valid: result.valid && !findings.some(({ severity }) => severity === "error"),
            issues: result.errors,
            sensors: sensorResults,
            findings,
          };
        },
        kb_conflicts: async () => {
          const result = await search({
            query: "conflict contradiction",
            mode: "audit",
          });
          return { conflicts: result.conflicts, citations: result.citations };
        },
        conflicts: async () => {
          const result = await search({
            query: "conflict contradiction",
            mode: "audit",
          });
          return { conflicts: result.conflicts, citations: result.citations };
        },
        kb_gaps: async () => {
          const result = await search({
            query: "gap missing todo",
            mode: "audit",
          });
          return { gaps: result.results, citations: result.citations };
        },
        gaps: async () => {
          const result = await search({
            query: "gap missing todo",
            mode: "audit",
          });
          return { gaps: result.results, citations: result.citations };
        },
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
  const engine = new KdlcEngine({
    ...options,
    root,
    principal,
    handlers: { ...handlers, ...(options.handlers ?? {}) },
  });
  return engine;
}
