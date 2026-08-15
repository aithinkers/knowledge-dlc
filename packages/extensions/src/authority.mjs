import { artifactHash, canonicalJson } from "../../core/index.mjs";
import { extensionFail } from "./errors.mjs";

const sessions = new WeakMap();
const trusts = new WeakMap();
const waivers = new WeakMap();

function same(left, right) { return canonicalJson(left) === canonicalJson(right); }

export class ExtensionAuthority {
  #principals;

  constructor(principals) {
    if (!Array.isArray(principals)) throw new TypeError("ExtensionAuthority requires trusted principal records");
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

  waiveUnsandboxedExecution(session, report, { executableIds, reason, expiresAt }) {
    const sessionRecord = sessions.get(session); const principal = sessionRecord?.authority === this ? sessionRecord.principal : null;
    if (!principal?.roles.includes("governance-reviewer")) extensionFail("KDLC_EXTENSION_WAIVER_DENIED", "Controlled execution waiver requires an authenticated governance reviewer");
    if (!Array.isArray(executableIds) || !executableIds.length || new Set(executableIds).size !== executableIds.length || typeof reason !== "string" || !reason.trim()
      || typeof expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt)
      || !Number.isFinite(Date.parse(expiresAt)) || new Date(Date.parse(expiresAt)).toISOString() !== expiresAt) extensionFail("KDLC_EXTENSION_WAIVER_INVALID", "Controlled execution waiver is malformed");
    const waiver = Object.freeze({ api_version: "kdlc.dev/plugin-waiver/v1alpha1", scope: "controlled-unsandboxed-execution", actor: principal.actor,
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
    return Boolean(record?.authority === this && record.reportHash === artifactHash(report) && waiver.scope === "controlled-unsandboxed-execution"
      && waiver.plugin === report.plugin && waiver.manifest_hash === report.manifest_hash && same(waiver.executable_ids, [...executableIds].sort())
      && Date.parse(waiver.expires_at) > Date.parse(now));
  }
}
