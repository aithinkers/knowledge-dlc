import { createHash } from "node:crypto";

const ID = /^[A-Za-z0-9._-]{1,128}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;

function key(sourceId) {
  return createHash("sha256").update(sourceId).digest("hex");
}

export class RevocationGuard {
  constructor({ store }) { this.store = store; }
  path(sourceId) { return `governance/revocations/${key(sourceId)}.json`; }
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
}

export function guardRetriever(retriever, guard) {
  return Object.freeze({
    prepareAuthorization: (...args) => retriever.prepareAuthorization(...args),
    async search(options) {
      const result = await retriever.search({ ...options, includeSources: true });
      if (result?.status !== "ok") return result;
      const kept = [];
      for (const item of result.results)
        if (await guard.allowedCitations(item.source_citations)) kept.push(item);
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
      if (result?.status === "ok" && !(await guard.allowedCitations(result.source_citations)))
        return { status: "not_found", results: [], citations: [], conflicts: [], warnings: [], timing_class: "bounded-floor" };
      return result;
    },
  });
}
