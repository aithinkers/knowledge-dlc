import semver from "semver";

import { artifactHash, canonicalJson } from "../../core/index.mjs";
import { extensionFail } from "./errors.mjs";

const previews = new WeakMap();
function clone(value) { return JSON.parse(canonicalJson(value)); }
function pointerParts(pointer) { return pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~")); }
const trustOrder = Object.freeze({ unverified: 0, "machine-confirmed": 1, "human-reviewed": 2 });
const severityOrder = Object.freeze({ info: 0, warning: 1, error: 2 });
function equal(left, right) { return canonicalJson(left) === canonicalJson(right); }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function deepMerge(base, patch) {
  const result = clone(base);
  for (const [key, value] of Object.entries(patch)) result[key] = object(value) && object(result[key]) ? deepMerge(result[key], value) : clone(value);
  return result;
}
function includesAll(after, before) { return Array.isArray(after) && Array.isArray(before) && before.every((value) => after.some((candidate) => equal(candidate, value))); }
function finding(path, rule, category, weakening) { return { path: `/${path.join("/")}`, rule, category, security_weakening: weakening }; }
function arrayIdentity(value) { return object(value) ? value.id ?? value.name ?? value.metadata?.id : undefined; }
function atomicArrayPath(path) {
  const semanticPath = `/${path.join("/")}`.toLowerCase();
  return ["gate", "approval", "network", "credential", "filesystem", "access", "rights", "permission"].some((term) => semanticPath.includes(term));
}
function evaluateLeaf(before, after, path) {
  const key = String(path.at(-1) ?? "").toLowerCase(); const semanticPath = `/${path.join("/")}`.toLowerCase();
  if (key.includes("trust")) {
    const safe = after !== undefined && trustOrder[after] !== undefined && (before === undefined || (trustOrder[before] !== undefined && trustOrder[after] >= trustOrder[before]));
    return finding(path, "minimum-trust", "trust", !safe);
  }
  if (key.includes("approval") || key.includes("mandatory_gate") || key === "gates" || key.endsWith("_gates")) {
    const safe = after !== undefined && (before === undefined ? Array.isArray(after) : includesAll(after, before));
    return finding(path, "mandatory-gates", "validation", !safe);
  }
  if (key === "blocking" || key === "deterministic") return finding(path, key, "validation", after !== true);
  if (key === "severity") {
    const safe = after !== undefined && severityOrder[after] !== undefined && (before === undefined ? after === "error" : severityOrder[before] !== undefined && severityOrder[after] >= severityOrder[before]);
    return finding(path, "sensor-severity", "validation", !safe);
  }
  const permissionPath = ["network", "execute", "macro", "subprocess", "credential", "permission", "security", "filesystem", "access", "rights", "resource", "memory", "cpu", "output", "budget", "limit"].some((term) => semanticPath.includes(term));
  if (permissionPath) {
    let safe = false;
    if (after === false) safe = true;
    else if (typeof before === "boolean" && typeof after === "boolean") safe = before === after || (before && !after);
    else if (Array.isArray(after)) safe = before === undefined ? after.length === 0 : Array.isArray(before) && includesAll(before, after);
    else if (typeof before === "number" && typeof after === "number") safe = after <= before;
    return finding(path, "permission-boundary", "permission", !safe);
  }
  if (["fresh", "stale", "retention", "policy", "waiver"].some((term) => semanticPath.includes(term))) {
    const timestamps = typeof before === "string" && typeof after === "string" && Number.isFinite(Date.parse(before)) && Number.isFinite(Date.parse(after));
    const safe = before === undefined ? after !== undefined : timestamps && Date.parse(after) <= Date.parse(before);
    return finding(path, "policy-boundary", "trust", !safe);
  }
  if (["configuration", "profile", "scope", "sensor", "normalizer", "template"].some((term) => semanticPath.split("/").some((part) => part.includes(term)))) {
    return finding(path, "unclassified-policy-surface", "validation", true);
  }
  return finding(path, "content", "content", false);
}
function recursivePolicyDiff(before, after, path) {
  if (before !== undefined && after !== undefined && equal(before, after)) return [];
  if (object(before) || object(after)) {
    const keys = [...new Set([...Object.keys(object(before) ? before : {}), ...Object.keys(object(after) ? after : {})])].sort();
    if (keys.length) return keys.flatMap((key) => recursivePolicyDiff(object(before) ? before[key] : undefined, object(after) ? after[key] : undefined, [...path, key]));
  }
  if ((Array.isArray(before) || Array.isArray(after)) && !atomicArrayPath(path)) {
    const left = Array.isArray(before) ? before : []; const right = Array.isArray(after) ? after : [];
    const leftIds = left.map(arrayIdentity); const rightIds = right.map(arrayIdentity); const keyed = [...leftIds, ...rightIds].every((id) => typeof id === "string")
      && new Set(leftIds).size === leftIds.length && new Set(rightIds).size === rightIds.length;
    if (keyed) {
      const leftMap = new Map(left.map((value) => [arrayIdentity(value), value])); const rightMap = new Map(right.map((value) => [arrayIdentity(value), value]));
      return [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort().flatMap((id) => recursivePolicyDiff(leftMap.get(id), rightMap.get(id), [...path, `@${id}`]));
    }
    if ([...left, ...right].some(object)) return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => recursivePolicyDiff(left[index], right[index], [...path, String(index)])).flat();
  }
  return [evaluateLeaf(before, after, path)];
}
function derivedEffect(operation) {
  if (operation.kind === "rename") return { operation: "rename", category: "routing", description: `Renames ${operation.from} to ${operation.to}.`, security_weakening: false,
    before_hash: artifactHash(operation.from), after_hash: artifactHash(operation.to) };
  const policy_changes = recursivePolicyDiff(operation.before, operation.after, pointerParts(operation.pointer));
  const category = policy_changes.find(({ category: value }) => value === "permission")?.category
    ?? policy_changes.find(({ category: value }) => value === "trust")?.category
    ?? policy_changes.find(({ category: value }) => value === "validation")?.category ?? "content";
  return { operation: operation.kind, category, description: `Changes ${operation.path}${operation.pointer}.`,
    security_weakening: policy_changes.some((change) => change.security_weakening), policy_changes,
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
    if (operation.kind === "rename") {
      effects.push(derivedEffect(operation));
      if (!output.has(operation.from) || output.has(operation.to)) extensionFail("KDLC_MIGRATION_PRECONDITION", "Migration rename source or destination drifted");
      const value = output.get(operation.from); output.delete(operation.from); output.set(operation.to, value);
    } else {
      if (!output.has(operation.path)) extensionFail("KDLC_MIGRATION_PRECONDITION", `Migration file is missing: ${operation.path}`);
      let document; try { document = JSON.parse(output.get(operation.path)); } catch { extensionFail("KDLC_MIGRATION_INPUT_INVALID", `Migration JSON file is malformed: ${operation.path}`); }
      const after = operation.kind === "merge-json" ? deepMerge(operation.before, operation.after) : operation.after;
      effects.push(derivedEffect({ ...operation, after }));
      replaceAtPointer(document, operation.pointer, operation.before, after); output.set(operation.path, canonicalJson(document));
    }
  }
  const paths = [...new Set([...before.keys(), ...output.keys()])].sort();
  const changed_files = paths.filter((path) => before.get(path) !== output.get(path)).map((path) => ({ path, before_hash: before.has(path) ? artifactHash(before.get(path)) : null, after_hash: output.has(path) ? artifactHash(output.get(path)) : null }));
  const basis = { api_version: "kdlc.dev/migration-preview/v1alpha1", migration_id: migration.id, plugin: migration.plugin, from: migration.from, to: migration.to,
    reversible: migration.reversible, migration_hash: artifactHash(migration), changed_files, semantic_effects: effects,
    security_weakening: effects.some((effect) => effect.security_weakening), output_hash: artifactHash(Object.fromEntries([...output].sort())) };
  const preview = Object.freeze({ ...basis, preview_hash: artifactHash(basis) }); previews.set(preview, Object.freeze(Object.fromEntries([...output].sort()))); return preview;
}

export function applyMigrationPreview(preview, { confirmedPreviewHash, authority, waiver }) {
  const output = previews.get(preview);
  if (!output || confirmedPreviewHash !== preview.preview_hash) extensionFail("KDLC_MIGRATION_CONFIRMATION_REQUIRED", "Migration application requires the exact preview hash");
  if (preview.security_weakening && !authority?.verifyMigrationWaiver(waiver, preview)) extensionFail("KDLC_MIGRATION_SECURITY_DOWNGRADE", "Security-weakening migration requires an exact active authenticated waiver");
  return Object.freeze({ report: structuredClone(preview), files: structuredClone(output) });
}
