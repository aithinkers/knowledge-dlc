import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { byteHash, canonicalJson, parseMarkdownConcept } from "../../core/index.mjs";
import { parseYamlArtifact } from "../../contracts/index.mjs";
import { traverseHierarchicalIndex } from "./index-traversal.mjs";
import { retrievalFail } from "./errors.mjs";

const MODES = new Set(["wiki-only", "sources-only", "trusted-only", "fresh-only", "exploratory", "audit", "refresh"]);
const TRUST = Object.freeze({ unverified: 0, "machine-confirmed": 1, "human-reviewed": 2 });
const CONFLICT_TYPES = new Set(["contradicting", "conflict", "unresolved"]);

function terms(value) { return [...new Set(String(value).normalize("NFKC").toLocaleLowerCase("en").match(/[\p{L}\p{N}_-]+/gu) ?? [])]; }
function trustTier(frontmatter) {
  const values = frontmatter.verified ? (Array.isArray(frontmatter.verified) ? frontmatter.verified : [frontmatter.verified]) : [];
  const verified = values.filter((event) => event && typeof event === "object" && typeof event.by === "string" && typeof event.at === "string"
    && /^(?:human:[A-Za-z0-9._@/-]+|process:[A-Za-z0-9._@/-]+|[a-z][a-z0-9_-]*\/[^/\s]+)$/.test(event.by) && Number.isFinite(Date.parse(event.at)));
  return verified.some(({ by }) => by.startsWith("human:")) ? "human-reviewed" : verified.length ? "machine-confirmed" : "unverified";
}
function stale(frontmatter, today) { return frontmatter.stale_after !== undefined && (typeof frontmatter.stale_after !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(frontmatter.stale_after) || today >= frontmatter.stale_after); }
function list(value) { return Array.isArray(value) ? value : []; }
function rawScore(query, concept) {
  const title = terms(concept.frontmatter.title ?? concept.id); const description = terms(concept.frontmatter.description ?? ""); const body = terms(concept.body);
  return query.reduce((score, term) => score + (title.includes(term) ? 5 : 0) + (description.includes(term) ? 3 : 0) + (body.includes(term) ? 1 : 0), 0);
}
function noDisclosure() {
  return { status: "not_found", results: [], citations: [], conflicts: [], warnings: [], timing_class: "bounded-floor" };
}
function livingReference(value) { return typeof value === "string" ? value.replace(/@[^/]+\//, "/") : null; }

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

export class FederatedRetriever {
  constructor({ mounts, policy, now = () => new Date(), minimumDurationMs = 25, monotonic = () => performance.now(), wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), readConcept = readFile, audit }) {
    if (!policy?.authorizeMount || !policy?.authorizeConcept) retrievalFail("KDLC_POLICY_REQUIRED", "Retrieval requires trusted mount and concept authorization functions");
    this.mounts = [...mounts]; this.policy = policy; this.now = now; this.minimumDurationMs = minimumDurationMs; this.monotonic = monotonic; this.wait = wait; this.readConcept = readConcept; this.audit = audit;
  }

  async search({ principal, query, mode = "wiki-only", minimumTrust = "unverified", staleBehavior = "warn", limit = 20, includeSources = false }) {
    const started = this.monotonic();
    try {
      if (!MODES.has(mode)) retrievalFail("KDLC_QUERY_MODE", "Unsupported retrieval query mode");
      if (!(minimumTrust in TRUST)) retrievalFail("KDLC_TRUST_TIER", "Unsupported minimum trust tier");
      if (!["warn", "exclude", "fail"].includes(staleBehavior)) retrievalFail("KDLC_FRESHNESS_POLICY", "Unsupported stale behavior");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) retrievalFail("KDLC_RETRIEVAL_LIMIT", "Retrieval limit must be between 1 and 100");
      const queryTerms = terms(query); if (!queryTerms.length) return noDisclosure();
      const today = this.now().toISOString().slice(0, 10); const eligible = []; let internallyDenied = false;
      for (const mount of [...this.mounts].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        const mountAllowed = await this.policy.authorizeMount({ principal, mount, queryMode: mode, capability: "read" }) === true;
        if (!mountAllowed) { internallyDenied = true; continue; }
        await verifySnapshot(mount);
        const paths = await traverseHierarchicalIndex(mount.root);
        const catalogPaths = mount.retrieval_catalog.map(({ path }) => path).sort();
        if (canonicalJson([...paths].sort()) !== canonicalJson(catalogPaths)) retrievalFail("KDLC_MOUNT_INTEGRITY", "An authorized mount failed integrity verification");
        for (const metadata of mount.retrieval_catalog) {
          const { id, path } = metadata;
          const allowed = await this.policy.authorizeConcept({ principal, mount, concept: { id, access: metadata.access }, queryMode: mode, capability: "read" }) === true;
          if (!allowed) { internallyDenied = true; continue; }
          let bytes;
          try { bytes = await this.readConcept(`${mount.root}/${path}`); }
          catch { retrievalFail("KDLC_MOUNT_INTEGRITY", "An authorized mount failed integrity verification"); }
          if (byteHash(bytes) !== metadata.byte_hash) retrievalFail("KDLC_MOUNT_INTEGRITY", "An authorized mount failed integrity verification");
          const parsed = parseMarkdownConcept(bytes);
          if (canonicalJson(parsed.frontmatter.access ?? null) !== canonicalJson(metadata.access)) retrievalFail("KDLC_MOUNT_INTEGRITY", "An authorized mount failed integrity verification");
          const concept = { id, path, frontmatter: parsed.frontmatter, body: parsed.body };
          const sourceLike = path.startsWith("references/sources/") || /source|evidence/i.test(parsed.frontmatter.type ?? "");
          const status = parsed.frontmatter.status ?? "stable"; const tier = trustTier(parsed.frontmatter); const isStale = stale(parsed.frontmatter, today);
          const modeEligible = mode === "exploratory" || mode === "audit" || mode === "refresh"
            ? true : mode === "sources-only" ? sourceLike : !sourceLike && ["stable", "deprecated"].includes(status);
          const trustEligible = TRUST[tier] >= TRUST[mode === "trusted-only" && minimumTrust === "unverified" ? "human-reviewed" : minimumTrust];
          const freshnessEligible = !(mode === "fresh-only" || staleBehavior === "exclude") || !isStale;
          if (!modeEligible || !trustEligible || !freshnessEligible) continue;
          const score = rawScore(queryTerms, concept);
          eligible.push({ mount, concept, score, tier, isStale });
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
        const citation = { concept: qualified, knowledge_base_id: item.mount.id, revision: item.mount.resolved_ref, tree_hash: item.mount.tree_hash };
        citations.push(citation);
        const sourceCitations = [];
        if (includeSources || mode === "audit") for (const source of list(item.concept.frontmatter.sources)) {
          if (typeof source?.id !== "string" || typeof source?.resource !== "string" || (source.source_hash !== undefined && !/^sha256:[0-9a-f]{64}$/.test(source.source_hash))) continue;
          if (await this.policy.authorizeSource?.({ principal, mount: item.mount, concept: item.concept, source, queryMode: mode, capability: "read" }) === true) sourceCitations.push({ id: source.id, resource: source.resource, ...(source.source_hash ? { source_hash: source.source_hash } : {}) });
        }
        results.push({ id: `kb://${item.mount.id}/${item.concept.id}`, title: typeof item.concept.frontmatter.title === "string" && item.concept.frontmatter.title ? item.concept.frontmatter.title : item.concept.id.split("/").at(-1),
          description: typeof item.concept.frontmatter.description === "string" ? item.concept.frontmatter.description : null, score: Number(item.normalized.toFixed(6)), trust: item.tier,
          freshness: item.isStale ? "stale" : "current", citation, source_citations: sourceCitations,
          applicability: item.concept.frontmatter.applicability ?? null });
        if (item.isStale) warnings.push({ code: "KDLC_STALE", subject: `kb://${item.mount.id}/${item.concept.id}` });
        for (const relationship of list(item.concept.frontmatter.relationships)) {
          const target = livingReference(relationship.target);
          if (CONFLICT_TYPES.has(String(relationship.type).toLocaleLowerCase("en")) && visible.has(target)) conflicts.push({ subject: `kb://${item.mount.id}/${item.concept.id}`, target, relationship: relationship.type, applicability: relationship.applicability ?? null });
        }
      }
      if (!results.length) {
        await this.audit?.({ action: "retrieval.empty", denied: internallyDenied, principal, minimized: true });
        return noDisclosure();
      }
      return { status: "ok", results, citations, conflicts, warnings, timing_class: "bounded-floor", ...(mode === "audit" ? { retrieved_at: this.now().toISOString(), resolved_bases: Object.fromEntries(selected.map(({ mount }) => [mount.id, { revision: mount.resolved_ref, tree_hash: mount.tree_hash }])) } : {}) };
    } finally {
      const remaining = this.minimumDurationMs - (this.monotonic() - started);
      if (remaining > 0) await this.wait(remaining);
    }
  }
}
