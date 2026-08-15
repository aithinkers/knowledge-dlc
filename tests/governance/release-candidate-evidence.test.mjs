import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { validateReleaseCandidateEvidence } from "../../scripts/release-evidence-validation.mjs";
import { deriveRulesetState } from "../../scripts/release-state-derivation.mjs";

const root = resolve(import.meta.dirname, "../.."); const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const cells = ["ubuntu-node22", "ubuntu-node24", "windows-node22", "windows-node24", "macos-node22", "macos-node24"];
const observed = { package: { first_sha256: "b".repeat(64), second_sha256: "b".repeat(64), manifest_sha256: "c".repeat(64), file_count: 178 }, supply_chain: { sbom_sha256: "d".repeat(64), notices_sha256: "e".repeat(64) }, smoke: { cli: true, imports: true } };
const matrix = (head) => cells.map((cell) => ({ cell, head_sha: head, observed_evidence: structuredClone(observed) }));

test("REL-001 release-candidate gate derives package, supply-chain, settings, and independent review evidence outside candidate records", async (context) => {
  const candidate = await mkdtemp(resolve(tmpdir(), "kdlc-candidate-evidence-")); context.after(() => rm(candidate, { recursive: true, force: true }));
  await mkdir(resolve(candidate, "core/schemas/release"), { recursive: true }); await mkdir(resolve(candidate, "distribution/release"), { recursive: true });
  await cp(resolve(root, "core/schemas/common.schema.json"), resolve(candidate, "core/schemas/common.schema.json"), { recursive: true });
  await cp(resolve(root, "core/schemas/release/release-candidate-evidence.schema.json"), resolve(candidate, "core/schemas/release/release-candidate-evidence.schema.json"), { recursive: true });
  const version = "1.0.0"; const head = "a".repeat(40); const changelog = `# Changelog\n\n## ${version}\n`;
  await writeFile(resolve(candidate, "CHANGELOG.md"), changelog);
  const evidence = { api_version: "kdlc.dev/release-candidate-evidence/v1alpha1", version, changelog: { path: "CHANGELOG.md", sha256: hash(changelog) } };
  await writeFile(resolve(candidate, "distribution/release/release-candidate-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  const settingsPath = resolve(candidate, "settings.json"); const reviewPath = resolve(candidate, "review.json");
  const settings = { visibility: "public", actions: { default_workflow_permissions: "read", can_approve_pull_request_reviews: false }, release_blocking_issues_closed: true, ruleset: { ids: [1], active: true, default_branch: true, prevents_deletion: true, prevents_non_fast_forward: true, linear_history: true, pull_request: { required_approvals: 1, require_code_owner_review: true, dismiss_stale_reviews: true, require_last_push_approval: true, require_thread_resolution: true, allowed_merge_methods: ["squash"] }, strict_status_checks: true, required_checks: ["Candidate tests", "CodeQL (JavaScript/TypeScript)", "Dependency review", "Pull request traceability", "Release matrix", "Repository policy", "Secret history scan", "Supply-chain verification"], direct_push_bypass: false } };
  const review = { head_sha: head, decision: "approved", evidence_kind: "independent-agent-comment", evidence_id: 42, evidence_url: "https://github.test/review/42", actor: "review-agent", observed_at: "2026-08-15T00:00:00Z" };
  await writeFile(settingsPath, JSON.stringify(settings)); await writeFile(reviewPath, JSON.stringify(review));
  const trusted = { version, headSha: head, matrixResults: matrix(head), trustedRepositorySnapshot: settingsPath, trustedReviewRecord: reviewPath };
  assert.deepEqual(await validateReleaseCandidateEvidence(candidate, trusted), []);

  const substituted = matrix(head); substituted[5].observed_evidence.package.first_sha256 = "f".repeat(64);
  assert.ok((await validateReleaseCandidateEvidence(candidate, { ...trusted, matrixResults: substituted })).some((failure) => failure.includes("package bytes")));
  await writeFile(settingsPath, JSON.stringify({ ...settings, ruleset: { ...settings.ruleset, required_checks: [] } }));
  assert.ok((await validateReleaseCandidateEvidence(candidate, trusted)).some((failure) => failure.includes("ruleset")));
  await writeFile(settingsPath, JSON.stringify(settings)); await writeFile(reviewPath, JSON.stringify({ ...review, head_sha: "f".repeat(40) }));
  assert.ok((await validateReleaseCandidateEvidence(candidate, trusted)).some((failure) => failure.includes("exact-head")));
  await writeFile(reviewPath, JSON.stringify(review)); await writeFile(settingsPath, JSON.stringify({ ...settings, actions: { default_workflow_permissions: "write", can_approve_pull_request_reviews: false } }));
  assert.ok((await validateReleaseCandidateEvidence(candidate, trusted)).some((failure) => failure.includes("ruleset")));

  const selfAttested = { ...evidence, artifacts: { first_sha256: "b".repeat(64) } };
  await writeFile(resolve(candidate, "distribution/release/release-candidate-evidence.json"), `${JSON.stringify(selfAttested)}\n`);
  assert.ok((await validateReleaseCandidateEvidence(candidate, trusted)).some((failure) => failure.includes("contract")));
});

test("REL-001 live ruleset derivation respects exact ref exclusions and composes split effective rules", () => {
  const base = { target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, bypass_actors: [] };
  const structural = { ...base, id: 1, rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "required_linear_history" }, { type: "pull_request", parameters: { required_approving_review_count: 1, require_code_owner_review: true, dismiss_stale_reviews_on_push: true, require_last_push_approval: true, required_review_thread_resolution: true, allowed_merge_methods: ["squash"] } }] };
  const checks = { ...base, id: 2, conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } }, rules: [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "Release matrix" }] } }] };
  const composed = deriveRulesetState([structural, checks], { baseRef: "main", defaultBranch: "main" });
  assert.deepEqual(composed.ids, [1, 2]); assert.equal(composed.prevents_deletion, true); assert.deepEqual(composed.required_checks, ["Release matrix"]);
  for (const exclusion of ["~DEFAULT_BRANCH", "refs/heads/main"]) {
    const excluded = structuredClone(structural); excluded.conditions.ref_name.exclude = [exclusion];
    assert.equal(deriveRulesetState([excluded], { baseRef: "main", defaultBranch: "main" }).active, false);
  }
});
