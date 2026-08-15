import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, cp, lstat, mkdtemp, opendir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { byteHash } from "../../packages/core/index.mjs";
import { createContractValidator } from "../../packages/contracts/index.mjs";
import { FederationError, FederationResolver, routeWrite } from "../../packages/federation/index.mjs";
import { FederatedRetriever, RetrievalError, traverseHierarchicalIndex } from "../../packages/retrieval/index.mjs";

const execFile = promisify(execFileCallback);
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/federation");
const fixedNow = () => "2026-08-14T15:00:00.000Z";
const policyState = JSON.parse(await readFile(join(fixtures, "policy-state.json"), "utf8"));

function federationCode(code) { return (error) => error instanceof FederationError && error.code === code; }
function retrievalCode(code) { return (error) => error instanceof RetrievalError && error.code === code; }

async function workspace(context) {
  const root = await mkdtemp(join(tmpdir(), "kdlc-federation-"));
  context.after(async () => {
    async function writable(path) {
      let metadata; try { metadata = await lstat(path); } catch { return; }
      if (metadata.isDirectory()) {
        await chmod(path, 0o700); const directory = await opendir(path);
        for await (const entry of directory) await writable(join(path, entry.name));
      } else if (!metadata.isSymbolicLink()) await chmod(path, 0o600);
    }
    await writable(root); await rm(root, { recursive: true, force: true });
  });
  await cp(join(fixtures, "base-primary"), join(root, "primary"), { recursive: true });
  await cp(join(fixtures, "base-legacy"), join(root, "legacy-source"), { recursive: true });
  await execFile("git", ["init", "-q", join(root, "legacy-source")]);
  await execFile("git", ["-C", join(root, "legacy-source"), "config", "user.name", "Fixture"]);
  await execFile("git", ["-C", join(root, "legacy-source"), "config", "user.email", "fixture@example.invalid"]);
  await execFile("git", ["-C", join(root, "legacy-source"), "add", "."]);
  await execFile("git", ["-C", join(root, "legacy-source"), "commit", "-q", "-m", "fixture"]);
  return root;
}

function project(root, extra = []) {
  return {
    api_version: "kdlc.dev/v1alpha1", kind: "Project", purpose: "./purpose.md", profile: "base@1",
    metadata: { name: "federation-test" },
    knowledge_bases: [
      { name: "primary", uri: "./primary", mode: "maintain", role: "primary", priority: 100 },
      { name: "legacy", uri: `git+${pathToFileURL(join(root, "legacy-source")).href}`, ref: "HEAD", mode: "read-only", role: "dependency", priority: 80 },
      ...extra
    ]
  };
}

test("FEAT-005 resolves local and Git mounts into verified immutable cache and knowledge.lock", async (context) => {
  const root = await workspace(context); const resolver = new FederationResolver({ projectRoot: root, now: fixedNow });
  const [resolved, concurrent] = await Promise.all([
    resolver.resolveProject(project(root)), new FederationResolver({ projectRoot: root, now: fixedNow }).resolveProject(project(root))
  ]);
  assert.equal(resolved.mounts.length, 2);
  assert.equal(resolved.mounts.find(({ alias }) => alias === "primary").retrieval_catalog.find(({ id }) => id === "policies/authentication").access.policy_ref, "acme-access@4");
  assert.match(resolved.mounts[1].resolved_ref, /^[0-9a-f]{40,64}$/);
  assert.equal(await resolver.verify(resolved.mounts[0]), true);
  assert.equal((await stat(resolved.mounts[0].root)).mode & 0o222, 0);
  const lock = JSON.parse(await readFile(join(root, "knowledge.lock"), "utf8"));
  assert.equal(lock.knowledge_bases.primary.id, "acme.primary");
  assert.equal(lock.knowledge_bases.legacy.tree_hash, resolved.mounts[1].tree_hash);
  const contracts = await createContractValidator();
  assert.equal(contracts.validate("knowledgeLock", lock).valid, true);
  for (const mount of resolved.mounts) assert.equal(contracts.validate("federationMountResolution", mount).valid, true);
  assert.deepEqual(concurrent.mounts.map(({ root: cache }) => cache), resolved.mounts.map(({ root: cache }) => cache));
});

test("FEAT-005 rejects duplicate stable IDs, cache drift, unsafe Git entries, and mutable tree reuse", async (context) => {
  const root = await workspace(context); const resolver = new FederationResolver({ projectRoot: root, now: fixedNow });
  await assert.rejects(resolver.resolveProject(project(root, [
    { name: "duplicate", uri: "./primary", mode: "read-only", role: "dependency", priority: 1 }
  ])), federationCode("KDLC_DUPLICATE_KB_ID"));

  const resolved = await resolver.resolveProject(project(root)); const primary = resolved.mounts.find(({ alias }) => alias === "primary");
  const concept = join(primary.root, "policies/authentication.md");
  await chmod(primary.root, 0o755); await chmod(join(primary.root, "policies"), 0o755); await chmod(concept, 0o644);
  await writeFile(concept, `${await readFile(concept, "utf8")}\ndrift\n`);
  await assert.rejects(resolver.verify(primary), federationCode("KDLC_CACHE_DRIFT"));
  const driftRetriever = new FederatedRetriever({ mounts: resolved.mounts, policy: policy(), now: () => new Date(fixedNow()) });
  const driftAuthorization = await driftRetriever.prepareAuthorization({ principal: {}, queryModes: ["wiki-only"] });
  await assert.rejects(driftRetriever.search({ authorization: driftAuthorization, principal: {}, query: "authentication" }), retrievalCode("KDLC_MOUNT_INTEGRITY"));
  await assert.rejects(resolver.resolveMount(project(root).knowledge_bases[0]), federationCode("KDLC_CACHE_DRIFT"));
  await assert.rejects(stat(primary.root), (error) => error.code === "ENOENT");

  await cp(join(fixtures, "base-primary"), join(root, "unsafe-local"), { recursive: true });
  await symlink(join(root, "primary", "index.md"), join(root, "unsafe-local", "escape.md"));
  await assert.rejects(resolver.resolveMount({ name: "unsafe", uri: "./unsafe-local", mode: "read-only" }), federationCode("KDLC_FEDERATION_SYMLINK"));

  await cp(join(fixtures, "base-primary"), join(root, "downgraded-access"), { recursive: true });
  const catalogPath = join(root, "downgraded-access", "retrieval-catalog.json");
  const downgradedCatalog = JSON.parse(await readFile(catalogPath, "utf8"));
  downgradedCatalog.concepts.find(({ id }) => id === "policies/nightfall").access = { classification: "internal", compartments: ["engineering"] };
  await writeFile(catalogPath, `${JSON.stringify(downgradedCatalog)}\n`);
  await assert.rejects(resolver.resolveMount({ name: "downgrade", uri: "./downgraded-access", mode: "read-only" }), federationCode("KDLC_RETRIEVAL_CATALOG"));

  const oldGit = resolved.mounts.find(({ alias }) => alias === "legacy");
  await writeFile(join(root, "legacy-source", "new.md"), "---\ntype: Reference\n---\nnew\n");
  await execFile("git", ["-C", join(root, "legacy-source"), "add", "."]); await execFile("git", ["-C", join(root, "legacy-source"), "commit", "-q", "-m", "next"]);
  const refreshed = await new FederationResolver({ projectRoot: root, now: fixedNow }).resolveMount(project(root).knowledge_bases[1]);
  assert.notEqual(refreshed.resolved_ref, oldGit.resolved_ref); assert.notEqual(refreshed.root, oldGit.root);

  await symlink("knowledge-base.yaml", join(root, "legacy-source", "escape"));
  await execFile("git", ["-C", join(root, "legacy-source"), "add", "escape"]); await execFile("git", ["-C", join(root, "legacy-source"), "commit", "-q", "-m", "unsafe symlink"]);
  await assert.rejects(new FederationResolver({ projectRoot: root, now: fixedNow }).resolveMount(project(root).knowledge_bases[1]), federationCode("KDLC_GIT_ENTRY"));
});

function policy(state = policyState) {
  const clearance = new Set(state.classifications); const compartments = new Set(state.compartments);
  const allows = (access = { classification: "internal" }) => clearance.has(access.classification)
    && (access.compartments ?? []).every((compartment) => compartments.has(compartment));
  return {
    authorizeMount: async ({ mount, queryMode }) => state.query_modes.includes(queryMode) && allows(mount.access),
    authorizeConcept: async ({ concept }) => allows(concept.access ?? undefined),
    authorizeSource: async ({ source }) => allows(source.access ?? undefined)
  };
}

test("FEAT-005 traverses hierarchical indexes and retrieves across mounts with qualified conflicts", async (context) => {
  const root = await workspace(context); const { mounts } = await new FederationResolver({ projectRoot: root, now: fixedNow }).resolveProject(project(root));
  assert.deepEqual(await traverseHierarchicalIndex(mounts.find(({ alias }) => alias === "primary").root), [
    "policies/authentication.md", "policies/nightfall.md", "policies/spoof.md", "references/sources/authentication.md"
  ]);
  const retriever = new FederatedRetriever({ mounts, policy: policy(), now: () => new Date("2026-08-14T15:00:00Z") });
  const principal = { id: "human:reader" }; const authorization = await retriever.prepareAuthorization({ principal, queryModes: ["wiki-only"] });
  const response = await retriever.search({ authorization, principal, query: "authentication", mode: "wiki-only", includeSources: true, limit: 1 });
  assert.equal(response.status, "ok"); assert.equal(response.results.length, 2); assert.equal(response.citations.length, 2);
  assert.match(response.citations[0].concept, /^kb:\/\/acme\.(?:primary|legacy)@[0-9a-z:-]+\/policies\/authentication$/);
  assert.equal(response.conflicts.length, 2);
  assert.deepEqual(response.results.find(({ id }) => id.startsWith("kb://acme.primary/")).source_citations.map(({ id }) => id), ["auth-source"]);
  const contracts = await createContractValidator(); assert.equal(contracts.validate("retrievalResponse", response).valid, true);

  const zeroScoreConflict = await retriever.search({ authorization, principal, query: "phishing-resistant", mode: "wiki-only", limit: 1 });
  assert.deepEqual(zeroScoreConflict.results.map(({ id }) => id), [
    "kb://acme.primary/policies/authentication", "kb://acme.legacy/policies/authentication"
  ]);
  assert.equal(zeroScoreConflict.results[1].score, 0);
  assert.equal(zeroScoreConflict.conflicts.length, 2);
});

test("FEAT-005 applies query-mode, trust, freshness, and access filters before disclosure", async (context) => {
  const root = await workspace(context); const { mounts } = await new FederationResolver({ projectRoot: root, now: fixedNow }).resolveProject(project(root));
  const retriever = new FederatedRetriever({ mounts, policy: policy(), now: () => new Date("2026-08-14T15:00:00Z") });
  const principal = {}; const authorization = await retriever.prepareAuthorization({ principal, queryModes: ["trusted-only", "sources-only", "fresh-only"] });
  const trusted = await retriever.search({ authorization, principal, query: "authentication", mode: "trusted-only" });
  assert.deepEqual(trusted.results.map(({ id }) => id), ["kb://acme.primary/policies/authentication"]);
  assert.equal((await retriever.search({ authorization, principal, query: "spoofed verification", mode: "trusted-only" })).status, "not_found");
  const sources = await retriever.search({ authorization, principal, query: "authentication", mode: "sources-only", staleBehavior: "warn" });
  assert.equal(sources.results.length, 1); assert.equal(sources.results[0].freshness, "stale"); assert.equal(sources.warnings.length, 1);
  const fresh = await retriever.search({ authorization, principal, query: "authentication", mode: "fresh-only" });
  assert.equal(fresh.results.some(({ id }) => id.includes("references/sources")), false);
  await assert.rejects(retriever.search({ principal, query: "authentication", mode: "wiki-only" }), retrievalCode("KDLC_AUTHORIZATION_SNAPSHOT_REQUIRED"));
  await assert.rejects(retriever.search({ principal: {}, query: "authentication", mode: "vector-only" }), retrievalCode("KDLC_QUERY_MODE"));
});

test("FEAT-005 authorizes before concept reads and bounds absent/unauthorized response timing", async (context) => {
  const root = await workspace(context); const catalogPath = join(root, "primary", "retrieval-catalog.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8")); const indexPath = join(root, "primary", "policies", "index.md"); let index = await readFile(indexPath, "utf8");
  for (let number = 0; number < 40; number += 1) {
    const name = `restricted-${String(number).padStart(2, "0")}`; const body = `---\ntype: Decision\ntitle: Restricted ${number}\nstatus: stable\naccess: { classification: restricted, compartments: [nightfall] }\n---\nRestricted material ${number}.\n`;
    await writeFile(join(root, "primary", "policies", `${name}.md`), body); index += `* [Restricted ${number}](${name}.md)\n`;
    catalog.concepts.push({ id: `policies/${name}`, path: `policies/${name}.md`, byte_hash: byteHash(body), access: { classification: "restricted", compartments: ["nightfall"] } });
  }
  await writeFile(indexPath, index); await writeFile(catalogPath, `${JSON.stringify(catalog)}\n`);
  const { mounts } = await new FederationResolver({ projectRoot: root, now: fixedNow }).resolveProject(project(root));
  const reads = []; let conceptDecisions = 0; const delayedPolicy = policy(); const authorizeConcept = delayedPolicy.authorizeConcept;
  delayedPolicy.authorizeConcept = async (input) => { conceptDecisions += 1; await new Promise((resolve) => setTimeout(resolve, 12)); return authorizeConcept(input); };
  const retriever = new FederatedRetriever({ mounts, policy: delayedPolicy, now: () => new Date("2026-08-14T15:00:00Z"), minimumDurationMs: 75,
    readConcept: async (path) => { reads.push(path); if (path.endsWith("/policies/nightfall.md")) throw new Error("unauthorized body opened"); return readFile(path); } });
  const principal = {}; const authorization = await retriever.prepareAuthorization({ principal, queryModes: ["wiki-only"] }); const preparedDecisions = conceptDecisions;
  const durations = []; let unauthorized; let absent;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    let started = performance.now(); unauthorized = await retriever.search({ authorization, principal, query: "Project Nightfall", mode: "wiki-only" });
    durations.push(performance.now() - started);
    started = performance.now(); absent = await retriever.search({ authorization, principal, query: "Project Zephyr", mode: "wiki-only" });
    durations.push(performance.now() - started);
    assert.deepEqual(unauthorized, absent);
  }
  assert.equal(preparedDecisions > 40, true, "fixture must exercise a large restricted catalog");
  assert.equal(conceptDecisions, preparedDecisions, "query path must not call the concept PDP");
  assert.equal(reads.some((path) => path.endsWith("/policies/nightfall.md")), false);
  assert.equal(durations.every((duration) => duration >= 65), true, `floor was not enforced: ${durations.join(", ")}`);
  for (let index = 0; index < durations.length; index += 2) assert.equal(Math.abs(durations[index] - durations[index + 1]) < 40, true, `timing classes diverged: ${durations.join(", ")}`);
  assert.deepEqual(Object.keys(absent), ["status", "results", "citations", "conflicts", "warnings", "timing_class"]);
  const contracts = await createContractValidator(); assert.equal(contracts.validate("retrievalResponse", absent).valid, true);
});

test("FEAT-005 write routing preserves dependency bases and never uses retrieval priority", async (context) => {
  const root = await workspace(context); const { mounts } = await new FederationResolver({ projectRoot: root, now: fixedNow }).resolveProject(project(root));
  const before = await readFile(join(mounts.find(({ alias }) => alias === "legacy").root, "policies/authentication.md"));
  assert.deepEqual(routeWrite({ mounts, explicitTarget: "legacy" }), { action: "proposal", target: "legacy", knowledge_base_id: "acme.legacy" });
  assert.deepEqual(routeWrite({ mounts, conceptType: "Policy", routing: { by_type: { Policy: "primary" } } }), { action: "write", target: "primary", knowledge_base_id: "acme.primary" });
  assert.deepEqual(await readFile(join(mounts.find(({ alias }) => alias === "legacy").root, "policies/authentication.md")), before);
  assert.throws(() => routeWrite({ mounts, routing: {} }), federationCode("KDLC_ROUTE_AMBIGUOUS"));
});
