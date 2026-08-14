import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { fail } from "./errors.mjs";

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function cleanConceptId(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    fail("KDLC_REFERENCE_INVALID", `Invalid percent encoding in reference: ${value}`);
  }
  const pieces = decoded.split("/");
  if (!decoded || decoded.includes("\0") || decoded.startsWith("/") || pieces.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
    fail("KDLC_REFERENCE_TRAVERSAL", `Unsafe concept path: ${value}`);
  }
  const conceptId = decoded.endsWith(".md") ? decoded.slice(0, -3) : decoded;
  if (!conceptId) fail("KDLC_REFERENCE_INVALID", `Concept ID is empty: ${value}`);
  return conceptId;
}

export async function resolveContainedPath(root, reference, { from = "", requireFile = true } = {}) {
  if (typeof reference !== "string" || reference.includes("\0")) {
    fail("KDLC_REFERENCE_INVALID", "Reference must be a non-NUL string");
  }
  const canonicalRoot = await realpath(root);
  const base = reference.startsWith("/") ? canonicalRoot : resolve(canonicalRoot, dirname(from));
  const lexical = resolve(base, reference.startsWith("/") ? `.${reference}` : reference);
  if (!isInside(canonicalRoot, lexical)) fail("KDLC_REFERENCE_TRAVERSAL", `Reference escapes mounted root: ${reference}`);

  let canonical;
  try {
    canonical = await realpath(lexical);
  } catch (error) {
    fail("KDLC_REFERENCE_MISSING", `Reference does not resolve: ${reference}`, { cause: error.code });
  }
  if (!isInside(canonicalRoot, canonical)) fail("KDLC_REFERENCE_TRAVERSAL", `Reference resolves outside mounted root: ${reference}`);
  if (requireFile && !(await lstat(canonical)).isFile()) fail("KDLC_REFERENCE_INVALID", `Reference is not a file: ${reference}`);
  return canonical;
}

export async function createMountTable(mounts) {
  if (!Array.isArray(mounts) || mounts.length === 0) fail("KDLC_MOUNT_INVALID", "At least one mount is required");
  const byId = new Map();
  const byName = new Map();
  for (const mount of mounts) {
    if (!mount?.id || !mount?.name || !mount?.root) fail("KDLC_MOUNT_INVALID", "Mount id, name, and root are required");
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(mount.id) || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(mount.name)) {
      fail("KDLC_MOUNT_INVALID", `Invalid mount identity: ${mount.id}/${mount.name}`);
    }
    if (byId.has(mount.id)) fail("KDLC_DUPLICATE_KB_ID", `Duplicate mounted knowledge-base ID: ${mount.id}`);
    if (byName.has(mount.name)) fail("KDLC_DUPLICATE_MOUNT", `Duplicate mount name: ${mount.name}`);
    const root = await realpath(mount.root);
    if (!(await lstat(root)).isDirectory()) fail("KDLC_MOUNT_INVALID", `Mount root is not a directory: ${mount.root}`);
    const resolved = Object.freeze({ ...mount, root });
    byId.set(mount.id, resolved);
    byName.set(mount.name, resolved);
  }
  return Object.freeze({
    getById: (id) => byId.get(id),
    getByName: (name) => byName.get(name),
    mounts: Object.freeze([...byId.values()])
  });
}

export function parseKbReference(reference) {
  if (typeof reference !== "string" || !reference.startsWith("kb://") || reference.includes("?") || reference.includes("#")) {
    fail("KDLC_REFERENCE_INVALID", `Invalid kb reference: ${reference}`);
  }
  const rest = reference.slice(5);
  const slash = rest.indexOf("/");
  if (slash <= 0) fail("KDLC_REFERENCE_INVALID", `Invalid kb reference: ${reference}`);
  const authority = rest.slice(0, slash);
  const at = authority.lastIndexOf("@");
  const id = at > 0 ? authority.slice(0, at) : authority;
  const version = at > 0 ? authority.slice(at + 1) : undefined;
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(id) || (at > 0 && !version)) {
    fail("KDLC_REFERENCE_INVALID", `Invalid knowledge-base authority: ${authority}`);
  }
  return Object.freeze({ id, version, conceptId: cleanConceptId(rest.slice(slash + 1)) });
}

export async function resolveKbReference(reference, mountTable, { aliases = new Map(), maxAliasHops = 16 } = {}) {
  let current = reference;
  const visited = new Set();
  for (let hop = 0; hop <= maxAliasHops; hop += 1) {
    const parsed = parseKbReference(current);
    const key = `kb://${parsed.id}/${parsed.conceptId}`;
    if (visited.has(key)) fail("KDLC_ALIAS_CYCLE", `Alias cycle detected at ${key}`);
    visited.add(key);
    const mount = mountTable.getById(parsed.id);
    if (!mount) fail("KDLC_KB_NOT_MOUNTED", `Knowledge base is not mounted: ${parsed.id}`);
    if (parsed.version && ![mount.version, mount.revision].includes(parsed.version)) {
      fail("KDLC_KB_VERSION_MISMATCH", `Mounted revision does not satisfy ${parsed.version}: ${parsed.id}`);
    }
    const target = aliases.get(key);
    if (target) {
      current = target.startsWith("kb://") ? target : `kb://${parsed.id}/${cleanConceptId(target)}`;
      continue;
    }
    return Object.freeze({
      ...parsed,
      mount,
      path: await resolveContainedPath(mount.root, `${parsed.conceptId}.md`),
      aliasChain: Object.freeze([...visited])
    });
  }
  fail("KDLC_ALIAS_LIMIT", `Alias resolution exceeded ${maxAliasHops} hops`);
}
