import { readFile, readdir } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../core/index.mjs";
import { createContractValidator } from "../contracts/index.mjs";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const roleRoot = resolve(packageRoot, "roles");
const safeSegment = /^[A-Za-z0-9._-]+$/;
const reviewerRoles = new Set(["trust-reviewer", "governance-reviewer"]);

export const AGENT_WORKFLOW_SCHEMA_PATHS = Object.freeze({
  conceptProposal: "core/schemas/artifacts/concept-proposal.schema.json",
  recordedNormalizedFixture: "core/schemas/agents/recorded-normalized-fixture.schema.json",
  recordedModelOutput: "core/schemas/agents/recorded-model-output.schema.json",
  roleDescriptor: "core/schemas/agents/role-descriptor.schema.json",
  publicationIntent: "core/schemas/artifacts/publication-intent.schema.json"
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
    if (reviewerRoles.has(role) && operation === "write" && !matches("workflow/runs/**/receipts/**", path)) {
      throw new AgentPolicyError("KDLC_REVIEWER_READ_ONLY", `${role} cannot mutate reviewed artifacts`, { operation, path });
    }
    if (!descriptor.permissions[operation].some((pattern) => matches(pattern, path))) {
      throw new AgentPolicyError("KDLC_CAPABILITY_DENIED", `${role} cannot ${operation} ${path}`, { role, operation, path });
    }
    return true;
  }

  async run(role, operations, action) {
    if (!Array.isArray(operations) || typeof action !== "function") throw new TypeError("Capability run requires operations and an action");
    for (const { operation, path } of operations) this.authorize(role, operation, path);
    return action();
  }
}

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
      const allowed = new Set(["id", "actor", "principal_mode", "issuer"]);
      if (!principal || typeof principal.id !== "string" || !/^(?:human|process):[A-Za-z0-9._@/-]+$/.test(principal.actor ?? "") || !["local", "served", "automation"].includes(principal.principal_mode) || Object.keys(principal).some((key) => !allowed.has(key)) || (principal.principal_mode === "served" && typeof principal.issuer !== "string")) {
        throw new AgentPolicyError("KDLC_PRINCIPAL_INVALID", "Trusted principal record is invalid");
      }
      if (this.#principals.has(principal.id)) throw new AgentPolicyError("KDLC_PRINCIPAL_INVALID", `Duplicate trusted principal: ${principal.id}`);
      this.#principals.set(principal.id, structuredClone(principal));
    }
  }

  resolve(id) {
    const principal = this.#principals.get(id);
    if (!principal) throw new AgentPolicyError("KDLC_PRINCIPAL_UNRESOLVED", `Review principal is not established by the trusted runtime: ${id}`);
    const { id: ignored, ...reviewer } = principal;
    return structuredClone(reviewer);
  }
}
