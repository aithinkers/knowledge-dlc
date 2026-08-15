import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, opendir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { artifactHash, byteHash, canonicalJson, generateHierarchicalIndexes, parseMarkdownConcept } from "../../packages/core/index.mjs";
import { FederationResolver } from "../../packages/federation/index.mjs";
import { GovernanceControlAuthority, GovernanceControlEngine } from "../../packages/governance/index.mjs";
import { FederatedRetriever } from "../../packages/retrieval/index.mjs";
import { validateReleaseEvidence, releaseEvidenceFiles, releaseEvidenceSchemas } from "../../scripts/release-evidence-validation.mjs";
import { scrubbedReleaseEnvironment } from "../../scripts/release-evaluation-boundary.mjs";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const readJson = async (base, path) => JSON.parse(await readFile(resolve(base, path), "utf8"));
const writeJson = async (base, path, value) => writeFile(resolve(base, path), `${JSON.stringify(value, null, 2)}\n`);
async function makeRemovable(path) {
  let metadata; try { metadata = await lstat(path); } catch { return; }
  if (metadata.isDirectory()) { await chmod(path, 0o700); const directory = await opendir(path); for await (const entry of directory) await makeRemovable(resolve(path, entry.name)); }
  else if (!metadata.isSymbolicLink()) await chmod(path, 0o600);
}

async function copyCandidate(target) {
  const corpus = await readJson(root, releaseEvidenceFiles.corpus);
  const run = await readJson(root, releaseEvidenceFiles.run);
  const conformance = await readJson(root, releaseEvidenceFiles.conformance);
  const paths = new Set([
    ...Object.values(releaseEvidenceFiles), ...Object.values(releaseEvidenceSchemas),
    "distribution/conformance.json", "package.json", "docs/traceability.json", "docs/release-readiness.md",
    ...corpus.cases.flatMap(({ fixtures }) => fixtures.map(({ path }) => path)),
    ...corpus.cases.map(({ executable_evidence }) => executable_evidence.path),
    ...conformance.modules.flatMap(({ evidence }) => evidence.map(({ path }) => path)), ...conformance.evidence.map(({ path }) => path),
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

test("REL-001 mandatory cases, requirements, status, and executable evidence cannot be removed or substituted", async (context) => {
  for (const mutation of ["remove-feat009", "substitute-evidence", "partial-core", "readme-evidence"]) {
    const candidate = await mkdtemp(resolve(tmpdir(), `kdlc-release-${mutation}-`)); context.after(() => rm(candidate, { recursive: true, force: true }));
    await copyCandidate(candidate);
    const corpus = await readJson(candidate, releaseEvidenceFiles.corpus); const profile = await readJson(candidate, releaseEvidenceFiles.profile);
    const run = await readJson(candidate, releaseEvidenceFiles.run); const report = await readJson(candidate, releaseEvidenceFiles.report);
    const statement = await readJson(candidate, releaseEvidenceFiles.conformance);
    if (mutation === "remove-feat009") { corpus.cases.pop(); run.results.pop(); profile.mandatory_requirements = profile.mandatory_requirements.filter((id) => id !== "FEAT-009"); }
    if (mutation === "substitute-evidence") {
      const entry = corpus.cases.find(({ id }) => id === "governed-revocation-erasure"); entry.executable_evidence = { path: "tests/governance/core-contracts.test.mjs", sha256: `sha256:${"0".repeat(64)}`, test_ids: ["FEAT-001 generated project and knowledge-base manifests satisfy their contracts"] };
    }
    if (mutation === "partial-core") statement.modules[0].status = "partial";
    if (mutation === "readme-evidence") statement.modules[0].evidence[0] = { path: "README.md", sha256: `sha256:${"0".repeat(64)}` };
    await writeJson(candidate, releaseEvidenceFiles.corpus, corpus); profile.corpus.sha256 = byteHash(await readFile(resolve(candidate, releaseEvidenceFiles.corpus))); await writeJson(candidate, releaseEvidenceFiles.profile, profile);
    run.corpus_hash = profile.corpus.sha256; run.profile_hash = byteHash(await readFile(resolve(candidate, releaseEvidenceFiles.profile))); await writeJson(candidate, releaseEvidenceFiles.run, run);
    report.run_hash = byteHash(await readFile(resolve(candidate, releaseEvidenceFiles.run))); await writeJson(candidate, releaseEvidenceFiles.report, report); await writeJson(candidate, releaseEvidenceFiles.conformance, statement);
    assert((await validateReleaseEvidence(candidate)).length > 0, mutation);
  }
});

test("REL-001 replay boundary scrubs credentials and observes caught network or process attempts", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "kdlc-release-boundary-test-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const report = resolve(directory, "report.json"); const probe = resolve(root, "tests/fixtures/release/offline-probe.mjs");
  const environment = scrubbedReleaseEnvironment(report);
  for (const secret of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "HTTP_PROXY", "HTTPS_PROXY"]) assert.equal(environment[secret], undefined);
  await execute(process.execPath, ["--permission", "--allow-child-process", `--allow-fs-read=${root}`, `--allow-fs-read=${dirname(tmpdir())}`, `--allow-fs-write=${directory}`, "--import", resolve(root, "scripts/release-offline-guard.mjs"), probe], { cwd: root, env: { ...environment, OPENAI_API_KEY: undefined } });
  assert.deepEqual(await readJson(directory, "report.json"), { external_network_calls: 1, live_model_calls: 1, blocked_process_calls: 1 });
});

test("REL-001 clean rebuild removes caches and indexes then reproduces retrieval records and bytes", async (context) => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "kdlc-release-rebuild-"));
  context.after(async () => { await makeRemovable(projectRoot); await rm(projectRoot, { recursive: true, force: true }); });
  const primary = resolve(projectRoot, "primary");
  await cp(resolve(root, "tests/fixtures/federation/base-primary"), primary, { recursive: true });
  const catalog = await readJson(primary, "retrieval-catalog.json");
  const concepts = [];
  for (const entry of catalog.concepts) {
    const parsed = parseMarkdownConcept(await readFile(resolve(primary, entry.path)));
    concepts.push({ path: entry.path, title: parsed.frontmatter.title, description: parsed.frontmatter.description });
  }
  const generated = [...generateHierarchicalIndexes(concepts)];
  const materializeIndexes = async () => {
    for (const [path, content] of generated) { await mkdir(dirname(resolve(primary, path)), { recursive: true }); await writeFile(resolve(primary, path), content); }
  };
  await materializeIndexes();
  const expectedIndexes = Object.fromEntries(await Promise.all(generated.map(async ([path]) => [path, byteHash(await readFile(resolve(primary, path)))])));
  const project = { api_version: "kdlc.dev/v1alpha1", kind: "Project", metadata: { name: "release-rebuild" }, purpose: "./purpose.md", profile: "base@1", knowledge_bases: [{ name: "primary", uri: "./primary", mode: "maintain", role: "primary", priority: 100 }] };
  const clock = { now: () => "2026-08-15T00:00:00.000Z" };
  const governancePolicy = { api_version: "kdlc.dev/governance-policy/v1alpha1", id: "release-rebuild", version: 1, minimum_independent_sources: 1, required_erasure_surfaces: [], waiver_authorities: {}, declassification_authorities: {}, erasure_policy_refs: {}, external_models: {} };
  const authority = new GovernanceControlAuthority({ authenticate: async () => null, clock, audit: { append: async () => {} } });
  const governanceControls = await GovernanceControlEngine.create({ policy: governancePolicy, clock, audit: { append: async () => {} }, authority });
  const retrievalPolicy = { authorizeMount: async () => true, authorizeConcept: async () => true, authorizeSource: async () => true, policyReference: async ({ access }) => access.policy_ref ?? null };
  const principal = { id: "human:release-verifier", clearance: "restricted", compartments: ["engineering", "nightfall"] };
  const retrieve = async () => {
    const { mounts } = await new FederationResolver({ projectRoot, now: clock.now }).resolveProject(project);
    const retriever = new FederatedRetriever({ mounts, policy: retrievalPolicy, governanceControls, now: () => new Date(clock.now()), minimumDurationMs: 0 });
    const authorization = await retriever.prepareAuthorization({ principal, query: "phishing-resistant", queryModes: ["wiki-only"] });
    return retriever.search({ authorization, principal, query: "phishing-resistant", mode: "wiki-only" });
  };
  const before = await retrieve(); const beforeHash = artifactHash(before);
  await makeRemovable(resolve(projectRoot, ".kdlc"));
  await rm(resolve(projectRoot, ".kdlc"), { recursive: true, force: true });
  await rm(resolve(projectRoot, "knowledge.lock"), { force: true });
  for (const [path] of generated) await rm(resolve(primary, path), { force: true });
  await materializeIndexes();
  const rebuiltIndexes = Object.fromEntries(await Promise.all(generated.map(async ([path]) => [path, byteHash(await readFile(resolve(primary, path)))])));
  const after = await retrieve();
  assert.deepEqual(rebuiltIndexes, expectedIndexes);
  assert.equal(artifactHash(after), beforeHash);
  assert.equal(canonicalJson(after), canonicalJson(before));
});

test("REL-001 federated evidence denies unauthorized local concepts without disclosure and detects cache drift", async (context) => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), "kdlc-release-federated-"));
  context.after(async () => { await makeRemovable(projectRoot); await rm(projectRoot, { recursive: true, force: true }); });
  await cp(resolve(root, "tests/fixtures/federation/base-primary"), resolve(projectRoot, "primary"), { recursive: true });
  const project = { api_version: "kdlc.dev/v1alpha1", kind: "Project", metadata: { name: "release-federated" }, purpose: "./purpose.md", profile: "base@1", knowledge_bases: [{ name: "primary", uri: "./primary", mode: "read-only", role: "primary", priority: 100 }] };
  const clock = { now: () => "2026-08-15T00:00:00.000Z" }; const audit = { append: async () => {} };
  const governancePolicy = { api_version: "kdlc.dev/governance-policy/v1alpha1", id: "release-federated", version: 1, minimum_independent_sources: 1, required_erasure_surfaces: [], waiver_authorities: {}, declassification_authorities: {}, erasure_policy_refs: {}, external_models: {} };
  const authority = new GovernanceControlAuthority({ authenticate: async () => null, clock, audit });
  const governanceControls = await GovernanceControlEngine.create({ policy: governancePolicy, clock, audit, authority });
  const allows = (access = {}) => access.classification !== "restricted";
  const restrictedPolicy = { authorizeMount: async () => true, authorizeConcept: async ({ concept }) => allows(concept.access), authorizeSource: async ({ source }) => allows(source.access) };
  const openPolicy = { authorizeMount: async () => true, authorizeConcept: async () => true, authorizeSource: async () => true };
  const { mounts } = await new FederationResolver({ projectRoot, now: clock.now }).resolveProject(project);
  const principal = { id: "human:release-verifier", clearance: "internal", compartments: ["engineering"] };
  const restricted = new FederatedRetriever({ mounts, policy: restrictedPolicy, governanceControls, now: () => new Date(clock.now()), minimumDurationMs: 0 });
  const hiddenProof = await restricted.prepareAuthorization({ principal, query: "Nightfall", queryModes: ["wiki-only"] });
  const hidden = await restricted.search({ authorization: hiddenProof, principal, query: "Nightfall", mode: "wiki-only" });
  const open = new FederatedRetriever({ mounts, policy: openPolicy, governanceControls, now: () => new Date(clock.now()), minimumDurationMs: 0 });
  const absentProof = await open.prepareAuthorization({ principal, query: "Zephyr", queryModes: ["wiki-only"] });
  assert.deepEqual(hidden, await open.search({ authorization: absentProof, principal, query: "Zephyr", mode: "wiki-only" }));
  const cachedConcept = resolve(mounts[0].root, "policies/authentication.md"); await chmod(resolve(mounts[0].root, "policies"), 0o700); await chmod(cachedConcept, 0o600); await writeFile(cachedConcept, `${await readFile(cachedConcept, "utf8")}\ndrift\n`);
  const proof = await open.prepareAuthorization({ principal, query: "authentication", queryModes: ["wiki-only"] }).catch(() => null);
  assert.equal(proof, null);
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
  assert(statement.modules.find(({ name }) => name === "Governed").evidence.some(({ path }) => path === "tests/governance/revocation-erasure.test.mjs"));
  const trace = traceability.requirements.find(({ id }) => id === "FEAT-009");
  assert.equal(trace.issue, 24);
  assert(["implemented", "verified", "released"].includes(trace.status));
  assert(trace.evidence.tests.includes("tests/governance/revocation-erasure.test.mjs"));
});
