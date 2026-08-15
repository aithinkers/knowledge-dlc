import { createContractValidator } from "../contracts/index.mjs";

export { ExtensionAuthority } from "./src/authority.mjs";
export { authorizeInstallation, createInstallReport, enforceCompatibility, validatePluginManifest } from "./src/compatibility.mjs";
export { ExtensionError } from "./src/errors.mjs";
export { applyMigrationPreview, previewMigration } from "./src/migrations.mjs";
export { ExtensionPackageScanner } from "./src/scanner.mjs";

export const EXTENSION_SCHEMA_PATHS = Object.freeze({
  extensionTemplate: "core/schemas/extensions/template.schema.json",
  extensionProfile: "core/schemas/extensions/profile.schema.json",
  extensionScope: "core/schemas/extensions/scope.schema.json",
  extensionSensor: "core/schemas/extensions/sensor.schema.json",
  extensionNormalizer: "core/schemas/extensions/normalizer.schema.json",
  extensionPluginManifest: "core/schemas/extensions/plugin-manifest.schema.json",
  extensionLock: "core/schemas/extensions/extension-lock.schema.json",
  extensionMigration: "core/schemas/extensions/migration.schema.json"
});

export async function createExtensionValidator(root) { return createContractValidator(root, EXTENSION_SCHEMA_PATHS); }
