import semver from "semver";

import { artifactHash, canonicalJson } from "../../core/index.mjs";
import { issueInstallReport, resolveTrustedExtensionHost, verifyInstallReport } from "./authority.mjs";
import { extensionFail } from "./errors.mjs";

const TRUST_ORDER = Object.freeze({ unverified: 0, "machine-confirmed": 1, "human-reviewed": 2 });
const SEVERITY_ORDER = Object.freeze({ info: 0, warning: 1, error: 2 });
const BOUNDARIES = Object.freeze(["filesystem", "network", "credentials", "subprocess", "macros", "memory", "cpu", "output"]);

function validRange(value, label) {
  if (typeof value !== "string" || semver.validRange(value, { includePrerelease: true }) === null) extensionFail("KDLC_EXTENSION_RANGE_INVALID", `${label} is not a valid semantic-version range`);
}
function requireValid(validator, contract, value) {
  const result = validator.validate(contract, value);
  if (!result.valid) extensionFail("KDLC_EXTENSION_SCHEMA_INVALID", `${contract} failed schema validation`, { contract, errors: result.errors });
}
function unique(values, label) {
  const ids = values.map(({ id, name, metadata }) => id ?? name ?? metadata?.id);
  if (ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length) extensionFail("KDLC_EXTENSION_DUPLICATE", `Plugin contains duplicate or invalid ${label}`);
}
function exactIdentity(locked, report) {
  return Boolean(locked && locked.version === report.version && locked.manifest_hash === report.manifest_hash && locked.package_hash === report.package_hash);
}
function verifyScan(report, scanner) {
  if (!report || !scanner?.verifyReport(report)) extensionFail("KDLC_EXTENSION_SCAN_UNTRUSTED", "Compatibility requires an authentic package scan over actual package bytes");
}

export function validatePluginManifest(manifest, validator) {
  requireValid(validator, "extensionPluginManifest", manifest);
  if (!semver.valid(manifest.metadata.version)) extensionFail("KDLC_EXTENSION_VERSION_INVALID", "Plugin version must be canonical SemVer");
  validRange(manifest.compatibility.framework, "Framework compatibility");
  if (manifest.compatibility.okf !== undefined) validRange(manifest.compatibility.okf, "OKF compatibility");
  unique(manifest.dependencies, "dependencies"); unique(manifest.executables, "executables");
  for (const [kind, contributions] of Object.entries(manifest.contributions)) {
    unique(contributions, `${kind} contributions`);
    for (const contribution of contributions) {
      const version = contribution.metadata?.version ?? contribution.version;
      if (!semver.valid(version)) extensionFail("KDLC_EXTENSION_VERSION_INVALID", `${kind} contribution version must be canonical SemVer`);
    }
  }
  const executables = new Map(manifest.executables.map((entry) => [entry.id, entry]));
  for (const sensor of manifest.contributions.sensors) if (sensor.executable_id && executables.get(sensor.executable_id)?.type !== "sensor") extensionFail("KDLC_EXTENSION_BINDING_INVALID", `Sensor ${sensor.id} does not bind a declared sensor executable`);
  for (const normalizer of manifest.contributions.normalizers) if (executables.get(normalizer.executable_id)?.type !== "normalizer") extensionFail("KDLC_EXTENSION_BINDING_INVALID", `Normalizer ${normalizer.id} does not bind a declared normalizer executable`);
  return structuredClone(manifest);
}

export function enforceCompatibility({ packageReport, installedPackages, lock, validator, scanner, authority }) {
  requireValid(validator, "extensionLock", lock); verifyScan(packageReport, scanner);
  const host = resolveTrustedExtensionHost(authority); const manifest = validatePluginManifest(packageReport.manifest, validator);
  if (!semver.valid(host.framework.version) || host.framework.version !== lock.framework.version || host.framework.hash !== lock.framework.hash
    || !semver.satisfies(host.framework.version, manifest.compatibility.framework, { includePrerelease: true })) extensionFail("KDLC_EXTENSION_FRAMEWORK_INCOMPATIBLE", "Plugin framework range or trusted framework lock does not match");
  if (!semver.valid(host.okf.version) || canonicalJson(host.okf) !== canonicalJson(lock.okf)
    || (manifest.compatibility.okf !== undefined && !semver.satisfies(host.okf.version, manifest.compatibility.okf, { includePrerelease: true }))) extensionFail("KDLC_EXTENSION_OKF_INCOMPATIBLE", "Plugin OKF range, revision, or hash does not match the trusted runtime");

  if (!Array.isArray(installedPackages)) extensionFail("KDLC_EXTENSION_GRAPH_INVALID", "Trusted scans for the complete installed plugin graph are required");
  const reports = new Map();
  for (const report of installedPackages) {
    verifyScan(report, scanner); validatePluginManifest(report.manifest, validator);
    if (reports.has(report.plugin)) extensionFail("KDLC_EXTENSION_GRAPH_INVALID", `Duplicate installed plugin scan: ${report.plugin}`);
    reports.set(report.plugin, report);
  }
  if (reports.get(packageReport.plugin)?.package_hash !== packageReport.package_hash || reports.size !== Object.keys(lock.plugins).length
    || [...reports.keys()].some((name) => !Object.hasOwn(lock.plugins, name))) extensionFail("KDLC_EXTENSION_GRAPH_INVALID", "Installed package scans do not exactly cover the dependency lock");

  for (const [name, locked] of Object.entries(lock.plugins)) {
    const report = reports.get(name);
    if (!report || !exactIdentity(locked, report)) extensionFail("KDLC_EXTENSION_LOCK_MISMATCH", `Locked plugin bytes or manifest drifted: ${name}`);
    if (!semver.satisfies(host.framework.version, report.manifest.compatibility.framework, { includePrerelease: true })
      || (report.manifest.compatibility.okf !== undefined && !semver.satisfies(host.okf.version, report.manifest.compatibility.okf, { includePrerelease: true }))) {
      extensionFail("KDLC_EXTENSION_DEPENDENCY_INCOMPATIBLE", `Installed plugin is incompatible with the trusted framework or OKF: ${name}`);
    }
    const declarations = new Map(report.manifest.dependencies.map((dependency) => [dependency.name, dependency]));
    if (Object.keys(locked.dependencies).some((dependency) => !declarations.has(dependency))) extensionFail("KDLC_EXTENSION_LOCK_MISMATCH", `Plugin lock contains an undeclared dependency: ${name}`);
    for (const dependency of report.manifest.dependencies) {
      validRange(dependency.range, `Dependency ${dependency.name}`); const resolved = locked.dependencies[dependency.name];
      if (!resolved) {
        if (!dependency.optional) extensionFail("KDLC_EXTENSION_DEPENDENCY_MISSING", `Required plugin dependency is not locked: ${dependency.name}`);
        if (reports.has(dependency.name)) extensionFail("KDLC_EXTENSION_LOCK_MISMATCH", `Installed optional dependency is not bound by its dependent: ${name} -> ${dependency.name}`);
        continue;
      }
      const installed = reports.get(dependency.name);
      if (!installed || !exactIdentity(resolved, installed) || !semver.satisfies(installed.version, dependency.range, { includePrerelease: true })) {
        extensionFail("KDLC_EXTENSION_DEPENDENCY_INCOMPATIBLE", `Locked dependency bytes are incompatible: ${name} -> ${dependency.name}`);
      }
    }
  }
  const graph = installedPackages.map(({ plugin, version, manifest_hash, package_hash }) => ({ plugin, version, manifest_hash, package_hash })).sort((a, b) => a.plugin.localeCompare(b.plugin));
  return Object.freeze({ plugin: manifest.metadata.name, version: manifest.metadata.version, manifest_hash: packageReport.manifest_hash,
    package_hash: packageReport.package_hash, lock_hash: artifactHash(lock), graph_hash: artifactHash(graph),
    host_context_hash: artifactHash({ framework: host.framework, okf: host.okf, policy: host.policy, mode: host.mode }) });
}

function enforceContributionPolicy(installedPackages, policy) {
  const semantics = [];
  for (const installed of installedPackages) {
    for (const template of installed.manifest.contributions.templates) {
      const merge_modes = [...new Set(template.files.map(({ merge }) => merge))].sort();
      semantics.push({ plugin: installed.plugin, type: "template", id: template.metadata.id, merge_modes });
      if (merge_modes.some((mode) => !policy.template.allowed_merge.includes(mode))) extensionFail("KDLC_EXTENSION_POLICY_DOWNGRADE", `Template ${installed.plugin}:${template.metadata.id} uses a disallowed merge mode`);
    }
    for (const profile of installed.manifest.contributions.profiles) {
      semantics.push({ plugin: installed.plugin, type: "profile", id: profile.metadata.id, minimum_trust: profile.security.minimum_trust, approval_gates: [...profile.security.approval_gates].sort() });
      if (TRUST_ORDER[profile.security.minimum_trust] < TRUST_ORDER[policy.minimum_trust] || policy.mandatory_gates.some((gate) => !profile.security.approval_gates.includes(gate))) extensionFail("KDLC_EXTENSION_POLICY_DOWNGRADE", `Profile ${installed.plugin}:${profile.metadata.id} weakens trusted policy`);
    }
    for (const scope of installed.manifest.contributions.scopes) {
      semantics.push({ plugin: installed.plugin, type: "scope", id: scope.metadata.id, approval_gates: [...scope.approval_gates].sort() });
      if (policy.mandatory_gates.some((gate) => !scope.approval_gates.includes(gate))) extensionFail("KDLC_EXTENSION_POLICY_DOWNGRADE", `Scope ${installed.plugin}:${scope.metadata.id} removes a mandatory gate`);
    }
    for (const sensor of installed.manifest.contributions.sensors) {
      semantics.push({ plugin: installed.plugin, type: "sensor", id: sensor.id, blocking: sensor.blocking, deterministic: sensor.deterministic, severity: sensor.severity });
      if ((policy.sensor.require_blocking && !sensor.blocking) || sensor.deterministic !== true || SEVERITY_ORDER[sensor.severity] < SEVERITY_ORDER[policy.sensor.minimum_severity]) extensionFail("KDLC_EXTENSION_POLICY_DOWNGRADE", `Sensor ${installed.plugin}:${sensor.id} weakens trusted policy`);
    }
    for (const normalizer of installed.manifest.contributions.normalizers) {
      const security = structuredClone(normalizer.default_security); semantics.push({ plugin: installed.plugin, type: "normalizer", id: normalizer.id, security });
      if (Object.entries(policy.normalizer).some(([name, value]) => security[name] !== value)) extensionFail("KDLC_EXTENSION_POLICY_DOWNGRADE", `Normalizer ${installed.plugin}:${normalizer.id} weakens trusted policy`);
    }
  }
  return semantics.sort((a, b) => `${a.plugin}:${a.type}:${a.id}`.localeCompare(`${b.plugin}:${b.type}:${b.id}`));
}

function coversAccess(granted, requested) { return granted.root === requested.root && (granted.access === "write" || granted.access === requested.access); }
function sandboxGaps(executable, sandbox) {
  if (executable.isolation !== "sandboxed") return ["isolation"];
  if (!sandbox.effective) return ["effective-sandbox"];
  const gaps = BOUNDARIES.filter((boundary) => sandbox.enforcement[boundary] !== true);
  if (executable.permissions.filesystem.some((request) => !sandbox.filesystem.some((grant) => coversAccess(grant, request)))) gaps.push("filesystem-scope");
  if (executable.permissions.network.some((destination) => !sandbox.network.includes(destination))) gaps.push("network-scope");
  if (executable.permissions.credentials.some((credential) => !sandbox.credentials.includes(credential))) gaps.push("credential-scope");
  if (executable.permissions.subprocess && sandbox.subprocess !== true) gaps.push("subprocess-scope");
  if (executable.permissions.macros && sandbox.macros !== true) gaps.push("macro-scope");
  if (executable.permissions.resources.memory_bytes > sandbox.resources.memory_bytes) gaps.push("memory-ceiling");
  if (executable.permissions.resources.cpu_ms > sandbox.resources.cpu_ms) gaps.push("cpu-ceiling");
  if (executable.permissions.resources.output_bytes > sandbox.resources.output_bytes) gaps.push("output-ceiling");
  return [...new Set(gaps)].sort();
}

export function createInstallReport({ packageReport, installedPackages, lock, scanner, validator, authority }) {
  const compatibility = enforceCompatibility({ packageReport, installedPackages, lock, validator, scanner, authority });
  const manifest = packageReport.manifest; const host = resolveTrustedExtensionHost(authority); const policySemantics = enforceContributionPolicy(installedPackages, host.policy);
  const executables = installedPackages.flatMap((installed) => {
    const analyses = new Map(installed.import_analysis.map((analysis) => [analysis.id, analysis]));
    return installed.manifest.executables.map((entry) => ({ plugin: installed.plugin, id: `${installed.plugin}:${entry.id}`,
      executable_id: entry.id, type: entry.type, entrypoint: entry.entrypoint, isolation: entry.isolation,
      permissions: structuredClone(entry.permissions), ambient_capabilities: structuredClone(analyses.get(entry.id)?.required_capabilities ?? []),
      detected_permissions: structuredClone(analyses.get(entry.id)?.detected_permissions ?? []), sandbox_gaps: sandboxGaps(entry, host.sandbox) }));
  }).sort((a, b) => a.id.localeCompare(b.id));
  const payload = { api_version: "kdlc.dev/plugin-install-report/v1alpha1", plugin: compatibility.plugin, version: compatibility.version,
    manifest_hash: compatibility.manifest_hash, package_hash: compatibility.package_hash, package_scan_hash: artifactHash(packageReport), lock_hash: compatibility.lock_hash,
    installed_graph_hash: compatibility.graph_hash, host_context_hash: compatibility.host_context_hash, sandbox_attestation_id: host.sandbox.attestation_id, mode: host.mode,
    policy_hash: artifactHash(host.policy), policy_semantics: policySemantics,
    requires_explicit_trust: executables.length > 0, executable_permissions: executables,
    waiver_required_executables: host.mode === "controlled" ? executables.filter(({ sandbox_gaps }) => sandbox_gaps.length).map(({ id }) => id) : [],
    permission_hash: artifactHash(executables), execution_status: "not-executed" };
  return issueInstallReport(authority, payload);
}

export function authorizeInstallation({ manifest, report, trustAuthorization, waiver, authority, now = new Date().toISOString() }) {
  if (!verifyInstallReport(authority, report)) extensionFail("KDLC_EXTENSION_REPORT_UNTRUSTED", "Installation authorization requires an authentic runtime-signed report");
  if (report.manifest_hash !== artifactHash(manifest) || report.plugin !== manifest.metadata.name || report.permission_hash !== artifactHash(report.executable_permissions)) extensionFail("KDLC_EXTENSION_REPORT_DRIFT", "Installation report no longer binds the exact plugin and permissions");
  if (report.requires_explicit_trust && !authority.verifyTrust(trustAuthorization, report)) extensionFail("KDLC_EXTENSION_TRUST_REQUIRED", "Executable plugin installation requires explicit authenticated trust");
  if (report.mode === "controlled" && report.waiver_required_executables.length && !authority.verifyWaiver(waiver, report, report.waiver_required_executables, now)) extensionFail("KDLC_EXTENSION_SANDBOX_DENIED", "Controlled mode requires effective sandbox coverage or an exact active waiver");
  return Object.freeze({ status: "installation-authorized", execution_status: "not-executed", plugin: report.plugin, version: report.version, manifest_hash: report.manifest_hash,
    package_hash: report.package_hash, trust_actor: trustAuthorization?.actor ?? null, waiver_actor: waiver?.actor ?? null, permission_hash: report.permission_hash });
}
