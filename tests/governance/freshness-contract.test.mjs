import assert from "node:assert/strict";
import { chmod, cp, lstat, mkdtemp, opendir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { artifactHash, byteHash, isGregorianDate, isRfc3339Instant, isStaleOn, utcDate } from "../../packages/core/index.mjs";
import { PrincipalAuthority, ReviewContextAuthority } from "../../packages/agents/index.mjs";
import { FederationResolver } from "../../packages/federation/index.mjs";
import { FederatedRetriever } from "../../packages/retrieval/index.mjs";
import { GovernedAgentWorkflows } from "../../packages/workflows/index.mjs";

test("FEAT-004 FEAT-005 share strict Gregorian and RFC3339 temporal contracts", () => {
  for (const value of ["2028-02-29", "2030-01-01", "2000-02-29"]) assert.equal(isGregorianDate(value), true);
  for (const value of ["2027-02-29", "2030-02-30", "2030-13-01", "2030-01-01T00:00:00Z"]) assert.equal(isGregorianDate(value), false);
  assert.equal(isRfc3339Instant("2028-02-29T23:59:59Z"), true);
  for (const value of ["2027-02-29T00:00:00Z", "2028-02-29T24:00:00Z", "2028-02-29T00:00:00+14:01", "2028-02-29T00:00:00+23:59", "2028-02-29T00:00:00-00:00"]) assert.equal(isRfc3339Instant(value), false);
  for (const value of ["2028-02-29T00:00:00+14:00", "2028-02-29T00:00:00-14:00", "2028-02-29T00:00:00+00:00"]) assert.equal(isRfc3339Instant(value), true);
  assert.equal(utcDate("2028-02-29T23:00:00-02:00"), "2028-03-01");
  assert.equal(isStaleOn("2030-01-02", "2030-01-01"), false);
  assert.equal(isStaleOn("2030-01-02", "2030-01-02"), true);
  assert.equal(isStaleOn("2030-02-30", "2030-01-01"), true);
});

test("FEAT-004 publication artifact crosses into FEAT-005 fresh retrieval at an exact date boundary", async (context) => {
  const repository = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const fixture = (path) => readFile(join(repository, path), "utf8").then(JSON.parse);
  const normalized = await fixture("tests/fixtures/workflows/ingest-normalized.json");
  const recording = await fixture("tests/fixtures/models/ingest-recording.json");
  recording.proposals[0].concept.after.frontmatter.verified = [{ by: "human:reviewer", at: "2026-08-14T15:00:00Z" }];
  recording.proposals[0].concept.after.frontmatter.access = { classification: "internal", compartments: ["engineering"], policy_ref: "acme-access@4" };
  recording.proposals[0].concept.after.frontmatter.stale_after = "2030-01-02";
  const digest = (value) => artifactHash(value);
  const reviewContext = { evidence: normalized.units.map((unit) => ({ source_id: normalized.source_id, source_hash: normalized.source_hash, locator: unit.locator, excerpt: unit.text, authority: "trusted:test", access: { classification: "public" }, rights: { use: "internal" }, extraction_quality: "deterministic", warnings: [] })), sensors: [{ id: "source-anchor-valid", severity: "error", result: "passed", producer: "kdlc-sensor-runtime/0.2.0", execution_hash: digest("sensor") }], impact: { links: [], dependents: [], freshness_change: "2030-01-02", unresolved_conflicts: [] }, resolved: { profile: { id: "kdlc-base", version: "0.2.0", hash: digest("profile") }, policies: [{ id: "team-policy", version: "1", hash: digest("policy") }], dependencies: {} }, provenance: { models: [{ id: "fixture-model-1" }], tools: [{ id: "kdlc-harness/0.2.0" }] }, budget: { model_tokens: 0, model_cost_usd: 0 } };
  const principals = new PrincipalAuthority([{ id: "reviewer", actor: "human:reviewer", principal_mode: "local", review_roles: ["trust-reviewer"] }]);
  const harness = await GovernedAgentWorkflows.create({ session: principals.establishReviewSession("reviewer", "trust-reviewer"), reviewContextSession: new ReviewContextAuthority([{ workflow_id: "wf_ingest", context: reviewContext }]).establish("wf_ingest"), clock: { now: () => "2026-08-14T15:00:00Z" } });
  const output = await harness.runRecorded({ task: "ingest", workflowId: "wf_ingest", recording, normalizedEvidence: normalized });
  await harness.assembleReview({ workflowId: "wf_ingest", proposalId: "pr_alpha" });
  await harness.decide({ workflowId: "wf_ingest", proposalId: "pr_alpha", decision: "approved", receiptId: "rr_boundary" });
  const proposal = output.proposals[0], current = { concept: proposal.concept.after, target_revision: "rev-1", source_hashes: [normalized.source_hash], resolved_dependencies: {}, profile: reviewContext.resolved.profile, policies: reviewContext.resolved.policies };
  const publication = await harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: "rr_boundary", current });
  assert.equal(publication.intent.proposal_id, "pr_alpha");
  const invalidCurrent = structuredClone(current); invalidCurrent.concept.frontmatter.stale_after = "2030-02-30";
  await assert.rejects(() => harness.preparePublication({ workflowId: "wf_ingest", proposalId: "pr_alpha", receiptId: "rr_boundary", current: invalidCurrent }), (error) => error.code === "KDLC_PUBLICATION_DENIED" && error.details.failures.includes("missing-future-freshness"));

  const root = await mkdtemp(join(tmpdir(), "kdlc-freshness-handoff-")); context.after(async () => { const writable = async (path) => { let metadata; try { metadata = await lstat(path); } catch { return; } if (metadata.isDirectory()) { await chmod(path, 0o700); const directory = await opendir(path); for await (const entry of directory) await writable(join(path, entry.name)); } else if (!metadata.isSymbolicLink()) await chmod(path, 0o600); }; await writable(root); await rm(root, { recursive: true, force: true }); });
  const base = join(root, "primary"); await cp(join(repository, "tests/fixtures/federation/base-primary"), base, { recursive: true });
  const markdown = `---\n${YAML.stringify(proposal.concept.after.frontmatter)}---\n${proposal.concept.after.body}\n`;
  const conceptPath = join(base, "policies/authentication.md"); await writeFile(conceptPath, markdown);
  const catalog = JSON.parse(await readFile(join(base, "retrieval-catalog.json"), "utf8")); catalog.concepts.find(({ id }) => id === "policies/authentication").byte_hash = byteHash(Buffer.from(markdown)); await writeFile(join(base, "retrieval-catalog.json"), `${JSON.stringify(catalog)}\n`);
  const project = { api_version: "kdlc.dev/v1alpha1", kind: "Project", purpose: "./purpose.md", profile: "base@1", metadata: { name: "handoff" }, knowledge_bases: [{ name: "primary", uri: "./primary", mode: "maintain", role: "primary", priority: 100 }] };
  const { mounts } = await new FederationResolver({ projectRoot: root, now: () => "2030-01-01T12:00:00Z" }).resolveProject(project);
  const policy = { authorizeMount: async () => true, authorizeConcept: async () => true, authorizeSource: async () => true };
  const cases = [
    ["2030-01-01T23:59:59Z", "fresh-only", "warn", "ok", "current", 0],
    ["2030-01-01T23:59:59Z", "wiki-only", "warn", "ok", "current", 0],
    ["2030-01-01T23:59:59Z", "wiki-only", "exclude", "ok", "current", 0],
    ["2030-01-02T00:00:00Z", "fresh-only", "warn", "not_found", null, 0],
    ["2030-01-02T00:00:00Z", "wiki-only", "warn", "ok", "stale", 1],
    ["2030-01-02T00:00:00Z", "wiki-only", "exclude", "not_found", null, 0]
  ];
  for (const [instant, mode, staleBehavior, expected, freshness, warnings] of cases) {
    const retriever = new FederatedRetriever({ mounts, policy, now: () => new Date(instant), minimumDurationMs: 0 });
    const principal = { actor: "human:reader" }, authorization = await retriever.prepareAuthorization({ principal });
    const result = await retriever.search({ authorization, principal, query: "token lifetime", mode, minimumTrust: "human-reviewed", staleBehavior });
    assert.equal(result.status, expected);
    assert.equal(result.results[0]?.freshness ?? null, freshness);
    assert.equal(result.warnings.length, warnings);
  }

  // Even if invalid candidate bytes are placed in a mount outside the governed
  // publication path, retrieval classifies them as stale and never as fresh.
  const invalidConcept = structuredClone(proposal.concept.after); invalidConcept.frontmatter.stale_after = "2030-02-30";
  const invalidMarkdown = `---\n${YAML.stringify(invalidConcept.frontmatter)}---\n${invalidConcept.body}\n`;
  await writeFile(conceptPath, invalidMarkdown); catalog.concepts.find(({ id }) => id === "policies/authentication").byte_hash = byteHash(Buffer.from(invalidMarkdown)); await writeFile(join(base, "retrieval-catalog.json"), `${JSON.stringify(catalog)}\n`);
  const invalidMounts = (await new FederationResolver({ projectRoot: root, now: () => "2030-01-01T12:00:00Z" }).resolveProject(project)).mounts;
  const invalidRetriever = new FederatedRetriever({ mounts: invalidMounts, policy, now: () => new Date("2030-01-01T12:00:00Z"), minimumDurationMs: 0 });
  const invalidPrincipal = { actor: "human:reader" }, invalidAuthorization = await invalidRetriever.prepareAuthorization({ principal: invalidPrincipal });
  const warned = await invalidRetriever.search({ authorization: invalidAuthorization, principal: invalidPrincipal, query: "token lifetime", mode: "wiki-only", minimumTrust: "human-reviewed", staleBehavior: "warn" });
  assert.equal(warned.status, "ok"); assert.equal(warned.results[0].freshness, "stale"); assert.equal(warned.warnings[0].code, "KDLC_STALE");
  const excluded = await invalidRetriever.search({ authorization: invalidAuthorization, principal: invalidPrincipal, query: "token lifetime", mode: "fresh-only", minimumTrust: "human-reviewed", staleBehavior: "exclude" });
  assert.equal(excluded.status, "not_found");
});
