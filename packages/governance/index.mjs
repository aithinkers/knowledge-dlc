import { artifactHash, BASE_REVIEW_FIELDS, canonicalJson, reviewHash, reviewProjection } from "../core/index.mjs";

export class GovernanceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GovernanceError";
    this.code = code;
    this.details = details;
  }
}

function requireValid(validator, contract, value) {
  const result = validator.validate(contract, value);
  if (!result.valid) throw new GovernanceError("KDLC_ARTIFACT_INVALID", `${contract} failed schema validation`, { contract, errors: result.errors });
  return value;
}

function same(left, right) { return canonicalJson(left) === canonicalJson(right); }
function sourceHashes(packet) { return [...new Set(packet.evidence.map(({ source_hash }) => source_hash))].sort(); }
function conceptSourceHashes(concept) { return [...new Set((concept?.frontmatter?.sources ?? []).map(({ source_hash }) => source_hash).filter((value) => typeof value === "string"))].sort(); }

function claimBuckets(claims, evidence, validator) {
  const buckets = { accepted: [], rejected: [], merged: [], conflicting: [] };
  const evidenceBindings = new Set(evidence.map(({ source_id, source_hash }) => `${source_id}\0${source_hash}`));
  const ids = new Set();
  for (const claim of claims) {
    requireValid(validator, "claim", claim);
    if (ids.has(claim.id)) throw new GovernanceError("KDLC_REVIEW_INPUT_INVALID", `Duplicate review claim: ${claim.id}`);
    ids.add(claim.id);
    const bucket = claim.status === "conflict" ? "conflicting" : claim.status;
    if (!Object.hasOwn(buckets, bucket)) throw new GovernanceError("KDLC_REVIEW_INPUT_INVALID", `Claim ${claim.id} lacks a review disposition`);
    if (!evidenceBindings.has(`${claim.source_id}\0${claim.source_hash}`)) throw new GovernanceError("KDLC_REVIEW_INPUT_INVALID", `Claim ${claim.id} is not bound to packet evidence`);
    buckets[bucket].push(structuredClone(claim));
  }
  return buckets;
}

export function createReviewPacket({ proposal, claims, evidence, sensors, impact, resolved, provenance, budget, validator }) {
  requireValid(validator, "conceptProposal", proposal);
  const fields = reviewProjection(proposal.concept.after, BASE_REVIEW_FIELDS).fields;
  const packet = {
    api_version: "kdlc.dev/review-packet/v1alpha1",
    proposal: { id: proposal.id, workflow_id: proposal.workflow_id },
    target: structuredClone(proposal.target),
    concept: structuredClone(proposal.concept),
    diff: {
      structural: proposal.direct_edit?.structural_diff ?? structuralDiff(proposal.concept.before, proposal.concept.after),
      textual: proposal.direct_edit?.textual_diff ?? canonicalJson({ before: proposal.concept.before?.body ?? null, after: proposal.concept.after.body })
    },
    review: { hash: reviewHash(proposal.concept.after, fields), projection: "kdlc-review-1", fields: [...fields] },
    claims: claimBuckets(claims, evidence, validator),
    evidence: structuredClone(evidence),
    sensors: structuredClone(sensors),
    impact: structuredClone(impact),
    resolved: structuredClone(resolved),
    provenance: structuredClone(provenance),
    budget: structuredClone(budget),
    reviewer_actions: ["approve", "reject", "request-changes"],
    approval_consequences: "Approval authorizes only this exact review projection and resolved evidence context; stable publication still requires all policy gates."
  };
  requireValid(validator, "reviewPacket", packet);
  return Object.freeze({ packet: structuredClone(packet), packet_hash: artifactHash(packet) });
}

export function createReviewReceipt({ packet, decision, reviewer, receiptId, reviewedAt, validator }) {
  requireValid(validator, "reviewPacket", packet);
  const receipt = {
    api_version: "kdlc.dev/review-receipt/v1alpha1",
    id: receiptId,
    proposal_id: packet.proposal.id,
    subject: packet.target.subject,
    decision,
    reviewer: structuredClone(reviewer),
    review: {
      algorithm: "sha256",
      canonicalization: "kdlc-c14n-1",
      projection: packet.review.projection,
      hash: packet.review.hash,
      fields: structuredClone(packet.review.fields)
    },
    packet_hash: artifactHash(packet),
    source_hashes: sourceHashes(packet),
    resolved_dependencies: structuredClone(packet.resolved.dependencies),
    profile: structuredClone(packet.resolved.profile),
    policies: structuredClone(packet.resolved.policies),
    reviewed_at: reviewedAt
  };
  requireValid(validator, "reviewReceipt", receipt);
  return Object.freeze(structuredClone(receipt));
}

function stableConceptFailures(concept, now) {
  const frontmatter = concept?.frontmatter ?? {};
  const failures = [];
  for (const field of ["type", "title", "description", "status"]) if (typeof frontmatter[field] !== "string" || frontmatter[field].length === 0) failures.push(`missing-${field}`);
  if (typeof frontmatter.generated?.by !== "string" || typeof frontmatter.generated?.at !== "string" || !Number.isFinite(Date.parse(frontmatter.generated.at))) failures.push("missing-generation");
  if (!Array.isArray(frontmatter.sources) || frontmatter.sources.length === 0) failures.push("missing-source");
  if (frontmatter.freshness !== "timeless" && (typeof frontmatter.stale_after !== "string" || !Number.isFinite(Date.parse(frontmatter.stale_after)) || Date.parse(frontmatter.stale_after) <= Date.parse(now))) failures.push("missing-future-freshness");
  return failures;
}

export function assessPublication({ proposal, packet, receipt, current, validator, now = new Date().toISOString() }) {
  requireValid(validator, "conceptProposal", proposal);
  requireValid(validator, "reviewPacket", packet);
  if (receipt) requireValid(validator, "reviewReceipt", receipt);
  const failures = [];
  const stable = proposal.concept.after?.frontmatter?.status === "stable";
  if (!current || typeof current !== "object" || !current.concept || !Array.isArray(current.source_hashes) || !current.resolved_dependencies || !current.profile || !Array.isArray(current.policies) || typeof current.target_revision !== "string") {
    return Object.freeze({ allowed: false, failures: ["current-context-invalid"] });
  }
  if (packet.proposal.id !== proposal.id || !same(packet.target, proposal.target) || !same(packet.concept, proposal.concept)) failures.push("packet-proposal-drift");
  if (!receipt) failures.push("receipt-missing");
  else {
    if (receipt.decision !== "approved") failures.push(`receipt-${receipt.decision}`);
    if (receipt.proposal_id !== proposal.id || receipt.subject !== proposal.target.subject) failures.push("receipt-subject-drift");
    if (receipt.packet_hash !== artifactHash(packet)) failures.push("packet-hash-drift");
    if (receipt.review.hash !== packet.review.hash || receipt.review.projection !== packet.review.projection || !same(receipt.review.fields, packet.review.fields)) failures.push("review-binding-drift");
    if (!same(receipt.source_hashes, sourceHashes(packet))) failures.push("source-binding-drift");
    if (!same(receipt.resolved_dependencies, packet.resolved.dependencies)) failures.push("dependency-binding-drift");
    if (!same(receipt.profile, packet.resolved.profile)) failures.push("profile-binding-drift");
    if (!same(receipt.policies, packet.resolved.policies)) failures.push("policy-binding-drift");
    if (stable && !receipt.reviewer.actor.startsWith("human:")) failures.push("human-review-required");
  }
  if (reviewHash(current.concept, packet.review.fields) !== packet.review.hash) failures.push("review-content-drift");
  if (reviewHash(packet.concept.after, packet.review.fields) !== packet.review.hash) failures.push("packet-review-hash-invalid");
  if (current.target_revision !== packet.target.revision) failures.push("target-revision-drift");
  if (!same([...new Set(current.source_hashes)].sort(), sourceHashes(packet))) failures.push("current-source-drift");
  if (!same(conceptSourceHashes(current.concept), sourceHashes(packet))) failures.push("concept-source-drift");
  if (!same(current.resolved_dependencies, packet.resolved.dependencies)) failures.push("current-dependency-drift");
  if (!same(current.profile, packet.resolved.profile)) failures.push("current-profile-drift");
  if (!same(current.policies, packet.resolved.policies)) failures.push("current-policy-drift");
  if (packet.sensors.some((sensor) => sensor.blocks === true || (sensor.severity === "error" && sensor.result !== "passed" && sensor.result !== "waived"))) failures.push("blocking-sensor");
  if (stable) failures.push(...stableConceptFailures(current.concept, now));
  return Object.freeze({ allowed: failures.length === 0, failures: [...new Set(failures)].sort() });
}

export function verificationStatus({ concept, receipt }) {
  const actual = reviewHash(concept, receipt.review.fields);
  return Object.freeze({ status: actual === receipt.review.hash ? "verified" : "modified-after-review", expected_review_hash: receipt.review.hash, current_review_hash: actual });
}

function structuralDiff(before, after) {
  const keys = [...new Set([...Object.keys(before?.frontmatter ?? {}), ...Object.keys(after?.frontmatter ?? {})])].sort();
  return keys.filter((key) => !same(before?.frontmatter?.[key] ?? null, after?.frontmatter?.[key] ?? null)).map((key) => ({ path: `frontmatter.${key}`, before: before?.frontmatter?.[key] ?? null, after: after?.frontmatter?.[key] ?? null }));
}

export function reconcileDirectEdit({ proposalId, workflowId, target, reviewedConcept, currentConcept, receipt, validator, actor = "kdlc-integrator/0.2.0" }) {
  requireValid(validator, "reviewReceipt", receipt);
  const status = verificationStatus({ concept: currentConcept, receipt });
  if (status.status !== "modified-after-review") throw new GovernanceError("KDLC_RECONCILE_UNNEEDED", "The concept review projection has not changed");
  const proposal = {
    api_version: "kdlc.dev/concept-proposal/v1alpha1",
    id: proposalId,
    workflow_id: workflowId,
    task: "reconcile-direct-edit",
    state: "candidate",
    target: structuredClone(target),
    concept: { before: structuredClone(reviewedConcept), after: structuredClone(currentConcept) },
    claim_ids: [],
    claim_decisions: [],
    created_by: actor,
    direct_edit: {
      expected_review_hash: status.expected_review_hash,
      current_review_hash: status.current_review_hash,
      structural_diff: structuralDiff(reviewedConcept, currentConcept),
      textual_diff: reviewedConcept.body === currentConcept.body ? "" : canonicalJson({ before: reviewedConcept.body, after: currentConcept.body })
    }
  };
  requireValid(validator, "conceptProposal", proposal);
  return Object.freeze(structuredClone(proposal));
}
