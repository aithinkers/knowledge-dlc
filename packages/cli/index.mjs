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
import { AuditWriter, createCoreSensors, scanLintContext, SensorRunner, TransactionManager, sha256Token } from "../lifecycle/src/index.mjs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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
  "setup",
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
  "sources",
  "revisit",
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
  setup: "mutate",
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
  sources: "read",
  revisit: "publish",
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
      // Governance and policy errors carry precise KDLC_ codes, messages, and
      // details an agent can act on (which claim drifted, which schema field
      // failed) — masking them as internal made every governed refusal look
      // like a crash (FEAT-032 round, observed live). Only truly unknown
      // errors stay scrubbed.
      const coded =
        typeof error?.code === "string" &&
        error.code.startsWith("KDLC_") &&
        ["GovernanceError", "AgentPolicyError"].includes(error?.name);
      // Exit classes are a stable §25 contract: conflicts and missing
      // dependencies must not masquerade as policy refusals.
      const codedClass = !coded
        ? EXIT.internal
        : /_(?:CONFLICT|IMMUTABLE)$/.test(error.code)
          ? EXIT.conflict
          : /_REQUIRED$/.test(error.code)
            ? EXIT.dependency
            : EXIT.policy;
      // envelope() must never throw: details fall back to {} if uncloneable.
      let codedDetails = {};
      if (coded) {
        try { codedDetails = JSON.parse(canonicalJson(error.details ?? {})); } catch { codedDetails = {}; }
      }
      const known =
        error instanceof EngineError
          ? error
          : coded
            ? new EngineError(error.code, error.message, codedClass, codedDetails)
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
    if (this.principal.bootstrap_init_only && !["init", "project_init", "setup"].includes(operation)) throw new EngineError("KDLC_POLICY_DENIED", "Bootstrap principal is restricted to project initialization", EXIT.policy);
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
    if (
      ["ingest", "ingest_start"].includes(operation) &&
      input.remote !== undefined &&
      (!Array.isArray(input.remote) || input.remote.length !== (input.sources?.length ?? 0))
    )
      throw inputError("remote descriptors must be an array aligned one-to-one with sources");
    if (operation === "init" || operation === "project_init")
      return this.init(input);
    if (operation === "setup") {
      const { runSetup } = await import("./setup.mjs");
      try { return await runSetup(input); }
      catch (error) { throw new EngineError("KDLC_INPUT_INVALID", error.message, EXIT.input); }
    }
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
    if (operation === "sources") return this.remoteSourceReceipts();
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
          clearance: "internal",
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
  async remoteSourceReceipts() {
    const directory = this.path("sources");
    const receipts = [];
    if (await exists(directory)) {
      for (const name of (await readdir(directory)).filter((item) => /^src_[a-f0-9]{16}\.receipt\.json$/.test(item)).sort()) {
        receipts.push(JSON.parse(await readFile(resolve(directory, name), "utf8")));
      }
    }
    // FEAT-025: configured connectors with env-presence booleans (never values).
    let connectors = null;
    const configPath = this.path("connectors.json");
    if (await exists(configPath)) {
      const { connectorReadiness } = await import("../sources/config.mjs");
      let parsed;
      try { parsed = JSON.parse(await readFile(configPath, "utf8")); }
      catch { parsed = null; }
      connectors = connectorReadiness(parsed);
    }
    return { sources: receipts, ...(connectors ? { connectors } : {}) };
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
  if (!new Set(["text", "json", "human"]).has(output))
    throw inputError("--output must be text, json, or human");
  const operation = args.shift();
  if (!CLI_COMMANDS.includes(operation))
    throw inputError("A supported command is required");
  const positionals = [];
  let idempotency;
  let remoteJson;
  for (let cursor = 0; cursor < args.length; cursor += 1) {
    if (args[cursor] === "--idempotency-key") idempotency = args[++cursor];
    else if (args[cursor] === "--remote-json") remoteJson = args[++cursor];
    else positionals.push(args[cursor]);
  }
  const input = { args: positionals };
  if (remoteJson !== undefined) {
    if (operation !== "ingest") throw inputError("--remote-json applies only to ingest");
    try {
      input.remote = JSON.parse(remoteJson);
    } catch {
      throw inputError("--remote-json must be a JSON array of remote source descriptors (null entries for local sources)");
    }
  }
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
  if (operation === "setup") {
    [input.tool, input.project] = positionals;
    if (!input.tool || !input.project) throw inputError("setup requires: kdlc setup <claude-code|codex|kiro|kiro-ide|mcp>[,...] <project-directory>");
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
  if (operation === "revisit") {
    const at = positionals.indexOf("--ratify");
    input.proposal_id = positionals.find((value) => !value.startsWith("--") && positionals[positionals.indexOf(value) - 1] !== "--ratify");
    if (input.proposal_id === undefined) delete input.proposal_id;
    if (at !== -1) input.reason = positionals[at + 1];
    input.args = [];
    return { operation, input, output };
  }
  if (operation === "publish") {
    const flags = positionals.filter((value) => value.startsWith("--"));
    const plain = positionals.filter((value, index) => !value.startsWith("--") && !(positionals[index - 1] === "--approve" || positionals[index - 1] === "--reject" || positionals[index - 1] === "--request-changes"));
    const reasonFor = (flag) => {
      const at = positionals.indexOf(flag);
      return at !== -1 && positionals[at + 1] && !positionals[at + 1].startsWith("--") ? positionals[at + 1] : undefined;
    };
    if (flags.includes("--approve")) { input.decide = "approved"; input.reason = reasonFor("--approve"); }
    else if (flags.includes("--reject")) { input.decide = "rejected"; input.reason = reasonFor("--reject"); }
    else if (flags.includes("--request-changes")) { input.decide = "changes_requested"; input.reason = reasonFor("--request-changes"); }
    [input.proposal_id, input.receipt_id] = plain;
    if (input.proposal_id === undefined) delete input.proposal_id;
    if (input.receipt_id === undefined) delete input.receipt_id;
    if (plain[2]) input.current = JSON.parse(plain[2]);
  }
  if (operation === "proposal" && (positionals.includes("--scaffold") || positionals.includes("--submit"))) {
    const flag = (name) => {
      const index = positionals.indexOf(name);
      return index === -1 ? undefined : positionals[index + 1];
    };
    if (positionals.includes("--submit")) {
      input.submit = { workflow_id: flag("--submit"), ...(positionals.includes("--auto") ? { auto: true } : {}) };
    } else {
      input.scaffold = {
        job_id: flag("--scaffold"),
        access: flag("--access"),
        license: flag("--license"),
        ...(flag("--workflow") ? { workflow_id: flag("--workflow") } : {}),
        ...(flag("--source") !== undefined ? { source: flag("--source") } : {}),
        ...(positionals.includes("--all-sources") ? { all_sources: true } : {}),
        ...(flag("--units") ? { units: flag("--units") } : {}),
        ...(positionals.includes("--save-defaults") ? { save_defaults: true } : {}),
      };
    }
    input.args = [];
    return { operation, input, output };
  }
  if (["proposal", "reconcile-edits", "migrate"].includes(operation) && positionals[0]) Object.assign(input, JSON.parse(positionals[0]));
  return { operation, input, output };
}
// Plain-language framing per failure class for --output human. The exact
// error code and message are still shown; this adds what the failure means
// for the person at the keyboard and what is safe to do next.
const HUMAN_ERROR_FRAMING = Object.freeze({
  [EXIT.input]: "The command couldn't be understood as given — nothing was changed. Adjust the arguments and try again.",
  [EXIT.policy]: "Project policy stopped this — it isn't permitted for this principal or project state. Nothing was changed.",
  [EXIT.conflict]: "This collided with a concurrent change — re-check the current state before retrying.",
  [EXIT.dependency]: "Something this operation needs is missing or not configured yet.",
  [EXIT.transient]: "A temporary problem occurred — it is safe to retry the same command.",
  [EXIT.internal]: "An internal error occurred. The governed state is protected; report this if it persists.",
});

function humanValue(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value !== "object") return String(value);
  return canonicalJson(value);
}

// FEAT-027 (#110): plain-language guidance where newcomers get lost, appended
// only to human/text output — the JSON envelope (the machine contract every
// harness consumes) stays byte-identical.
function guidanceHint(envelope) {
  if (!envelope.ok) return null;
  if (envelope.operation === "ingest" && envelope.result?.api_version === "kdlc.dev/job/v1") {
    return [
      `Ingest runs as a background job (${envelope.result.id}) — "kdlc jobs" shows the outcome and the evidence it produced.`,
      'Evidence feeds proposals, not answers: knowledge becomes queryable after proposal → review → publish.',
      'For the guided experience, add K-DLC to your AI tool: kdlc setup <claude-code|codex|kiro|kiro-ide|mcp> <project-dir> — its agents drive the lifecycle and stop at the review gates for you.',
    ].join("\n");
  }
  if (envelope.operation === "query" && envelope.result?.status === "not_found" && (envelope.result.results?.length ?? 0) === 0) {
    return [
      "No published knowledge yet — query answers only from published, reviewed concepts.",
      "If you've ingested sources, that evidence is waiting on proposal → review → publish.",
      "In an AI harness (kdlc setup <tool> <project-dir>) the agents drive that path conversationally.",
    ].join("\n");
  }
  return null;
}

// FEAT-032 (#123): human/text output never carries evidence unit bodies — a
// single document was transiting agent context repeatedly via job echoes.
// The JSON envelope (machine contract) is untouched.
function elideUnits(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => elideUnits(item, depth + 1));
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "units" || key === "probabilisticUnits") && Array.isArray(entry)) {
      out[key] = `[${entry.length} unit${entry.length === 1 ? "" : "s"} elided — kdlc proposal --scaffold to draft from them, source_excerpt to inspect one]`;
    } else {
      out[key] = elideUnits(entry, depth + 1);
    }
  }
  return out;
}

export function renderEnvelope(envelope, output = "text") {
  if (output === "json") return `${canonicalJson(envelope)}\n`;
  envelope = envelope.ok && envelope.result ? { ...envelope, result: elideUnits(envelope.result) } : envelope;
  const hint = guidanceHint(envelope);
  if (output === "human") {
    if (envelope.ok) {
      const lines = [`✔ ${envelope.operation} completed.`];
      const result = envelope.result;
      if (result && typeof result === "object" && !Array.isArray(result)) {
        for (const [key, value] of Object.entries(result))
          lines.push(`  ${key.replaceAll("_", " ")}: ${humanValue(value)}`);
      } else if (result !== null && result !== undefined) {
        lines.push(`  ${humanValue(result)}`);
      }
      if (hint) lines.push("", ...hint.split("\n").map((line) => `  ${line}`));
      return `${lines.join("\n")}\n`;
    }
    const framing = HUMAN_ERROR_FRAMING[envelope.error.class] ?? HUMAN_ERROR_FRAMING[EXIT.internal];
    const details = envelope.error.details && Object.keys(envelope.error.details).length > 0
      ? `\n  Specifics: ${canonicalJson(envelope.error.details).slice(0, 2000)}`
      : "";
    return `✖ ${envelope.operation} did not complete.\n  ${framing}\n  Detail: ${envelope.error.message} (${envelope.error.code})${details}\n`;
  }
  if (envelope.ok)
    return `${envelope.operation}: ok\n${canonicalJson(envelope.result)}\n${hint ? `${hint}\n` : ""}`;
  const textDetails = envelope.error.details && Object.keys(envelope.error.details).length > 0 ? `\n${canonicalJson(envelope.error.details).slice(0, 2000)}` : "";
  return `${envelope.operation}: ${envelope.error.code}: ${envelope.error.message}${textDetails}\n`;
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
    { sources, remote },
    { durableIdempotencyKey, cancellationPoint },
  ) => {
    const canonicalRoot = await realpath(root);
    // FEAT-021: optional remote descriptors, aligned by index with sources.
    if (remote !== undefined && (!Array.isArray(remote) || remote.length !== sources.length)) {
      throw inputError("remote descriptors must be an array aligned one-to-one with sources");
    }
    const { bindReceipt, validateRemoteDescriptor, RemoteSourceError } = await import("../sources/index.mjs");
    for (const [index, descriptor] of (remote ?? []).entries()) {
      if (descriptor === null) continue;
      const failures = validateRemoteDescriptor(descriptor);
      if (failures.length > 0) throw inputError(`remote descriptor ${index} is invalid: ${failures.join("; ")}`);
    }
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
      const result = await normalize({
        bytes,
        filename: basename(candidate),
        sourceId,
        normalizedAt: new Date().toISOString(),
      });
      const descriptor = remote?.[index] ?? null;
      if (descriptor !== null && descriptor !== undefined) {
        let receipt;
        try {
          receipt = bindReceipt(descriptor, bytes, { sourceId, receivedAt: new Date().toISOString() });
        } catch (error) {
          if (error instanceof RemoteSourceError) {
            throw new EngineError("KDLC_POLICY_DENIED", `${error.message} (${error.failures.join("; ")})`, EXIT.policy);
          }
          throw error;
        }
        const receiptsDirectory = resolve(root, ".kdlc/sources");
        await mkdir(receiptsDirectory, { recursive: true });
        await writeFile(resolve(receiptsDirectory, `${sourceId}.receipt.json`), `${canonicalJson(receipt)}\n`);
        result.receipt = receipt;
      }
      normalized.push(result);
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
      // FEAT-033 (#125): humans never assemble the publish current-context —
      // every field already exists in the workflow's own durable records.
      const deriveCurrent = async (workflowId, proposal) => {
        const normalized = await store.get(`workflow/runs/${workflowId}/state/normalized-evidence.json`);
        const record = policy.review_contexts.find((entry) => entry.workflow_id === workflowId)
          ?? (await indexStore.exists(contextPath(workflowId)) ? await indexStore.readJson(contextPath(workflowId)) : null);
        if (!record) throw missing("Trusted review context is unavailable");
        return {
          concept: structuredClone(proposal.concept.after),
          target_revision: proposal.target.revision,
          source_hashes: [normalized.source_hash],
          resolved_dependencies: structuredClone(record.context.resolved.dependencies),
          profile: structuredClone(record.context.resolved.profile),
          policies: structuredClone(record.context.resolved.policies),
        };
      };
      // FEAT-033: the last mile — after the verification chain authorizes
      // publication, land the OKF concept and regenerate index + catalog in
      // one journaled, crash-recoverable transaction (never half-published).
      const materializePublication = async ({ workflowId, proposal }) => {
        const project = JSON.parse(readFileSync(resolve(root, ".kdlc/project.json"), "utf8"));
        const mount = project.mounts?.[0]?.alias ?? "primary";
        const base = `knowledge/${mount}`;
        const subjectPath = String(proposal.target.subject).replace(/^kb:\/\/[^/]+\//, "").replace(/[^A-Za-z0-9/_-]+/g, "-").toLowerCase();
        if (!subjectPath || subjectPath.includes("..")) throw inputError(`proposal subject ${proposal.target.subject} does not yield a safe concept path`);
        const conceptRelative = `concepts/${subjectPath}.md`;
        const conceptId = conceptRelative.slice(0, -3); // retriever contract: id === path minus .md
        const frontmatter = proposal.concept.after.frontmatter;
        const conceptContent = `---\n${stringifyYaml(frontmatter)}---\n\n${String(proposal.concept.after.body).replace(/\n*$/, "\n")}`;
        const kbConfigText = await indexStore.exists(`${base}/knowledge-base.yaml`) ? await indexStore.readText(`${base}/knowledge-base.yaml`) : null;
        const kbAccess = kbConfigText ? parseYaml(kbConfigText)?.access?.classification ?? "internal" : "internal";
        const catalogPath = `${base}/retrieval-catalog.json`;
        const oldCatalog = await indexStore.exists(catalogPath) ? JSON.parse(await indexStore.readText(catalogPath)) : { version: "kdlc-retrieval-catalog-1", concepts: [] };
        // Retrieval binds to frontmatter access and per-source access/rights.
        // Concepts reviewed without them keep the pre-FEAT-033 contract —
        // authorization recorded, nothing materialized — with the reason
        // stated so the drafter can fix and re-review.
        const missingMetadata = !frontmatter.access || typeof frontmatter.access.classification !== "string"
          ? `the concept frontmatter lacks access.classification (e.g. "${kbAccess}")`
          : (frontmatter.sources ?? []).filter((source) => typeof source.resource !== "string" || !source.access?.classification || !source.rights?.license)
              .map((source) => `source "${source.id}" lacks resource/access/rights`).join("; ") || null;
        if (missingMetadata) {
          return { materialized: false, reason: `${missingMetadata} — retrieval binds to these reviewed fields, so the intent is recorded but the concept was not published to the knowledge base; add them in the drafting template and re-review` };
        }
        const entry = { id: conceptId, path: conceptRelative, byte_hash: sha256Token(conceptContent), access: structuredClone(frontmatter.access) };
        const catalog = { ...oldCatalog, concepts: [...oldCatalog.concepts.filter((item) => item.id !== conceptId), entry].sort((a, b) => a.id.localeCompare(b.id)) };
        const catalogContent = `${JSON.stringify(catalog)}\n`;
        const indexPathRel = `${base}/index.md`;
        const oldIndex = await indexStore.exists(indexPathRel) ? await indexStore.readText(indexPathRel) : "<!-- generated by kdlc; do not edit -->\n# Knowledge Index\n";
        const line = `* [${String(frontmatter.title ?? conceptId).replace(/[\[\]\n]/g, " ")}](${conceptRelative})`;
        const kept = oldIndex.split("\n").filter((existing) => existing.trim().length > 0 && !existing.includes(`](${conceptRelative})`));
        const indexContent = `${[...kept, line].join("\n")}\n`;
        const priorToken = async (path) => (await indexStore.exists(path)) ? sha256Token(await indexStore.readText(path)) : null;
        const existingConceptToken = await priorToken(`${base}/${conceptRelative}`);
        if (existingConceptToken === sha256Token(conceptContent)) {
          return { materialized: true, concept: `${base}/${conceptRelative}`, index: indexPathRel, catalog: catalogPath, already_published: true };
        }
        // A creation proposal (concept.before === null) was reviewed as NEW
        // content. Lossy subject sanitization can collide distinct subjects
        // onto one path — the CAS must refuse, never bless a silent overwrite
        // of a different reviewed concept (review round HIGH).
        if (proposal.concept.before === null && existingConceptToken !== null) {
          throw new EngineError(
            "KDLC_STATE_CONFLICT",
            `a different concept already occupies ${conceptRelative} (subjects may collide after path sanitization) — this proposal was reviewed as a creation, so publishing it would silently destroy reviewed content; re-draft it as an update (concept.before set to the current content) or choose a distinct subject`,
            EXIT.conflict,
            { path: `${base}/${conceptRelative}` },
          );
        }
        const transactions = new TransactionManager({
          store: indexStore,
          clock: { now: () => new Date().toISOString(), millis: () => Date.now() },
          ids: { next: (prefix) => `${prefix}_${randomBytes(8).toString("hex")}` },
          token: sha256Token,
          audit: new AuditWriter({ store: indexStore, clock: { now: () => new Date().toISOString(), millis: () => Date.now() }, ids: { next: (prefix) => `${prefix}_${randomBytes(8).toString("hex")}` } }),
        });
        const journal = await transactions.prepare({
          workflowId,
          targets: [
            { path: `${base}/${conceptRelative}`, expectedToken: proposal.concept.before === null ? null : existingConceptToken, content: conceptContent },
            { path: indexPathRel, expectedToken: await priorToken(indexPathRel), content: indexContent },
            { path: catalogPath, expectedToken: await priorToken(catalogPath), content: catalogContent },
          ],
        });
        try {
          await transactions.commit(workflowId, journal.transaction_id);
        } catch (error) {
          // Content is journaled: finalization hiccups roll forward, never
          // leave the KB half-published.
          if (error?.code === "KDLC_TRANSACTION_FINALIZATION_PENDING") await transactions.recover(workflowId, journal.transaction_id, "rollforward");
          else throw error;
        }
        return { materialized: true, concept: `${base}/${conceptRelative}`, index: indexPathRel, catalog: catalogPath, transaction_id: journal.transaction_id };
      };
      // FEAT-033: the human gate — list what awaits decision, in plain terms.
      const pendingReviews = async () => {
        const directory = resolve(root, ".kdlc/governed/proposal-index");
        if (!existsSync(directory)) return { pending: [] };
        const pending = [];
        for (const name of (await readdir(directory)).filter((item) => item.endsWith(".json")).sort()) {
          const record = JSON.parse(await readFile(resolve(directory, name), "utf8"));
          const decided = await indexStore.exists(`.kdlc/governed/workflow/runs/${record.workflow_id}/reviews/${record.proposal_id}/decision.json`);
          if (decided) continue;
          const proposal = await store.get(`workflow/runs/${record.workflow_id}/proposals/${record.proposal_id}.json`).catch(() => null);
          pending.push({
            proposal_id: record.proposal_id,
            workflow_id: record.workflow_id,
            packet_hash: record.packet_hash,
            title: proposal?.concept?.after?.frontmatter?.title ?? record.proposal_id,
            subject: proposal?.target?.subject ?? null,
            next: `kdlc publish ${record.proposal_id} --approve "<reason>" (or --reject / --request-changes)`,
          });
        }
        return { pending, ...(pending.length === 0 ? { note: "nothing is waiting on you" } : {}) };
      };
      // FEAT-034 (#127): the ratification queue for auto-approved drafts, and
      // one-command promotion to stable through a real reviewed update.
      const revisitQueue = async () => {
        const runsDirectory = resolve(root, ".kdlc/governed/workflow/runs");
        if (!existsSync(runsDirectory)) return { awaiting_ratification: [] };
        const awaiting = [];
        for (const workflowId of (await readdir(runsDirectory)).sort()) {
          const reviewsDirectory = resolve(runsDirectory, workflowId, "reviews");
          if (!existsSync(reviewsDirectory)) continue;
          for (const proposalId of (await readdir(reviewsDirectory)).sort()) {
            const rationalePath = resolve(reviewsDirectory, proposalId, "rationale.json");
            if (!existsSync(rationalePath)) continue;
            const rationale = JSON.parse(await readFile(rationalePath, "utf8"));
            if (!rationale.auto || rationale.ratified) continue;
            const proposal = await store.get(`workflow/runs/${workflowId}/proposals/${proposalId}.json`).catch(() => null);
            awaiting.push({
              proposal_id: proposalId, workflow_id: workflowId,
              title: proposal?.concept?.after?.frontmatter?.title ?? proposalId,
              subject: proposal?.target?.subject ?? null,
              auto_approved_at: rationale.decided_at,
              next: `kdlc revisit ${proposalId} --ratify "<reason>" to promote it to stable (default query answers)`,
            });
          }
        }
        return { awaiting_ratification: awaiting, ...(awaiting.length === 0 ? { note: "no auto-approved drafts are awaiting ratification" } : {}) };
      };
      const ratifyDraft = async ({ proposal_id: proposalId, reason }) => {
        if (typeof reason !== "string" || reason.trim().length === 0) throw inputError('ratification requires --ratify "<reason>" — it becomes the human review rationale');
        const index = await proposalIndex(proposalId);
        const workflowId = index.workflow_id;
        const rationalePath = `.kdlc/governed/workflow/runs/${workflowId}/reviews/${proposalId}/rationale.json`;
        if (!(await indexStore.exists(rationalePath))) throw missing("no auto-approval record exists for this proposal");
        const rationale = await indexStore.readJson(rationalePath);
        if (!rationale.auto) throw inputError(`${proposalId} was human-decided, not auto-approved — nothing to ratify`);
        if (rationale.ratified) throw new EngineError("KDLC_STATE_CONFLICT", `${proposalId} is already ratified`, EXIT.conflict);
        const original = await store.get(`workflow/runs/${workflowId}/proposals/${proposalId}.json`);
        if (original.concept.after.frontmatter.status !== "draft") throw inputError(`${proposalId} is not a draft-tier concept`);
        const evidence = await store.get(`workflow/runs/${workflowId}/state/normalized-evidence.json`);
        const claims = [];
        for (const claimId of original.claim_ids) claims.push(await store.get(`workflow/runs/${workflowId}/claims/${claimId}.json`));
        const promotionWorkflow = `${workflowId}r${Date.now().toString(36)}`.slice(0, 40);
        const contextRecord = await indexStore.readJson(contextPath(workflowId));
        await indexStore.writeJsonAtomic(contextPath(promotionWorkflow), { workflow_id: promotionWorkflow, context: contextRecord.context });
        const promotedId = `pr${proposalId.replace(/^pr_?/, "")}s`.replace(/[^a-z0-9]/g, "").replace(/^pr/, "pr_");
        const recording = {
          api_version: "kdlc.dev/recorded-model-output/v1alpha1",
          fixture_id: `ratify-${promotionWorkflow.replace(/[^a-z0-9-]/g, "-")}`,
          task: "ingest",
          model: { provider: "recorded", model: "kdlc-revisit", prompt: "promote ratified draft to stable", recorded_at: new Date().toISOString() },
          input_hashes: { normalized_evidence: artifactHash(evidence) },
          claims,
          proposals: [{
            ...structuredClone(original),
            id: promotedId,
            workflow_id: promotionWorkflow,
            state: "review_pending",
            concept: {
              before: structuredClone(original.concept.after),
              after: { ...structuredClone(original.concept.after), frontmatter: { ...structuredClone(original.concept.after.frontmatter), status: "stable" } },
            },
          }].map(({ input_hashes: ignored, ...entry }) => entry),
        };
        const submitted = await governed.proposal_create({ proposal: { workflow_id: promotionWorkflow, task: "ingest", recording, normalized_evidence: evidence } });
        const landed = await governed.publish_request({ proposal_id: promotedId, decide: "approved", reason });
        await indexStore.writeJsonAtomic(rationalePath, { ...rationale, ratified: true, ratified_by: principal.actor, ratified_at: new Date().toISOString(), ratification_reason: reason, promoted_as: promotedId });
        return { proposal_id: proposalId, promoted_as: promotedId, workflow_id: promotionWorkflow, published: landed.published, next: "the concept is stable — default kdlc query answers include it now" };
      };
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
        publish_request: async ({ proposal_id: proposalId, receipt_id: receiptId, current, decide, reason, auto }) => {
          if (proposalId === undefined) return pendingReviews();
          const index = await proposalIndex(proposalId);
          if (decide) {
            // --approve/--reject/--request-changes: record the human decision
            // first; only approvals continue into publication.
            const reviewRuntime = await harness(index.workflow_id, true);
            receiptId = receiptId ?? `rr_${digest(`${proposalId}:${decide}:${Date.now()}`).slice(7, 19)}`;
            try {
              await reviewRuntime.decide({ workflowId: index.workflow_id, proposalId, decision: decide, receiptId });
            } catch (error) {
              if (error?.code === "KDLC_DECISION_CONFLICT") {
                throw new EngineError("KDLC_STATE_CONFLICT", `${proposalId} already has a recorded decision (receipt ${error.details?.current ?? "on file"}) — your earlier decision stands; finish with: kdlc publish ${proposalId} ${error.details?.current ?? "<receipt-id>"}`, EXIT.conflict, structuredClone(error.details ?? {}));
              }
              throw error;
            }
            // The human's stated rationale is part of the governance record.
            await indexStore.writeJsonAtomic(`.kdlc/governed/workflow/runs/${index.workflow_id}/reviews/${proposalId}/rationale.json`, {
              api_version: "kdlc.dev/review-rationale/v1",
              proposal_id: proposalId, receipt_id: receiptId, decision: decide,
              reason: reason ?? null, decided_by: principal.actor, decided_at: new Date().toISOString(),
              ...(auto ? { auto: true, ratified: false } : {}),
            });
            if (decide !== "approved") return { proposal_id: proposalId, decision: decide, receipt_id: receiptId, reason: reason ?? null, published: null };
          }
          if (!receiptId) throw inputError("publish requires a receipt id (or use --approve to decide and publish in one step)");
          const proposal = await store.get(`workflow/runs/${index.workflow_id}/proposals/${proposalId}.json`);
          const effectiveCurrent = current ?? await deriveCurrent(index.workflow_id, proposal);
          const runtime = await harness(index.workflow_id, true);
          const receipt = await store.get(`workflow/runs/${index.workflow_id}/receipts/${receiptId}.json`);
          const decision = await store.get(`workflow/runs/${index.workflow_id}/reviews/${proposalId}/decision.json`);
          trustAuthority.activateReview({ workflowId: index.workflow_id, receipt, decision });
          const publication = await runtime.preparePublication({ workflowId: index.workflow_id, proposalId, receiptId, current: effectiveCurrent });
          const published = await materializePublication({ workflowId: index.workflow_id, proposal });
          return { ...publication, published, next: published.materialized ? "the concept is live — kdlc query answers with citations now" : published.reason };
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
      governed.revisit = async (input) => (input.proposal_id ? ratifyDraft(input) : revisitQueue());
    }
  }
  // FEAT-030 (#118): bridge live agents to the recorded-proposal contract.
  // Scaffolding is the only step a human/agent cannot derive: it turns a
  // completed ingest job into (a) a trusted review context — with the access
  // classification and license the OWNER explicitly declares, never a silent
  // default — and (b) a drafting kit whose hashes the runtime will accept.
  const sourceDefaultsPath = resolve(root, ".kdlc/source-defaults.json");
  const scaffoldProposalDrafting = async ({ job_id: jobId, access, license, workflow_id: requestedWorkflow, source, all_sources: allSources, units: unitRange, save_defaults: saveDefaults }) => {
    if (typeof jobId !== "string" || !/^job_[a-f0-9]{16}$/.test(jobId)) throw inputError("scaffold requires the completed ingest job id (job_<16 hex>)");
    // FEAT-034 (#127): access/license may be declared once for the project.
    // Explicit flags always win; saved defaults fill gaps and are reported;
    // with neither, the governance decision still fails closed.
    let usedDefaults = false;
    if ((access === undefined || license === undefined) && existsSync(sourceDefaultsPath)) {
      const saved = JSON.parse(readFileSync(sourceDefaultsPath, "utf8"));
      if (access === undefined && saved.access) { access = saved.access; usedDefaults = true; }
      if (license === undefined && saved.license) { license = saved.license; usedDefaults = true; }
    }
    if (!["public", "internal", "restricted"].includes(access)) {
      throw inputError("scaffold requires --access <public|internal|restricted> (or saved project defaults via --save-defaults) — the source's access classification is a governance decision only you can make");
    }
    if (typeof license !== "string" || license.length === 0) {
      throw inputError("scaffold requires --license <spdx-or-LicenseRef> (or saved project defaults via --save-defaults) — the source's license is a governance decision only you can make");
    }
    if (saveDefaults) {
      await mkdir(dirname(sourceDefaultsPath), { recursive: true });
      await writeFile(sourceDefaultsPath, `${canonicalJson({ api_version: "kdlc.dev/source-defaults/v1", access, license, saved_by: principal.actor, saved_at: new Date().toISOString() })}\n`);
    }
    const jobPath = resolve(root, ".kdlc/jobs", `${jobId}.json`);
    if (!existsSync(jobPath)) throw missing("Requested job is unavailable");
    const job = JSON.parse(readFileSync(jobPath, "utf8"));
    if (job.operation !== "ingest" || job.state !== "completed") throw inputError(`scaffold needs a completed ingest job; ${jobId} is ${job.operation}/${job.state}`);
    const artifacts = (job.result?.normalized ?? []).filter((entry) => entry?.manifest?.status === "complete");
    if (artifacts.length === 0) throw inputError("the job's normalization did not complete — nothing to draft from");
    // Fail closed on multi-document jobs: silently drafting only the first
    // file loses the rest. Each document gets its own workflow and kit.
    let selection;
    if (allSources) {
      if (requestedWorkflow) throw inputError("--workflow cannot combine with --all-sources (each document gets its own workflow)");
      selection = artifacts.map((artifact, index) => ({ artifact, index }));
    } else if (source !== undefined) {
      const index = Number(source);
      if (!Number.isInteger(index) || index < 0 || index >= artifacts.length) throw inputError(`--source must be 0..${artifacts.length - 1} for this job`);
      selection = [{ artifact: artifacts[index], index }];
    } else if (artifacts.length === 1) {
      selection = [{ artifact: artifacts[0], index: 0 }];
    } else {
      const menu = artifacts.map((artifact, index) => `${index}: ${job.request?.sources?.[index] ?? artifact.manifest.source_id} (${artifact.units.length} units)`).join("; ");
      throw inputError(`this job ingested ${artifacts.length} documents — pick one with --source <n> or scaffold every document with --all-sources. Sources: ${menu}`);
    }
    let sliceBounds = null;
    if (unitRange !== undefined) {
      const match = /^([0-9]+)-([0-9]+)$/.exec(String(unitRange));
      if (!match) throw inputError("--units must be <start>-<end> (1-based positions among the document's text units)");
      sliceBounds = [Number(match[1]), Number(match[2])];
      if (sliceBounds[0] < 1 || sliceBounds[1] < sliceBounds[0]) throw inputError("--units range must satisfy 1 <= start <= end");
    }
    const scaffolded = [];
    for (const { artifact, index } of selection) {
      const workflowId = requestedWorkflow ?? (selection.length > 1 || source !== undefined ? `wf_${jobId.slice(4)}s${index}` : `wf_${jobId.slice(4)}`);
      if (!/^wf_[a-z0-9]+$/.test(workflowId)) throw inputError("workflow_id must match wf_<lowercase letters and digits> (the concept-proposal schema enforces it)");
      scaffolded.push(await scaffoldOneSource({ artifact, workflowId, access, license, sliceBounds, sourceName: job.request?.sources?.[index] ?? artifact.manifest.source_id }));
    }
    return withDefaultsNote(
      selection.length === 1 ? scaffolded[0] : { job_id: jobId, scaffolds: scaffolded, next: "fill each kit's recording template, then submit each with kdlc proposal --submit <workflow-id>" },
      usedDefaults, access, license,
    );
  };
  const scaffoldOneSource = async ({ artifact, workflowId, access, license, sliceBounds, sourceName }) => {
    let units = artifact.units.filter((unit) => typeof unit.text === "string" && unit.text.trim().length > 0)
      .map((unit) => ({ locator: unit.locator, text: unit.text }));
    const totalUnits = units.length;
    if (sliceBounds) units = units.slice(sliceBounds[0] - 1, sliceBounds[1]);
    if (units.length === 0) throw inputError(sliceBounds ? `--units ${sliceBounds[0]}-${sliceBounds[1]} selects nothing (the document has ${totalUnits} text units)` : "the ingested source produced no text units to draft from");
    const normalizedEvidence = {
      api_version: "kdlc.dev/recorded-normalized-fixture/v1alpha1",
      source_id: artifact.manifest.source_id,
      source_hash: artifact.manifest.source_hash,
      media_type: artifact.descriptor?.accepted?.media_types?.[0] ?? "text/plain",
      units,
    };
    const rights = { license, redistribution: "prohibited", derivative_use: "allowed", commercial_use: "prohibited" };
    const stamp = digest(`${workflowId}:scaffold`);
    const context = {
      evidence: [{
        source_id: normalizedEvidence.source_id,
        source_hash: normalizedEvidence.source_hash,
        locator: units[0].locator,
        excerpt: units[0].text,
        authority: principal.actor,
        access: { classification: access },
        rights,
        extraction_quality: "high",
        warnings: [],
      }],
      // The base profile requires exactly this sensor; its check (every claim
      // anchored to a persisted normalized unit) is re-executed deterministically
      // by the runtime at submission, which is the execution this entry records.
      sensors: [{ id: "source-anchor-valid", severity: "error", result: "passed", producer: "kdlc-sensor-runtime/0.2.0", execution_hash: digest({ workflow: workflowId, evidence: normalizedEvidence.source_hash }) }],
      impact: { links: [], dependents: [], freshness_change: null, unresolved_conflicts: [] },
      resolved: {
        profile: { id: "kdlc-base", version: "0.2.0", hash: stamp },
        policies: [{ id: "team-policy", version: "1", hash: stamp }],
        dependencies: {},
      },
      provenance: { models: [{ id: "live-agent" }], tools: [{ id: "kdlc-harness/0.2.0" }] },
      budget: { model_tokens: 0, model_cost_usd: 0 },
    };
    const scaffoldStore = new NodeFileStore(root);
    const contextRecordPath = `.kdlc/governed/review-contexts/${workflowId}.json`;
    if (await scaffoldStore.exists(contextRecordPath)) throw new EngineError("KDLC_STATE_CONFLICT", `workflow ${workflowId} already has a review context — pass a fresh workflow_id`, EXIT.conflict);
    await scaffoldStore.writeJsonAtomic(contextRecordPath, { workflow_id: workflowId, context });
    const template = {
      api_version: "kdlc.dev/recorded-model-output/v1alpha1",
      fixture_id: `live-${workflowId.replace(/[^a-z0-9-]/g, "-")}`,
      task: "ingest",
      model: { provider: "recorded", model: "FILL: your model id", prompt: "FILL: one-line description of your drafting prompt", recorded_at: new Date().toISOString() },
      input_hashes: { normalized_evidence: artifactHash(normalizedEvidence) },
      claims: [],
      proposals: [],
    };
    const kitDirectory = resolve(root, ".kdlc/drafting", workflowId);
    await mkdir(kitDirectory, { recursive: true });
    await writeFile(resolve(kitDirectory, "normalized-evidence.json"), `${canonicalJson(normalizedEvidence)}\n`);
    await writeFile(resolve(kitDirectory, "recording-template.json"), `${JSON.stringify(template, null, 2)}\n`);
    await writeFile(resolve(kitDirectory, "locators.json"), `${JSON.stringify(units.map(({ locator, text }) => ({ locator, excerpt: text.slice(0, 120) })), null, 2)}\n`);
    await writeFile(resolve(kitDirectory, "README.md"), [
      `# Drafting kit — workflow ${workflowId}`,
      "",
      "Fill `recording-template.json`, then submit it — the runtime verifies every hash and anchor:",
      "",
      "1. Add claims: each needs `id` matching clm_<lowercase letters and digits only>, `text`, `source_id` and",
      "   `source_hash` copied EXACTLY from `normalized-evidence.json`, a `locator` copied EXACTLY from",
      "   `locators.json`, `extraction` (explicit|inferred|computed), `status: \"accepted\"`, and the same",
      "   `access`/`rights` objects shown in this scaffold's result summary (the runtime re-binds them from the",
      "   trusted review context, but the claim schema requires the fields present).",
      "2. Add proposals: `kdlc.dev/concept-proposal/v1alpha1` entries with `id` matching pr_<lowercase+digits>,",
      "   `workflow_id: \"" + workflowId + "\"`, `task: \"ingest\"`, `state: \"review_pending\"`, a `target`",
      "   (knowledge_base_id/revision/subject), the OKF `concept` ({before: null, after: {frontmatter, body}}) —",
      "   frontmatter MUST include `access: {classification: \"" + access + "\"}` (retrieval binds to it) and",
      "   each `sources` entry MUST carry `id`, `resource` (e.g. \"file:sources/<name>\"), `source_hash`,",
      "   `access` and `rights` matching this kit's declarations (answers are withheld unless the requester",
      "   may see the concept AND every disclosed source),",
      "   `claim_ids` listing every claim the concept rests on, `claim_decisions`",
      "   ([{claim_id, disposition: \"accepted\", rationale}]), and `created_by` (e.g. \"kdlc-integrator/0.2.0\").",
      "3. Set model.model and model.prompt to what actually drafted the content.",
      "4. Submit:",
      "",
      "   kdlc proposal --submit " + workflowId,
      "",
      "   (the engine reads this kit's recording-template.json and normalized-evidence.json from disk —",
      "   never paste their contents into the conversation).",
      "",
      "   (or pass the same object through the harness runner). The response carries each proposal's review",
      "   packet and packet hash — bring that to the human for the review decision.",
      "5. Review (human decision): kdlc review <proposal-id> <approved|rejected|changes_requested> <receipt-id>",
      "6. Publish: kdlc publish <proposal-id> <receipt-id> '<current-json>' where current is",
      "   {\"concept\": <the proposal's concept.after>, \"target_revision\": \"rev-1\",",
      "    \"source_hashes\": [<normalized-evidence source_hash>],",
      "    \"resolved_dependencies\"/\"profile\"/\"policies\": copied from this workflow's review-context",
      "    record (" + contextRecordPath + ")}.",
      "",
    ].join("\n"));
    return {
      workflow_id: workflowId,
      source: sourceName,
      review_context: contextRecordPath,
      kit: [".kdlc/drafting/" + workflowId + "/README.md", ".kdlc/drafting/" + workflowId + "/recording-template.json", ".kdlc/drafting/" + workflowId + "/normalized-evidence.json", ".kdlc/drafting/" + workflowId + "/locators.json"],
      units: units.length,
      ...(sliceBounds ? { slice: `${sliceBounds[0]}-${sliceBounds[1]} of ${totalUnits} text units` } : {}),
      access: { classification: access },
      rights,
      next: "fill the recording template (see the kit README), then submit with kdlc proposal --submit " + workflowId,
    };
  };
  const withDefaultsNote = (result, usedDefaults, access, license) => usedDefaults ? { ...result, defaults: `using saved project defaults: ${access} / ${license}` } : result;
  // FEAT-032 (#123): submit from the kit on disk — evidence and recording
  // never transit the model context; the agent only edits the template file.
  const submitProposalFromKit = async ({ workflow_id: workflowId, auto }) => {
    if (typeof workflowId !== "string" || !/^wf_[a-z0-9]+$/.test(workflowId)) throw inputError("--submit requires the scaffolded workflow id (wf_...)");
    const kitDirectory = resolve(root, ".kdlc/drafting", workflowId);
    const read = (name) => {
      const path = resolve(kitDirectory, name);
      if (!existsSync(path)) throw missing(`the drafting kit for ${workflowId} is missing ${name} — run kdlc proposal --scaffold first`);
      try { return JSON.parse(readFileSync(path, "utf8")); }
      catch { throw inputError(`${name} in the ${workflowId} kit is not valid JSON — fix the file and retry`); }
    };
    const recording = read("recording-template.json");
    const normalizedEvidence = read("normalized-evidence.json");
    if (!Array.isArray(recording.claims) || recording.claims.length === 0 || !Array.isArray(recording.proposals) || recording.proposals.length === 0) {
      throw inputError(`the recording template for ${workflowId} has empty claims or proposals — fill it per the kit README before submitting`);
    }
    if (typeof recording.model?.model === "string" && recording.model.model.startsWith("FILL:")) {
      throw inputError("set model.model and model.prompt in the recording template to what actually drafted the content");
    }
    // FEAT-034 (#127): auto mode publishes WITHOUT a human pause, but only at
    // the draft trust tier — stable publication on model confidence alone is
    // a spec non-goal and the profile enforces a human for stable anyway.
    if (auto) {
      const stableOnes = recording.proposals.filter((entry) => entry?.concept?.after?.frontmatter?.status === "stable");
      if (stableOnes.length > 0) {
        throw inputError(`--auto only publishes draft-tier concepts; ${stableOnes.map(({ id }) => id).join(", ")} declare status "stable", which requires a human decision — submit without --auto, or set status: "draft" and ratify later with kdlc revisit`);
      }
    }
    const submitted = await governed.proposal_create({ proposal: { workflow_id: workflowId, task: recording.task ?? "ingest", recording, normalized_evidence: normalizedEvidence } });
    if (!auto) return submitted;
    const auto_published = [];
    for (const item of submitted.proposals) {
      const landed = await governed.publish_request({ proposal_id: item.proposal.id, decide: "approved", reason: "auto mode — machine-approved draft pending human ratification (kdlc revisit)", auto: true });
      auto_published.push({ proposal_id: item.proposal.id, packet_hash: item.packet_hash, published: landed.published });
    }
    return { ...submitted, auto_published, next: "drafts are live at the draft trust tier (exploratory queries; unreviewed). Ratify with: kdlc revisit" };
  };
  const handlers = policy
    ? {
        query: search,
        kb_search: search,
        kb_fetch: fetchConcept,
        source_excerpt: sourceExcerpt,
        ...governed,
        ...(governed.proposal_create
          ? {
              proposal: async (input, extras) =>
                input.scaffold
                  ? scaffoldProposalDrafting(input.scaffold)
                  : input.submit
                    ? submitProposalFromKit(input.submit)
                    : governed.proposal_create(input, extras),
            }
          : {}),
        ...(governed.review_submit ? { review: governed.review_submit } : {}),
        ...(governed.revisit ? { revisit: governed.revisit } : {}),
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
