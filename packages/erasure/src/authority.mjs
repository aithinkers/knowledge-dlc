import { createHmac, timingSafeEqual } from "node:crypto";

import { artifactHash, canonicalJson } from "../../core/index.mjs";
import { denied, invalid } from "./errors.mjs";

const governanceEvidence = new WeakMap();
const ACTOR = /^(?:human|process):[A-Za-z0-9._@/-]+$/;
const ID = /^[A-Za-z0-9._-]{1,128}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const SURFACE_KINDS = new Set(["original", "normalized", "claim", "concept", "quote", "cache", "index", "embedding", "graph", "export", "log", "backup", "proposal", "receipt", "audit"]);
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

function validTime(value) {
  const match = typeof value === "string" ? RFC3339.exec(value) : null;
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) &&
    instant.getUTCFullYear() === Number(year) &&
    instant.getUTCMonth() + 1 === Number(month) &&
    instant.getUTCDate() === Number(day) &&
    instant.getUTCHours() === Number(hour) &&
    instant.getUTCMinutes() === Number(minute) &&
    instant.getUTCSeconds() === Number(second);
}

function unsigned(value) {
  const copy = structuredClone(value);
  delete copy.proof;
  return copy;
}

function validatePolicy(policy) {
  return policy && ID.test(policy.id ?? "") && ID.test(policy.version ?? "") &&
    typeof policy.governance_ref === "string" && policy.governance_ref.length > 0 &&
    Array.isArray(policy.immediate_erasure_reasons) &&
    policy.immediate_erasure_reasons.every((reason) => ID.test(reason)) &&
    Array.isArray(policy.tombstone_fields) &&
    policy.tombstone_fields.every((field) => ["source_id", "source_hash", "event_id"].includes(field));
}

export class RetentionDecisionAuthority {
  #governanceAuthority;
  #policies;
  #holdsProvider;
  #key;
  #keyId;
  #clock;

  constructor({ governanceAuthority, policies, holds = [], key, keyId, clock }) {
    if (!governanceAuthority || typeof governanceAuthority.erasureAuthorization !== "function")
      throw invalid("An instance-bound governance authorization authority is required");
    if (!Array.isArray(policies) || policies.some((policy) => !validatePolicy(policy)))
      throw invalid("Trusted retention policies are invalid");
    if (new Set(policies.map(({ id, version }) => `${id}@${version}`)).size !== policies.length ||
      new Set(policies.map(({ governance_ref: reference }) => reference)).size !== policies.length)
      throw invalid("Trusted retention policies must have unique identities and governance references");
    if (!Buffer.isBuffer(key) || key.byteLength < 32 || !ID.test(keyId ?? "") || typeof clock?.now !== "function")
      throw invalid("A trusted retention decision signing authority and clock are required");
    this.#governanceAuthority = governanceAuthority;
    this.#policies = new Map(policies.map((policy) => [`${policy.id}@${policy.version}`, structuredClone(policy)]));
    if (typeof holds !== "function" && !Array.isArray(holds) && typeof holds?.list !== "function") throw invalid("Trusted legal holds are invalid");
    this.#holdsProvider = typeof holds?.list === "function" ? () => holds.list() : typeof holds === "function" ? holds : () => structuredClone(holds);
    this.#key = Buffer.from(key);
    this.#keyId = keyId;
    this.#clock = clock;
  }

  resolve(authorization) {
    const resolved = this.#governanceAuthority.erasureAuthorization(authorization);
    if (!resolved || !ACTOR.test(resolved.authority ?? ""))
      throw denied("Revocation requires a current instance-bound governance authorization");
    return structuredClone(resolved);
  }

  async #activeHolds(sourceId, impactedKinds) {
    const holds = await this.#holdsProvider();
    if (!Array.isArray(holds) || holds.some((hold) => !hold || !ID.test(hold.id ?? "") ||
      !ID.test(hold.source_id ?? "") || !["active", "released"].includes(hold.status) ||
      (hold.kinds !== undefined && (!Array.isArray(hold.kinds) || hold.kinds.some((kind) => !SURFACE_KINDS.has(kind))))))
      throw invalid("Trusted legal-hold provider returned an invalid value");
    if (new Set(holds.map(({ id }) => id)).size !== holds.length)
      throw invalid("Trusted legal-hold provider returned duplicate identities");
    return holds.filter((hold) =>
      hold && ID.test(hold.id ?? "") && hold.status === "active" && hold.source_id === sourceId &&
      (!Array.isArray(hold.kinds) || hold.kinds.some((kind) => impactedKinds.has(kind))),
    );
  }

  #mac(value) {
    return createHmac("sha256", this.#key).update(canonicalJson(value)).digest("hex");
  }

  async decide({ authorization, request, impact }) {
    const authenticated = this.resolve(authorization);
    if (!request || !["revoke", "erase"].includes(request.action) || !ID.test(request.reason ?? "") ||
      !ID.test(request.policy_id ?? "") || !ID.test(request.policy_version ?? "") ||
      !ID.test(request.source_id ?? "") || !HASH.test(request.source_hash ?? ""))
      throw invalid("Revocation request is invalid");
    const policy = this.#policies.get(`${request.policy_id}@${request.policy_version}`);
    if (!policy) throw denied("Retention policy is unresolved");
    const subject = artifactHash({ id: request.source_id, hash: request.source_hash });
    if (authenticated.subject !== subject || authenticated.action !== request.action ||
      authenticated.reason !== request.reason || authenticated.policy_ref !== policy.governance_ref)
      throw denied("Governance authorization does not exactly bind the revocation request");
    const now = this.#clock.now();
    if (!validTime(now)) throw invalid("Trusted authority clock is invalid");
    const impactedKinds = new Set(impact.nodes.map(({ kind }) => kind));
    const activeHolds = await this.#activeHolds(request.source_id, impactedKinds);
    const retentionBlocks = request.action === "erase" &&
      !policy.immediate_erasure_reasons.includes(request.reason)
      ? impact.nodes.filter(({ retained_until: retainedUntil }) => retainedUntil && Date.parse(retainedUntil) > Date.parse(now))
      : [];
    const allowed = request.action === "revoke" || (activeHolds.length === 0 && retentionBlocks.length === 0);
    const decision = {
      api_version: "kdlc.dev/retention-decision/v1alpha1",
      action: request.action,
      source: { id: request.source_id, hash: request.source_hash },
      reason: request.reason,
      allowed,
      policy: { id: policy.id, version: policy.version },
      authority: { actor: authenticated.authority },
      authorization_hash: artifactHash(authenticated),
      impact_hash: artifactHash(impact),
      blocked: {
        legal_holds: activeHolds.map(({ id }) => id).sort(),
        retention_surfaces: retentionBlocks.map(({ id }) => id).sort(),
      },
      tombstone_fields: [...policy.tombstone_fields].sort(),
      decided_at: now,
    };
    decision.proof = {
      algorithm: "hmac-sha256",
      key_id: this.#keyId,
      domain: "kdlc-retention-decision-1",
      mac: this.#mac(decision),
    };
    return Object.freeze(structuredClone(decision));
  }

  verify(decision, impact) {
    if (!decision?.proof || decision.proof.algorithm !== "hmac-sha256" ||
      decision.proof.key_id !== this.#keyId || decision.proof.domain !== "kdlc-retention-decision-1" ||
      decision.impact_hash !== artifactHash(impact)) return false;
    const expected = Buffer.from(this.#mac(unsigned(decision)), "hex");
    let actual;
    try { actual = Buffer.from(decision.proof.mac, "hex"); } catch { return false; }
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  }

  attestReceipt(receipt) {
    return Object.freeze({
      algorithm: "hmac-sha256",
      key_id: this.#keyId,
      domain: "kdlc-erasure-receipt-1",
      mac: this.#mac({ domain: "kdlc-erasure-receipt-1", receipt }),
    });
  }

  verifyReceipt(receipt) {
    const proof = receipt?.proof;
    if (!proof || proof.algorithm !== "hmac-sha256" || proof.key_id !== this.#keyId || proof.domain !== "kdlc-erasure-receipt-1") return false;
    const unsignedReceipt = structuredClone(receipt);
    delete unsignedReceipt.proof;
    const expected = Buffer.from(this.#mac({ domain: proof.domain, receipt: unsignedReceipt }), "hex");
    let actual;
    try { actual = Buffer.from(proof.mac, "hex"); } catch { return false; }
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  }

  issueGovernanceEvidence({ receipt, decision, impact }) {
    if (!this.verify(decision, impact) || !this.verifyReceipt(receipt) ||
      receipt.action !== "erase" || receipt.result !== "erased" || decision.action !== "erase" || decision.allowed !== true ||
      receipt.impact_hash !== artifactHash(impact) || receipt.decision_hash !== artifactHash(decision) ||
      receipt.source?.id !== impact.source?.id || receipt.source?.hash !== impact.source?.hash ||
      decision.source?.id !== impact.source?.id || decision.source?.hash !== impact.source?.hash)
      throw denied("Governance erasure evidence requires an exact verified purge receipt");
    const evidence = Object.freeze({
      api_version: "kdlc.dev/verified-erasure-evidence/v1alpha1",
      subject: artifactHash(receipt.source),
      source: Object.freeze(structuredClone(receipt.source)),
      action: receipt.action,
      result: receipt.result,
      workflow_id: receipt.workflow_id,
      job_id: receipt.job_id,
      receipt_hash: artifactHash(receipt),
      impact_hash: artifactHash(impact),
      decision_hash: artifactHash(decision),
      verification_hash: receipt.verification_hash,
      legal_hold: false,
      propagation_verified: true,
      inventory: impact.nodes.map((node) => Object.freeze({
        surface: node.kind,
        known_copy: true,
        status: node.strategy === "tombstone" ? "tombstoned" : "purged",
      })),
      completed_at: receipt.completed_at,
    });
    const token = Object.freeze({ kind: "kdlc-verified-erasure-evidence-1" });
    governanceEvidence.set(token, Object.freeze({ authority: this, evidence }));
    return token;
  }

  resolveGovernanceEvidence(token) {
    const state = governanceEvidence.get(token);
    if (!state || state.authority !== this) throw denied("Verified erasure evidence is not bound to this authority");
    return structuredClone(state.evidence);
  }

  evidenceVerifier() {
    const authority = this;
    return Object.freeze({ resolve(token) {
      try { return authority.resolveGovernanceEvidence(token); } catch { return undefined; }
    } });
  }

  async revalidate(decision, impact) {
    if (!this.verify(decision, impact)) return false;
    if (decision.action !== "erase") return true;
    const kinds = new Set(impact.nodes.map(({ kind }) => kind));
    return (await this.#activeHolds(decision.source.id, kinds)).length === 0;
  }
}

export class GovernedLegalHoldRegistry {
  constructor({ store, clock, authenticate }) {
    if (!store || !clock?.now || !clock?.millis || typeof authenticate !== "function") throw invalid("Governed legal-hold registry requires storage, clock, and authentication");
    Object.assign(this, { store, clock, authenticate });
    this.path = "governance/legal-holds.json";
  }

  async list() { return await this.store.exists(this.path) ? this.store.readJson(this.path) : []; }

  async activate(credential, hold) {
    const actor = await this.authenticate(credential);
    if (!ACTOR.test(actor?.actor ?? "") || !actor.roles?.includes("records")) throw denied("Legal-hold activation requires authenticated records authority");
    return this.store.withMutationNamespace({ owner: `legal-hold:${actor.actor}`, clock: this.clock }, async () => {
      const holds = await this.list();
      if (holds.some(({ id }) => id === hold?.id)) throw invalid("Legal-hold identity already exists");
      const next = [...holds, { ...structuredClone(hold), status: "active", activated_by: actor.actor, activated_at: this.clock.now() }];
      await this.store.writeJsonAtomic(this.path, next);
      return Object.freeze(structuredClone(next.at(-1)));
    });
  }
}
