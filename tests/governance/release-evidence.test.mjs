import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { generateHierarchicalIndexes } from "../../packages/core/index.mjs";
import { validateReleaseEvidence, releaseEvidenceFiles, releaseEvidenceSchemas } from "../../scripts/release-evidence-validation.mjs";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const readJson = async (base, path) => JSON.parse(await readFile(resolve(base, path), "utf8"));

async function copyCandidate(target) {
  const corpus = await readJson(root, releaseEvidenceFiles.corpus);
  const run = await readJson(root, releaseEvidenceFiles.run);
  const conformance = await readJson(root, releaseEvidenceFiles.conformance);
  const paths = new Set([
    ...Object.values(releaseEvidenceFiles), ...Object.values(releaseEvidenceSchemas),
    "distribution/conformance.json", "package.json", "docs/traceability.json", "docs/release-readiness.md",
    ...corpus.cases.flatMap(({ fixtures }) => fixtures.map(({ path }) => path)),
    ...run.results.flatMap(({ evidence }) => evidence),
    ...conformance.modules.flatMap(({ evidence }) => evidence), ...conformance.evidence,
  ]);
  for (const path of paths) {
    const destination = resolve(target, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(resolve(root, path), destination);
  }
}

test("REL-001 machine-readable conformance and recorded evaluation bind exact offline evidence", async () => {
  assert.deepEqual(await validateReleaseEvidence(root), []);
  const [statement, profile, run, report] = await Promise.all([
    readJson(root, releaseEvidenceFiles.conformance), readJson(root, releaseEvidenceFiles.profile),
    readJson(root, releaseEvidenceFiles.run), readJson(root, releaseEvidenceFiles.report),
  ]);
  assert.equal(statement.release_status, "not-ready");
  assert.equal(statement.modules.find(({ name }) => name === "Governed").status, "implemented");
  assert(statement.modules.find(({ name }) => name === "Governed").requirement_ids.includes("FEAT-009"));
  assert.equal(statement.pending_requirements.some(({ id }) => id === "FEAT-009"), false);
  assert.equal(profile.mode, "recorded-only");
  assert.equal(profile.statistical_suite.status, "pending");
  assert.equal(run.live_model_calls, 0);
  assert.equal(run.external_network_calls, 0);
  assert.equal(report.statistical_suite.release_blocking, true);
});

test("REL-001 verifier rejects result, fixture, live-call, and report substitution", async (context) => {
  const candidate = await mkdtemp(resolve(tmpdir(), "kdlc-release-candidate-"));
  context.after(() => rm(candidate, { recursive: true, force: true }));
  await copyCandidate(candidate);
  const runPath = resolve(candidate, releaseEvidenceFiles.run);
  const run = await readJson(candidate, releaseEvidenceFiles.run);
  run.results[0].status = "failed";
  run.live_model_calls = 1;
  await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`);
  await writeFile(resolve(candidate, "tests/fixtures/models/ingest-recording.json"), "{}\n");
  const failures = await validateReleaseEvidence(candidate);
  assert(failures.some((failure) => /run contract|recorded and offline/.test(failure)));
  assert(failures.some((failure) => /fixture hash drift/.test(failure)));
  assert(failures.some((failure) => /report does not bind|summary is not derived/.test(failure)));
});

test("REL-001 clean rebuild produces byte-identical hierarchical indexes", async (context) => {
  const project = await mkdtemp(resolve(tmpdir(), "kdlc-release-rebuild-"));
  context.after(() => rm(project, { recursive: true, force: true }));
  const concepts = [
    { path: "policies/z.md", title: "Zulu", description: "Last" },
    { path: "overview.md", title: "Overview" },
    { path: "policies/a.md", title: "Alpha", description: "First" },
  ];
  const first = [...generateHierarchicalIndexes(concepts)];
  for (const [path, content] of first) {
    const target = resolve(project, ".generated", path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const committedBytes = await Promise.all(first.map(([path]) => readFile(resolve(project, ".generated", path), "utf8")));
  await rm(resolve(project, ".generated"), { recursive: true, force: true });
  const rebuilt = [...generateHierarchicalIndexes(structuredClone(concepts).reverse())];
  assert.deepEqual(rebuilt, first);
  for (const [path, content] of rebuilt) {
    const target = resolve(project, ".generated", path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  assert.deepEqual(await Promise.all(rebuilt.map(([path]) => readFile(resolve(project, ".generated", path), "utf8"))), committedBytes);
});

test("REL-001 emitted package smoke includes exact release contracts and evidence while remaining private", async (context) => {
  const destination = await mkdtemp(resolve(tmpdir(), "kdlc-release-package-"));
  context.after(() => rm(destination, { recursive: true, force: true }));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const { stdout } = await execute(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  const packed = JSON.parse(stdout);
  assert.equal(packed.length, 1);
  const paths = new Set(packed[0].files.map(({ path }) => path));
  for (const path of [...Object.values(releaseEvidenceFiles), ...Object.values(releaseEvidenceSchemas)].filter((path) => path.startsWith("core/") || path.startsWith("distribution/"))) assert(paths.has(path), path);
  await execute("tar", ["-xzf", resolve(destination, packed[0].filename), "-C", destination]);
  const manifest = await readJson(resolve(destination, "package"), "package.json");
  assert.equal(manifest.private, true);
  assert.equal(manifest.version, "0.0.0-private");
  assert.equal((await readJson(resolve(destination, "package"), releaseEvidenceFiles.conformance)).release_status, "not-ready");
  assert.equal((await readJson(resolve(destination, "package"), releaseEvidenceSchemas.report)).$schema, "https://json-schema.org/draft/2020-12/schema");
});

test("REL-001 security policy cannot erase pending release blockers", async () => {
  const [corpus, run, report, statement, readiness] = await Promise.all([
    readJson(root, releaseEvidenceFiles.corpus), readJson(root, releaseEvidenceFiles.run),
    readJson(root, releaseEvidenceFiles.report), readJson(root, releaseEvidenceFiles.conformance),
    readFile(resolve(root, "docs/release-readiness.md"), "utf8"),
  ]);
  const statuses = new Map(run.results.map(({ case_id: id, status }) => [id, status]));
  assert(corpus.cases.filter(({ security }) => security).every(({ id }) => statuses.get(id) === "passed"));
  assert.deepEqual(report.pending_release_evidence, [
    "statistical-quality-report", "final-version-changelog-artifact-agreement",
    "release-tag-and-package", "current-public-state-verification", "external-protection-settings", "independent-release-verification",
  ]);
  assert(statement.pending_requirements.every(({ release_blocking }) => release_blocking));
  assert.match(readiness, /not a final statistical\s+quality report/i);
  assert.match(readiness, /0\.0\.0-private/);
});

test("REL-001 Governed conformance literally binds merged FEAT-009 erasure evidence", async () => {
  const [corpus, run, statement, traceability] = await Promise.all([
    readJson(root, releaseEvidenceFiles.corpus), readJson(root, releaseEvidenceFiles.run),
    readJson(root, releaseEvidenceFiles.conformance), readJson(root, "docs/traceability.json"),
  ]);
  const erasureCase = corpus.cases.find(({ id }) => id === "governed-revocation-erasure");
  assert.deepEqual(erasureCase.requirement_ids, ["FEAT-008", "FEAT-009"]);
  assert.equal(erasureCase.security, true);
  assert.equal(run.results.find(({ case_id: id }) => id === erasureCase.id).status, "passed");
  assert(statement.modules.find(({ name }) => name === "Governed").evidence.includes("tests/governance/revocation-erasure.test.mjs"));
  const trace = traceability.requirements.find(({ id }) => id === "FEAT-009");
  assert.equal(trace.issue, 24);
  assert(["implemented", "verified", "released"].includes(trace.status));
  assert(trace.evidence.tests.includes("tests/governance/revocation-erasure.test.mjs"));
});
