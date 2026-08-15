import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { artifactHash } from "../../packages/core/index.mjs";
import {
  ExtensionAuthority,
  ExtensionPackageScanner,
  applyMigrationPreview,
  authorizeInstallation,
  createExtensionValidator,
  createInstallReport,
  enforceCompatibility,
  previewMigration,
  validatePluginManifest
} from "../../packages/extensions/index.mjs";

const root = resolve(import.meta.dirname, "../..");
const packageRoot = (name) => resolve(root, "tests/fixtures/extensions/packages", name);
const hash = (character) => `sha256:${character.repeat(64)}`;
const framework = Object.freeze({ version: "0.2.0", hash: hash("f") });
const okf = Object.freeze({ version: "0.2.0", revision: "okf-0.2-reference", hash: hash("b") });
function trustedClock(initial = "2026-08-14T00:00:00.000Z") {
  let millis = Date.parse(initial);
  return { millis: () => millis, set: (value) => { millis = Date.parse(value); } };
}

async function fixture(name) { return JSON.parse(await readFile(resolve(root, "tests/fixtures/extensions", name), "utf8")); }
function expectCode(code, action) { assert.throws(action, (error) => error?.code === code); }
async function expectCodeAsync(code, action) { await assert.rejects(action, (error) => error?.code === code); }

function sandbox(overrides = {}) {
  return {
    attestation_id: "sandbox-test-v1", effective: true,
    enforcement: { filesystem: true, network: true, credentials: true, subprocess: true, macros: true, memory: true, cpu: true, output: true },
    filesystem: [{ root: "sources/staging", access: "read" }, { root: "workflow/runs", access: "read" }], network: [], credentials: [], subprocess: false, macros: false,
    resources: { memory_bytes: 268435456, cpu_ms: 10000, output_bytes: 20000000 }, ...overrides
  };
}
function authorityWith(sandboxState = sandbox(), clock = trustedClock()) {
  return new ExtensionAuthority([
    { id: "trust-token", actor: "human:alice", roles: ["plugin-trust"] },
    { id: "review-token", actor: "human:bob", roles: ["governance-reviewer"] }
  ], { framework, okf, sandbox: sandboxState, mode: "controlled", clock, policy: {
    minimum_trust: "machine-confirmed", mandatory_gates: ["human-review"], sensor: { require_blocking: true, minimum_severity: "error" },
    normalizer: { network: false, execute_code: false, macros: false }, template: { allowed_merge: ["create", "deep-merge"] }
  } });
}
function identity(report) { return { version: report.version, manifest_hash: report.manifest_hash, package_hash: report.package_hash }; }
function lockFor(reports, dependencies = {}) {
  return { api_version: "kdlc.dev/extension-lock/v1alpha1", framework, okf,
    plugins: Object.fromEntries(reports.map((report) => [report.plugin, { ...identity(report), dependencies: dependencies[report.plugin] ?? {} }])) };
}
async function scanGraph(validator) {
  const scanner = new ExtensionPackageScanner({ validator, key: Buffer.alloc(32, 7), keyId: "fixture-scanner" });
  const plugin = await scanner.scan(packageRoot("compatible")); const helper = await scanner.scan(packageRoot("helper")); const leaf = await scanner.scan(packageRoot("leaf"));
  const lock = lockFor([plugin, helper, leaf], { "acme-quality": { "kdlc-helper": identity(helper) }, "kdlc-helper": { "kdlc-leaf": identity(leaf) } });
  return { scanner, plugin, helper, leaf, packageReport: plugin, lock, installedPackages: [plugin, helper, leaf] };
}

test("FEAT-007 validates strict versioned extension contracts", async () => {
  const validator = await createExtensionValidator(root); const { plugin } = await scanGraph(validator); const manifest = plugin.manifest;
  assert.equal(validatePluginManifest(manifest, validator).metadata.name, "acme-quality");
  for (const [name, value] of [["extensionTemplate", manifest.contributions.templates[0]], ["extensionProfile", manifest.contributions.profiles[0]],
    ["extensionScope", manifest.contributions.scopes[0]], ["extensionSensor", manifest.contributions.sensors[0]], ["extensionNormalizer", manifest.contributions.normalizers[0]]]) {
    assert.equal(validator.validate(name, value).valid, true, name);
  }
  const unknown = structuredClone(manifest); unknown.metadata.untrusted = true;
  expectCode("KDLC_EXTENSION_SCHEMA_INVALID", () => validatePluginManifest(unknown, validator));
  const unsafeNormalizer = structuredClone(manifest); unsafeNormalizer.executables[0].permissions.network = ["https://example.invalid"];
  expectCode("KDLC_EXTENSION_SCHEMA_INVALID", () => validatePluginManifest(unsafeNormalizer, validator));
});

test("FEAT-007 scanner derives signed inventory from bytes and rejects hidden imports", async () => {
  const validator = await createExtensionValidator(root); const scanner = new ExtensionPackageScanner({ validator, key: Buffer.alloc(32, 5) });
  const report = await scanner.scan(packageRoot("compatible"));
  assert.equal(scanner.verifyReport(report), true);
  assert.ok(report.files.some(({ path }) => path === "tools/normalizer.mjs"));
  assert.ok(report.import_analysis.every(({ required_capabilities }) => required_capabilities.length === 5));
  assert.equal(report.package_hash, artifactHash({ files: report.files }));
  assert.equal(scanner.verifyReport(structuredClone(report)), true);
  const forged = structuredClone(report); forged.files[0].size += 1;
  assert.equal(scanner.verifyReport(forged), false);
  const attackerScanner = new ExtensionPackageScanner({ validator, key: Buffer.alloc(32, 6) });
  const attackerReport = await attackerScanner.scan(packageRoot("compatible"));
  assert.equal(scanner.verifyReport(attackerReport), false);
  await expectCodeAsync("KDLC_EXTENSION_PERMISSION_UNDERREPORTED", () => scanner.scan(packageRoot("underreported")));
});

test("REQ-SUPPLY-001 upgraded parser and SemVer runtime fail closed on adversarial extension metadata", async () => {
  const validator = await createExtensionValidator(root);
  const scanner = new ExtensionPackageScanner({ validator, key: Buffer.alloc(32, 8) });
  const malformedPackage = await mkdtemp(join(tmpdir(), "kdlc-extension-parser-"));
  await cp(packageRoot("compatible"), malformedPackage, { recursive: true });
  await writeFile(join(malformedPackage, "tools/normalizer.mjs"), "export const broken = ;\n");
  await expectCodeAsync("KDLC_EXTENSION_SOURCE_INVALID", () => scanner.scan(malformedPackage));

  const manifest = JSON.parse(await readFile(join(packageRoot("compatible"), ".kdlc-plugin/plugin.json"), "utf8"));
  const malformedRange = structuredClone(manifest);
  malformedRange.compatibility.framework = "1.2.3 - nope";
  expectCode("KDLC_EXTENSION_RANGE_INVALID", () => validatePluginManifest(malformedRange, validator));

  const nonCanonicalVersion = structuredClone(manifest);
  nonCanonicalVersion.metadata.version = "01.4.0";
  expectCode("KDLC_EXTENSION_VERSION_INVALID", () => validatePluginManifest(nonCanonicalVersion, validator));
});

test("FEAT-007 scanner detects post-open swaps without leaking descriptors", async () => {
  const validator = await createExtensionValidator(root); const packageCopy = await mkdtemp(join(tmpdir(), "kdlc-extension-race-"));
  await cp(packageRoot("compatible"), packageCopy, { recursive: true });
  const outside = join(await mkdtemp(join(tmpdir(), "kdlc-extension-outside-")), "outside.mjs"); await writeFile(outside, "export const outside = true;\n");
  let swapped = false;
  const scanner = new ExtensionPackageScanner({ validator, key: Buffer.alloc(32, 4), afterOpen: async ({ relativePath, absolutePath }) => {
    if (!swapped && relativePath === "tools/normalizer.mjs") { swapped = true; await rename(absolutePath, `${absolutePath}.original`); await symlink(outside, absolutePath); }
  } });
  if (process.platform === "win32") {
    await expectCodeAsync("KDLC_EXTENSION_PACKAGE_RACE", () => scanner.scan(packageCopy));
    await rename(`${join(packageCopy, "tools/normalizer.mjs")}.original`, join(packageCopy, "tools/normalizer.closed.mjs"));
  } else {
    const before = (await readdir("/dev/fd")).length;
    await expectCodeAsync("KDLC_EXTENSION_PACKAGE_RACE", () => scanner.scan(packageCopy));
    assert.equal((await readdir("/dev/fd")).length, before);
  }
});

test("FEAT-007 exact-binds trusted framework, OKF revision/hash, and the complete installed graph", async () => {
  const validator = await createExtensionValidator(root); const graph = await scanGraph(validator); const authority = authorityWith();
  assert.equal(enforceCompatibility({ ...graph, validator, authority }).version, "1.4.0");
  const callerOkf = { ...graph, validator, authority, okfVersion: "99.0.0", okfHash: hash("0") };
  assert.equal(enforceCompatibility(callerOkf).version, "1.4.0");
  const wrongOkf = structuredClone(graph.lock); wrongOkf.okf.hash = hash("0");
  expectCode("KDLC_EXTENSION_OKF_INCOMPATIBLE", () => enforceCompatibility({ ...graph, lock: wrongOkf, validator, authority }));

  const temp = await mkdtemp(join(tmpdir(), "kdlc-extension-drift-")); await cp(packageRoot("leaf"), temp, { recursive: true });
  await writeFile(join(temp, "drift.txt"), "changed package bytes\n");
  const driftedLeaf = await graph.scanner.scan(temp);
  expectCode("KDLC_EXTENSION_DEPENDENCY_INCOMPATIBLE", () => enforceCompatibility({ ...graph, installedPackages: [graph.plugin, graph.helper, driftedLeaf], validator, authority }));
  expectCode("KDLC_EXTENSION_GRAPH_INVALID", () => enforceCompatibility({ ...graph, installedPackages: [graph.plugin], validator, authority }));
});

test("FEAT-007 runtime-signed permission report uses effective sandbox attestation", async () => {
  const validator = await createExtensionValidator(root); const graph = await scanGraph(validator); const authority = authorityWith();
  const options = { ...graph, validator, authority, mode: "controlled", policyFloor: { minimum_trust: "machine-confirmed", approval_gates: ["human-review"] } };
  const report = createInstallReport(options);
  assert.deepEqual(report.waiver_required_executables, []);
  assert.deepEqual([...new Set(report.policy_semantics.filter(({ plugin }) => plugin === "acme-quality").map(({ type }) => type))].sort(), ["normalizer", "profile", "scope", "sensor", "template"]);
  assert.ok(report.executable_permissions.every(({ ambient_capabilities }) => ambient_capabilities.length === 5));
  assert.equal(report.execution_status, "not-executed");
  const trust = authority.trustInstallation(authority.establishSession("trust-token"), report);
  const authorization = authorizeInstallation({ manifest: graph.plugin.manifest, report, trustAuthorization: trust, authority });
  assert.deepEqual({ status: authorization.status, execution: authorization.execution_status }, { status: "installation-authorized", execution: "not-executed" });

  const mismatched = sandbox({ enforcement: { ...sandbox().enforcement, network: false } });
  const weakAuthority = authorityWith(mismatched);
  const weakReport = createInstallReport({ ...options, authority: weakAuthority, mode: "local", hostCapabilities: { network: true } });
  assert.equal(weakReport.mode, "controlled");
  assert.ok(weakReport.executable_permissions.every(({ sandbox_gaps }) => sandbox_gaps.includes("network")));
  const weakTrust = weakAuthority.trustInstallation(weakAuthority.establishSession("trust-token"), weakReport);
  expectCode("KDLC_EXTENSION_SANDBOX_DENIED", () => authorizeInstallation({ manifest: graph.plugin.manifest, report: weakReport, trustAuthorization: weakTrust, authority: weakAuthority }));
  const forged = structuredClone(report); forged.sandbox_attestation_id = "caller-label";
  expectCode("KDLC_EXTENSION_REPORT_UNTRUSTED", () => authorizeInstallation({ manifest: graph.plugin.manifest, report: forged, trustAuthorization: trust, authority }));

  const packageCopy = await mkdtemp(join(tmpdir(), "kdlc-extension-policy-")); await cp(packageRoot("compatible"), packageCopy, { recursive: true });
  const manifestPath = join(packageCopy, ".kdlc-plugin/plugin.json"); const downgraded = JSON.parse(await readFile(manifestPath, "utf8"));
  downgraded.contributions.sensors[0].blocking = false; await writeFile(manifestPath, JSON.stringify(downgraded));
  const badPlugin = await graph.scanner.scan(packageCopy);
  const badLock = lockFor([badPlugin, graph.helper, graph.leaf], { "acme-quality": { "kdlc-helper": identity(graph.helper) }, "kdlc-helper": { "kdlc-leaf": identity(graph.leaf) } });
  expectCode("KDLC_EXTENSION_POLICY_DOWNGRADE", () => createInstallReport({ packageReport: badPlugin, installedPackages: [badPlugin, graph.helper, graph.leaf], lock: badLock,
    scanner: graph.scanner, validator, authority, mode: "controlled", policyFloor: { minimum_trust: "unverified", approval_gates: [] } }));
});

test("FEAT-007 controlled unsandboxed code needs exact authenticated trust and waiver", async () => {
  const validator = await createExtensionValidator(root); const scanner = new ExtensionPackageScanner({ validator, key: Buffer.alloc(32, 9) });
  const plugin = await scanner.scan(packageRoot("malicious")); const lock = lockFor([plugin]); const installedPackages = [plugin];
  const clock = trustedClock(); const authority = authorityWith(sandbox(), clock); const report = createInstallReport({ packageReport: plugin, installedPackages, lock, scanner, validator, authority, mode: "controlled" });
  assert.deepEqual(report.waiver_required_executables, ["malicious-exporter:exfiltrate"]);
  const trust = authority.trustInstallation(authority.establishSession("trust-token"), report);
  expectCode("KDLC_EXTENSION_TRUST_REQUIRED", () => authorizeInstallation({ manifest: plugin.manifest, report, trustAuthorization: { ...trust }, authority }));
  expectCode("KDLC_EXTENSION_SANDBOX_DENIED", () => authorizeInstallation({ manifest: plugin.manifest, report, trustAuthorization: trust, authority }));
  const session = authority.establishSession("review-token");
  expectCode("KDLC_EXTENSION_WAIVER_INVALID", () => authority.waiveControlledExecution(session, report, { executableIds: ["malicious-exporter:exfiltrate"], reason: "expired", expiresAt: "2026-01-01T00:00:00.000Z" }));
  expectCode("KDLC_EXTENSION_WAIVER_INVALID", () => authority.waiveControlledExecution(session, report, { executableIds: ["malicious-exporter:exfiltrate"], reason: "zero length", expiresAt: "2026-08-14T00:00:00.000Z" }));
  const waiver = authority.waiveControlledExecution(session, report, { executableIds: ["malicious-exporter:exfiltrate"], reason: "time limited", expiresAt: "2027-01-01T00:00:00.000Z" });
  assert.equal(waiver.issued_at, "2026-08-14T00:00:00.000Z");
  assert.equal(authorizeInstallation({ manifest: plugin.manifest, report, trustAuthorization: trust, waiver, authority }).status, "installation-authorized");
  clock.set("2026-08-13T23:59:59.999Z");
  expectCode("KDLC_EXTENSION_SANDBOX_DENIED", () => authorizeInstallation({ manifest: plugin.manifest, report, trustAuthorization: trust, waiver, authority, now: "2026-08-14T00:00:00.000Z" }));
  clock.set("2027-01-01T00:00:00.000Z");
  expectCode("KDLC_EXTENSION_SANDBOX_DENIED", () => authorizeInstallation({ manifest: plugin.manifest, report, trustAuthorization: trust, waiver, authority, now: "2026-08-14T00:00:00.000Z" }));
});

test("FEAT-007 migrations are previewable, semantic, immutable, and exact-confirmation gated", async () => {
  const validator = await createExtensionValidator(root); const migration = await fixture("migration.json");
  const files = { "profiles/quality.json": JSON.stringify({ enabled: true }), "settings/plugin.json": JSON.stringify({ minimum_trust: "machine-confirmed", retained: true }) };
  const original = structuredClone(files); const preview = previewMigration({ migration, files, validator });
  assert.deepEqual(files, original); assert.equal(preview.changed_files.length, 3);
  assert.deepEqual(preview.semantic_effects.map(({ category }) => category), ["routing", "trust"]);
  assert.equal(preview.security_weakening, false);
  expectCode("KDLC_MIGRATION_CONFIRMATION_REQUIRED", () => applyMigrationPreview({ ...preview }, { confirmedPreviewHash: preview.preview_hash }));
  const applied = applyMigrationPreview(preview, { confirmedPreviewHash: preview.preview_hash });
  assert.equal(applied.files["profiles/quality.json"], undefined);
  assert.equal(JSON.parse(applied.files["settings/plugin.json"]).minimum_trust, "human-reviewed");
  const drifted = { ...files, "settings/plugin.json": JSON.stringify({ minimum_trust: "unverified" }) };
  expectCode("KDLC_MIGRATION_PRECONDITION", () => previewMigration({ migration, files: drifted, validator }));

  const weakening = structuredClone(migration); weakening.id = "acme-quality-weaken"; weakening.operations = [{ kind: "replace-json", path: "settings/plugin.json", pointer: "/minimum_trust",
    before: "machine-confirmed", after: "unverified", semantic_effect: { category: "none", description: "Claims no effect." } }];
  const weakPreview = previewMigration({ migration: weakening, files, validator });
  assert.equal(weakPreview.semantic_effects[0].category, "trust"); assert.equal(weakPreview.security_weakening, true);
  expectCode("KDLC_MIGRATION_SECURITY_DOWNGRADE", () => applyMigrationPreview(weakPreview, { confirmedPreviewHash: weakPreview.preview_hash }));
  const clock = trustedClock(); const authority = authorityWith(sandbox(), clock); const reviewSession = authority.establishSession("review-token");
  expectCode("KDLC_MIGRATION_WAIVER_INVALID", () => authority.waiveMigrationSecurity(reviewSession, weakPreview,
    { reason: "zero length", expiresAt: "2026-08-14T00:00:00.000Z" }));
  const waiver = authority.waiveMigrationSecurity(reviewSession, weakPreview,
    { reason: "approved compatibility rollback", expiresAt: "2027-01-01T00:00:00.000Z" });
  expectCode("KDLC_MIGRATION_SECURITY_DOWNGRADE", () => applyMigrationPreview(weakPreview, { confirmedPreviewHash: weakPreview.preview_hash, authority, waiver: { ...waiver } }));
  assert.equal(applyMigrationPreview(weakPreview, { confirmedPreviewHash: weakPreview.preview_hash, authority, waiver }).report.security_weakening, true);
  clock.set("2026-08-13T23:59:59.999Z");
  expectCode("KDLC_MIGRATION_SECURITY_DOWNGRADE", () => applyMigrationPreview(weakPreview, { confirmedPreviewHash: weakPreview.preview_hash, authority, waiver, now: "2026-08-14T00:00:00.000Z" }));
  clock.set("2027-01-01T00:00:00.000Z");
  expectCode("KDLC_MIGRATION_SECURITY_DOWNGRADE", () => applyMigrationPreview(weakPreview, { confirmedPreviewHash: weakPreview.preview_hash, authority, waiver, now: "2026-08-14T00:00:00.000Z" }));

  const beforeConfiguration = { minimum_trust: "human-reviewed", approval_gates: ["human-review", "policy-review"],
    sensor: { blocking: true, severity: "error" }, security: { network: [], subprocess: false, credentials: [] } };
  const afterConfiguration = { minimum_trust: "unverified", approval_gates: ["human-review"],
    sensor: { blocking: false, severity: "warning" }, security: { network: ["https://outside.invalid"], subprocess: true, credentials: ["TOKEN"] } };
  const nested = structuredClone(migration); nested.id = "acme-quality-nested-weaken"; nested.operations = [{ kind: "merge-json", path: "settings/nested.json", pointer: "/configuration",
    before: beforeConfiguration, after: afterConfiguration, semantic_effect: { category: "none", description: "Incorrectly claims no effect." } }];
  const nestedPreview = previewMigration({ migration: nested, files: { "settings/nested.json": JSON.stringify({ configuration: beforeConfiguration }) }, validator });
  const changes = nestedPreview.semantic_effects[0].policy_changes;
  assert.equal(nestedPreview.security_weakening, true);
  assert.deepEqual(new Set(changes.filter(({ security_weakening }) => security_weakening).map(({ rule }) => rule)),
    new Set(["minimum-trust", "mandatory-gates", "blocking", "sensor-severity", "permission-boundary"]));
  assert.ok(changes.some(({ path }) => path === "/configuration/security/credentials"));
  expectCode("KDLC_MIGRATION_SECURITY_DOWNGRADE", () => applyMigrationPreview(nestedPreview, { confirmedPreviewHash: nestedPreview.preview_hash }));

  const beforeProfiles = [{ metadata: { id: "regulated" }, security: { minimum_trust: "human-reviewed", approval_gates: ["human-review"] } }];
  const afterProfiles = [{ metadata: { id: "regulated" }, security: { minimum_trust: "unverified", approval_gates: [] } }];
  const parentArray = structuredClone(migration); parentArray.id = "acme-quality-parent-array"; parentArray.operations = [{ kind: "replace-json", path: "settings/profiles.json", pointer: "/profiles",
    before: beforeProfiles, after: afterProfiles, semantic_effect: { category: "content", description: "Claims ordinary content." } }];
  const arrayPreview = previewMigration({ migration: parentArray, files: { "settings/profiles.json": JSON.stringify({ profiles: beforeProfiles }) }, validator });
  assert.equal(arrayPreview.security_weakening, true);
  assert.ok(arrayPreview.semantic_effects[0].policy_changes.some(({ path }) => path === "/profiles/@regulated/security/minimum_trust"));
});
