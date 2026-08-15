import { artifactHash, canonicalJson } from "../../core/index.mjs";
import { createContractValidator } from "../../contracts/index.mjs";
import { GovernanceError } from "../index.mjs";

export const GOVERNANCE_CONTROL_SCHEMA_PATHS = Object.freeze({
  governanceSensorDescriptor: "core/schemas/governance/sensor-descriptor.schema.json",
  governanceControlReport: "core/schemas/governance/control-report.schema.json"
});

const GATES = new Set(["ingest", "review", "retrieval", "model-route", "publication", "erasure"]);
const CLASSIFICATION = Object.freeze({ public: 0, internal: 1, confidential: 2, restricted: 3 });
const SENSOR_SPECS = Object.freeze([
  ["secret-pattern", ["ingest", "review", "model-route", "publication"]],
  ["classification-declassification", ["ingest", "review", "retrieval", "model-route", "publication"]],
  ["rights-license", ["ingest", "review", "publication"]],
  ["external-model-route", ["model-route"]],
  ["retention-legal-hold", ["ingest", "erasure"]],
  ["prompt-injection", ["ingest", "review", "model-route"]],
  ["falsehood-provenance", ["review", "publication"]]
]);

export const BUILT_IN_GOVERNANCE_SENSORS = Object.freeze(SENSOR_SPECS.map(([id, gates]) => Object.freeze({
  api_version: "kdlc.dev/governance-sensor/v1alpha1", id, version: 1, severity: "error", blocking: true, deterministic: true, gates: Object.freeze(gates)
})));

const authoritySessions = new WeakMap();
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function isRfc3339Instant(value) {
  const match = typeof value === "string" ? RFC3339.exec(value) : null;
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59
    && Number(match[7] ?? 0) <= 14 && Number(match[8] ?? 0) <= 59
    && (Number(match[7] ?? 0) < 14 || Number(match[8] ?? 0) === 0) && Number.isFinite(Date.parse(value));
}

function fail(code, message, details = {}) { throw new GovernanceError(code, message, details); }
function jsonClone(value) { try { return JSON.parse(canonicalJson(value)); } catch { fail("KDLC_GOVERNANCE_CONTEXT_INVALID", "Governance input must be stable JSON"); } }
function stringArray(value) { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
function classification(value) { return Object.hasOwn(CLASSIFICATION, value) ? value : null; }
function at(clock) {
  const value = clock.now();
  if (!(value instanceof Date) && !isRfc3339Instant(value)) fail("KDLC_TRUSTED_CLOCK_INVALID", "Trusted governance clock returned a non-RFC3339 instant");
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail("KDLC_TRUSTED_CLOCK_INVALID", "Trusted governance clock returned an invalid instant");
  return date;
}
function distinct(values) { return [...new Set(values)].sort(); }
function contentStrings(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) for (const item of value) contentStrings(item, output);
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { output.push(key); contentStrings(item, output); }
  return output;
}
function secretCodes(value) {
  const text = contentStrings(value).join("\n");
  const patterns = [
    ["KDLC_SECRET_PRIVATE_KEY", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
    ["KDLC_SECRET_BEARER", /\b(?:authorization\s*[:=]\s*)?bearer\s+[A-Za-z0-9._~+/=-]{12,}/iu],
    ["KDLC_SECRET_AWS_KEY", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u],
    ["KDLC_SECRET_ASSIGNMENT", /\b(?:api[_-]?key|client[_-]?secret|password|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/iu]
  ];
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([code]) => code);
}
function injectionCodes(value) {
  const text = contentStrings(value).join("\n");
  const patterns = [
    /\bignore (?:all |any )?(?:previous|prior|system|developer) instructions?\b/iu,
    /\b(?:reveal|print|return|exfiltrate) (?:the )?(?:secret|credential|system prompt|environment variable)/iu,
    /\b(?:run|execute|spawn) (?:this |the )?(?:command|shell|script)/iu,
    /\b(?:disable|bypass|override|alter) (?:the )?(?:policy|approval|guardrail|workflow state)/iu
  ];
  return patterns.some((pattern) => pattern.test(text)) ? ["KDLC_PROMPT_INJECTION"] : [];
}
function materials(context) { return Array.isArray(context.materials) ? context.materials : []; }
function mostRestricted(context) {
  const levels = materials(context).map((item) => classification(item?.access?.classification));
  if (!levels.length || levels.some((value) => value === null)) return null;
  return levels.reduce((left, right) => CLASSIFICATION[right] > CLASSIFICATION[left] ? right : left, "public");
}
function hasAccess(context, required) {
  const clearance = classification(context.principal?.clearance);
  if (!clearance || CLASSIFICATION[clearance] < CLASSIFICATION[required]) return false;
  const requiredCompartments = distinct(materials(context).flatMap((item) => item?.access?.compartments ?? []));
  const held = new Set(context.principal?.compartments ?? []);
  return requiredCompartments.every((item) => held.has(item));
}
function rightsCodes(context) {
  if (!materials(context).length) return ["KDLC_RIGHTS_MISSING"];
  const codes = [];
  for (const material of materials(context)) {
    const rights = material?.rights;
    if (!rights || rights.redistribution === "unknown" || (!rights.license && !rights.terms)) codes.push("KDLC_RIGHTS_LEGAL_REVIEW_REQUIRED");
    if (["public", "external"].includes(context.target?.scope) && ["prohibited", "metadata-only"].includes(rights?.redistribution) && context.transformation !== "metadata-only") codes.push("KDLC_RIGHTS_REDISTRIBUTION_PROHIBITED");
    if (context.transformation === "derivative" && rights?.derivative_use !== "allowed") codes.push("KDLC_RIGHTS_DERIVATIVE_PROHIBITED");
    if (context.target?.commercial === true && rights?.commercial_use !== "allowed") codes.push("KDLC_RIGHTS_COMMERCIAL_PROHIBITED");
    if (rights?.expires_at && !isRfc3339Instant(rights.expires_at)) codes.push("KDLC_RIGHTS_EXPIRY_INVALID");
    else if (rights?.expires_at && Date.parse(rights.expires_at) <= context.nowMillis) codes.push("KDLC_RIGHTS_EXPIRED");
  }
  return distinct(codes);
}
function falsehoodCodes(context, policy) {
  const claims = Array.isArray(context.claims) ? context.claims : [];
  const codes = [];
  for (const claim of claims) {
    const sources = Array.isArray(claim.sources) ? claim.sources : [];
    const sourceIds = distinct(sources.map((source) => source.source_id).filter(Boolean));
    if (sources.some((source) => source.source_class === "authoritative" && typeof source.authority_policy_ref !== "string")) codes.push("KDLC_AUTHORITY_METADATA_UNTRUSTED");
    if (claim.consequential === true && sourceIds.length < policy.minimum_independent_sources) codes.push("KDLC_FALSEHOOD_CORROBORATION_REQUIRED");
    if (claim.conflict === true || sources.some((source) => source.compromised === true)) codes.push("KDLC_FALSEHOOD_CONFLICT_UNRESOLVED");
  }
  return distinct(codes);
}

export class GovernanceControlAuthority {
  #authenticate; #clock; #audit; #policy; #waivers = new WeakMap(); #declassifications = new WeakMap(); #erasureAuthorizations = new WeakMap();
  constructor({ authenticate, clock, audit }) {
    if (typeof authenticate !== "function" || typeof clock?.now !== "function" || typeof audit?.append !== "function") fail("KDLC_GOVERNANCE_AUTHORITY_INVALID", "Governance authority requires authentication, a trusted clock, and durable audit");
    this.#authenticate = authenticate; this.#clock = clock; this.#audit = audit;
  }
  async openSession(credential) {
    const identity = await this.#authenticate(credential);
    if (!identity || typeof identity.actor !== "string" || !stringArray(identity.roles)) fail("KDLC_AUTHENTICATION_DENIED", "Governance authentication failed");
    const session = Object.freeze({ kind: "kdlc-governance-session-1" });
    authoritySessions.set(session, Object.freeze({ authority: this, identity: jsonClone(identity) }));
    return session;
  }
  bindPolicy(policy) {
    const value = Object.freeze(jsonClone(policy));
    if (this.#policy && artifactHash(this.#policy) !== artifactHash(value)) fail("KDLC_GOVERNANCE_POLICY_CONFLICT", "Governance authority is already bound to another policy");
    this.#policy = value;
  }
  #identity(session, roles) {
    const state = authoritySessions.get(session);
    if (!state || state.authority !== this || !state.identity.roles.some((role) => roles.includes(role))) fail("KDLC_GOVERNANCE_AUTHORITY_DENIED", "Authenticated governance authority is required");
    return state.identity;
  }
  async issueWaiver(session, { id, sensor_id, gate, subject, reason, expires_at }) {
    const roles = this.#policy?.waiver_authorities?.[sensor_id]?.[gate] ?? [];
    const identity = this.#identity(session, roles); const now = at(this.#clock);
    if (!roles.length || typeof id !== "string" || !id || typeof reason !== "string" || !reason || !GATES.has(gate) || !BUILT_IN_GOVERNANCE_SENSORS.some((sensor) => sensor.id === sensor_id) || typeof subject !== "string" || !subject || !isRfc3339Instant(expires_at) || Date.parse(expires_at) <= now.getTime()) fail("KDLC_WAIVER_INVALID", "Waiver scope and validity must be exact, policy-authorized, and current");
    const token = Object.freeze({ kind: "kdlc-governance-waiver-1", id });
    const state = Object.freeze({ id, sensor_id, gate, subject, reason, authority: identity.actor, issued_at: now.toISOString(), expires_at });
    await this.#audit.append(Object.freeze({ action: "governance.waiver.issued", actor: identity.actor, subject, sensor_id, gate, waiver_id: id, at: state.issued_at }));
    this.#waivers.set(token, state); return token;
  }
  async issueDeclassification(session, { id, subject, from, to, policy_ref, reason, expires_at }) {
    const rule = this.#policy?.declassification_authorities?.[policy_ref];
    const identity = this.#identity(session, rule?.roles ?? []); const now = at(this.#clock);
    if (!rule || !id || !subject || !classification(from) || !classification(to) || CLASSIFICATION[to] >= CLASSIFICATION[from] || !rule.from?.includes(from) || !rule.to?.includes(to) || !reason || !isRfc3339Instant(expires_at) || Date.parse(expires_at) <= now.getTime()) fail("KDLC_DECLASSIFICATION_INVALID", "Declassification must be a scoped, current downgrade under an active policy");
    const token = Object.freeze({ kind: "kdlc-declassification-1", id });
    const state = Object.freeze({ id, subject, from, to, policy_ref, reason, authority: identity.actor, issued_at: now.toISOString(), expires_at });
    await this.#audit.append(Object.freeze({ action: "governance.declassification.issued", actor: identity.actor, subject, from, to, policy_ref, authorization_id: id, at: state.issued_at }));
    this.#declassifications.set(token, state); return token;
  }
  async issueErasureAuthorization(session, { id, subject, action, policy_ref, reason, expires_at }) {
    const rule = this.#policy?.erasure_policy_refs?.[policy_ref];
    const identity = this.#identity(session, rule?.roles ?? []); const now = at(this.#clock);
    if (!rule || !id || !subject || !["revoke", "erase"].includes(action) || !rule.actions?.includes(action) || !reason || !isRfc3339Instant(expires_at) || Date.parse(expires_at) <= now.getTime()) fail("KDLC_ERASURE_AUTHORIZATION_INVALID", "Revocation or erasure authorization must be policy-scoped and current");
    const authorization = Object.freeze({ id, subject, action, policy_ref, reason, authority: identity.actor, issued_at: now.toISOString(), expires_at });
    const token = Object.freeze({ kind: "kdlc-erasure-authorization-1", id });
    await this.#audit.append(Object.freeze({ action: "governance.erasure.authorized", actor: identity.actor, subject, requested_action: action, authorization_hash: artifactHash(authorization), at: authorization.issued_at }));
    this.#erasureAuthorizations.set(token, authorization); return token;
  }
  waiver(token) { return this.#waivers.get(token); }
  declassification(token) { return this.#declassifications.get(token); }
  erasureAuthorization(token) {
    const authorization = this.#erasureAuthorizations.get(token); const now = at(this.#clock);
    return authorization && isRfc3339Instant(authorization.issued_at) && isRfc3339Instant(authorization.expires_at) && Date.parse(authorization.issued_at) <= now.getTime() && Date.parse(authorization.expires_at) > now.getTime() ? authorization : undefined;
  }
}

export class GovernanceControlEngine {
  #policy; #policyHash; #clock; #audit; #authority; #validator; #erasureVerifier;
  constructor({ policy, clock, audit, authority, validator, erasureVerifier }) {
    if (!policy || policy.api_version !== "kdlc.dev/governance-policy/v1alpha1" || !Number.isInteger(policy.version) || policy.version < 1 || !Number.isInteger(policy.minimum_independent_sources) || policy.minimum_independent_sources < 1 || !Array.isArray(policy.required_erasure_surfaces) || !policy.external_models || typeof policy.external_models !== "object" || !policy.waiver_authorities || !policy.declassification_authorities || !policy.erasure_policy_refs) fail("KDLC_GOVERNANCE_POLICY_INVALID", "A complete versioned governance policy is required");
    if (typeof clock?.now !== "function" || typeof audit?.append !== "function" || !(authority instanceof GovernanceControlAuthority) || !validator) fail("KDLC_GOVERNANCE_RUNTIME_INVALID", "Governance controls require trusted clock, audit, authority, and schemas");
    this.#policy = Object.freeze(jsonClone(policy)); this.#policyHash = artifactHash(this.#policy); this.#clock = clock; this.#audit = audit; this.#authority = authority; this.#validator = validator; this.#erasureVerifier = erasureVerifier; authority.bindPolicy(this.#policy);
  }
  static async create(options) {
    return new GovernanceControlEngine({ ...options, validator: options.validator ?? await createContractValidator(undefined, GOVERNANCE_CONTROL_SCHEMA_PATHS) });
  }
  #codes(sensor, context, now) {
    if (sensor.id === "secret-pattern") return secretCodes(context.content ?? context.payload ?? context.materials ?? []);
    if (sensor.id === "prompt-injection") return injectionCodes(context.content ?? context.payload ?? []);
    if (sensor.id === "rights-license") return rightsCodes({ ...context, nowMillis: now.getTime() });
    if (sensor.id === "falsehood-provenance") return falsehoodCodes(context, this.#policy);
    if (sensor.id === "classification-declassification") {
      const required = mostRestricted(context); const derived = classification(context.derived_access?.classification);
      if (!required) return ["KDLC_CLASSIFICATION_MISSING"];
      if (context.gate === "retrieval" && !hasAccess(context, required)) return ["KDLC_ACCESS_DENIED"];
      if (derived && CLASSIFICATION[derived] < CLASSIFICATION[required]) {
        const auth = this.#authority.declassification(context.declassification);
        const rule = auth && this.#policy.declassification_authorities[auth.policy_ref];
        if (!auth || !rule || auth.subject !== context.subject || auth.from !== required || auth.to !== derived || !isRfc3339Instant(auth.issued_at) || !isRfc3339Instant(auth.expires_at) || Date.parse(auth.issued_at) > now.getTime() || Date.parse(auth.expires_at) <= now.getTime()) return ["KDLC_DECLASSIFICATION_REQUIRED"];
      }
      return derived || context.gate === "retrieval" ? [] : ["KDLC_DERIVED_CLASSIFICATION_MISSING"];
    }
    if (sensor.id === "external-model-route") {
      const route = this.#policy.external_models[`${context.provider}/${context.model}`]; const required = mostRestricted(context);
      if (!route || route.allowed !== true || !required || !classification(route.max_classification) || CLASSIFICATION[required] > CLASSIFICATION[route.max_classification]) return ["KDLC_EXTERNAL_MODEL_ROUTE_DENIED"];
      return [];
    }
    if (sensor.id === "retention-legal-hold") {
      if (context.gate === "ingest" && context.regulated === true && context.storage?.erasable !== true) return ["KDLC_RETENTION_STORAGE_INCOMPATIBLE"];
      if (context.gate !== "erasure") return [];
      const evidence = this.#erasureVerifier?.resolve?.(context.erasure_verification);
      if (!evidence || evidence.subject !== context.subject || evidence.action !== "erase" || evidence.result !== "erased" || !isRfc3339Instant(evidence.completed_at) || Date.parse(evidence.completed_at) > now.getTime() || !/^sha256:[a-f0-9]{64}$/.test(evidence.impact_hash ?? "") || !/^sha256:[a-f0-9]{64}$/.test(evidence.decision_hash ?? "") || !/^sha256:[a-f0-9]{64}$/.test(evidence.verification_hash ?? "") || !/^sha256:[a-f0-9]{64}$/.test(evidence.receipt_hash ?? "")) return ["KDLC_ERASURE_WORKFLOW_VERIFICATION_REQUIRED"];
      const inventory = Array.isArray(evidence.inventory) ? evidence.inventory : [];
      const bySurface = new Map(inventory.map((item) => [item.surface, item]));
      if (this.#policy.required_erasure_surfaces.some((surface) => !bySurface.has(surface))) return ["KDLC_ERASURE_INVENTORY_INCOMPLETE"];
      if (inventory.some((item) => item.known_copy === true && !["purged", "crypto-shredded", "tombstoned"].includes(item.status))) return ["KDLC_ERASURE_COPY_REMAINS"];
      return [];
    }
    return ["KDLC_SENSOR_UNKNOWN"];
  }
  async evaluate(gate, input, { waivers = [] } = {}) {
    if (!GATES.has(gate) || !input || typeof input.subject !== "string" || !input.subject) fail("KDLC_GOVERNANCE_CONTEXT_INVALID", "A supported gate and stable subject are required");
    const now = at(this.#clock); const { declassification, erasure_verification, ...serializableInput } = input;
    const context = { ...jsonClone({ ...serializableInput, gate }), declassification, erasure_verification };
    const results = [];
    for (const sensor of BUILT_IN_GOVERNANCE_SENSORS.filter(({ gates }) => gates.includes(gate))) {
      const findingCodes = this.#codes(sensor, context, now); let result = findingCodes.length ? "failed" : "passed"; let blocks = findingCodes.length > 0; let waiverView;
      if (blocks) {
        const waiver = waivers.map((token) => this.#authority.waiver(token)).find((state) => state?.sensor_id === sensor.id && state.gate === gate && state.subject === input.subject && Date.parse(state.issued_at) <= now.getTime() && Date.parse(state.expires_at) > now.getTime());
        if (waiver) {
          await this.#audit.append(Object.freeze({ action: "governance.sensor.waived", actor: waiver.authority, subject: input.subject, sensor_id: sensor.id, gate, waiver_id: waiver.id, at: now.toISOString() }));
          result = "waived"; blocks = false; waiverView = { id: waiver.id, authority: waiver.authority, reason: waiver.reason, expires_at: waiver.expires_at };
        }
      }
      const base = { id: sensor.id, version: sensor.version, gate, severity: sensor.severity, result, blocks, finding_codes: findingCodes, producer: "kdlc-governance-runtime/1" };
      results.push({ ...base, execution_hash: artifactHash(base), ...(waiverView ? { waiver: waiverView } : {}) });
    }
    const unsigned = { api_version: "kdlc.dev/governance-control-report/v1alpha1", gate, subject: input.subject, policy_hash: this.#policyHash, evaluated_at: now.toISOString(), results, allowed: !results.some(({ blocks }) => blocks) };
    const report = Object.freeze({ ...unsigned, report_hash: artifactHash(unsigned) });
    const validation = this.#validator.validate("governanceControlReport", report);
    if (!validation.valid) fail("KDLC_GOVERNANCE_REPORT_INVALID", "Governance report failed schema validation", { errors: validation.errors });
    await this.#audit.append(Object.freeze({ action: "governance.gate.completed", subject: input.subject, gate, allowed: report.allowed, policy_hash: this.#policyHash, report_hash: report.report_hash, finding_codes: distinct(results.flatMap(({ finding_codes }) => finding_codes)), at: now.toISOString() }));
    return report;
  }
  assertAllowed(report) {
    const unsigned = report && typeof report === "object" ? Object.fromEntries(Object.entries(report).filter(([key]) => key !== "report_hash")) : null;
    if (!report?.allowed || report.report_hash !== artifactHash(unsigned)) fail("KDLC_GOVERNANCE_DENIED", "Governance controls denied the operation", { finding_codes: distinct((report?.results ?? []).filter(({ blocks }) => blocks).flatMap(({ finding_codes }) => finding_codes)) });
  }
  async authorizeRetrieval(input, options) { const report = await this.evaluate("retrieval", input, options); this.assertAllowed(report); return report; }
  async authorizeExternalModel(input, options) { const report = await this.evaluate("model-route", input, options); this.assertAllowed(report); return report; }
  async authorizePublication(input, options) { const report = await this.evaluate("publication", input, options); this.assertAllowed(report); return report; }
  async authorizeErasure(input, options) { const report = await this.evaluate("erasure", input, options); this.assertAllowed(report); return report; }
}

export function propagateGovernanceMetadata({ materials, target = {}, clock }) {
  const now = at(clock);
  const context = { materials };
  const access = { classification: mostRestricted(context) };
  if (!access.classification) fail("KDLC_CLASSIFICATION_MISSING", "Every material source must carry a valid classification");
  access.compartments = distinct(materials.flatMap((item) => item.access?.compartments ?? []));
  if (!access.compartments.length) delete access.compartments;
  const obligations = distinct(materials.flatMap((item) => item.rights?.attribution_required ? [`attribution:${item.id}`] : []));
  const legalReview = rightsCodes({ materials, target, transformation: target.transformation ?? "derivative", nowMillis: now.getTime() }).length > 0;
  return Object.freeze({ access, rights: { disposition: legalReview ? "legal-review-required" : "allowed", obligations, policy_refs: distinct(target.policy_refs ?? []), decision_refs: distinct(target.decision_refs ?? []), target_scope: target.scope ?? "workspace" } });
}
