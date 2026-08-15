import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { artifactHash, canonicalJson } from "../../core/index.mjs";
import { extensionFail } from "./errors.mjs";

const sessions = new WeakMap();
const trusts = new WeakMap();
const waivers = new WeakMap();
const authorityStates = new WeakMap();
const INSTALL_PROOF_DOMAIN = "kdlc.extension.install-report/v1";

function same(left, right) { return canonicalJson(left) === canonicalJson(right); }
function validSandbox(sandbox) {
  const boundaryNames = ["filesystem", "network", "credentials", "subprocess", "macros", "memory", "cpu", "output"];
  return Boolean(sandbox && typeof sandbox.attestation_id === "string" && sandbox.attestation_id.length && typeof sandbox.effective === "boolean"
    && sandbox.enforcement && Object.keys(sandbox.enforcement).length === boundaryNames.length && boundaryNames.every((name) => sandbox.enforcement[name] === true || sandbox.enforcement[name] === false)
    && Array.isArray(sandbox.filesystem) && sandbox.filesystem.every(({ root, access }) => typeof root === "string" && ["read", "write"].includes(access))
    && Array.isArray(sandbox.network) && sandbox.network.every((value) => typeof value === "string") && Array.isArray(sandbox.credentials) && sandbox.credentials.every((value) => typeof value === "string")
    && typeof sandbox.subprocess === "boolean" && typeof sandbox.macros === "boolean" && sandbox.resources
    && ["memory_bytes", "cpu_ms", "output_bytes"].every((name) => Number.isSafeInteger(sandbox.resources[name]) && sandbox.resources[name] >= 0));
}

export class ExtensionAuthority {
  #principals;

  constructor(principals, { framework, okf, sandbox, key = randomBytes(32), keyId = "extension-runtime-v1" } = {}) {
    if (!Array.isArray(principals)) throw new TypeError("ExtensionAuthority requires trusted principal records");
    if (!framework || typeof framework.version !== "string" || typeof framework.hash !== "string" || !okf || typeof okf.version !== "string" || typeof okf.revision !== "string" || typeof okf.hash !== "string"
      || !validSandbox(sandbox)
      || !(key instanceof Uint8Array) || key.byteLength < 32 || typeof keyId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(keyId)) {
      throw new TypeError("ExtensionAuthority requires trusted framework, OKF, sandbox, and signing configuration");
    }
    authorityStates.set(this, { framework: structuredClone(framework), okf: structuredClone(okf), sandbox: structuredClone(sandbox), key: Buffer.from(key), keyId });
    this.#principals = new Map();
    for (const principal of principals) {
      const allowed = new Set(["id", "actor", "roles"]);
      if (!principal || typeof principal.id !== "string" || !principal.id || typeof principal.actor !== "string" || !/^(?:human|process):[A-Za-z0-9._@/-]+$/.test(principal.actor)
        || !Array.isArray(principal.roles) || new Set(principal.roles).size !== principal.roles.length
        || principal.roles.some((role) => !["plugin-trust", "governance-reviewer"].includes(role)) || Object.keys(principal).some((key) => !allowed.has(key))
        || this.#principals.has(principal.id)) {
        extensionFail("KDLC_EXTENSION_PRINCIPAL_INVALID", "Extension authority principal is invalid or duplicated");
      }
      this.#principals.set(principal.id, structuredClone(principal));
    }
  }

  establishSession(id) {
    const principal = this.#principals.get(id);
    if (!principal) extensionFail("KDLC_EXTENSION_PRINCIPAL_UNRESOLVED", "Extension authority principal is not trusted");
    const session = Object.freeze({ actor: principal.actor }); sessions.set(session, { authority: this, principal: structuredClone(principal) }); return session;
  }

  trustInstallation(session, report) {
    const record = sessions.get(session); const principal = record?.authority === this ? record.principal : null;
    if (!principal?.roles.includes("plugin-trust")) extensionFail("KDLC_EXTENSION_TRUST_DENIED", "Plugin installation requires an authenticated trust principal");
    const authorization = Object.freeze({ api_version: "kdlc.dev/plugin-trust/v1alpha1", actor: principal.actor, plugin: report.plugin, report_hash: artifactHash(report) });
    trusts.set(authorization, { authority: this, report: structuredClone(report), principal: structuredClone(principal) });
    return authorization;
  }

  waiveControlledExecution(session, report, { executableIds, reason, expiresAt }) {
    const sessionRecord = sessions.get(session); const principal = sessionRecord?.authority === this ? sessionRecord.principal : null;
    if (!principal?.roles.includes("governance-reviewer")) extensionFail("KDLC_EXTENSION_WAIVER_DENIED", "Controlled execution waiver requires an authenticated governance reviewer");
    if (!Array.isArray(executableIds) || !executableIds.length || new Set(executableIds).size !== executableIds.length || typeof reason !== "string" || !reason.trim()
      || typeof expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt)
      || !Number.isFinite(Date.parse(expiresAt)) || new Date(Date.parse(expiresAt)).toISOString() !== expiresAt) extensionFail("KDLC_EXTENSION_WAIVER_INVALID", "Controlled execution waiver is malformed");
    const waiver = Object.freeze({ api_version: "kdlc.dev/plugin-waiver/v1alpha1", scope: "controlled-execution-gap", actor: principal.actor,
      plugin: report.plugin, manifest_hash: report.manifest_hash, executable_ids: [...executableIds].sort(), reason, expires_at: expiresAt });
    waivers.set(waiver, { authority: this, reportHash: artifactHash(report), principal: structuredClone(principal) });
    return waiver;
  }

  verifyTrust(authorization, report) {
    const record = trusts.get(authorization);
    return Boolean(record?.authority === this && authorization.report_hash === artifactHash(report) && same(record.report, report));
  }

  verifyWaiver(waiver, report, executableIds, now) {
    const record = waivers.get(waiver);
    return Boolean(record?.authority === this && record.reportHash === artifactHash(report) && waiver.scope === "controlled-execution-gap"
      && waiver.plugin === report.plugin && waiver.manifest_hash === report.manifest_hash && same(waiver.executable_ids, [...executableIds].sort())
      && Date.parse(waiver.expires_at) > Date.parse(now));
  }
}

function installMac(state, payload) { return createHmac("sha256", state.key).update(`${INSTALL_PROOF_DOMAIN}\0${canonicalJson(payload)}`).digest(); }

export function resolveTrustedExtensionHost(authority) {
  const state = authorityStates.get(authority);
  if (!state) extensionFail("KDLC_EXTENSION_HOST_UNTRUSTED", "Extension operation requires the configured runtime authority");
  return { framework: structuredClone(state.framework), okf: structuredClone(state.okf), sandbox: structuredClone(state.sandbox) };
}

export function issueInstallReport(authority, payload) {
  const state = authorityStates.get(authority);
  if (!state) extensionFail("KDLC_EXTENSION_HOST_UNTRUSTED", "Installation report requires the configured runtime authority");
  const proof = Object.freeze({ algorithm: "hmac-sha256", key_id: state.keyId, domain: INSTALL_PROOF_DOMAIN, mac: `sha256:${installMac(state, payload).toString("hex")}` });
  return Object.freeze({ ...structuredClone(payload), authority_proof: proof });
}

export function verifyInstallReport(authority, report) {
  try {
    const state = authorityStates.get(authority); const proof = report?.authority_proof;
    if (!state || !proof || proof.algorithm !== "hmac-sha256" || proof.key_id !== state.keyId || proof.domain !== INSTALL_PROOF_DOMAIN || !/^sha256:[a-f0-9]{64}$/.test(proof.mac)) return false;
    const { authority_proof: ignored, ...payload } = report; const actual = Buffer.from(proof.mac.slice(7), "hex"); const expected = installMac(state, payload);
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  } catch { return false; }
}
