import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, opendir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { artifactHash, byteHash } from "../../packages/core/index.mjs";
import { createContractValidator } from "../../packages/contracts/index.mjs";
import { createLocalProjectEngine, KdlcEngine } from "../../packages/cli/index.mjs";
import { GovernanceControlAuthority, GovernanceControlEngine } from "../../packages/governance/index.mjs";
import {
  RetentionDecisionAuthority,
  GovernedErasureOperation,
  ProjectProvenanceInventory,
  RevocationEngine,
  RevocationGuard,
  SurfaceInventory,
  guardRetriever,
  resolveImpact,
} from "../../packages/erasure/index.mjs";
import { AuditWriter, NodeFileStore } from "../../packages/lifecycle/src/index.mjs";

const source = {
  id: "src_private",
  hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};
const now = "2026-08-14T15:00:00.000Z";
const clock = { now: () => now, millis: () => Date.parse(now) };
const governancePolicy = {
  api_version: "kdlc.dev/governance-policy/v1alpha1",
  version: 1,
  minimum_independent_sources: 1,
  required_erasure_surfaces: ["original", "normalized", "claim", "concept", "cache", "index", "audit", "proposal"],
  waiver_authorities: {},
  declassification_authorities: {},
  erasure_policy_refs: { "policy://retention/7": { roles: ["records"], actions: ["revoke", "erase"] } },
  external_models: {},
};

async function removeTree(root) {
  const writable = async (path) => {
    let metadata;
    try { metadata = await lstat(path); } catch { return; }
    if (metadata.isDirectory()) {
      await chmod(path, 0o700);
      const directory = await opendir(path);
      for await (const entry of directory) await writable(join(path, entry.name));
    } else if (!metadata.isSymbolicLink()) await chmod(path, 0o600);
  };
  await writable(root);
  await rm(root, { recursive: true, force: true });
}

class Ids {
  constructor() { this.value = 0; }
  next(prefix) { this.value += 1; return `${prefix}_${String(this.value).padStart(6, "0")}`; }
}

async function fixture(context, { holds = [], immediate = ["privacy-delete"], fault, surfaces: supplied, externalProcessors = {}, trustedClock = clock } = {}) {
  const root = await mkdtemp(join(tmpdir(), "kdlc-erasure-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new NodeFileStore(root);
  const ids = new Ids();
  const audit = new AuditWriter({ store, clock: trustedClock, ids });
  const surfaces = supplied ?? [
    { id: "original", kind: "original", path: "sources/original/private.txt", strategy: "purge", bindings: { source_ids: [source.id], source_hashes: [source.hash] }, depends_on: [] },
    { id: "normalized", kind: "normalized", path: "sources/normalized/private.json", strategy: "purge", bindings: { source_ids: [source.id], source_hashes: [source.hash] }, depends_on: ["original"] },
    { id: "claim", kind: "claim", path: "workflow/claims/private.json", strategy: "purge", bindings: { source_ids: [], source_hashes: [] }, depends_on: ["normalized"] },
    { id: "concept", kind: "concept", path: "knowledge/private.md", strategy: "tombstone", bindings: { source_ids: [], source_hashes: [] }, depends_on: ["claim"] },
    { id: "proposal", kind: "proposal", path: "workflow/proposals/private.json", strategy: "purge", bindings: { source_ids: [], source_hashes: [] }, depends_on: ["claim"] },
    { id: "index", kind: "index", path: "knowledge/index.json", strategy: "purge", bindings: { source_ids: [], source_hashes: [] }, depends_on: ["concept"] },
    { id: "cache", kind: "cache", path: ".kdlc/cache/private.json", strategy: "purge", bindings: { source_ids: [source.id], source_hashes: [source.hash] }, depends_on: [] },
    { id: "audit-copy", kind: "audit", path: "workflow/audit-evidence/private.json", strategy: "tombstone", bindings: { source_ids: [source.id], source_hashes: [source.hash] }, depends_on: [] },
  ];
  for (const surface of surfaces) if (surface.path)
    await store.writeTextAtomic(surface.path, `sensitive:${surface.id}:Production API token is SECRET-123\n`);
  const governanceEvents = [];
  const governanceAuthority = new GovernanceControlAuthority({
    authenticate: async (credential) => credential === "records-credential" ? { actor: "human:privacy-officer", roles: ["records"] } : null,
    clock: trustedClock,
    audit: { append: async (event) => { governanceEvents.push(structuredClone(event)); } },
  });
  const authority = new RetentionDecisionAuthority({
    governanceAuthority,
    policies: [{ id: "retention", version: "7", governance_ref: "policy://retention/7", immediate_erasure_reasons: immediate, tombstone_fields: ["source_hash", "event_id"] }],
    holds,
    key: Buffer.alloc(32, 7),
    keyId: "retention-authority",
    clock: trustedClock,
  });
  const governance = await GovernanceControlEngine.create({ policy: governancePolicy, clock: trustedClock, audit: { append: async (event) => { governanceEvents.push(structuredClone(event)); } }, authority: governanceAuthority, erasureVerifier: authority.evidenceVerifier() });
  const governanceSession = await governanceAuthority.openSession("records-credential");
  const inventory = new SurfaceInventory({ store, list: async () => structuredClone(surfaces) });
  const engine = new RevocationEngine({ store, clock: trustedClock, ids, audit, authority, inventory, fault, externalProcessors });
  return { root, store, ids, audit, authority, governanceAuthority, governanceSession, governance, governanceEvents, inventory, engine, surfaces };
}

async function request(state, overrides = {}) {
  const input = {
    projectId: "project_alpha",
    workflowId: "wf_erase",
    sourceId: source.id,
    sourceHash: source.hash,
    action: "erase",
    reason: "privacy-delete",
    policyId: "retention",
    policyVersion: "7",
    idempotencyKey: "erase-private-1",
    ...overrides,
  };
  input.authorization = await state.governanceAuthority.issueErasureAuthorization(state.governanceSession, {
    id: `authorization-${input.idempotencyKey}`,
    subject: artifactHash({ id: input.sourceId, hash: input.sourceHash }),
    action: input.action,
    policy_ref: "policy://retention/7",
    reason: input.reason,
    expires_at: "2026-08-15T15:00:00Z",
  });
  return input;
}

test("FEAT-009 resolves a deterministic complete provenance impact graph and validates contracts", async (context) => {
  const { inventory } = await fixture(context);
  const first = resolveImpact(await inventory.snapshot(), source);
  const second = resolveImpact(await inventory.snapshot(), source);
  assert.deepEqual(first, second);
  assert.deepEqual(first.nodes.map(({ id }) => id), ["audit-copy", "cache", "claim", "concept", "index", "normalized", "original", "proposal"]);
  assert(first.edges.some(({ from, to }) => from === "claim" && to === "concept"));
  const validator = await createContractValidator();
  assert.equal(validator.validate("revocationImpact", first).valid, true);
});

test("FEAT-009 erasure barriers retrieval, treats every local copy, minimizes audit, and issues a verified receipt", async (context) => {
  const state = await fixture(context);
  const { engine, store, surfaces } = state;
  const started = await engine.start(await request(state));
  assert.equal(started.job.state, "queued");
  const guard = new RevocationGuard({ store });
  assert.equal(await guard.revoked(source.id, source.hash), true);
  const protectedRetriever = guardRetriever({
    async search() {
      return { status: "ok", results: [{ id: "kb://base/private", citation: { concept: "kb://base@r/private" }, source_citations: [{ id: source.id, source_hash: source.hash }] }], citations: [{ concept: "kb://base@r/private" }], conflicts: [], warnings: [], timing_class: "bounded-floor" };
    },
    async fetch() { return { status: "ok", body: "SECRET-123", source_citations: [{ id: source.id, source_hash: source.hash }] }; },
  }, guard);
  assert.equal((await protectedRetriever.search({ includeSources: true })).status, "not_found");
  assert.equal((await protectedRetriever.fetch({ uri: "kb://base/private" })).status, "not_found");
  const uncited = guardRetriever({
    async search() { return { status: "ok", results: [{ id: "kb://base/uncited", citation: { concept: "kb://base@r/uncited" } }], citations: [], conflicts: [], warnings: [], timing_class: "bounded-floor" }; },
    async fetch() { return { status: "ok", body: "uncited" }; },
  }, guard);
  assert.equal((await uncited.search({})).status, "not_found");
  assert.equal((await uncited.fetch({})).status, "not_found");
  await store.writeTextAtomic(guard.path("src_corrupt"), "{not-json\n");
  assert.equal(await guard.revoked("src_corrupt", source.hash), true);
  await store.writeJsonAtomic(guard.path("src_malformed"), { api_version: "kdlc.dev/revocation-barrier/v1alpha1", source: { id: "src_malformed" }, state: "revoked" });
  assert.equal(await guard.revoked("src_malformed", source.hash), true);
  const receipt = await engine.run("wf_erase", started.job.job_id);
  assert.equal(receipt.result, "erased");
  assert.equal(receipt.treated.total, surfaces.length);
  for (const surface of surfaces.filter(({ strategy }) => strategy === "purge"))
    assert.equal(await store.exists(surface.path), false, surface.id);
  for (const surface of surfaces.filter(({ strategy }) => strategy === "tombstone")) {
    const value = await store.readJson(surface.path);
    assert.equal(value.status, "deleted");
    assert.equal(JSON.stringify(value).includes("SECRET-123"), false);
    assert.equal(Object.hasOwn(value, "source_id"), false);
  }
  const validator = await createContractValidator();
  assert.equal(validator.validate("retentionDecision", started.decision).valid, true);
  assert.equal(validator.validate("erasureReceipt", receipt).valid, true);
  const audit = await store.readText("workflow/runs/wf_erase/audit.jsonl");
  assert.equal(audit.includes("SECRET-123"), false);
  assert.equal(audit.includes(source.id), false);
});

test("FEAT-008 FEAT-009 exposes only instance-bound evidence derived from a verified durable purge", async (context) => {
  const state = await fixture(context);
  const started = await state.engine.start(await request(state));
  assert.equal(state.governanceEvents.some(({ action }) => action === "governance.erasure.authorized"), true);
  await state.engine.run("wf_erase", started.job.job_id);
  const token = await state.engine.issueGovernanceEvidence("wf_erase", started.job.job_id);
  const evidence = state.authority.evidenceVerifier().resolve(token);
  assert.equal(evidence.subject, artifactHash(source));
  assert.equal(evidence.action, "erase");
  assert.equal(evidence.result, "erased");
  assert.equal(evidence.impact_hash, artifactHash(started.impact));
  assert.equal(evidence.decision_hash, artifactHash(started.decision));
  assert.equal(evidence.propagation_verified, true);
  assert.equal(evidence.legal_hold, false);
  assert.deepEqual([...new Set(evidence.inventory.map(({ surface }) => surface))].sort(),
    ["audit", "cache", "claim", "concept", "index", "normalized", "original", "proposal"]);
  assert.equal(evidence.inventory.find(({ surface }) => surface === "concept").status, "tombstoned");
  assert.equal(evidence.inventory.find(({ surface }) => surface === "original").status, "purged");
  assert.equal((await state.governance.authorizeErasure({ subject: artifactHash(source), erasure_verification: token })).allowed, true);
  await assert.rejects(state.governance.authorizeErasure({
    subject: artifactHash(source),
    erasure_verification: { ...evidence, inventory: evidence.inventory.map((item) => ({ ...item, status: "purged" })) },
  }), (error) => error.code === "KDLC_GOVERNANCE_DENIED");
  assert.throws(() => state.authority.resolveGovernanceEvidence(Object.freeze({ kind: "kdlc-verified-erasure-evidence-1" })),
    (error) => error.code === "KDLC_ERASURE_POLICY_DENIED");
  const other = await fixture(context);
  assert.throws(() => other.authority.resolveGovernanceEvidence(token),
    (error) => error.code === "KDLC_ERASURE_POLICY_DENIED");
  await assert.rejects(other.engine.start(await request(state, { idempotencyKey: "cross-authority" })),
    (error) => error.code === "KDLC_ERASURE_POLICY_DENIED");
});

test("FEAT-009 the shipped project engine enforces a newly installed barrier without restart", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "kdlc-erasure-cli-"));
  context.after(() => removeTree(root));
  await new KdlcEngine({ root, clock }).execute("init", { project_id: "revocation.project" });
  const hiddenSource = { id: "src_hidden", hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" };
  const concept = `---\ntype: Policy\ntitle: Private Control\nstatus: stable\naccess: { classification: public }\nsources:\n  - id: ${source.id}\n    resource: file:sources/private.md\n    source_hash: ${source.hash}\n    access: { classification: public }\n    rights: { license: Apache-2.0, redistribution: allowed, derivative_use: allowed, commercial_use: allowed }\n  - id: ${hiddenSource.id}\n    resource: file:sources/hidden.md\n    source_hash: ${hiddenSource.hash}\n    access: { classification: restricted }\n    rights: { license: Apache-2.0, redistribution: allowed, derivative_use: allowed, commercial_use: allowed }\n---\nThe secret control remains active.\n`;
  await writeFile(join(root, "knowledge/primary/private.md"), concept);
  await writeFile(join(root, "knowledge/primary/index.md"), "# Knowledge\n\n* [Private Control](private.md)\n");
  await writeFile(join(root, "knowledge/primary/retrieval-catalog.json"), `${JSON.stringify({ version: "kdlc-retrieval-catalog-1", concepts: [{ id: "private", path: "private.md", byte_hash: byteHash(Buffer.from(concept)), access: { classification: "public" } }] })}\n`);
  const projectStore = new NodeFileStore(root);
  const principalPolicy = await projectStore.readJson(".kdlc/principal-policy.json");
  principalPolicy.principals[0].clearance = "internal";
  await projectStore.writeJsonAtomic(".kdlc/principal-policy.json", principalPolicy);
  const engine = createLocalProjectEngine({ root });
  assert.equal((await engine.execute("query", { question: "secret control" })).status, "ok");
  const store = new NodeFileStore(root);
  const guard = new RevocationGuard({ store });
  await store.writeJsonAtomic(guard.path(hiddenSource.id), {
    api_version: "kdlc.dev/revocation-barrier/v1alpha1", source: hiddenSource, state: "revoked",
    workflow_id: "wf_hidden", job_id: "job_hidden", impact_hash: artifactHash("hidden-impact"),
    decision_hash: artifactHash("hidden-decision"), activated_at: now,
  });
  assert.equal((await engine.execute("query", { question: "secret control" })).status, "not_found");
  await store.remove(guard.path(hiddenSource.id));
  await store.writeJsonAtomic(guard.path(source.id), {
    api_version: "kdlc.dev/revocation-barrier/v1alpha1",
    source,
    state: "revoked",
    workflow_id: "wf_erase",
    job_id: "job_erase",
    impact_hash: artifactHash("impact"),
    decision_hash: artifactHash("decision"),
    activated_at: now,
  });
  assert.equal((await engine.execute("query", { question: "secret control" })).status, "not_found");
  await engine.close();
});

test("FEAT-009 legal hold and unexpired retention fail closed with authenticated audited blocked jobs", async (context) => {
  const held = await fixture(context, { holds: [{ id: "hold-case-7", source_id: source.id, status: "active", kinds: ["original", "concept"] }] });
  const result = await held.engine.start(await request(held));
  assert.equal(result.decision.allowed, false);
  assert.equal(result.job.state, "failed");
  assert.deepEqual(result.decision.blocked.legal_holds, ["hold-case-7"]);
  assert.equal(await held.store.exists("sources/original/private.txt"), true);
  assert.equal((await held.store.readJson(held.engine.guard.path(source.id))).state, "held");
  assert.match(await held.store.readText("workflow/runs/wf_erase/audit.jsonl"), /erasure\.blocked/);
  await assert.rejects(held.engine.issueGovernanceEvidence("wf_erase", result.job.job_id),
    (error) => error.code === "KDLC_ERASURE_POLICY_DENIED");
  await assert.rejects(held.governance.authorizeErasure({ subject: artifactHash(source), erasure_verification: Object.freeze({ kind: "kdlc-verified-erasure-evidence-1" }) }),
    (error) => error.code === "KDLC_GOVERNANCE_DENIED");

  const retainedSurfaces = [{ id: "retained", kind: "original", path: "retained.txt", strategy: "purge", retained_until: "2027-08-14T15:00:00.000Z", bindings: { source_ids: [source.id], source_hashes: [source.hash] }, depends_on: [] }];
  const retained = await fixture(context, { immediate: [], surfaces: retainedSurfaces });
  const blocked = await retained.engine.start(await request(retained, { reason: "ordinary-delete", idempotencyKey: "retention-block" }));
  assert.equal(blocked.decision.allowed, false);
  assert.deepEqual(blocked.decision.blocked.retention_surfaces, ["retained"]);
});

test("FEAT-009 crash after physical purge resumes idempotently without duplicate audit records", async (context) => {
  let crashed = false;
  const fixtureState = await fixture(context, {
    fault: async ({ phase, surface }) => {
      if (!crashed && phase === "after-surface-before-checkpoint" && surface === "audit-copy") {
        crashed = true;
        throw new Error("simulated process crash");
      }
    },
  });
  const started = await fixtureState.engine.start(await request(fixtureState));
  await assert.rejects(fixtureState.engine.run("wf_erase", started.job.job_id), /simulated process crash/);
  assert.equal((await fixtureState.engine.jobs.get(started.job.job_id)).state, "running");
  const receipt = await fixtureState.engine.run("wf_erase", started.job.job_id);
  assert.equal(receipt.result, "erased");
  const events = (await fixtureState.store.readText("workflow/runs/wf_erase/audit.jsonl")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(({ action }) => action === "erasure.completed").length, 1);
  assert.equal(events.filter(({ action, subject }) => action === "erasure.copy-treated" && subject).length, fixtureState.surfaces.length);
});

test("FEAT-009 crash after copy audit but before its checkpoint replays without duplicate audit", async (context) => {
  let crashed = false;
  const state = await fixture(context, {
    fault: async ({ phase, surface }) => {
      if (!crashed && phase === "after-surface-audit-before-checkpoint" && surface === "audit-copy") {
        crashed = true;
        throw new Error("simulated audit checkpoint crash");
      }
    },
  });
  const started = await state.engine.start(await request(state));
  await assert.rejects(state.engine.run("wf_erase", started.job.job_id), /simulated audit checkpoint crash/);
  assert.equal((await state.engine.run("wf_erase", started.job.job_id)).result, "erased");
  const events = (await state.store.readText("workflow/runs/wf_erase/audit.jsonl")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(({ action }) => action === "erasure.copy-treated").length, state.surfaces.length);
});

test("FEAT-009 audit/receipt finalization crash gaps recover forward exactly once", async (context) => {
  for (const crashPhase of ["after-audit-before-receipt", "after-receipt-before-finalization"]) {
    let crashed = false;
    const state = await fixture(context, {
      fault: async ({ phase }) => {
        if (!crashed && phase === crashPhase) {
          crashed = true;
          throw new Error(`crash:${crashPhase}`);
        }
      },
    });
    const started = await state.engine.start(await request(state, { workflowId: `wf_${crashPhase.replaceAll("-", "_")}`, idempotencyKey: `key-${crashPhase}` }));
    await assert.rejects(state.engine.run(started.job.workflow_id, started.job.job_id), new RegExp(`crash:${crashPhase}`));
    const receipt = await state.engine.run(started.job.workflow_id, started.job.job_id);
    assert.equal(receipt.result, "erased");
    assert.equal((await state.engine.jobs.get(started.job.job_id)).state, "completed");
    assert.equal((await state.store.readJson(state.engine.guard.path(source.id))).state, "erased");
    const events = (await state.store.readText(`workflow/runs/${started.job.workflow_id}/audit.jsonl`)).trim().split("\n").map(JSON.parse);
    assert.equal(events.filter(({ action }) => action === "erasure.completed").length, 1);
    const receiptPath = state.engine.receiptPath(started.job.workflow_id, started.job.job_id);
    const tampered = await state.store.readJson(receiptPath);
    tampered.treated.total += 1;
    await state.store.writeJsonAtomic(receiptPath, tampered);
    await assert.rejects(state.engine.run(started.job.workflow_id, started.job.job_id), (error) => error.code === "KDLC_ERASURE_INCOMPLETE");
  }
});

test("FEAT-009 completion outbox freezes receipt and audit hashes across an advancing-clock crash", async (context) => {
  let tick = 0;
  const base = Date.parse("2026-08-14T15:00:00.000Z");
  const advancing = { now: () => new Date(base + tick++ * 1000).toISOString(), millis: () => base + tick * 1000 };
  let crashed = false;
  const state = await fixture(context, { trustedClock: advancing, fault: async ({ phase }) => {
    if (phase === "after-audit-before-receipt" && !crashed) { crashed = true; throw new Error("advancing-clock-crash"); }
  } });
  const started = await state.engine.start(await request(state));
  await assert.rejects(state.engine.run("wf_erase", started.job.job_id), /advancing-clock-crash/);
  const persisted = await state.store.readJson(state.engine.planPath("wf_erase", started.job.job_id));
  const frozenHash = artifactHash(persisted.finalization.receipt);
  const receipt = await state.engine.run("wf_erase", started.job.job_id);
  assert.equal(artifactHash(receipt), frozenHash);
  assert.equal(receipt.completed_at, persisted.finalization.receipt.completed_at);
  const events = (await state.store.readText("workflow/runs/wf_erase/audit.jsonl")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(({ action }) => action === "erasure.completed").length, 1);
});

test("FEAT-009 same-ID path substitution and post-audit late copies cannot receive a receipt", async (context) => {
  for (const substitution of ["same-id", "new-id"]) {
    let state;
    let injected = false;
    state = await fixture(context, { fault: async ({ phase }) => {
      if (phase !== "after-audit-before-receipt" || injected) return;
      injected = true;
      const late = { id: substitution === "same-id" ? "original" : "late-copy", kind: "original", path: `sources/original/${substitution}.txt`, strategy: "purge", bindings: { source_ids: [source.id], source_hashes: [source.hash] }, depends_on: [] };
      await state.store.writeTextAtomic(late.path, "SECRET-123 late copy\n");
      if (substitution === "same-id") state.surfaces.splice(state.surfaces.findIndex(({ id }) => id === "original"), 1, late);
      else state.surfaces.push(late);
    } });
    const started = await state.engine.start(await request(state, { workflowId: `wf_${substitution}`, idempotencyKey: `key-${substitution}` }));
    await assert.rejects(state.engine.run(started.job.workflow_id, started.job.job_id), (error) => error.code === "KDLC_ERASURE_INCOMPLETE");
    assert.equal(await state.store.exists(state.engine.receiptPath(started.job.workflow_id, started.job.job_id)), false);
    assert.equal(await state.store.exists(`sources/original/${substitution}.txt`), true);
  }
});

test("FEAT-009 durable generation fails retrieval closed through an interrupted barrier install", async (context) => {
  const state = await fixture(context);
  const guard = new RevocationGuard({ store: state.store });
  await state.store.writeJsonAtomic(guard.generationPath(), { generation: 7 });
  const guarded = guardRetriever({ async search() { return { status: "ok", results: [{ citation: { concept: "kb://base@r/private" }, source_citations: [{ id: source.id, source_hash: source.hash }] }], citations: [], conflicts: [], warnings: [], timing_class: "bounded-floor" }; } }, guard);
  assert.equal((await guarded.search({ includeSources: true })).status, "not_found");
});

test("FEAT-009 shipped complete project inventory rejects unknown files and operation consumes FEAT-008 tokens", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "kdlc-project-inventory-"));
  context.after(() => removeTree(root));
  const store = new NodeFileStore(root);
  const originalBytes = Buffer.from("private\n");
  const originalHash = byteHash(originalBytes);
  await store.writeTextAtomic("sources/private.txt", originalBytes.toString());
  await store.writeJsonAtomic(".kdlc/provenance-evidence/original.json", { source_id: source.id, source_hash: originalHash });
  assert.throws(() => new ProjectProvenanceInventory({ store, governedRoots: ["sources"] }), (error) => error.code === "KDLC_ERASURE_INPUT_INVALID");
  const inventory = new ProjectProvenanceInventory({ store });
  const descriptors = [{ id: "original", kind: "original", path: "sources/private.txt", strategy: "purge", evidence_paths: [".kdlc/provenance-evidence/original.json"] }];
  await assert.rejects(inventory.commitManifest([{ ...descriptors[0], bindings: { source_ids: [], source_hashes: [] } }], { clock }),
    (error) => error.code === "KDLC_ERASURE_INCOMPLETE");
  await inventory.commitManifest(descriptors, { clock });
  assert.equal((await inventory.snapshot()).surfaces.length, 1);
  await store.writeTextAtomic("sources/unknown.txt", "untracked\n");
  await assert.rejects(inventory.snapshot(), (error) => error.code === "KDLC_ERASURE_INCOMPLETE" && error.details.unknown.includes("sources/unknown.txt"));

  const external = new ProjectProvenanceInventory({ store, externalProcessors: { vault: {
    async inventory() { return [{ object_id: "external-secret", bindings: { source_ids: [source.id], source_hashes: [originalHash] }, depends_on: [] }]; },
    async verifyInventory() { return true; },
  } } });
  await assert.rejects(external.commitManifest(descriptors, { clock, owner: "external-omission" }),
    (error) => error.code === "KDLC_ERASURE_INCOMPLETE" && /omitted/.test(error.message));

  const state = await fixture(context);
  const operation = new GovernedErasureOperation({ engine: state.engine, governanceControls: state.governance });
  const result = await operation.execute(await request(state, { workflowId: "wf_adapter", idempotencyKey: "adapter-erase" }));
  assert.equal(result.status, "erased");
  assert.equal(state.authority.evidenceVerifier().resolve(result.completion).receipt_hash, artifactHash(result.receipt));
});

test("FEAT-009 production namespace blocks uncoordinated final-commit copies", async (context) => {
  const state = await fixture(context);
  const projectInventory = new ProjectProvenanceInventory({ store: state.store });
  await projectInventory.ensureNamespace();
  state.inventory.finalize = projectInventory.finalize.bind(projectInventory);
  const started = await state.engine.start(await request(state));
  const originalWrite = state.store.writeJsonAtomic.bind(state.store);
  let lateWrite;
  state.store.writeJsonAtomic = async (path, value) => {
    if (path === state.engine.receiptPath("wf_erase", started.job.job_id) && !lateWrite)
      lateWrite = state.store.writeTextAtomic("backups/uncoordinated-late.txt", "SECRET-123\n").then(() => null, (error) => error);
    return originalWrite(path, value);
  };
  const receipt = await state.engine.run("wf_erase", started.job.job_id);
  assert.equal(receipt.result, "erased");
  assert.equal((await lateWrite)?.code, "KDLC_HASH_CONFLICT");
  assert.equal(await state.store.exists("backups/uncoordinated-late.txt"), false);
});

test("FEAT-009 cooperative provenance updates cannot reintroduce a revoked source", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "kdlc-cooperative-late-"));
  context.after(() => removeTree(root));
  const store = new NodeFileStore(root);
  const bytes = Buffer.from("private\n");
  const hash = byteHash(bytes);
  await store.writeTextAtomic("sources/private.txt", bytes.toString());
  await store.writeJsonAtomic(".kdlc/provenance-evidence/original.json", { source_id: source.id, source_hash: hash });
  const inventory = new ProjectProvenanceInventory({ store });
  const descriptors = [{ id: "original", kind: "original", path: "sources/private.txt", strategy: "purge", evidence_paths: [".kdlc/provenance-evidence/original.json"] }];
  await inventory.commitManifest(descriptors, { clock });
  const guard = new RevocationGuard({ store });
  await store.writeJsonAtomic(guard.path(source.id), {
    api_version: "kdlc.dev/revocation-barrier/v1alpha1", source: { id: source.id, hash }, state: "erased",
    workflow_id: "wf_late", job_id: "job_late", impact_hash: artifactHash("impact"), decision_hash: artifactHash("decision"), activated_at: now,
  });
  await store.writeJsonAtomic("backups/cooperative.json", { source_id: source.id, source_hash: hash, secret: "SECRET-123" });
  await assert.rejects(inventory.commitManifest([...descriptors, { id: "late", kind: "backup", path: "backups/cooperative.json", strategy: "purge" }], { clock, owner: "late-update" }),
    (error) => error.code === "KDLC_ERASURE_POLICY_DENIED");
  await assert.rejects(inventory.snapshot(), (error) => error.code === "KDLC_ERASURE_INCOMPLETE" && error.details.unknown.includes("backups/cooperative.json"));
});

test("FEAT-009 verification detects a late partial copy and refuses success until it is removed from the trusted inventory", async (context) => {
  const state = await fixture(context);
  const started = await state.engine.start(await request(state));
  const late = { id: "late-backup", kind: "backup", path: "backups/late.txt", strategy: "purge", bindings: { source_ids: [source.id], source_hashes: [source.hash] }, depends_on: [] };
  await state.store.writeTextAtomic(late.path, "SECRET-123 late copy\n");
  state.surfaces.push(late);
  await assert.rejects(state.engine.run("wf_erase", started.job.job_id), (error) => error.code === "KDLC_ERASURE_INCOMPLETE" && error.details.added.includes("late-backup"));
  assert.equal(await state.store.exists(state.engine.receiptPath("wf_erase", started.job.job_id)), false);
  assert.equal((await state.engine.jobs.get(started.job.job_id)).state, "running");
  await state.store.remove(late.path);
  state.surfaces.splice(state.surfaces.indexOf(late), 1);
  assert.equal((await state.engine.run("wf_erase", started.job.job_id)).result, "erased");
});

test("FEAT-009 revocation retains historical artifacts but invalidates every dependent and rejects spoofed authority", async (context) => {
  const state = await fixture(context);
  await assert.rejects(state.engine.start({ ...await request(state, { action: "revoke", reason: "source-revoked", idempotencyKey: "forged-revoke" }), authorization: Object.freeze({ kind: "kdlc-erasure-authorization-1", id: "forged" }) }), (error) => error.code === "KDLC_ERASURE_POLICY_DENIED");
  const exact = await request(state, { action: "revoke", reason: "source-revoked", idempotencyKey: "mismatched-binding" });
  await assert.rejects(state.engine.start({ ...exact, reason: "privacy-delete" }),
    (error) => error.code === "KDLC_ERASURE_POLICY_DENIED");
  const started = await state.engine.start(await request(state, { action: "revoke", reason: "source-revoked", idempotencyKey: "revoke-private-1" }));
  const receipt = await state.engine.run("wf_erase", started.job.job_id);
  assert.equal(receipt.result, "revoked");
  assert.equal(await state.store.exists("knowledge/private.md"), true);
  for (const surface of state.surfaces) {
    const invalidation = await state.store.readJson(state.engine.impactPath(source.id, surface.id));
    assert(["invalidated", "review-required"].includes(invalidation.status));
  }
  const planPath = state.engine.planPath("wf_erase", started.job.job_id);
  const plan = await state.store.readJson(planPath);
  plan.decision.reason = "tampered";
  await state.store.writeJsonAtomic(planPath, plan);
  await state.store.remove(state.engine.receiptPath("wf_erase", started.job.job_id));
  await assert.rejects(state.engine.run("wf_erase", started.job.job_id), (error) => error.code === "KDLC_ERASURE_POLICY_DENIED");
});

test("FEAT-009 a concurrent retrieval finishing after barrier installation cannot disclose revoked content", async (context) => {
  const state = await fixture(context);
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const guarded = guardRetriever({
    async search() {
      entered();
      await waiting;
      return { status: "ok", results: [{ id: "kb://base/private", citation: { concept: "kb://base@r/private" }, source_citations: [{ id: source.id, source_hash: source.hash }] }], citations: [{ concept: "kb://base@r/private" }], conflicts: [], warnings: [], timing_class: "bounded-floor" };
    },
  }, new RevocationGuard({ store: state.store }));
  const query = guarded.search({ includeSources: true });
  await enteredPromise;
  await state.engine.start(await request(state));
  release();
  const result = await query;
  assert.equal(result.status, "not_found");
  assert.deepEqual(result.results, []);
});

test("FEAT-009 one generation snapshot covers every result in a retrieval response", async (context) => {
  const state = await fixture(context);
  const guard = new RevocationGuard({ store: state.store });
  let checked = 0;
  const original = guard.allowedCitations.bind(guard);
  guard.allowedCitations = async (citations) => {
    const allowed = await original(citations);
    checked += 1;
    if (checked === 1) await state.engine.start(await request(state, { idempotencyKey: "multi-result-race" }));
    return allowed;
  };
  const guarded = guardRetriever({ async search() { return {
    status: "ok", results: ["one", "two"].map((id) => ({ id, citation: { concept: `kb://base@r/${id}` }, source_citations: [{ id: source.id, source_hash: source.hash }] })),
    citations: [], conflicts: [], warnings: [], timing_class: "bounded-floor",
  }; } }, guard);
  assert.equal((await guarded.search({ includeSources: true })).status, "not_found");
});

test("FEAT-009 a legal hold activated after planning stops purge before any copy is treated", async (context) => {
  const activeHolds = [];
  const state = await fixture(context, { holds: () => structuredClone(activeHolds) });
  const started = await state.engine.start(await request(state));
  activeHolds.push({ id: "late-hold", source_id: source.id, status: "active", kinds: ["original"] });
  await assert.rejects(state.engine.run("wf_erase", started.job.job_id), (error) => error.code === "KDLC_ERASURE_POLICY_DENIED");
  assert.equal(await state.store.exists("sources/original/private.txt"), true);
  assert.equal((await state.engine.jobs.get(started.job.job_id)).state, "queued");
});

test("FEAT-009 a hold activated at the destructive boundary prevents the first deletion", async (context) => {
  const activeHolds = [];
  let activated = false;
  const state = await fixture(context, { holds: () => structuredClone(activeHolds), fault: async ({ phase }) => {
    if (phase === "before-surface" && !activated) {
      activated = true;
      activeHolds.push({ id: "boundary-hold", source_id: source.id, status: "active", kinds: ["audit"] });
    }
  } });
  const started = await state.engine.start(await request(state));
  await assert.rejects(state.engine.run("wf_erase", started.job.job_id), (error) => error.code === "KDLC_ERASURE_POLICY_DENIED");
  for (const surface of state.surfaces) assert.equal(await state.store.exists(surface.path), true, surface.id);
  assert.equal(await state.store.exists(state.engine.receiptPath("wf_erase", started.job.job_id)), false);
});

test("FEAT-009 external processors require minimized receipts and verified idempotent deletion", async (context) => {
  const surfaces = [{ id: "backup", kind: "backup", strategy: "external-delete", processor: "vault", object_id: "object-private", bindings: { source_ids: [source.id], source_hashes: [source.hash] }, depends_on: [] }];
  const deleted = new Map();
  let calls = 0;
  const processor = {
    async delete({ objectId, idempotencyKey }) {
      calls += 1;
      const receipt = {
        api_version: "kdlc.dev/external-deletion-receipt/v1alpha1",
        processor: "vault",
        object_id_hash: `sha256:${(await import("node:crypto")).createHash("sha256").update(objectId).digest("hex")}`,
        deletion_id: "delete_001",
        proof_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      };
      deleted.set(idempotencyKey, receipt);
      return receipt;
    },
    async verify({ objectId, receipt }) {
      return receipt.object_id_hash === `sha256:${(await import("node:crypto")).createHash("sha256").update(objectId).digest("hex")}` && [...deleted.values()].some((candidate) => candidate.proof_hash === receipt.proof_hash);
    },
  };
  const state = await fixture(context, { surfaces, externalProcessors: { vault: processor } });
  const started = await state.engine.start(await request(state));
  assert.equal((await state.engine.run("wf_erase", started.job.job_id)).result, "erased");
  assert.equal(calls, 1);
  assert.equal((await state.engine.run("wf_erase", started.job.job_id)).result, "erased");
  assert.equal(calls, 1);
  const persisted = await state.store.readText(state.engine.planPath("wf_erase", started.job.job_id));
  assert.equal(persisted.includes("object-private"), true);
  assert.equal(persisted.includes("SECRET"), false);
});

test("FEAT-009 idempotent start returns the bound plan despite later inventory drift and rejects changed input", async (context) => {
  const state = await fixture(context);
  const first = await state.engine.start(await request(state));
  assert.equal((await state.engine.start(await request(state))).job.job_id, first.job.job_id);
  state.surfaces.push({ id: "new-copy", kind: "export", path: "exports/new.txt", strategy: "purge", bindings: { source_ids: [source.id], source_hashes: [source.hash] }, depends_on: [] });
  await state.store.writeTextAtomic("exports/new.txt", "copy\n");
  const replay = await state.engine.start(await request(state));
  assert.equal(replay.reused, true);
  assert.deepEqual(replay.impact, first.impact);
  await assert.rejects(state.engine.start(await request(state, { reason: "source-revoked" })), (error) => error.code === "KDLC_ERASURE_CONFLICT");
  assert.notEqual(artifactHash(first.impact), artifactHash(resolveImpact(await state.inventory.snapshot(), source)));
});

test("FEAT-009 signed impact binds exact deletion paths and invalid calendar retention fails closed", async (context) => {
  const state = await fixture(context);
  const started = await state.engine.start(await request(state));
  const planPath = state.engine.planPath("wf_erase", started.job.job_id);
  const plan = await state.store.readJson(planPath);
  plan.surfaces[0].path = "unrelated.txt";
  await state.store.writeJsonAtomic(planPath, plan);
  await assert.rejects(state.engine.run("wf_erase", started.job.job_id), (error) => error.code === "KDLC_ERASURE_POLICY_DENIED");
  assert.equal(await state.store.exists("sources/original/private.txt"), true);

  const invalidDate = [{ id: "bad-date", kind: "original", path: "bad.txt", strategy: "purge", retained_until: "2027-02-30T00:00:00Z", bindings: { source_ids: [source.id], source_hashes: [source.hash] }, depends_on: [] }];
  const malformed = await fixture(context, { surfaces: invalidDate });
  await assert.rejects(malformed.engine.start(await request(malformed, { idempotencyKey: "bad-date" })), (error) => error.code === "KDLC_ERASURE_INCOMPLETE");
});
