import { lstat, readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { artifactHash, byteHash, canonicalJson, isRfc3339Instant, isStaleOn, parseMarkdownConcept } from "../../core/index.mjs";
import { parseYamlArtifact } from "../../contracts/index.mjs";
import { traverseHierarchicalIndex } from "./index-traversal.mjs";
import { retrievalFail } from "./errors.mjs";

const MODES = new Set(["wiki-only", "sources-only", "trusted-only", "fresh-only", "exploratory", "audit", "refresh"]);
const TRUST = Object.freeze({ unverified: 0, "machine-confirmed": 1, "human-reviewed": 2 });
const CONFLICT_TYPES = new Set(["contradicting", "conflict", "unresolved"]);
const authorizationStates = new WeakMap();


function terms(value) { return [...new Set(String(value).normalize("NFKC").toLocaleLowerCase("en").match(/[\p{L}\p{N}_-]+/gu) ?? [])]; }
function trustTier(frontmatter, now) {
  const values = frontmatter.verified ? (Array.isArray(frontmatter.verified) ? frontmatter.verified : [frontmatter.verified]) : [];
  const verified = values.filter((event) => event && typeof event === "object" && typeof event.by === "string" && typeof event.at === "string"
    && /^(?:human:[A-Za-z0-9._@/-]+|process:[A-Za-z0-9._@/-]+|[a-z][a-z0-9_-]*\/[^/\s]+)$/.test(event.by) && isRfc3339Instant(event.at) && Date.parse(event.at) <= now.getTime());
  return verified.some(({ by }) => by.startsWith("human:")) ? "human-reviewed" : verified.length ? "machine-confirmed" : "unverified";
}
function stale(frontmatter, today) { return frontmatter.stale_after !== undefined && isStaleOn(frontmatter.stale_after, today); }
function list(value) { return Array.isArray(value) ? value : []; }
function rawScore(query, concept) {
  const title = terms(concept.frontmatter.title ?? concept.id); const description = terms(concept.frontmatter.description ?? ""); const body = terms(concept.body);
  return query.reduce((score, term) => score + (title.includes(term) ? 5 : 0) + (description.includes(term) ? 3 : 0) + (body.includes(term) ? 1 : 0), 0);
}
function noDisclosure() {
  return { status: "not_found", results: [], citations: [], conflicts: [], warnings: [], timing_class: "bounded-floor" };
}
function livingReference(value) { return typeof value === "string" ? value.replace(/@[^/]+\//, "/") : null; }
function sourceRecord(source) {
  if (typeof source?.id !== "string" || typeof source?.resource !== "string" || (source.source_hash !== undefined && !/^sha256:[0-9a-f]{64}$/.test(source.source_hash))) return null;
  return { id: source.id, resource: source.resource, ...(source.source_hash ? { source_hash: source.source_hash } : {}), ...(source.access ? { access: source.access } : {}), ...(source.rights ? { rights: source.rights } : {}) };
}
function fileIdentity(metadata) { return { dev: metadata.dev, ino: metadata.ino, size: metadata.size, mtimeMs: metadata.mtimeMs }; }
function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value); for (const member of Object.values(value)) deepFreeze(member, seen); return Object.freeze(value);
}
function immutableJson(value) { return deepFreeze(JSON.parse(canonicalJson(value))); }
function sourcePolicyRecord(source) {
  const citation = sourceRecord(source); if (!citation) return null;
  return { ...citation, ...(source.access !== undefined ? { access: source.access } : {}) };
}
function dispatchAudit(audit, event) {
  if (!audit || !event) return;
  setTimeout(() => { void Promise.resolve().then(() => audit(event)).catch(() => {}); }, 0);
}

async function verifySnapshot(mount) {
  try {
    const manifestBytes = await readFile(`${mount.root}/knowledge-base.yaml`);
    const catalogBytes = await readFile(`${mount.root}/retrieval-catalog.json`);
    const manifest = parseYamlArtifact(manifestBytes.toString("utf8"));
    const catalog = JSON.parse(catalogBytes.toString("utf8"));
    if (byteHash(manifestBytes) !== mount.manifest_hash || byteHash(catalogBytes) !== mount.catalog_hash || manifest?.metadata?.id !== mount.id
      || canonicalJson(catalog.concepts) !== canonicalJson(mount.retrieval_catalog)) throw new Error("identity mismatch");
  } catch { retrievalFail("KDLC_MOUNT_INTEGRITY", "An authorized mount failed integrity verification"); }
}

async function verifyMountIdentity(mount) {
  try {
    const manifestBytes = await readFile(`${mount.root}/knowledge-base.yaml`); const manifest = parseYamlArtifact(manifestBytes.toString("utf8"));
    if (byteHash(manifestBytes) !== mount.manifest_hash || manifest?.metadata?.id !== mount.id) throw new Error("identity mismatch");
  } catch { retrievalFail("KDLC_MOUNT_INTEGRITY", "An authorized mount failed integrity verification"); }
}

export class FederatedRetriever {
  constructor({ mounts, policy, now = () => new Date(), minimumDurationMs = 25, monotonic = () => performance.now(), wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    authorizationTtlMs = 60_000, authorizationMonotonic = () => performance.now(), readConcept = readFile, audit }) {
    if (!policy?.authorizeMount || !policy?.authorizeConcept) retrievalFail("KDLC_POLICY_REQUIRED", "Retrieval requires trusted mount and concept authorization functions");
    if (!Number.isSafeInteger(authorizationTtlMs) || authorizationTtlMs < 1 || authorizationTtlMs > 300_000) retrievalFail("KDLC_AUTHORIZATION_TTL", "Authorization snapshot lifetime must be between 1 and 300000 milliseconds");
    this.mounts = [...mounts]; this.policy = policy; this.now = now; this.minimumDurationMs = minimumDurationMs; this.monotonic = monotonic; this.wait = wait;
    this.authorizationTtlMs = authorizationTtlMs; this.authorizationMonotonic = authorizationMonotonic; this.readConcept = readConcept; this.audit = audit;
  }

  async prepareAuthorization({ principal, queryModes = [...MODES] }) {
    if (!Array.isArray(queryModes) || !queryModes.length || queryModes.some((mode) => !MODES.has(mode))) retrievalFail("KDLC_QUERY_MODE", "Authorization snapshot requires supported query modes");
    let principalHash, principalSnapshot; try { principalSnapshot = immutableJson(principal ?? null); principalHash = artifactHash(principalSnapshot); }
    catch { retrievalFail("KDLC_PRINCIPAL_INVALID", "Retrieval principal must have a stable serializable identity"); }
    const modes = new Map();
    const orderedMounts = [...this.mounts].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const queryMode of [...new Set(queryModes)]) {
      let internallyDenied = false;
      const decisions = await Promise.all(orderedMounts.map(async (mount) => {
        const mountAllowed = await this.policy.authorizeMount({ principal, mount, queryMode, capability: "read" }) === true;
        if (!mountAllowed) { internallyDenied = true; return null; }
        await verifySnapshot(mount);
        const paths = await traverseHierarchicalIndex(mount.root); const catalogPaths = mount.retrieval_catalog.map(({ path }) => path).sort();
        if (canonicalJson([...paths].sort()) !== canonicalJson(catalogPaths)) retrievalFail("KDLC_MOUNT_INTEGRITY", "An authorized mount failed integrity verification");
        const allowed = await Promise.all(mount.retrieval_catalog.map((metadata) => this.policy.authorizeConcept({
          principal, mount, concept: { id: metadata.id, access: metadata.access }, queryMode, capability: "read"
        })));
        if (allowed.some((value) => value !== true)) internallyDenied = true;
        const concepts = await Promise.all(mount.retrieval_catalog.map(async (metadata, index) => {
          if (allowed[index] !== true) return null;
          const conceptPath = `${mount.root}/${metadata.path}`;
          try {
            const bytes = await this.readConcept(conceptPath);
            if (byteHash(bytes) !== metadata.byte_hash) throw new Error("concept hash mismatch");
            const parsed = parseMarkdownConcept(bytes);
            if (canonicalJson(parsed.frontmatter.access ?? null) !== canonicalJson(metadata.access)) throw new Error("concept access mismatch");
            const concept = immutableJson({ id: metadata.id, path: metadata.path, frontmatter: parsed.frontmatter, body: parsed.body });
            const sources = list(parsed.frontmatter.sources).map((source) => ({ policySource: sourcePolicyRecord(source), citation: sourceRecord(source) })).filter(({ citation }) => citation);
            const sourceAllowed = await Promise.all(sources.map(({ policySource }) => this.policy.authorizeSource?.(immutableJson({
              principal: principalSnapshot, mount: { id: mount.id, ...(mount.alias !== undefined ? { alias: mount.alias } : {}), access: mount.access ?? null }, concept: { id: concept.id, access: concept.frontmatter.access ?? null },
              source: policySource, queryMode, capability: "read"
            }))));
            if (sourceAllowed.some((value) => value !== true)) internallyDenied = true;
            const sourceCitations = immutableJson(sources.filter((_, sourceIndex) => sourceAllowed[sourceIndex] === true).map(({ citation }) => citation));
            return deepFreeze({ metadata: immutableJson(metadata), concept, sourceCitations, fileIdentity: fileIdentity(await lstat(conceptPath)) });
          } catch (error) {
            if (error?.code?.startsWith?.("KDLC_")) throw error;
            retrievalFail("KDLC_MOUNT_INTEGRITY", "An authorized mount failed integrity verification");
          }
        }));
        return Object.freeze({ mount, concepts: Object.freeze(concepts.filter(Boolean)) });
      }));
      modes.set(queryMode, Object.freeze({ internallyDenied, mounts: Object.freeze(decisions.filter(Boolean)) }));
    }
    const snapshot = Object.freeze({ kind: "kdlc-retrieval-authorization-1" });
    authorizationStates.set(snapshot, Object.freeze({ retriever: this, principalHash, modes, expiresAt: this.authorizationMonotonic() + this.authorizationTtlMs }));
    return snapshot;
  }

  #authorizedMode(authorization, principal, mode) {
    const authorizationState = authorizationStates.get(authorization); let principalHash;
    try { principalHash = artifactHash(immutableJson(principal ?? null)); }
    catch { retrievalFail("KDLC_PRINCIPAL_INVALID", "Retrieval principal must have a stable serializable identity"); }
    const authorizedMode = authorizationState?.modes.get(mode);
    if (!authorizationState || authorizationState.retriever !== this || authorizationState.expiresAt <= this.authorizationMonotonic()
      || authorizationState.principalHash !== principalHash || !authorizedMode) retrievalFail("KDLC_AUTHORIZATION_SNAPSHOT_REQUIRED", "Retrieval requires a matching current precomputed authorization snapshot");
    return authorizedMode;
  }

  async fetch({ authorization, principal, uri, mode = "audit" }) {
    const started = this.monotonic();
    try {
      if (!MODES.has(mode)) retrievalFail("KDLC_QUERY_MODE", "Unsupported retrieval query mode");
      const authorizedMode = this.#authorizedMode(authorization, principal, mode);
      const match = /^kb:\/\/([^/@]+)(?:@([^/]+))?\/(.+)$/.exec(uri ?? "");
      if (!match) return noDisclosure();
      const [, mountId, revision, conceptId] = match;
      const preparedMount = authorizedMode.mounts.find(({ mount }) => mount.id === mountId && (!revision || mount.resolved_ref === revision));
      const prepared = preparedMount?.concepts.find(({ concept }) => concept.id === conceptId);
      if (!prepared) return noDisclosure();
      await verifyMountIdentity(preparedMount.mount);
      const conceptPath = `${preparedMount.mount.root}/${prepared.metadata.path}`;
      let bytes;
      try {
        if (canonicalJson(fileIdentity(await lstat(conceptPath))) !== canonicalJson(prepared.fileIdentity)) throw new Error("identity mismatch");
        bytes = await this.readConcept(conceptPath);
        if (byteHash(bytes) !== prepared.metadata.byte_hash) throw new Error("byte mismatch");
      } catch { retrievalFail("KDLC_MOUNT_INTEGRITY", "An authorized mount failed integrity verification"); }
      const qualified = `kb://${mountId}@${preparedMount.mount.resolved_ref}/${conceptId}`;
      return immutableJson({ status: "ok", uri: qualified, body: bytes.toString("utf8"), content_hash: byteHash(bytes), citations: [{ concept: qualified, knowledge_base_id: mountId, revision: preparedMount.mount.resolved_ref, tree_hash: preparedMount.mount.tree_hash }], source_citations: prepared.sourceCitations, timing_class: "bounded-floor" });
    } finally {
      const remaining = this.minimumDurationMs - (this.monotonic() - started);
      if (remaining > 0) await this.wait(remaining);
    }
  }

  async search({ authorization, principal, query, mode = "wiki-only", minimumTrust = "unverified", staleBehavior = "warn", limit = 20, includeSources = false }) {
    const started = this.monotonic(); let auditEvent = null;
    try {
      if (!MODES.has(mode)) retrievalFail("KDLC_QUERY_MODE", "Unsupported retrieval query mode");
      if (!(minimumTrust in TRUST)) retrievalFail("KDLC_TRUST_TIER", "Unsupported minimum trust tier");
      if (!["warn", "exclude", "fail"].includes(staleBehavior)) retrievalFail("KDLC_FRESHNESS_POLICY", "Unsupported stale behavior");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) retrievalFail("KDLC_RETRIEVAL_LIMIT", "Retrieval limit must be between 1 and 100");
      let principalSnapshot; try { principalSnapshot = immutableJson(principal ?? null); } catch { retrievalFail("KDLC_PRINCIPAL_INVALID", "Retrieval principal must have a stable serializable identity"); }
      const authorizedMode = this.#authorizedMode(authorization, principal, mode);
      const queryTerms = terms(query); if (!queryTerms.length) return noDisclosure();
      const current = this.now(); const today = current.toISOString().slice(0, 10); const eligible = []; const { internallyDenied } = authorizedMode;
      for (const { mount, concepts } of authorizedMode.mounts) {
        await verifyMountIdentity(mount);
        for (const prepared of concepts) {
          const { metadata, concept, sourceCitations } = prepared; const { path } = metadata;
          try {
            if (canonicalJson(fileIdentity(await lstat(`${mount.root}/${path}`))) !== canonicalJson(prepared.fileIdentity)) throw new Error("concept identity mismatch");
          } catch { retrievalFail("KDLC_MOUNT_INTEGRITY", "An authorized mount failed integrity verification"); }
          const sourceLike = path.startsWith("references/sources/") || /source|evidence/i.test(concept.frontmatter.type ?? "");
          const status = concept.frontmatter.status ?? "stable"; const tier = trustTier(concept.frontmatter, current); const isStale = stale(concept.frontmatter, today);
          const modeEligible = mode === "exploratory" || mode === "audit" || mode === "refresh"
            ? true : mode === "sources-only" ? sourceLike : !sourceLike && ["stable", "deprecated"].includes(status);
          const trustEligible = TRUST[tier] >= TRUST[mode === "trusted-only" && minimumTrust === "unverified" ? "human-reviewed" : minimumTrust];
          const freshnessEligible = !(mode === "fresh-only" || staleBehavior === "exclude") || !isStale;
          if (!modeEligible || !trustEligible || !freshnessEligible) continue;
          const score = rawScore(queryTerms, concept);
          eligible.push({ mount, concept, sourceCitations, score, tier, isStale });
        }
      }
      const candidates = eligible.filter(({ score }) => score > 0);
      const maxima = new Map(); for (const item of candidates) maxima.set(item.mount.id, Math.max(maxima.get(item.mount.id) ?? 0, item.score));
      for (const item of candidates) item.normalized = item.score / maxima.get(item.mount.id) + Math.max(-0.01, Math.min(0.01, item.mount.priority / 10000));
      candidates.sort((a, b) => b.normalized - a.normalized || (a.mount.id < b.mount.id ? -1 : a.mount.id > b.mount.id ? 1 : a.concept.id < b.concept.id ? -1 : a.concept.id > b.concept.id ? 1 : 0));
      const byReference = new Map(eligible.map((item) => [`kb://${item.mount.id}/${item.concept.id}`, item]));
      const selectedByReference = new Map(candidates.slice(0, limit).map((item) => [`kb://${item.mount.id}/${item.concept.id}`, item]));
      for (const item of [...selectedByReference.values()]) for (const relationship of list(item.concept.frontmatter.relationships)) {
        if (!CONFLICT_TYPES.has(String(relationship.type).toLocaleLowerCase("en"))) continue;
        const target = livingReference(relationship.target); const related = byReference.get(target);
        if (related) {
          if (related.normalized === undefined) related.normalized = 0;
          selectedByReference.set(target, related);
        }
      }
      const selected = [...selectedByReference.values()]; const visible = new Set(selectedByReference.keys());
      const results = []; const citations = []; const warnings = []; const conflicts = [];
      for (const item of selected) {
        if (item.isStale && staleBehavior === "fail") return noDisclosure();
        const qualified = `kb://${item.mount.id}@${item.mount.resolved_ref}/${item.concept.id}`;
        const governance = { ...(item.concept.frontmatter.access ? { access: item.concept.frontmatter.access } : {}), ...(item.concept.frontmatter.rights ? { rights: item.concept.frontmatter.rights } : {}) };
        const citation = { concept: qualified, knowledge_base_id: item.mount.id, revision: item.mount.resolved_ref, tree_hash: item.mount.tree_hash, ...governance };
        citations.push(citation);
        const sourceCitations = includeSources || mode === "audit" ? item.sourceCitations : [];
        results.push({ id: `kb://${item.mount.id}/${item.concept.id}`, title: typeof item.concept.frontmatter.title === "string" && item.concept.frontmatter.title ? item.concept.frontmatter.title : item.concept.id.split("/").at(-1),
          description: typeof item.concept.frontmatter.description === "string" ? item.concept.frontmatter.description : null, score: Number(item.normalized.toFixed(6)), trust: item.tier,
          freshness: item.isStale ? "stale" : "current", citation, source_citations: sourceCitations, ...governance,
          applicability: item.concept.frontmatter.applicability ?? null });
        if (item.isStale) warnings.push({ code: "KDLC_STALE", subject: `kb://${item.mount.id}/${item.concept.id}` });
        for (const relationship of list(item.concept.frontmatter.relationships)) {
          const target = livingReference(relationship.target);
          if (CONFLICT_TYPES.has(String(relationship.type).toLocaleLowerCase("en")) && visible.has(target)) conflicts.push({ subject: `kb://${item.mount.id}/${item.concept.id}`, target, relationship: relationship.type, applicability: relationship.applicability ?? null });
        }
      }
      if (!results.length) {
        auditEvent = immutableJson({ action: "retrieval.empty", denied: internallyDenied, principal: principalSnapshot, minimized: true });
        return noDisclosure();
      }
      return { status: "ok", results, citations, conflicts, warnings, timing_class: "bounded-floor", ...(mode === "audit" ? { retrieved_at: this.now().toISOString(), resolved_bases: Object.fromEntries(selected.map(({ mount }) => [mount.id, { revision: mount.resolved_ref, tree_hash: mount.tree_hash }])) } : {}) };
    } finally {
      const remaining = this.minimumDurationMs - (this.monotonic() - started);
      if (remaining > 0) await this.wait(remaining);
      dispatchAudit(this.audit, auditEvent);
    }
  }
}
