import semver from "semver";

import { artifactHash, canonicalJson } from "../../core/index.mjs";
import { extensionFail } from "./errors.mjs";

const previews = new WeakMap();
function clone(value) { return JSON.parse(canonicalJson(value)); }
function pointerParts(pointer) { return pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~")); }
const trustOrder = Object.freeze({ unverified: 0, "machine-confirmed": 1, "human-reviewed": 2 });
const severityOrder = Object.freeze({ info: 0, warning: 1, error: 2 });
function removedValues(before, after) { return Array.isArray(before) && Array.isArray(after) && before.some((value) => !after.includes(value)); }
function derivedEffect(operation) {
  if (operation.kind === "rename") return { operation: "rename", category: "routing", description: `Renames ${operation.from} to ${operation.to}.`, security_weakening: false,
    before_hash: artifactHash(operation.from), after_hash: artifactHash(operation.to) };
  const key = pointerParts(operation.pointer).at(-1).toLowerCase(); const semanticPath = operation.pointer.toLowerCase(); let category = "content"; let security_weakening = false;
  if (key.includes("trust")) { category = "trust"; security_weakening = trustOrder[operation.after] === undefined || trustOrder[operation.before] === undefined || trustOrder[operation.after] < trustOrder[operation.before]; }
  else if (key.includes("approval") || key.includes("gate")) { category = "validation"; security_weakening = !Array.isArray(operation.before) || !Array.isArray(operation.after) || removedValues(operation.before, operation.after); }
  else if (key === "blocking" || key === "deterministic") { category = "validation"; security_weakening = operation.before === true && operation.after !== true; }
  else if (key === "severity") { category = "validation"; security_weakening = severityOrder[operation.after] === undefined || severityOrder[operation.before] === undefined || severityOrder[operation.after] < severityOrder[operation.before]; }
  else if (["network", "execute", "macro", "subprocess", "credential", "permission", "security", "filesystem", "access", "rights", "resource", "memory", "cpu", "output", "budget", "limit"].some((term) => semanticPath.includes(term))) {
    category = "permission";
    if (operation.before === false) security_weakening = operation.after !== false;
    else if (operation.before === true) security_weakening = ![true, false].includes(operation.after);
    else if (Array.isArray(operation.before)) security_weakening = !Array.isArray(operation.after) || removedValues(operation.after, operation.before);
    else if (typeof operation.before === "number" && typeof operation.after === "number") security_weakening = operation.after > operation.before;
    else security_weakening = canonicalJson(operation.before) !== canonicalJson(operation.after);
  } else if (["fresh", "stale", "retention", "policy", "waiver"].some((term) => semanticPath.includes(term))) {
    category = "trust";
    if (typeof operation.before === "string" && typeof operation.after === "string" && Number.isFinite(Date.parse(operation.before)) && Number.isFinite(Date.parse(operation.after))) security_weakening = Date.parse(operation.after) > Date.parse(operation.before);
    else security_weakening = canonicalJson(operation.before) !== canonicalJson(operation.after);
  } else if (key.includes("route") || key.includes("target") || key.includes("mount")) category = "routing";
  return { operation: "replace-json", category, description: `Changes ${operation.path}${operation.pointer}.`, security_weakening,
    before_hash: artifactHash(operation.before), after_hash: artifactHash(operation.after) };
}
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
    effects.push(derivedEffect(operation));
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
    reversible: migration.reversible, migration_hash: artifactHash(migration), changed_files, semantic_effects: effects,
    security_weakening: effects.some((effect) => effect.security_weakening), output_hash: artifactHash(Object.fromEntries([...output].sort())) };
  const preview = Object.freeze({ ...basis, preview_hash: artifactHash(basis) }); previews.set(preview, Object.freeze(Object.fromEntries([...output].sort()))); return preview;
}

export function applyMigrationPreview(preview, { confirmedPreviewHash, authority, waiver, now = new Date().toISOString() }) {
  const output = previews.get(preview);
  if (!output || confirmedPreviewHash !== preview.preview_hash) extensionFail("KDLC_MIGRATION_CONFIRMATION_REQUIRED", "Migration application requires the exact preview hash");
  if (preview.security_weakening && !authority?.verifyMigrationWaiver(waiver, preview, now)) extensionFail("KDLC_MIGRATION_SECURITY_DOWNGRADE", "Security-weakening migration requires an exact active authenticated waiver");
  return Object.freeze({ report: structuredClone(preview), files: structuredClone(output) });
}
