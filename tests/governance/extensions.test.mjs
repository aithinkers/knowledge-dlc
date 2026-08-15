import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { artifactHash } from "../../packages/core/index.mjs";
import {
  ExtensionAuthority,
  applyMigrationPreview,
  authorizeInstallation,
  createExtensionValidator,
  createInstallReport,
  enforceCompatibility,
  previewMigration,
  validatePluginManifest
} from "../../packages/extensions/index.mjs";

const root = resolve(import.meta.dirname, "../..");
const hash = (character) => `sha256:${character.repeat(64)}`;

async function fixture(name) {
  return JSON.parse(await readFile(resolve(root, "tests/fixtures/extensions", name), "utf8"));
}

function expectCode(code, action) {
  assert.throws(action, (error) => error?.code === code);
}

function maliciousInputs(manifest) {
  const packageHash = hash("a");
  const lock = {
    api_version: "kdlc.dev/extension-lock/v1alpha1",
    framework: { version: "0.2.0", hash: hash("f") },
    plugins: {
      [manifest.metadata.name]: {
        version: manifest.metadata.version,
        manifest_hash: artifactHash(manifest),
        package_hash: packageHash,
        dependencies: {}
      }
    }
  };
  const packageInventory = {
    package_hash: packageHash,
    executables: manifest.executables.map(({ id, type, entrypoint, isolation, permissions }) => ({ id, type, entrypoint, isolation, permissions }))
  };
  return { lock, packageHash, packageInventory };
}

test("FEAT-007 validates strict versioned extension contracts", async () => {
  const validator = await createExtensionValidator(root);
  const manifest = await fixture("compatible-plugin.json");
  assert.equal(validatePluginManifest(manifest, validator).metadata.name, "acme-quality");
  const contracts = [
    ["extensionTemplate", manifest.contributions.templates[0]],
    ["extensionProfile", manifest.contributions.profiles[0]],
    ["extensionScope", manifest.contributions.scopes[0]],
    ["extensionSensor", manifest.contributions.sensors[0]],
    ["extensionNormalizer", manifest.contributions.normalizers[0]]
  ];
  for (const [name, value] of contracts) assert.equal(validator.validate(name, value).valid, true, name);

  const unknown = structuredClone(manifest);
  unknown.metadata.untrusted = true;
  expectCode("KDLC_EXTENSION_SCHEMA_INVALID", () => validatePluginManifest(unknown, validator));

  const unsafeNormalizer = structuredClone(manifest);
  unsafeNormalizer.executables[0].permissions.network = ["https://example.invalid"];
  expectCode("KDLC_EXTENSION_SCHEMA_INVALID", () => validatePluginManifest(unsafeNormalizer, validator));

  const noncanonical = structuredClone(manifest);
  noncanonical.contributions.sensors[0].version = "01.0.0";
  expectCode("KDLC_EXTENSION_VERSION_INVALID", () => validatePluginManifest(noncanonical, validator));
});

test("FEAT-007 enforces exact compatibility and dependency locks", async () => {
  const validator = await createExtensionValidator(root);
  const manifest = await fixture("compatible-plugin.json");
  const lock = await fixture("extension-lock.json");
  const options = { manifest, lock, frameworkVersion: "0.2.0", frameworkHash: hash("f"), okfVersion: "0.2.0", packageHash: hash("c"), validator };
  assert.equal(enforceCompatibility(options).version, "1.4.0");
  expectCode("KDLC_EXTENSION_FRAMEWORK_INCOMPATIBLE", () => enforceCompatibility({ ...options, frameworkHash: hash("0") }));
  expectCode("KDLC_EXTENSION_OKF_INCOMPATIBLE", () => enforceCompatibility({ ...options, okfVersion: "1.0.0" }));
  expectCode("KDLC_EXTENSION_LOCK_MISMATCH", () => enforceCompatibility({ ...options, packageHash: hash("0") }));
  const drifted = structuredClone(lock);
  drifted.plugins["kdlc-helper"].manifest_hash = hash("0");
  expectCode("KDLC_EXTENSION_DEPENDENCY_INCOMPATIBLE", () => enforceCompatibility({ ...options, lock: drifted }));
});

test("FEAT-007 reports permissions exactly and rejects inventory or policy under-reporting", async () => {
  const validator = await createExtensionValidator(root);
  const manifest = await fixture("compatible-plugin.json");
  const lock = await fixture("extension-lock.json");
  const packageInventory = await fixture("compatible-inventory.json");
  const options = { manifest, lock, frameworkVersion: "0.2.0", frameworkHash: hash("f"), packageHash: hash("c"), packageInventory, validator,
    policyFloor: { minimum_trust: "machine-confirmed", approval_gates: ["human-review"] }, hostCapabilities: { filesystem: true, resources: true } };
  const report = createInstallReport(options);
  assert.equal(report.requires_explicit_trust, true);
  assert.deepEqual(report.executable_permissions[0].enforcement_limitations, []);
  assert.equal(report.permission_hash, artifactHash(report.executable_permissions));

  const hiddenPermission = structuredClone(packageInventory);
  hiddenPermission.executables[0].permissions.filesystem = [];
  expectCode("KDLC_EXTENSION_PERMISSION_UNDERREPORTED", () => createInstallReport({ ...options, packageInventory: hiddenPermission }));
  const isolationLie = structuredClone(packageInventory);
  isolationLie.executables[0].isolation = "unsandboxed";
  expectCode("KDLC_EXTENSION_PERMISSION_UNDERREPORTED", () => createInstallReport({ ...options, packageInventory: isolationLie }));
  expectCode("KDLC_EXTENSION_POLICY_DOWNGRADE", () => createInstallReport({ ...options, policyFloor: { minimum_trust: "human-reviewed", approval_gates: ["release-manager"] } }));
});

test("FEAT-007 requires authenticated trust and a scoped live waiver for controlled unsandboxed code", async () => {
  const validator = await createExtensionValidator(root);
  const manifest = await fixture("malicious-plugin.json");
  const { lock, packageHash, packageInventory } = maliciousInputs(manifest);
  const report = createInstallReport({ manifest, lock, frameworkVersion: "0.2.0", frameworkHash: hash("f"), packageHash, packageInventory, validator, mode: "controlled" });
  assert.deepEqual(report.unsandboxed_executables, ["exfiltrate"]);
  assert.ok(report.executable_permissions[0].enforcement_limitations.includes("network"));

  const authority = new ExtensionAuthority([
    { id: "trust-token", actor: "human:alice", roles: ["plugin-trust"] },
    { id: "review-token", actor: "human:bob", roles: ["governance-reviewer"] }
  ]);
  const trust = authority.trustInstallation(authority.establishSession("trust-token"), report);
  expectCode("KDLC_EXTENSION_TRUST_REQUIRED", () => authorizeInstallation({ manifest, report, trustAuthorization: { ...trust }, authority }));
  expectCode("KDLC_EXTENSION_REPORT_UNTRUSTED", () => authorizeInstallation({ manifest, report: structuredClone(report), trustAuthorization: trust, authority }));
  expectCode("KDLC_EXTENSION_UNSANDBOXED_DENIED", () => authorizeInstallation({ manifest, report, trustAuthorization: trust, waiver: { actor: "bob" }, authority }));
  const reviewSession = authority.establishSession("review-token");
  const expired = authority.waiveUnsandboxedExecution(reviewSession, report, { executableIds: ["exfiltrate"], reason: "bounded emergency review", expiresAt: "2026-01-01T00:00:00.000Z" });
  expectCode("KDLC_EXTENSION_UNSANDBOXED_DENIED", () => authorizeInstallation({ manifest, report, trustAuthorization: trust, waiver: expired, authority, now: "2026-08-14T00:00:00.000Z" }));
  const waiver = authority.waiveUnsandboxedExecution(reviewSession, report, { executableIds: ["exfiltrate"], reason: "bounded emergency review", expiresAt: "2027-01-01T00:00:00.000Z" });
  assert.equal(authorizeInstallation({ manifest, report, trustAuthorization: trust, waiver, authority, now: "2026-08-14T00:00:00.000Z" }).status, "authorized");

  const attacker = new ExtensionAuthority([{ id: "self", actor: "human:mallory", roles: ["plugin-trust", "governance-reviewer"] }]);
  const attackerSession = attacker.establishSession("self");
  const attackerTrust = attacker.trustInstallation(attackerSession, report);
  const attackerWaiver = attacker.waiveUnsandboxedExecution(attackerSession, report, { executableIds: ["exfiltrate"], reason: "self-issued", expiresAt: "2027-01-01T00:00:00.000Z" });
  expectCode("KDLC_EXTENSION_TRUST_REQUIRED", () => authorizeInstallation({ manifest, report, trustAuthorization: attackerTrust, waiver: attackerWaiver, authority, now: "2026-08-14T00:00:00.000Z" }));

  const altered = structuredClone(report);
  altered.executable_permissions[0].permissions.network = [];
  expectCode("KDLC_EXTENSION_REPORT_UNTRUSTED", () => authorizeInstallation({ manifest, report: altered, trustAuthorization: trust, waiver, authority }));
});

test("FEAT-007 migrations are previewable, semantic, immutable, and exact-confirmation gated", async () => {
  const validator = await createExtensionValidator(root);
  const migration = await fixture("migration.json");
  const files = {
    "profiles/quality.json": JSON.stringify({ enabled: true }),
    "settings/plugin.json": JSON.stringify({ minimum_trust: "machine-confirmed", retained: true })
  };
  const original = structuredClone(files);
  const preview = previewMigration({ migration, files, validator });
  assert.deepEqual(files, original);
  assert.equal(preview.changed_files.length, 3);
  assert.deepEqual(preview.semantic_effects.map(({ category }) => category), ["validation", "trust"]);
  expectCode("KDLC_MIGRATION_CONFIRMATION_REQUIRED", () => applyMigrationPreview({ ...preview }, { confirmedPreviewHash: preview.preview_hash }));
  expectCode("KDLC_MIGRATION_CONFIRMATION_REQUIRED", () => applyMigrationPreview(preview, { confirmedPreviewHash: hash("0") }));
  const applied = applyMigrationPreview(preview, { confirmedPreviewHash: preview.preview_hash });
  assert.equal(applied.files["profiles/quality.json"], undefined);
  assert.equal(JSON.parse(applied.files["profiles/assurance.json"]).enabled, true);
  assert.equal(JSON.parse(applied.files["settings/plugin.json"]).minimum_trust, "human-reviewed");

  const drifted = { ...files, "settings/plugin.json": JSON.stringify({ minimum_trust: "unverified" }) };
  expectCode("KDLC_MIGRATION_PRECONDITION", () => previewMigration({ migration, files: drifted, validator }));
});
