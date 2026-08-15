import semver from "semver";

import { artifactHash, canonicalJson } from "../../core/index.mjs";
import { extensionFail } from "./errors.mjs";

const TRUST_ORDER = Object.freeze({ unverified: 0, "machine-confirmed": 1, "human-reviewed": 2 });
const PERMISSION_KEYS = Object.freeze(["filesystem", "network", "credentials", "subprocess", "macros", "resources"]);
const installReports = new WeakMap();

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
function permissionRequests(permissions) {
  return { filesystem: permissions.filesystem.length > 0, network: permissions.network.length > 0, credentials: permissions.credentials.length > 0,
    subprocess: permissions.subprocess, macros: permissions.macros, resources: true };
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

export function enforceCompatibility({ manifest, lock, frameworkVersion, frameworkHash, okfVersion = "0.2.0", packageHash, validator }) {
  validatePluginManifest(manifest, validator); requireValid(validator, "extensionLock", lock);
  if (!semver.valid(frameworkVersion) || frameworkVersion !== lock.framework.version || frameworkHash !== lock.framework.hash
    || !semver.satisfies(frameworkVersion, manifest.compatibility.framework, { includePrerelease: true })) extensionFail("KDLC_EXTENSION_FRAMEWORK_INCOMPATIBLE", "Plugin framework range or framework lock does not match");
  if (manifest.compatibility.okf !== undefined && (!semver.valid(okfVersion) || !semver.satisfies(okfVersion, manifest.compatibility.okf, { includePrerelease: true }))) extensionFail("KDLC_EXTENSION_OKF_INCOMPATIBLE", "Plugin OKF compatibility range does not match");
  const locked = lock.plugins[manifest.metadata.name];
  if (!locked || locked.version !== manifest.metadata.version || locked.manifest_hash !== artifactHash(manifest) || locked.package_hash !== packageHash) extensionFail("KDLC_EXTENSION_LOCK_MISMATCH", "Plugin identity, manifest, or package bytes do not match the dependency lock");
  const declarations = new Map(manifest.dependencies.map((dependency) => [dependency.name, dependency]));
  if (Object.keys(locked.dependencies).some((name) => !declarations.has(name))) extensionFail("KDLC_EXTENSION_LOCK_MISMATCH", "Plugin lock contains an undeclared dependency");
  for (const dependency of manifest.dependencies) {
    validRange(dependency.range, `Dependency ${dependency.name}`); const resolved = locked.dependencies[dependency.name];
    if (!resolved) { if (!dependency.optional) extensionFail("KDLC_EXTENSION_DEPENDENCY_MISSING", `Required plugin dependency is not locked: ${dependency.name}`); continue; }
    const installed = lock.plugins[dependency.name];
    if (!installed || installed.version !== resolved.version || installed.manifest_hash !== resolved.manifest_hash || !semver.satisfies(resolved.version, dependency.range, { includePrerelease: true })) {
      extensionFail("KDLC_EXTENSION_DEPENDENCY_INCOMPATIBLE", `Locked dependency is incompatible: ${dependency.name}`);
    }
  }
  return Object.freeze({ plugin: manifest.metadata.name, version: manifest.metadata.version, manifest_hash: artifactHash(manifest), package_hash: packageHash });
}

export function createInstallReport({ manifest, lock, frameworkVersion, frameworkHash, okfVersion = "0.2.0", packageHash, packageInventory, validator, mode = "local", hostCapabilities = {}, policyFloor = { minimum_trust: "unverified", approval_gates: [] } }) {
  if (!['local', 'controlled'].includes(mode)) extensionFail("KDLC_EXTENSION_MODE_INVALID", "Extension installation mode is invalid");
  const compatibility = enforceCompatibility({ manifest, lock, frameworkVersion, frameworkHash, okfVersion, packageHash, validator });
  if (!packageInventory || packageInventory.package_hash !== packageHash || !Array.isArray(packageInventory.executables)) extensionFail("KDLC_EXTENSION_INVENTORY_INVALID", "Trusted package inventory is required");
  const declaredInventory = manifest.executables.map(({ id, type, entrypoint, isolation, permissions }) => ({ id, type, entrypoint, isolation, permissions })).sort((a, b) => a.id.localeCompare(b.id));
  const observedInventory = structuredClone(packageInventory.executables).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (canonicalJson(declaredInventory) !== canonicalJson(observedInventory)) extensionFail("KDLC_EXTENSION_PERMISSION_UNDERREPORTED", "Executable inventory or permissions differ from the plugin declaration");
  const requiredGates = new Set(policyFloor.approval_gates ?? []); const minimum = TRUST_ORDER[policyFloor.minimum_trust];
  if (minimum === undefined) extensionFail("KDLC_EXTENSION_POLICY_INVALID", "Extension policy floor is invalid");
  for (const profile of manifest.contributions.profiles) if (TRUST_ORDER[profile.security.minimum_trust] < minimum || [...requiredGates].some((gate) => !profile.security.approval_gates.includes(gate))) {
    extensionFail("KDLC_EXTENSION_POLICY_DOWNGRADE", `Profile ${profile.metadata.id} weakens the installation policy floor`);
  }
  const executables = manifest.executables.map((entry) => {
    const requested = permissionRequests(entry.permissions); const limitations = PERMISSION_KEYS.filter((name) => requested[name] && hostCapabilities[name] !== true);
    return { id: entry.id, type: entry.type, entrypoint: entry.entrypoint, isolation: entry.isolation, permissions: structuredClone(entry.permissions), enforcement_limitations: limitations };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const report = { api_version: "kdlc.dev/plugin-install-report/v1alpha1", plugin: compatibility.plugin, version: compatibility.version,
    manifest_hash: compatibility.manifest_hash, package_hash: packageHash, mode, requires_explicit_trust: executables.length > 0,
    executable_permissions: executables, unsandboxed_executables: executables.filter(({ isolation }) => isolation === "unsandboxed").map(({ id }) => id),
    permission_hash: artifactHash(executables) };
  const issued = Object.freeze(structuredClone(report));
  installReports.set(issued, structuredClone(report));
  return issued;
}

export function authorizeInstallation({ manifest, report, trustAuthorization, waiver, authority, now = new Date().toISOString() }) {
  const issued = installReports.get(report);
  if (!issued || canonicalJson(issued) !== canonicalJson(report)) extensionFail("KDLC_EXTENSION_REPORT_UNTRUSTED", "Installation authorization requires the exact issued permission report");
  if (report.manifest_hash !== artifactHash(manifest) || report.plugin !== manifest.metadata.name || report.permission_hash !== artifactHash(report.executable_permissions)) extensionFail("KDLC_EXTENSION_REPORT_DRIFT", "Installation report no longer binds the exact plugin and permissions");
  if (report.requires_explicit_trust && !authority?.verifyTrust(trustAuthorization, report)) extensionFail("KDLC_EXTENSION_TRUST_REQUIRED", "Executable plugin installation requires explicit authenticated trust");
  if (report.mode === "controlled" && report.unsandboxed_executables.length && !authority?.verifyWaiver(waiver, report, report.unsandboxed_executables, now)) extensionFail("KDLC_EXTENSION_UNSANDBOXED_DENIED", "Controlled mode rejects unsandboxed execution without an exact active waiver");
  return Object.freeze({ status: "authorized", plugin: report.plugin, version: report.version, manifest_hash: report.manifest_hash, package_hash: report.package_hash,
    trust_actor: trustAuthorization?.actor ?? null, waiver_actor: waiver?.actor ?? null, permission_hash: report.permission_hash });
}
