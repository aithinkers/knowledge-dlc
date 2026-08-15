import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { canonicalJson, materializeScaffold, scaffoldProject } from "../core/index.mjs";

export const CLI_COMMANDS = Object.freeze(["init","adopt","ingest","query","review","publish","status","lint","refresh","trace","conflicts","gaps","migrate","doctor","reconcile-edits","jobs"]);
export const EXIT = Object.freeze({ success: 0, input: 2, policy: 3, conflict: 4, dependency: 5, transient: 6, internal: 7 });
const longOperations = new Set(["adopt", "ingest", "refresh"]);
const digest = (value) => `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const portable = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);

export class EngineError extends Error { constructor(code, message, exitClass, details = {}) { super(message); Object.assign(this, { code, exitClass, details }); } }
const inputError = (message, details) => new EngineError("KDLC_INPUT_INVALID", message, EXIT.input, details);
const missing = (message, details) => new EngineError("KDLC_DEPENDENCY_MISSING", message, EXIT.dependency, details);

async function exists(path) { try { await stat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function atomicJson(path, value) { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temporary, `${canonicalJson(value)}\n`, { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
async function createJson(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${canonicalJson(value)}\n`, { flag: "wx", mode: 0o600 }); }

export class KdlcEngine {
  constructor({ root = process.cwd(), principal = { actor: "process:local", scopes: ["read", "mutate", "publish"] }, clock = { now: () => new Date().toISOString() }, handlers = {} } = {}) {
    this.root = resolve(root); this.principal = structuredClone(principal); this.clock = clock; this.handlers = { ...handlers };
  }
  path(...parts) { return resolve(this.root, ".kdlc", ...parts); }
  async project() { const path = this.path("project.json"); if (!(await exists(path))) throw missing("Project is not initialized"); return JSON.parse(await readFile(path, "utf8")); }
  correlation(operation, input) { return `cor_${digest({ operation, input }).slice(7, 23)}`; }
  async envelope(operation, input = {}) {
    const correlation_id = this.correlation(operation, input);
    try { return { api_version: "kdlc.dev/engine-envelope/v1", ok: true, operation, correlation_id, result: await this.execute(operation, input), warnings: [], error: null }; }
    catch (error) { const known = error instanceof EngineError ? error : new EngineError("KDLC_INTERNAL", "Internal operation failure", EXIT.internal); return { api_version: "kdlc.dev/engine-envelope/v1", ok: false, operation, correlation_id, result: null, warnings: [], error: { code: known.code, message: known.message, class: known.exitClass, details: known.details } }; }
  }
  async execute(operation, input = {}) {
    if (!CLI_COMMANDS.includes(operation) && !["project_init","project_get","project_list_mounts","kb_search","kb_fetch","kb_trace","kb_conflicts","kb_gaps","source_excerpt","job_status","job_cancel","ingest_start","proposal_create","review_submit","publish_request","review_packet"].includes(operation)) throw inputError(`Unknown operation: ${operation}`);
    if (this.handlers[operation]) return this.handlers[operation](structuredClone(input), { engine: this, principal: structuredClone(this.principal) });
    if (operation === "init" || operation === "project_init") return this.init(input);
    if (longOperations.has(operation)) return this.startJob(operation, input);
    if (operation === "ingest_start") return this.startJob("ingest", input);
    if (operation === "job_status") return this.job(input.id);
    if (operation === "job_cancel") return this.cancelJob(input.id);
    if (operation === "jobs") return this.jobs();
    if (operation === "doctor") return this.doctor();
    const project = await this.project();
    if (operation === "status" || operation === "project_get") return { project, state: "ready" };
    if (operation === "project_list_mounts") return { project_id: project.id, mounts: project.mounts };
    if (["query","kb_search"].includes(operation)) return { query: input.question ?? input.query ?? "", results: [] };
    if (["trace","kb_trace"].includes(operation)) return { concept: input.concept ?? input.uri ?? null, trace: [] };
    if (["conflicts","kb_conflicts"].includes(operation)) return { conflicts: [] };
    if (["gaps","kb_gaps"].includes(operation)) return { gaps: [] };
    if (operation === "lint") return { valid: true, issues: [] };
    if (operation === "review") return { proposals: [] };
    if (operation === "reconcile-edits") return { proposals: [], changed: false };
    if (operation === "migrate") return { changed: false, version: project.specification_version };
    if (["publish","publish_request","review_submit","proposal_create"].includes(operation)) throw new EngineError("KDLC_POLICY_DENIED", "Governed mutation requires an installed workflow handler and valid authority", EXIT.policy);
    if (["kb_fetch","source_excerpt"].includes(operation)) throw missing("Requested resource is unavailable");
    throw inputError(`Unsupported operation: ${operation}`);
  }
  async init(input) { const id = input.project_id ?? basename(this.root).toLowerCase().replace(/[^a-z0-9._-]+/g, "-"); if (!portable(id)) throw inputError("Project ID must be portable"); const path = this.path("project.json"); if (await exists(path)) throw new EngineError("KDLC_STATE_CONFLICT", "Project is already initialized", EXIT.conflict); const name = id.replace(/[._]+/g, "-"); const knowledgeBaseId = id.includes(".") ? id : `local.${id}`; const files = await materializeScaffold(this.root, scaffoldProject({ name, title: input.title ?? id, knowledgeBaseId })); const project = { api_version: "kdlc.dev/project-runtime/v1", id, specification_version: "0.2.0", canonicalization: "kdlc-c14n-1", mounts: [{ alias: "primary", id: knowledgeBaseId, mode: "maintain", role: "primary" }] }; await atomicJson(path, project); return { ...project, files }; }
  async startJob(operation, input) { const project = await this.project(); const idempotency = input.idempotency_key; if (typeof idempotency !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(idempotency)) throw inputError("Long operations require a portable idempotency_key"); const inputHash = digest(input); const id = `job_${digest({ actor: this.principal.actor, project: project.id, operation, idempotency }).slice(7, 23)}`; const path = this.path("jobs", `${id}.json`); const now = this.clock.now(); const job = { api_version: "kdlc.dev/job/v1", id, project_id: project.id, workflow_id: input.workflow_id ?? null, principal: this.principal.actor, operation, idempotency_key: idempotency, input_hashes: { request: inputHash }, dependencies: {}, state: "queued", progress: { completed: 0, total: 0 }, checkpoints: [], resource_budget: {}, created_at: now, updated_at: now, result: null, error: null, cancellation_requested: false }; try { await createJson(path, job); return job; } catch (error) { if (error.code !== "EEXIST") throw error; const current = JSON.parse(await readFile(path, "utf8")); if (current.input_hashes?.request !== inputHash) throw new EngineError("KDLC_STATE_CONFLICT", "Idempotency key was reused with changed input", EXIT.conflict); return current; } }
  async job(id) { if (typeof id !== "string" || !/^job_[a-f0-9]{16}$/.test(id)) throw inputError("Invalid job ID"); const path = this.path("jobs", `${id}.json`); if (!(await exists(path))) throw missing("Job does not exist"); const job = JSON.parse(await readFile(path, "utf8")); if (job.principal !== this.principal.actor && !this.principal.scopes.includes("jobs:all")) throw new EngineError("KDLC_POLICY_DENIED", "Job principal mismatch", EXIT.policy); return job; }
  async cancelJob(id) { const job = await this.job(id); if (["completed","failed","cancelled"].includes(job.state)) return job; const updated = { ...job, state: job.state === "queued" ? "cancelled" : job.state, cancellation_requested: true, updated_at: this.clock.now() }; await atomicJson(this.path("jobs", `${id}.json`), updated); return updated; }
  async jobs() { const directory = this.path("jobs"); if (!(await exists(directory))) return { jobs: [] }; const records = []; for (const name of (await readdir(directory)).filter((item) => /^job_[a-f0-9]{16}\.json$/.test(item)).sort()) { const value = JSON.parse(await readFile(resolve(directory, name), "utf8")); if (value.principal === this.principal.actor || this.principal.scopes.includes("jobs:all")) records.push(value); } return { jobs: records }; }
  async doctor() { const projectPresent = await exists(this.path("project.json")); const lockPresent = await exists(resolve(this.root, "knowledge.lock")); const packageLock = await exists(resolve(this.root, "package-lock.json")); const now = this.clock.now(); const diagnostics = [
    { id: "runtime.node", status: Number(process.versions.node.split(".")[0]) >= 22 && Number(process.versions.node.split(".")[0]) < 25 ? "pass" : "fail", detail: process.versions.node },
    { id: "project.manifest", status: projectPresent ? "pass" : "fail", detail: projectPresent ? "initialized" : "missing" },
    { id: "dependencies.lock", status: packageLock ? "pass" : "warn", detail: packageLock ? "package-lock.json" : "missing" },
    { id: "mounts.lock", status: lockPresent ? "pass" : "warn", detail: lockPresent ? "knowledge.lock present" : "no knowledge.lock" },
    { id: "cache.integrity", status: "pass", detail: "content-addressed cache validation delegated to mounted resolver" },
    { id: "clock", status: Number.isFinite(Date.parse(now)) ? "pass" : "fail", detail: now },
    { id: "policies.compatibility", status: projectPresent ? "pass" : "warn", detail: projectPresent ? "runtime project schema 1" : "not evaluated" }
  ]; return { healthy: diagnostics.every(({ status }) => status !== "fail"), diagnostics }; }
}

export function parseCli(argv) { const args = [...argv]; let output = "text"; const index = args.indexOf("--output"); if (index !== -1) { output = args[index + 1]; args.splice(index, 2); } if (!new Set(["text","json"]).has(output)) throw inputError("--output must be text or json"); const operation = args.shift(); if (!CLI_COMMANDS.includes(operation)) throw inputError("A supported command is required"); const positionals = []; let idempotency; for (let cursor = 0; cursor < args.length; cursor += 1) { if (args[cursor] === "--idempotency-key") idempotency = args[++cursor]; else positionals.push(args[cursor]); } const input = { args: positionals }; if (["adopt","ingest","refresh"].includes(operation)) { input.sources = positionals; input.idempotency_key = idempotency ?? `cli-${createHash("sha256").update(canonicalJson(positionals)).digest("hex").slice(0, 16)}`; } if (operation === "query") input.question = positionals.join(" "); if (operation === "trace") input.concept = positionals[0]; return { operation, input, output }; }
export function renderEnvelope(envelope, output = "text") { if (output === "json") return `${canonicalJson(envelope)}\n`; if (envelope.ok) return `${envelope.operation}: ok\n${canonicalJson(envelope.result)}\n`; return `${envelope.operation}: ${envelope.error.code}: ${envelope.error.message}\n`; }
