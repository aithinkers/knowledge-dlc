import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { validateReleaseCandidateEvidence } from "../../scripts/release-evidence-validation.mjs";

const root = resolve(import.meta.dirname, "../.."); const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
test("REL-001 release-candidate evidence binds artifact, supply-chain, matrix, settings, and independent review records", async (context) => {
  const candidate = await mkdtemp(resolve(tmpdir(), "kdlc-candidate-evidence-")); context.after(() => rm(candidate, { recursive: true, force: true }));
  await mkdir(resolve(candidate, "core/schemas/release"), { recursive: true });
  await cp(resolve(root, "core/schemas/common.schema.json"), resolve(candidate, "core/schemas/common.schema.json"), { recursive: true });
  await cp(resolve(root, "core/schemas/release/release-candidate-evidence.schema.json"), resolve(candidate, "core/schemas/release/release-candidate-evidence.schema.json"), { recursive: true });
  const version = "1.0.0"; const head = "a".repeat(40); const packageHash = `sha256:${"b".repeat(64)}`;
  const records = {
    "CHANGELOG.md": `# Changelog\n\n## ${version}\n`,
    "distribution/release/artifact-manifest.json": `${JSON.stringify({ version, files: ["package.json"] })}\n`,
    "distribution/release/checksums.json": `${JSON.stringify({ version, package_sha256: packageHash })}\n`,
    "distribution/release/sbom.json": `${JSON.stringify({ version, packages: ["knowledge-dlc"] })}\n`,
    "distribution/release/notices.txt": "Apache-2.0 notices\n",
    "distribution/release/provenance.json": `${JSON.stringify({ version, decision: "passed" })}\n`,
    "distribution/release/install-smoke.json": `${JSON.stringify({ version, passed: true, cli: true, imports: true })}\n`,
    "distribution/release/repository-settings.json": `${JSON.stringify({ visibility: "public", branch_protection: true, release_blocking_issues_closed: true, required_checks: ["Release matrix"] })}\n`,
    "distribution/release/independent-review.json": `${JSON.stringify({ head_sha: head, decision: "approved", independent: true })}\n`
  };
  for (const [path, bytes] of Object.entries(records)) { await mkdir(dirname(resolve(candidate, path)), { recursive: true }); await writeFile(resolve(candidate, path), bytes); }
  const file = (path) => ({ path, sha256: hash(records[path]) });
  const evidence = { api_version: "kdlc.dev/release-candidate-evidence/v1alpha1", version, head_sha: head, changelog: file("CHANGELOG.md"), artifacts: { first_sha256: packageHash, second_sha256: packageHash, manifest: file("distribution/release/artifact-manifest.json"), checksums: file("distribution/release/checksums.json") }, supply_chain: { sbom: file("distribution/release/sbom.json"), notices: file("distribution/release/notices.txt"), provenance_decision: file("distribution/release/provenance.json") }, install_smoke: { passed: true, record: file("distribution/release/install-smoke.json") }, matrix: { run_id: 42, head_sha: head, cells: ["ubuntu-node22", "ubuntu-node24", "windows-node22", "windows-node24", "macos-node22", "macos-node24"], aggregator: "passed" }, repository: file("distribution/release/repository-settings.json"), independent_review: file("distribution/release/independent-review.json") };
  await writeFile(resolve(candidate, "distribution/release/release-candidate-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  const trusted = { version, headSha: head, matrixRunId: 42, trustedRepositorySnapshot: resolve(candidate, evidence.repository.path), trustedReviewRecord: resolve(candidate, evidence.independent_review.path) };
  assert.deepEqual(await validateReleaseCandidateEvidence(candidate, trusted), []);
  evidence.artifacts.second_sha256 = `sha256:${"c".repeat(64)}`; await writeFile(resolve(candidate, "distribution/release/release-candidate-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  assert.ok((await validateReleaseCandidateEvidence(candidate, trusted)).some((failure) => failure.includes("byte-identical")));
  await writeFile(resolve(candidate, "distribution/release/independent-review.json"), `${JSON.stringify({ head_sha: "d".repeat(40), decision: "approved", independent: true })}\n`);
  assert.ok((await validateReleaseCandidateEvidence(candidate, trusted)).length > 0);
});
