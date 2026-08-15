import { artifactHash } from "../../core/index.mjs";
import { incomplete, invalid } from "./errors.mjs";

export const SURFACE_KINDS = Object.freeze([
  "original", "normalized", "claim", "concept", "quote", "cache", "index",
  "embedding", "graph", "export", "log", "backup", "proposal", "receipt", "audit",
]);
const kinds = new Set(SURFACE_KINDS);
const strategies = new Set(["purge", "tombstone", "external-delete"]);
const ID = /^[A-Za-z0-9._-]{1,128}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

function validTime(value) {
  if (value === null || value === undefined) return true;
  const match = typeof value === "string" ? RFC3339.exec(value) : null;
  if (!match) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) && date.getUTCDate() === Number(match[3]) &&
    date.getUTCHours() === Number(match[4]) && date.getUTCMinutes() === Number(match[5]) &&
    date.getUTCSeconds() === Number(match[6]);
}

function referencesSource(surface, source) {
  return surface.bindings.source_ids.includes(source.id) || surface.bindings.source_hashes.includes(source.hash);
}

export function surfaceIdentity(surface) {
  return {
    id: surface.id,
    kind: surface.kind,
    strategy: surface.strategy,
    path: surface.path ?? null,
    ...(surface.processor ? { processor: surface.processor, object_id: surface.object_id } : {}),
    bindings: surface.bindings,
    depends_on: surface.depends_on,
    retained_until: surface.retained_until ?? null,
  };
}

export class SurfaceInventory {
  constructor({ store, list }) {
    if (!store || typeof list !== "function") throw invalid("Surface inventory requires a trusted store and enumerator");
    this.store = store;
    this.list = list;
  }

  async snapshot() {
    const input = await this.list();
    if (!Array.isArray(input)) throw incomplete("Surface enumerator did not return a complete list");
    const surfaces = [];
    const ids = new Set();
    const paths = new Set();
    for (const candidate of input) {
      if (!candidate || !ID.test(candidate.id ?? "") || !kinds.has(candidate.kind) ||
        !strategies.has(candidate.strategy) || !Array.isArray(candidate.depends_on) ||
        candidate.depends_on.some((id) => !ID.test(id)) ||
        !Array.isArray(candidate.bindings?.source_ids) || !Array.isArray(candidate.bindings?.source_hashes) ||
        candidate.bindings.source_ids.some((id) => !ID.test(id)) ||
        candidate.bindings.source_hashes.some((hash) => !HASH.test(hash)) || !validTime(candidate.retained_until))
        throw incomplete("Surface inventory contains an invalid record", { id: candidate?.id });
      if (ids.has(candidate.id)) throw incomplete("Surface inventory contains a duplicate ID", { id: candidate.id });
      ids.add(candidate.id);
      if (["audit", "log"].includes(candidate.kind) && candidate.strategy === "purge")
        throw incomplete("Audit and log surfaces must retain a minimized tombstone", { id: candidate.id });
      let path = null;
      let token = null;
      if (candidate.strategy !== "external-delete") {
        if (typeof candidate.path !== "string") throw incomplete("Local surface lacks a path", { id: candidate.id });
        path = await this.store.identity(candidate.path);
        if (paths.has(path)) throw incomplete("Surface inventory aliases one local path", { path });
        paths.add(path);
        token = await this.store.exists(path) ? await this.store.tokenOf(path) : null;
      } else if (!ID.test(candidate.processor ?? "") || !ID.test(candidate.object_id ?? "")) {
        throw incomplete("External surface lacks a processor/object identity", { id: candidate.id });
      }
      const surface = {
        id: candidate.id,
        kind: candidate.kind,
        strategy: candidate.strategy,
        path,
        token,
        ...(candidate.processor ? { processor: candidate.processor, object_id: candidate.object_id } : {}),
        bindings: {
          source_ids: [...new Set(candidate.bindings.source_ids)].sort(),
          source_hashes: [...new Set(candidate.bindings.source_hashes)].sort(),
        },
        depends_on: [...new Set(candidate.depends_on)].sort(),
        retained_until: candidate.retained_until ?? null,
      };
      surface.identity_hash = artifactHash(surfaceIdentity(surface));
      surfaces.push(surface);
    }
    for (const surface of surfaces) for (const dependency of surface.depends_on)
      if (!ids.has(dependency)) throw incomplete("Surface inventory contains an unresolved provenance edge", { id: surface.id, dependency });
    surfaces.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    return Object.freeze({ version: 1, surfaces: Object.freeze(surfaces.map(Object.freeze)) });
  }
}

export function resolveImpact(snapshot, source) {
  if (!snapshot?.surfaces || !ID.test(source?.id ?? "") || !HASH.test(source?.hash ?? ""))
    throw invalid("Impact analysis requires a valid source identity and inventory snapshot");
  const impacted = new Set(snapshot.surfaces.filter((surface) => referencesSource(surface, source)).map(({ id }) => id));
  if (!impacted.size) throw incomplete("No inventoried source copy matches the revocation request");
  let changed = true;
  while (changed) {
    changed = false;
    for (const surface of snapshot.surfaces) {
      if (!impacted.has(surface.id) && surface.depends_on.some((dependency) => impacted.has(dependency))) {
        impacted.add(surface.id);
        changed = true;
      }
    }
  }
  const nodes = snapshot.surfaces.filter(({ id }) => impacted.has(id)).map((surface) => ({
    id: surface.id,
    kind: surface.kind,
    strategy: surface.strategy,
    retained_until: surface.retained_until,
    identity_hash: surface.identity_hash,
    depends_on: surface.depends_on.filter((dependency) => impacted.has(dependency)),
  }));
  const edges = nodes.flatMap((node) => node.depends_on.map((dependency) => ({ from: dependency, to: node.id })));
  const impact = {
    api_version: "kdlc.dev/revocation-impact/v1alpha1",
    source: structuredClone(source),
    inventory_hash: artifactHash(snapshot),
    surface_plan_hash: artifactHash(snapshot.surfaces.filter(({ id }) => impacted.has(id))),
    nodes,
    edges,
  };
  return Object.freeze(structuredClone(impact));
}
