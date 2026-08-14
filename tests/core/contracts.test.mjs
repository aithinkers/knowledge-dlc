import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createContractValidator,
  loadContractSchemas,
  validateProjectSemantics,
  validateResolvedMountIds
} from "../../packages/contracts/index.mjs";
import { OKF_REFERENCE, verifyOkfReference } from "../../scripts/verify-okf-reference.mjs";

const digest = `sha256:${"a".repeat(64)}`;

const validProject = {
  api_version: "kdlc.dev/v1alpha1",
  kind: "Project",
  metadata: { name: "payments-modernization", title: "Payments Modernization" },
  purpose: "./purpose.md",
  profile: "software-project@1",
  knowledge_bases: [
    { name: "payments", uri: "./knowledge/primary", mode: "maintain", role: "primary", priority: 100 },
    { name: "security", uri: "../security", mode: "read-only", role: "dependency", priority: 90 }
  ],
  routing: { default_write_target: "payments", by_type: { Decision: "payments" } },
  workflow: {
    scope: "ingest",
    knowledge_depth: "standard",
    trust_level: "team",
    autonomy: "draft",
    approval_policy: "publish-only"
  },
  policies: { access: "acme-access@4" },
  budgets: { max_model_cost_usd: 25, max_model_tokens: 500000, on_exceed: "park" },
  retrieval: {
    mode: "filesystem",
    default_bases: ["payments", "security"],
    minimum_trust: "unverified",
    stale_behavior: "warn",
    citation_format: "qualified"
  }
};

const validReceipt = {
  api_version: "kdlc.dev/review-receipt/v1alpha1",
  id: "rr_01j5",
  proposal_id: "pr_01j5",
  subject: "kb://acme.payments/policies/authentication",
  decision: "approved",
  reviewer: { actor: "human:reviewer-123", principal_mode: "served", issuer: "https://id.acme.example" },
  review: {
    algorithm: "sha256",
    canonicalization: "kdlc-c14n-1",
    projection: "kdlc-review-1",
    hash: digest,
    fields: ["body", "type", "sources"]
  },
  packet_hash: digest,
  source_hashes: [digest],
  resolved_dependencies: { "acme.security": { version: "2.4.0", tree_hash: digest } },
  profile: { id: "software-project", version: "1.2.0", hash: digest },
  policies: [{ id: "team-policy", version: "7", hash: digest }],
  reviewed_at: "2026-08-14T15:20:00Z"
};

test("FEAT-001 vendors the exact pinned OKF 0.2 bytes", async () => {
  const result = await verifyOkfReference();
  assert.equal(result.valid, true, result.failures.join("\n"));
  assert.equal(result.digest, OKF_REFERENCE.sha256);
});

test("FEAT-001 publishes strict JSON Schema 2020-12 contracts", async () => {
  const schemas = await loadContractSchemas();
  assert.equal(schemas.length, 10);
  for (const { relativePath, schema } of schemas) {
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema", relativePath);
    assert.match(schema.$id, /^https:\/\/kdlc\.dev\/schemas\//, relativePath);
  }
  await createContractValidator();
});

test("FEAT-001 validates Project structure and cross-field invariants", async () => {
  const contracts = await createContractValidator();
  assert.deepEqual(contracts.validate("project", validProject), { valid: true, errors: [] });
  assert.deepEqual(validateProjectSemantics(validProject), []);

  const unknownEnum = structuredClone(validProject);
  unknownEnum.workflow.autonomy = "fully-autonomous";
  assert.equal(contracts.validate("project", unknownEnum).valid, false);

  const injected = structuredClone(validProject);
  injected.credentials = "not-allowed";
  assert.equal(contracts.validate("project", injected).valid, false);

  const duplicate = structuredClone(validProject);
  duplicate.knowledge_bases[1].name = "payments";
  duplicate.routing.default_write_target = "security";
  assert.deepEqual(validateProjectSemantics(duplicate), [
    "duplicate mount name: payments",
    "default write target does not name a mount: security"
  ]);
});

test("FEAT-001 rejects duplicate resolved knowledge-base IDs", () => {
  assert.deepEqual(validateResolvedMountIds([
    { alias: "security", id: "acme.security" },
    { alias: "security-copy", id: "acme.security" }
  ]), ["duplicate knowledge-base id acme.security: security and security-copy"]);
});

test("FEAT-001 validates manifests, claims, extensions, packets, and receipts", async () => {
  const contracts = await createContractValidator();
  const knowledgeBase = {
    api_version: "kdlc.dev/v1alpha1",
    kind: "KnowledgeBase",
    metadata: { id: "acme.security", name: "security", title: "Security", version: "2.4.0" },
    format: { type: "okf", version: "0.2" },
    profile: "security-policy@2",
    ownership: { owner: "team:security", maintainers: ["team:security-architecture"] },
    access: { classification: "internal" },
    publication: { stable_requires: { human_verifiers: 1 }, default_stale_after: "180d" }
  };
  const lock = {
    api_version: "kdlc.dev/v1alpha1",
    project: "payments-modernization",
    resolved_at: "2026-08-14T15:00:00Z",
    knowledge_bases: { security: { id: "acme.security", version: "2.4.0", uri: "../security", manifest_hash: digest, tree_hash: digest } }
  };
  const source = {
    api_version: "kdlc.dev/v1alpha1",
    kind: "SourceRecord",
    id: "src_01j5",
    source_kind: "document",
    title: "Authentication Standard",
    resource: "https://security.example/standard",
    source_class: "authoritative",
    media_type: "text/html",
    language: "en",
    retrieved_at: "2026-08-14T14:00:00Z",
    content_hash: digest,
    normalizer: { id: "html-to-markdown", version: "1.1.0" },
    rights: { license: "LicenseRef-Proprietary", redistribution: "metadata-only", attribution_required: true },
    access: { classification: "internal", policy_ref: "acme-access@4" },
    status: "active"
  };
  const claim = { id: "clm_01j5", text: "Tokens expire.", source_id: "src_01j5", source_hash: digest, locator: { heading: "Lifetime" }, extraction: "explicit", status: "candidate" };
  const claimSidecarEntry = {
    assertion_key: "policies/authentication#token-lifetime",
    assertion: "Tokens expire.",
    source_key: "auth-standard",
    source_record_id: "src_01j5",
    source_hash: digest,
    locator: { heading: "Lifetime" },
    extraction: "explicit",
    disposition: "accepted"
  };
  const extensions = {
    producer_extension: { preserved: true },
    relationships: [{ type: "depends_on", target: "kb://acme.platform/systems/identity" }],
    access: { classification: "internal", compartments: ["payments"] },
    claim_provenance: { resource: "/references/claims/policies/auth.jsonl", artifact_hash: digest },
    review_receipts: [{ resource: "/references/reviews/rr_01j5.json", artifact_hash: digest }]
  };
  const reviewPacket = {
    api_version: "kdlc.dev/review-packet/v1alpha1",
    proposal: { id: "pr_01j5", workflow_id: "wf_01j5" },
    target: {
      knowledge_base_id: "acme.payments",
      revision: "0123456789abcdef",
      subject: "kb://acme.payments/policies/authentication"
    },
    concept: { before: null, after: { type: "Policy", title: "Authentication" } },
    diff: { structural: [{ op: "add", path: "/title" }], textual: "+ Authentication" },
    review: { hash: digest, projection: "kdlc-review-1", fields: ["body", "type", "title"] },
    claims: { accepted: [], rejected: [], merged: [], conflicting: [] },
    evidence: [{ source_id: "src_01j5", source_hash: digest, access: { classification: "internal" }, rights: { redistribution: "metadata-only" }, extraction_quality: "deterministic" }],
    sensors: [{ id: "source-anchor-valid", severity: "error", result: "passed" }],
    impact: { links: [], dependents: [], freshness_change: null, unresolved_conflicts: [] },
    resolved: {
      profile: { id: "software-project", version: "1.2.0", hash: digest },
      policies: [{ id: "team-policy", version: "7", hash: digest }],
      dependencies: { "acme.security": { version: "2.4.0", tree_hash: digest } }
    },
    provenance: { models: [], tools: [{ id: "kdlc-validator", version: "0.2.0" }] },
    budget: { model_tokens: 0, model_cost_usd: 0 },
    reviewer_actions: ["approve", "reject", "request-changes"],
    approval_consequences: "Approval authorizes the reviewed proposal only."
  };

  for (const [name, value] of Object.entries({ knowledgeBase, knowledgeLock: lock, sourceRecord: source, claim, claimSidecarEntry, conceptExtensions: extensions, reviewPacket, reviewReceipt: validReceipt })) {
    const result = contracts.validate(name, value);
    assert.equal(result.valid, true, `${name}: ${JSON.stringify(result.errors)}`);
  }

  const ambiguousSource = { ...source, digest_evidence: { method: "etag", value: "abc" } };
  assert.equal(contracts.validate("sourceRecord", ambiguousSource).valid, false);

  const workflowReceipt = structuredClone(extensions);
  workflowReceipt.review_receipts[0].resource = "/workflow/runs/wf_1/receipts/rr_1.json";
  assert.equal(contracts.validate("conceptExtensions", workflowReceipt).valid, false);

  const unboundReceipt = structuredClone(validReceipt);
  delete unboundReceipt.packet_hash;
  assert.equal(contracts.validate("reviewReceipt", unboundReceipt).valid, false);
});

test("FEAT-001 base profile records stable publication requirements", async () => {
  const profile = JSON.parse(await readFile("core/profiles/kdlc-base/profile.json", "utf8"));
  assert.equal(profile.canonicalization, "kdlc-c14n-1");
  assert.equal(profile.stable_requires_source_or_exemption, true);
  assert.equal(profile.stable_requires_freshness_or_timeless, true);
  assert.deepEqual(profile.classification_order, ["public", "internal", "confidential", "restricted"]);
});
