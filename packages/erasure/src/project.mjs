import { lstat, readdir } from "node:fs/promises";

import { artifactHash } from "../../core/index.mjs";
import { denied, incomplete, invalid } from "./errors.mjs";
import { RevocationGuard } from "./guard.mjs";
import { SurfaceInventory } from "./inventory.mjs";

const MANIFEST_VERSION = "kdlc.dev/provenance-inventory/v1alpha1";
const LOCK = "governance/erasure-inventory-lock";
export const PROJECT_GOVERNED_ROOTS = Object.freeze([
  ".kdlc/cache", ".kdlc/embeddings", ".kdlc/graph", ".kdlc/index",
  "backups", "exports", "knowledge", "sources", "workflow/audit-evidence",
  "workflow/claims", "workflow/proposals", "workflow/receipts", "workflow/review-packets",
]);

async function filesBelow(store, root) {
  const output = [];
  if (!(await store.exists(root))) return output;
  const visit = async (path) => {
    const absolute = store.path(path);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw incomplete("Governed provenance root contains a symlink", { path });
    if (metadata.isDirectory()) {
      for (const entry of (await readdir(absolute)).sort()) await visit(`${path}/${entry}`);
    } else if (metadata.isFile()) output.push(await store.identity(path));
    else throw incomplete("Governed provenance root contains an unsupported object", { path });
  };
  await visit(root);
  return output;
}

export class ProjectProvenanceInventory extends SurfaceInventory {
  constructor({ store, governedRoots = PROJECT_GOVERNED_ROOTS, manifestPath = ".kdlc/provenance-surfaces.json" }) {
    if (!Array.isArray(governedRoots) || governedRoots.some((root) => typeof root !== "string" || !root) ||
      PROJECT_GOVERNED_ROOTS.some((required) => !governedRoots.includes(required)))
      throw invalid("Project provenance inventory requires explicit governed roots");
    const state = { store, governedRoots: [...new Set(governedRoots)].sort(), manifestPath };
    super({ store, list: () => ProjectProvenanceInventory.readComplete(state) });
    Object.assign(this, state);
  }

  static async readComplete({ store, governedRoots, manifestPath }) {
    if (!(await store.exists(manifestPath))) throw incomplete("Durable provenance inventory is missing");
    let manifest;
    try { manifest = await store.readJson(manifestPath); } catch { throw incomplete("Durable provenance inventory is invalid"); }
    if (manifest?.api_version !== MANIFEST_VERSION || manifest.complete !== true || !Array.isArray(manifest.surfaces) ||
      artifactHash(manifest.surfaces) !== manifest.surfaces_hash)
      throw incomplete("Durable provenance inventory is not a complete bound manifest");
    const represented = new Set();
    for (const surface of manifest.surfaces) if (surface.strategy !== "external-delete") represented.add(await store.identity(surface.path));
    const discovered = new Set((await Promise.all(governedRoots.map((root) => filesBelow(store, root)))).flat());
    const unknown = [...discovered].filter((path) => !represented.has(path)).sort();
    const outside = [...represented].filter((path) => !governedRoots.some((root) => path === root || path.startsWith(`${root}/`))).sort();
    if (unknown.length || outside.length) throw incomplete("Provenance inventory does not exactly cover governed storage", { unknown, outside });
    return structuredClone(manifest.surfaces);
  }

  async #coordinate(clock, owner, action) {
    return this.store.withMutex(LOCK, { owner, clock }, action);
  }

  async replaceManifest(surfaces, { clock, owner = "provenance-manifest" }) {
    return this.#coordinate(clock, owner, async () => {
      const guard = new RevocationGuard({ store: this.store });
      for (const surface of surfaces) for (const [index, sourceId] of (surface.bindings?.source_ids ?? []).entries())
        if (await guard.revoked(sourceId, surface.bindings?.source_hashes?.[index]))
          throw denied("A revoked source cannot be added back to governed provenance storage");
      const candidate = await new SurfaceInventory({ store: this.store, list: async () => structuredClone(surfaces) }).snapshot();
      const represented = new Set(candidate.surfaces.filter(({ strategy }) => strategy !== "external-delete").map(({ path }) => path));
      const discovered = new Set((await Promise.all(this.governedRoots.map((root) => filesBelow(this.store, root)))).flat());
      const unknown = [...discovered].filter((path) => !represented.has(path)).sort();
      const outside = [...represented].filter((path) => !this.governedRoots.some((root) => path === root || path.startsWith(`${root}/`))).sort();
      if (unknown.length || outside.length) throw incomplete("Provenance inventory does not exactly cover governed storage", { unknown, outside });
      const manifest = { api_version: MANIFEST_VERSION, complete: true, surfaces: structuredClone(surfaces), surfaces_hash: artifactHash(surfaces), updated_at: clock.now() };
      await this.store.writeJsonAtomic(this.manifestPath, manifest);
      return Object.freeze(structuredClone(manifest));
    });
  }
}

export class GovernedErasureOperation {
  constructor({ engine, governanceControls }) {
    if (!engine?.start || !engine?.run || !engine?.issueGovernanceEvidence || !governanceControls?.authorizeErasure)
      throw invalid("Governed erasure operation requires the shipped erasure and FEAT-008 governance engines");
    Object.assign(this, { engine, governanceControls });
  }

  async execute(request) {
    const started = await this.engine.start(request);
    if (!started.decision.allowed) return { status: "blocked", job: started.job, decision: started.decision };
    const receipt = await this.engine.run(request.workflowId, started.job.job_id);
    const completion = await this.engine.issueGovernanceEvidence(request.workflowId, started.job.job_id);
    await this.governanceControls.authorizeErasure({
      subject: artifactHash({ id: request.sourceId, hash: request.sourceHash }),
      erasure_verification: completion,
    });
    return { status: receipt.result, job_id: started.job.job_id, receipt, completion };
  }
}
