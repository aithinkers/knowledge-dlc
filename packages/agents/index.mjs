import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../core/index.mjs";
import { createContractValidator } from "../contracts/index.mjs";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const roleRoot = resolve(packageRoot, "roles");
const safeSegment = /^[A-Za-z0-9._-]+$/;
const reviewerRoles = new Set(["trust-reviewer", "governance-reviewer"]);
const authenticatedSessions = new WeakSet();
const trustedReviewContexts = new WeakMap();

export const AGENT_WORKFLOW_SCHEMA_PATHS = Object.freeze({
  conceptProposal: "core/schemas/artifacts/concept-proposal.schema.json",
  recordedNormalizedFixture: "core/schemas/agents/recorded-normalized-fixture.schema.json",
  recordedModelOutput: "core/schemas/agents/recorded-model-output.schema.json",
  roleDescriptor: "core/schemas/agents/role-descriptor.schema.json",
  publicationIntent: "core/schemas/artifacts/publication-intent.schema.json",
  governedReviewPacket: "core/schemas/artifacts/governed-review-packet.schema.json",
  reviewDecision: "core/schemas/artifacts/review-decision.schema.json",
  freshnessAuthorization: "core/schemas/artifacts/freshness-authorization.schema.json",
  freshnessDecision: "core/schemas/artifacts/freshness-decision.schema.json",
  reviewContext: "core/schemas/artifacts/review-context.schema.json"
});

export class AgentPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AgentPolicyError";
    this.code = code;
    this.details = details;
  }
}

function safePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0") || posix.isAbsolute(value)) {
    throw new AgentPolicyError("KDLC_PATH_INVALID", "Capability paths must be non-empty repository-relative POSIX paths");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !safeSegment.test(segment) || segment === "." || segment === "..") || posix.normalize(value) !== value) {
    throw new AgentPolicyError("KDLC_PATH_INVALID", `Unsafe capability path: ${value}`);
  }
  return segments;
}

function safePattern(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0") || posix.isAbsolute(value)) {
    throw new AgentPolicyError("KDLC_ROLE_INVALID", `Unsafe capability pattern: ${value}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => (segment !== "*" && segment !== "**" && !safeSegment.test(segment)) || segment === "." || segment === "..")) {
    throw new AgentPolicyError("KDLC_ROLE_INVALID", `Unsafe capability pattern: ${value}`);
  }
  return segments;
}

function matches(pattern, target) {
  const expected = safePattern(pattern);
  const actual = safePath(target);
  function visit(left, right) {
    if (left === expected.length) return right === actual.length;
    if (expected[left] === "**") {
      if (left === expected.length - 1) return true;
      for (let next = right; next <= actual.length; next += 1) if (visit(left + 1, next)) return true;
      return false;
    }
    if (right === actual.length || (expected[left] !== "*" && expected[left] !== actual[right])) return false;
    return visit(left + 1, right + 1);
  }
  return visit(0, 0);
}

export async function loadRoleDescriptors({ root = roleRoot, validator } = {}) {
  const contracts = validator ?? await createContractValidator(undefined, AGENT_WORKFLOW_SCHEMA_PATHS);
  const files = (await readdir(root)).filter((name) => name.endsWith(".json")).sort();
  const roles = new Map();
  for (const file of files) {
    const descriptor = JSON.parse(await readFile(resolve(root, file), "utf8"));
    const result = contracts.validate("roleDescriptor", descriptor);
    if (!result.valid) throw new AgentPolicyError("KDLC_ROLE_INVALID", `Invalid role descriptor: ${file}`, { errors: result.errors });
    if (roles.has(descriptor.role)) throw new AgentPolicyError("KDLC_ROLE_INVALID", `Duplicate role descriptor: ${descriptor.role}`);
    if (descriptor.actor !== `kdlc-${descriptor.role}/0.2.0`) throw new AgentPolicyError("KDLC_ROLE_INVALID", `Role ${descriptor.role} has a spoofed producer actor`);
    if (descriptor.review_only !== reviewerRoles.has(descriptor.role)) throw new AgentPolicyError("KDLC_ROLE_INVALID", `Role ${descriptor.role} has an invalid review-only classification`);
    for (const pattern of [...descriptor.permissions.read, ...descriptor.permissions.write]) safePattern(pattern);
    roles.set(descriptor.role, structuredClone(descriptor));
  }
  return roles;
}

export class CapabilityRuntime {
  #roles;

  constructor(roles) {
    this.#roles = new Map(roles);
  }

  static async create(options) { return new CapabilityRuntime(await loadRoleDescriptors(options)); }

  descriptor(role) {
    const descriptor = this.#roles.get(role);
    if (!descriptor) throw new AgentPolicyError("KDLC_ROLE_UNKNOWN", `Unknown agent role: ${role}`);
    return structuredClone(descriptor);
  }

  authorize(role, operation, path) {
    if (operation !== "read" && operation !== "write") throw new AgentPolicyError("KDLC_CAPABILITY_INVALID", `Unknown capability operation: ${operation}`);
    const descriptor = this.descriptor(role);
    safePath(path);
    if (reviewerRoles.has(role) && operation === "write") {
      throw new AgentPolicyError("KDLC_REVIEWER_READ_ONLY", `${role} cannot mutate reviewed artifacts`, { operation, path });
    }
    if (!descriptor.permissions[operation].some((pattern) => matches(pattern, path))) {
      throw new AgentPolicyError("KDLC_CAPABILITY_DENIED", `${role} cannot ${operation} ${path}`, { role, operation, path });
    }
    return true;
  }

}

function cloneJson(value) { return JSON.parse(canonicalJson(value)); }

export class MediatedAgentRuntime {
  #capabilities;
  #store;

  constructor({ capabilities, store }) {
    if (!capabilities || typeof store?.get !== "function" || typeof store?.put !== "function") throw new TypeError("Mediated runtime requires capabilities and a read/write store");
    this.#capabilities = capabilities;
    this.#store = store;
  }

  async read(role, path) {
    this.#capabilities.authorize(role, "read", path);
    return cloneJson(await this.#store.get(path));
  }

  async write(role, path, value) {
    this.#capabilities.authorize(role, "write", path);
    const safeValue = cloneJson(value);
    await this.#store.put(path, safeValue);
    return safeValue;
  }

}

export class RepositoryFileStore {
  #handles;

  constructor(token, handles) {
    if (token !== repositoryStoreToken) throw new TypeError("Use RepositoryFileStore.create with an explicit path allowlist");
    this.#handles = handles;
  }

  static async create(root, paths) {
    if (typeof root !== "string" || root.length === 0 || !Array.isArray(paths) || !paths.length) throw new TypeError("Repository file store requires a root and explicit non-empty path allowlist");
    const canonicalRoot = await realpath(root); const handles = new Map();
    try {
      for (const declaration of paths) {
        const path = typeof declaration === "string" ? declaration : declaration?.path; const writable = declaration?.write === true;
        const segments = safePath(path); let current = canonicalRoot;
        for (const segment of segments) {
          current = resolve(current, segment);
          const metadata = await lstat(current);
          if (metadata.isSymbolicLink()) throw new AgentPolicyError("KDLC_PATH_SYMLINK", `Capability path crosses a symbolic link: ${path}`);
          const canonical = await realpath(current);
          if (!canonical.startsWith(`${canonicalRoot}/`)) throw new AgentPolicyError("KDLC_PATH_ESCAPE", `Capability path escapes repository root: ${path}`);
          current = canonical;
        }
        const handle = await open(current, (writable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW);
        const opened = await handle.stat(); const resolved = await lstat(current);
        if (!opened.isFile() || opened.dev !== resolved.dev || opened.ino !== resolved.ino) { await handle.close(); throw new AgentPolicyError("KDLC_PATH_RACE", `Capability target changed while it was opened: ${path}`); }
        handles.set(path, { handle, writable });
      }
      return new RepositoryFileStore(repositoryStoreToken, handles);
    } catch (error) {
      await Promise.all([...handles.values()].map(({ handle }) => handle.close().catch(() => {})));
      throw error;
    }
  }

  #handle(path) {
    const entry = this.#handles.get(path);
    if (!entry) throw new AgentPolicyError("KDLC_PATH_UNDECLARED", `Repository capability path was not declared before execution: ${path}`);
    return entry;
  }

  async get(path) {
    const { handle } = this.#handle(path); const metadata = await handle.stat(); const bytes = Buffer.alloc(metadata.size);
    await handle.read(bytes, 0, bytes.length, 0); return JSON.parse(bytes.toString("utf8"));
  }
  async put(path, value) {
    const { handle, writable } = this.#handle(path); if (!writable) throw new AgentPolicyError("KDLC_PATH_READ_ONLY", `Repository capability path is read-only: ${path}`);
    const bytes = Buffer.from(`${canonicalJson(value)}\n`);
    await handle.truncate(0); await handle.write(bytes, 0, bytes.length, 0); await handle.sync();
  }
  async close() { await Promise.all([...this.#handles.values()].map(({ handle }) => handle.close())); this.#handles.clear(); }
}

const repositoryStoreToken = Object.freeze({});

export class RecordedModelRuntime {
  #validator;

  constructor(validator) { this.#validator = validator; }

  static async create({ validator } = {}) { return new RecordedModelRuntime(validator ?? await createContractValidator(undefined, AGENT_WORKFLOW_SCHEMA_PATHS)); }

  replay(recording, { task, inputHashes }) {
    const result = this.#validator.validate("recordedModelOutput", recording);
    if (!result.valid) throw new AgentPolicyError("KDLC_MODEL_RECORDING_INVALID", "Recorded model output failed schema validation", { errors: result.errors });
    if (recording.task !== task || canonicalJson(recording.input_hashes) !== canonicalJson(inputHashes)) {
      throw new AgentPolicyError("KDLC_MODEL_RECORDING_DRIFT", "Recorded model output does not bind the requested task and inputs");
    }
    const claims = new Map(recording.claims.map((claim) => [claim.id, claim]));
    if (claims.size !== recording.claims.length) throw new AgentPolicyError("KDLC_MODEL_RECORDING_INVALID", "Recorded model output contains duplicate claim IDs");
    const proposals = new Set(recording.proposals.map(({ id }) => id));
    if (proposals.size !== recording.proposals.length) throw new AgentPolicyError("KDLC_MODEL_RECORDING_INVALID", "Recorded model output contains duplicate proposal IDs");
    for (const proposal of recording.proposals) {
      const decisions = new Set(proposal.claim_decisions.map(({ claim_id }) => claim_id));
      const dispositionDrift = proposal.claim_decisions.some(({ claim_id, disposition }) => claims.get(claim_id)?.status !== disposition);
      if (proposal.task !== task || proposal.created_by !== "kdlc-integrator/0.2.0" || proposal.claim_ids.some((id) => !claims.has(id)) || decisions.size !== proposal.claim_decisions.length || canonicalJson([...decisions].sort()) !== canonicalJson([...proposal.claim_ids].sort()) || dispositionDrift) {
        throw new AgentPolicyError("KDLC_MODEL_RECORDING_INVALID", `Proposal ${proposal.id} does not bind recorded claims and task`);
      }
    }
    return structuredClone(recording);
  }
}

export class PrincipalAuthority {
  #principals;

  constructor(principals) {
    if (!Array.isArray(principals)) throw new TypeError("PrincipalAuthority requires trusted principal records");
    this.#principals = new Map();
    for (const principal of principals) {
      const allowed = new Set(["id", "actor", "principal_mode", "issuer", "review_roles"]);
      if (!principal || typeof principal.id !== "string" || !/^(?:human|process):[A-Za-z0-9._@/-]+$/.test(principal.actor ?? "") || !["local", "served", "automation"].includes(principal.principal_mode) || !Array.isArray(principal.review_roles) || principal.review_roles.some((role) => !reviewerRoles.has(role)) || new Set(principal.review_roles).size !== principal.review_roles.length || Object.keys(principal).some((key) => !allowed.has(key)) || (principal.principal_mode === "served" && typeof principal.issuer !== "string")) {
        throw new AgentPolicyError("KDLC_PRINCIPAL_INVALID", "Trusted principal record is invalid");
      }
      if (this.#principals.has(principal.id)) throw new AgentPolicyError("KDLC_PRINCIPAL_INVALID", `Duplicate trusted principal: ${principal.id}`);
      this.#principals.set(principal.id, structuredClone(principal));
    }
  }

  establishReviewSession(id, role) {
    const principal = this.#principals.get(id);
    if (!principal) throw new AgentPolicyError("KDLC_PRINCIPAL_UNRESOLVED", `Review principal is not established by the trusted runtime: ${id}`);
    if (!principal.review_roles.includes(role)) throw new AgentPolicyError("KDLC_REVIEW_ROLE_DENIED", `Principal ${id} is not authenticated for ${role}`);
    const { id: ignored, review_roles: ignoredRoles, ...reviewer } = principal;
    const session = Object.freeze({ role, reviewer: Object.freeze(structuredClone(reviewer)) });
    authenticatedSessions.add(session);
    return session;
  }
}

export function resolveAuthenticatedReviewSession(session) {
  if (!session || !authenticatedSessions.has(session) || !reviewerRoles.has(session.role)) throw new AgentPolicyError("KDLC_SESSION_INVALID", "Review decision requires a trusted authenticated session");
  return { role: session.role, reviewer: structuredClone(session.reviewer) };
}

export class ReviewContextAuthority {
  #contexts;

  constructor(records) {
    if (!Array.isArray(records)) throw new TypeError("ReviewContextAuthority requires trusted executed context records");
    this.#contexts = new Map();
    for (const record of records) {
      if (!record || typeof record.workflow_id !== "string" || !record.context || this.#contexts.has(record.workflow_id)) throw new AgentPolicyError("KDLC_REVIEW_CONTEXT_INVALID", "Trusted review context record is invalid or duplicated");
      this.#contexts.set(record.workflow_id, structuredClone(record.context));
    }
  }

  establish(workflowId) {
    if (!this.#contexts.has(workflowId)) throw new AgentPolicyError("KDLC_REVIEW_CONTEXT_UNRESOLVED", `No trusted executed review context exists for ${workflowId}`);
    const session = Object.freeze({ workflow_id: workflowId });
    trustedReviewContexts.set(session, structuredClone(this.#contexts.get(workflowId)));
    return session;
  }
}

export function resolveTrustedReviewContext(session, workflowId) {
  if (!session || !trustedReviewContexts.has(session) || session.workflow_id !== workflowId) throw new AgentPolicyError("KDLC_REVIEW_CONTEXT_UNTRUSTED", "Recorded workflow requires a trusted executed review context for the exact workflow");
  return structuredClone(trustedReviewContexts.get(session));
}
