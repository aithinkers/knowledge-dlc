import { lstat, readdir } from "node:fs/promises";

import { artifactHash, byteHash, canonicalJson, parseMarkdownConcept } from "../../core/index.mjs";
import { denied, incomplete, invalid } from "./errors.mjs";
import { RevocationGuard } from "./guard.mjs";
import { SurfaceInventory } from "./inventory.mjs";

const MANIFEST_VERSION = "kdlc.dev/provenance-inventory/v1alpha1";
const LOCK = "governance/erasure-inventory-lock";
const GENERATION = "governance/revocations/generation.json";
const NAMESPACE_PATH = ".kdlc/governed-mutation-namespace.json";
const ID = /^[A-Za-z0-9._-]{1,128}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
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

function collectReferences(value, ids = new Set(), hashes = new Set()) {
  if (!value || typeof value !== "object") return { ids, hashes };
  if (typeof value.source_id === "string") ids.add(value.source_id);
  if (typeof value.source_hash === "string") hashes.add(value.source_hash);
  if (Array.isArray(value.source_ids)) for (const id of value.source_ids) if (typeof id === "string") ids.add(id);
  if (Array.isArray(value.source_hashes)) for (const hash of value.source_hashes) if (typeof hash === "string") hashes.add(hash);
  if (value.source && typeof value.source === "object") {
    if (typeof value.source.id === "string") ids.add(value.source.id);
    if (typeof value.source.hash === "string") hashes.add(value.source.hash);
  }
  for (const member of Object.values(value)) collectReferences(member, ids, hashes);
  return { ids, hashes };
}

async function derivedReferences(store, path, evidencePaths = []) {
  const values = [];
  for (const candidate of [path, ...evidencePaths]) {
    let text;
    try { text = await store.readText(candidate); }
    catch { if (candidate === path && evidencePaths.length) continue; throw incomplete("Provenance evidence is unavailable", { path: candidate }); }
    try { values.push(JSON.parse(text)); continue; } catch {}
    if (/\.md$/i.test(candidate)) {
      try { values.push(parseMarkdownConcept(Buffer.from(text)).frontmatter); continue; } catch {}
    }
  }
  const references = values.reduce((result, value) => collectReferences(value, result.ids, result.hashes), { ids: new Set(), hashes: new Set() });
  return { source_ids: [...references.ids].sort(), source_hashes: [...references.hashes].sort() };
}

function referencesPath(content, path) {
  try {
    const values = [];
    const visit = (value) => { if (typeof value === "string") values.push(value); else if (value && typeof value === "object") for (const member of Object.values(value)) visit(member); };
    visit(JSON.parse(content));
    return values.some((value) => value === path || value.endsWith(`/${path}`));
  } catch {}
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\]\\((?:\\.\\./|\\./)*${escaped}(?:#[^)]+)?\\)`).test(content);
}

async function authenticateExternalCatalog(processorId, processor, catalog) {
  if (!Array.isArray(catalog) || typeof processor?.verifyInventory !== "function")
    throw incomplete("External provenance inventory is unavailable or unauthenticated", { processor: processorId });
  const records = [];
  const objectIds = new Set();
  for (const record of catalog) {
    const sourceIds = record?.bindings?.source_ids;
    const sourceHashes = record?.bindings?.source_hashes;
    const dependencies = record?.depends_on;
    if (!ID.test(record?.object_id ?? "") || !HASH.test(record?.object_hash ?? "") ||
      record.deletion_identity_hash !== byteHash(Buffer.from(record.object_id ?? "")) ||
      !HASH.test(record?.attestation_hash ?? "") || !Array.isArray(sourceIds) || !sourceIds.length ||
      sourceIds.some((id) => !ID.test(id)) || new Set(sourceIds).size !== sourceIds.length ||
      !Array.isArray(sourceHashes) || sourceHashes.length !== sourceIds.length ||
      sourceHashes.some((hash) => !HASH.test(hash)) || new Set(sourceHashes).size !== sourceHashes.length ||
      !Array.isArray(dependencies) || dependencies.some((id) => !ID.test(id)) ||
      new Set(dependencies).size !== dependencies.length || objectIds.has(record?.object_id))
      throw incomplete("External provenance catalog contains an unbound or ambiguous record", { processor: processorId });
    objectIds.add(record.object_id);
    const claim = {
      processor: processorId,
      object_id: record.object_id,
      object_hash: record.object_hash,
      deletion_identity_hash: record.deletion_identity_hash,
      bindings: { source_ids: [...sourceIds].sort(), source_hashes: [...sourceHashes].sort() },
      depends_on: [...dependencies].sort(),
    };
    const recordHash = artifactHash(claim);
    if ((await processor.verifyInventory({
      claim: structuredClone(claim),
      record_hash: recordHash,
      attestation_hash: record.attestation_hash,
    })) !== true) throw incomplete("External provenance inventory is unavailable or unauthenticated", { processor: processorId });
    records.push({
      ...claim,
      inventory_record_hash: recordHash,
      inventory_attestation_hash: record.attestation_hash,
    });
  }
  return records;
}

export class ProjectProvenanceInventory extends SurfaceInventory {
  constructor({ store, governedRoots = PROJECT_GOVERNED_ROOTS, manifestPath = ".kdlc/provenance-surfaces.json", externalProcessors = {} }) {
    if (!Array.isArray(governedRoots) || governedRoots.some((root) => typeof root !== "string" || !root) ||
      PROJECT_GOVERNED_ROOTS.some((required) => !governedRoots.includes(required)))
      throw invalid("Project provenance inventory requires explicit governed roots");
    const state = { store, governedRoots: [...new Set(governedRoots)].sort(), manifestPath, externalProcessors };
    super({ store, list: () => ProjectProvenanceInventory.readComplete(state) });
    Object.assign(this, state);
  }

  async ensureNamespace() {
    const expected = { api_version: "kdlc.dev/governed-mutation-namespace/v1", roots: this.governedRoots, lock_path: LOCK, generation_path: GENERATION };
    if (await this.store.exists(NAMESPACE_PATH)) {
      if (canonicalJson(await this.store.readJson(NAMESPACE_PATH)) !== canonicalJson(expected)) throw incomplete("Governed mutation namespace drifted");
    } else await this.store.writeJsonAtomic(NAMESPACE_PATH, expected);
    return expected;
  }

  async snapshot() {
    const namespace = await this.ensureNamespace();
    const before = await this.store.mutationGeneration(namespace);
    if (before % 2) throw incomplete("Governed provenance mutation is incomplete");
    const snapshot = await super.snapshot();
    const after = await this.store.mutationGeneration(namespace);
    if (before !== after || after % 2) throw incomplete("Governed provenance changed during enumeration");
    return Object.freeze({ ...snapshot, namespace_generation: after });
  }

  finalize({ owner, clock }, action) { return this.store.withMutationNamespace({ owner, clock }, action); }

  static async readComplete({ store, governedRoots, manifestPath, externalProcessors = {} }) {
    if (!(await store.exists(manifestPath))) throw incomplete("Durable provenance inventory is missing");
    let manifest;
    try { manifest = await store.readJson(manifestPath); } catch { throw incomplete("Durable provenance inventory is invalid"); }
    if (manifest?.api_version !== MANIFEST_VERSION || manifest.complete !== true || !Array.isArray(manifest.descriptors) || !Array.isArray(manifest.surfaces) ||
      artifactHash(manifest.descriptors) !== manifest.descriptors_hash || artifactHash(manifest.surfaces) !== manifest.surfaces_hash)
      throw incomplete("Durable provenance inventory is not a complete bound manifest");
    const surfaces = await ProjectProvenanceInventory.derive({ store, descriptors: manifest.descriptors, externalProcessors });
    if (canonicalJson(surfaces) !== canonicalJson(manifest.surfaces)) throw incomplete("Committed provenance bindings do not match trusted artifacts");
    const represented = new Set();
    for (const surface of manifest.surfaces) if (surface.strategy !== "external-delete") represented.add(await store.identity(surface.path));
    const discovered = new Set((await Promise.all(governedRoots.map((root) => filesBelow(store, root)))).flat());
    const unknown = [...discovered].filter((path) => !represented.has(path)).sort();
    const outside = [...represented].filter((path) => !governedRoots.some((root) => path === root || path.startsWith(`${root}/`))).sort();
    if (unknown.length || outside.length) throw incomplete("Provenance inventory does not exactly cover governed storage", { unknown, outside });
    return structuredClone(surfaces);
  }

  static async derive({ store, descriptors, externalProcessors = {} }) {
    if (!Array.isArray(descriptors) || descriptors.some((item) => item.bindings !== undefined || item.depends_on !== undefined))
      throw incomplete("Provenance descriptors cannot declare bindings or dependency edges");
    const surfaces = [];
    const externalCatalogs = new Map();
    for (const [processorId, processor] of Object.entries(externalProcessors)) {
      const catalog = await processor?.inventory?.();
      const authenticated = await authenticateExternalCatalog(processorId, processor, catalog);
      externalCatalogs.set(processorId, authenticated);
      for (const record of authenticated) if (!descriptors.some((descriptor) => descriptor.strategy === "external-delete" && descriptor.processor === processorId && descriptor.object_id === record.object_id))
        throw incomplete("Authenticated external surface is omitted from provenance inventory", { processor: processorId });
    }
    for (const descriptor of descriptors) {
      if (descriptor.strategy === "external-delete") {
        const catalog = externalCatalogs.get(descriptor.processor);
        const record = Array.isArray(catalog) ? catalog.find(({ object_id: objectId }) => objectId === descriptor.object_id) : null;
        if (!record) throw incomplete("External provenance inventory is unavailable or unauthenticated", { processor: descriptor.processor });
        const { processor: _processor, ...bindings } = record;
        surfaces.push({ ...structuredClone(descriptor), ...structuredClone(bindings) });
        continue;
      }
      const bindings = await derivedReferences(store, descriptor.path, descriptor.evidence_paths ?? []);
      if (descriptor.kind === "original" && await store.exists(descriptor.path) && !bindings.source_hashes.includes(await store.tokenOf(descriptor.path)))
        throw incomplete("Original-source provenance does not bind its exact bytes", { id: descriptor.id });
      const content = await store.exists(descriptor.path) ? await store.readText(descriptor.path) : "";
      const depends_on = descriptors.filter((candidate) => candidate.id !== descriptor.id && candidate.strategy !== "external-delete" &&
        referencesPath(content, candidate.path)).map(({ id }) => id).sort();
      if (!bindings.source_ids.length && !bindings.source_hashes.length && !depends_on.length)
        throw incomplete("Governed surface has no trusted provenance binding", { id: descriptor.id });
      const { evidence_paths: _evidence, ...surface } = descriptor;
      surfaces.push({ ...structuredClone(surface), bindings, depends_on });
    }
    return surfaces;
  }

  async #coordinate(clock, owner, action) {
    return this.store.withMutex(LOCK, { owner, clock }, action);
  }

  async commitManifest(descriptors, { clock, owner = "provenance-manifest" }) {
    await this.ensureNamespace();
    return this.#coordinate(clock, owner, async () => {
      const surfaces = await ProjectProvenanceInventory.derive({ store: this.store, descriptors, externalProcessors: this.externalProcessors });
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
      const manifest = { api_version: MANIFEST_VERSION, complete: true, descriptors: structuredClone(descriptors), descriptors_hash: artifactHash(descriptors), surfaces: structuredClone(surfaces), surfaces_hash: artifactHash(surfaces), updated_at: clock.now() };
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
