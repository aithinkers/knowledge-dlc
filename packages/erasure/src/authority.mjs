import { createHmac, timingSafeEqual } from "node:crypto";

import { artifactHash, canonicalJson } from "../../core/index.mjs";
import { denied, invalid } from "./errors.mjs";

const sessions = new WeakMap();
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

function validatePrincipal(principal) {
  return principal && ID.test(principal.id ?? "") && ACTOR.test(principal.actor ?? "") &&
    ["local", "served", "automation"].includes(principal.principal_mode) &&
    (principal.principal_mode !== "served" || typeof principal.issuer === "string") &&
    Array.isArray(principal.permissions) &&
    principal.permissions.every((permission) => ["revoke", "erase"].includes(permission));
}

function validatePolicy(policy) {
  return policy && ID.test(policy.id ?? "") && ID.test(policy.version ?? "") &&
    Array.isArray(policy.immediate_erasure_reasons) &&
    policy.immediate_erasure_reasons.every((reason) => ID.test(reason)) &&
    Array.isArray(policy.tombstone_fields) &&
    policy.tombstone_fields.every((field) => ["source_id", "source_hash", "event_id"].includes(field));
}

export class RetentionDecisionAuthority {
  #principals;
  #policies;
  #holdsProvider;
  #key;
  #keyId;
  #clock;

  constructor({ principals, policies, holds = [], key, keyId, clock }) {
    if (!Array.isArray(principals) || principals.some((principal) => !validatePrincipal(principal)))
      throw invalid("Trusted revocation principals are invalid");
    if (!Array.isArray(policies) || policies.some((policy) => !validatePolicy(policy)))
      throw invalid("Trusted retention policies are invalid");
    if (new Set(principals.map(({ id }) => id)).size !== principals.length ||
      new Set(policies.map(({ id, version }) => `${id}@${version}`)).size !== policies.length)
      throw invalid("Trusted revocation principals and policies must have unique identities");
    if (!Buffer.isBuffer(key) || key.byteLength < 32 || !ID.test(keyId ?? "") || typeof clock?.now !== "function")
      throw invalid("A trusted retention decision signing authority and clock are required");
    this.#principals = new Map(principals.map((principal) => [principal.id, structuredClone(principal)]));
    this.#policies = new Map(policies.map((policy) => [`${policy.id}@${policy.version}`, structuredClone(policy)]));
    if (typeof holds !== "function" && !Array.isArray(holds)) throw invalid("Trusted legal holds are invalid");
    this.#holdsProvider = typeof holds === "function" ? holds : () => structuredClone(holds);
    this.#key = Buffer.from(key);
    this.#keyId = keyId;
    this.#clock = clock;
  }

  establish(principalId) {
    const principal = this.#principals.get(principalId);
    if (!principal) throw denied("Revocation authority principal is not established");
    const session = Object.freeze({ kind: "kdlc-revocation-session-1" });
    sessions.set(session, structuredClone(principal));
    return session;
  }

  resolve(session, permission) {
    const principal = sessions.get(session);
    if (!principal || !principal.permissions.includes(permission))
      throw denied("Revocation requires an authenticated principal with the requested authority");
    return structuredClone(principal);
  }

  #activeHolds(sourceId, impactedKinds) {
    const holds = this.#holdsProvider();
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

  decide({ session, request, impact }) {
    const principal = sessions.get(session);
    if (!principal) throw denied("Revocation requires an authenticated authority session");
    if (!request || !["revoke", "erase"].includes(request.action) || !ID.test(request.reason ?? "") ||
      !ID.test(request.policy_id ?? "") || !ID.test(request.policy_version ?? "") ||
      !ID.test(request.source_id ?? "") || !HASH.test(request.source_hash ?? ""))
      throw invalid("Revocation request is invalid");
    if (!principal.permissions.includes(request.action)) throw denied("Principal lacks revocation authority");
    const policy = this.#policies.get(`${request.policy_id}@${request.policy_version}`);
    if (!policy) throw denied("Retention policy is unresolved");
    const now = this.#clock.now();
    if (!validTime(now)) throw invalid("Trusted authority clock is invalid");
    const impactedKinds = new Set(impact.nodes.map(({ kind }) => kind));
    const activeHolds = this.#activeHolds(request.source_id, impactedKinds);
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
      authority: {
        actor: principal.actor,
        principal_mode: principal.principal_mode,
        ...(principal.issuer ? { issuer: principal.issuer } : {}),
      },
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

  revalidate(decision, impact) {
    if (!this.verify(decision, impact)) return false;
    if (decision.action !== "erase") return true;
    const kinds = new Set(impact.nodes.map(({ kind }) => kind));
    return this.#activeHolds(decision.source.id, kinds).length === 0;
  }
}
