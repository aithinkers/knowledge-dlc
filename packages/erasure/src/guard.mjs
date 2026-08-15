import { createHash } from "node:crypto";

import { internalSources } from "../../retrieval/src/internal-source-bindings.mjs";

const ID = /^[A-Za-z0-9._-]{1,128}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;

function key(sourceId) {
  return createHash("sha256").update(sourceId).digest("hex");
}

export class RevocationGuard {
  constructor({ store }) { this.store = store; }
  path(sourceId) { return `governance/revocations/${key(sourceId)}.json`; }
  generationPath() { return "governance/revocations/generation.json"; }
  async generation() {
    if (!(await this.store.exists(this.generationPath()))) return 0;
    try {
      const value = await this.store.readJson(this.generationPath());
      return Number.isSafeInteger(value?.generation) && value.generation >= 0 ? value.generation : null;
    } catch { return null; }
  }
  async revoked(sourceId, sourceHash) {
    const path = this.path(sourceId);
    if (!(await this.store.exists(path))) return false;
    let barrier;
    try { barrier = await this.store.readJson(path); } catch { return true; }
    if (barrier?.api_version !== "kdlc.dev/revocation-barrier/v1alpha1" ||
      barrier.source?.id !== sourceId || !HASH.test(barrier.source?.hash ?? "") ||
      !ID.test(barrier.workflow_id ?? "") || !ID.test(barrier.job_id ?? "") ||
      !HASH.test(barrier.impact_hash ?? "") || !HASH.test(barrier.decision_hash ?? "") ||
      typeof barrier.activated_at !== "string" || !Number.isFinite(Date.parse(barrier.activated_at)) ||
      !["revoked", "erasure-pending", "erased", "held"].includes(barrier.state)) return true;
    return !sourceHash || barrier.source.hash === sourceHash;
  }
  async allowedCitations(citations) {
    if (!Array.isArray(citations) || citations.length === 0) return false;
    for (const citation of citations) {
      if (!citation || typeof citation.id !== "string" ||
        typeof citation.source_hash !== "string") return false;
      if (await this.revoked(citation.id, citation.source_hash)) return false;
    }
    return true;
  }
  async stableAllowed(citations) {
    const before = await this.generation();
    if (before === null || before % 2 === 1 || !(await this.allowedCitations(citations))) return false;
    const after = await this.generation();
    return after !== null && after % 2 === 0 && before === after;
  }
  async stableFilter(citationSets) {
    const before = await this.generation();
    if (before === null || before % 2 === 1) return null;
    const allowed = [];
    for (const citations of citationSets) allowed.push(await this.allowedCitations(citations));
    const after = await this.generation();
    return after !== null && after % 2 === 0 && before === after ? allowed : null;
  }
}

export function guardRetriever(retriever, guard) {
  return Object.freeze({
    prepareAuthorization: (...args) => retriever.prepareAuthorization(...args),
    async search(options) {
      const result = await retriever.search({ ...options, includeSources: true });
      if (result?.status !== "ok") return result;
      const decisions = await guard.stableFilter(result.results.map((item) => internalSources(item)));
      const kept = decisions ? result.results.filter((_, index) => decisions[index]) : [];
      if (!kept.length)
        return { status: "not_found", results: [], citations: [], conflicts: [], warnings: [], timing_class: "bounded-floor" };
      const allowedConcepts = new Set(kept.map(({ citation }) => citation.concept));
      const livingConcepts = new Set([...allowedConcepts].map((concept) => concept.replace(/@[^/]+\//, "/")));
      return {
        ...result,
        status: kept.length ? "ok" : "not_found",
        results: kept,
        citations: result.citations.filter(({ concept }) => allowedConcepts.has(concept)),
        conflicts: result.conflicts.filter(({ subject, target }) => (allowedConcepts.has(subject) || livingConcepts.has(subject)) && (allowedConcepts.has(target) || livingConcepts.has(target))),
        warnings: result.warnings.filter(({ subject }) => !subject || allowedConcepts.has(subject) || livingConcepts.has(subject)),
        ...(result.resolved_bases ? { resolved_bases: Object.fromEntries(Object.entries(result.resolved_bases).filter(([id]) => kept.some(({ citation }) => citation.knowledge_base_id === id))) } : {}),
        ...(!options.includeSources && options.mode !== "audit" ? { results: kept.map((item) => ({ ...item, source_citations: [] })) } : {}),
      };
    },
    async fetch(options) {
      const result = await retriever.fetch(options);
      if (result?.status === "ok" && !(await guard.stableAllowed(internalSources(result))))
        return { status: "not_found", results: [], citations: [], conflicts: [], warnings: [], timing_class: "bounded-floor" };
      return result;
    },
  });
}
