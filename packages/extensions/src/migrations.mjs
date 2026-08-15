import semver from "semver";

import { artifactHash, canonicalJson } from "../../core/index.mjs";
import { extensionFail } from "./errors.mjs";

const previews = new WeakMap();
function clone(value) { return JSON.parse(canonicalJson(value)); }
function pointerParts(pointer) { return pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~")); }
function replaceAtPointer(document, pointer, before, after) {
  const parts = pointerParts(pointer); let target = document;
  for (const part of parts.slice(0, -1)) {
    if (!target || typeof target !== "object" || !Object.hasOwn(target, part)) extensionFail("KDLC_MIGRATION_PRECONDITION", `Migration pointer does not resolve: ${pointer}`);
    target = target[part];
  }
  const key = parts.at(-1);
  if (!target || typeof target !== "object" || !Object.hasOwn(target, key) || canonicalJson(target[key]) !== canonicalJson(before)) extensionFail("KDLC_MIGRATION_PRECONDITION", `Migration before-value drifted: ${pointer}`);
  target[key] = clone(after);
}

export function previewMigration({ migration, files, validator }) {
  const validation = validator.validate("extensionMigration", migration);
  if (!validation.valid) extensionFail("KDLC_EXTENSION_SCHEMA_INVALID", "Migration failed schema validation", { errors: validation.errors });
  if (!semver.valid(migration.from) || !semver.valid(migration.to) || semver.eq(migration.from, migration.to)) extensionFail("KDLC_MIGRATION_VERSION_INVALID", "Migration endpoints must be distinct canonical semantic versions");
  if (!files || typeof files !== "object" || Array.isArray(files)) extensionFail("KDLC_MIGRATION_INPUT_INVALID", "Migration preview requires an explicit file snapshot");
  const output = new Map(Object.entries(files).map(([path, value]) => [path, typeof value === "string" ? value : canonicalJson(value)]));
  const before = new Map(output); const effects = [];
  for (const operation of migration.operations) {
    effects.push({ operation: operation.kind, ...structuredClone(operation.semantic_effect) });
    if (operation.kind === "rename") {
      if (!output.has(operation.from) || output.has(operation.to)) extensionFail("KDLC_MIGRATION_PRECONDITION", "Migration rename source or destination drifted");
      const value = output.get(operation.from); output.delete(operation.from); output.set(operation.to, value);
    } else {
      if (!output.has(operation.path)) extensionFail("KDLC_MIGRATION_PRECONDITION", `Migration file is missing: ${operation.path}`);
      let document; try { document = JSON.parse(output.get(operation.path)); } catch { extensionFail("KDLC_MIGRATION_INPUT_INVALID", `Migration JSON file is malformed: ${operation.path}`); }
      replaceAtPointer(document, operation.pointer, operation.before, operation.after); output.set(operation.path, canonicalJson(document));
    }
  }
  const paths = [...new Set([...before.keys(), ...output.keys()])].sort();
  const changed_files = paths.filter((path) => before.get(path) !== output.get(path)).map((path) => ({ path, before_hash: before.has(path) ? artifactHash(before.get(path)) : null, after_hash: output.has(path) ? artifactHash(output.get(path)) : null }));
  const basis = { api_version: "kdlc.dev/migration-preview/v1alpha1", migration_id: migration.id, plugin: migration.plugin, from: migration.from, to: migration.to,
    reversible: migration.reversible, migration_hash: artifactHash(migration), changed_files, semantic_effects: effects, output_hash: artifactHash(Object.fromEntries([...output].sort())) };
  const preview = Object.freeze({ ...basis, preview_hash: artifactHash(basis) }); previews.set(preview, Object.freeze(Object.fromEntries([...output].sort()))); return preview;
}

export function applyMigrationPreview(preview, { confirmedPreviewHash }) {
  const output = previews.get(preview);
  if (!output || confirmedPreviewHash !== preview.preview_hash) extensionFail("KDLC_MIGRATION_CONFIRMATION_REQUIRED", "Migration application requires the exact preview hash");
  return Object.freeze({ report: structuredClone(preview), files: structuredClone(output) });
}
