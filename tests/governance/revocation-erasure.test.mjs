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

async function fixture(context, { holds = [], immediate = ["privacy-delete"], fault, surfaces: supplied, externalProcessors = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "kdlc-erasure-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new NodeFileStore(root);
  const ids = new Ids();
  const audit = new AuditWriter({ store, clock, ids });
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
    clock,
    audit: { append: async (event) => { governanceEvents.push(structuredClone(event)); } },
  });
  const authority = new RetentionDecisionAuthority({
    governanceAuthority,
    policies: [{ id: "retention", version: "7", governance_ref: "policy://retention/7", immediate_erasure_reasons: immediate, tombstone_fields: ["source_hash", "event_id"] }],
    holds,
    key: Buffer.alloc(32, 7),
    keyId: "retention-authority",
    clock,
  });
  const governance = await GovernanceControlEngine.create({ policy: governancePolicy, clock, audit: { append: async (event) => { governanceEvents.push(structuredClone(event)); } }, authority: governanceAuthority, erasureVerifier: authority.evidenceVerifier() });
  const governanceSession = await governanceAuthority.openSession("records-credential");
  const inventory = new SurfaceInventory({ store, list: async () => structuredClone(surfaces) });
  const engine = new RevocationEngine({ store, clock, ids, audit, authority, inventory, fault, externalProcessors });
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
  const concept = `---\ntype: Policy\ntitle: Private Control\nstatus: stable\naccess: { classification: public }\nsources:\n  - id: ${source.id}\n    resource: file:sources/private.md\n    source_hash: ${source.hash}\n    access: { classification: public }\n    rights: { license: Apache-2.0, redistribution: allowed, derivative_use: allowed, commercial_use: allowed }\n---\nThe secret control remains active.\n`;
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

test("FEAT-009 a legal hold activated after planning stops purge before any copy is treated", async (context) => {
  const activeHolds = [];
  const state = await fixture(context, { holds: () => structuredClone(activeHolds) });
  const started = await state.engine.start(await request(state));
  activeHolds.push({ id: "late-hold", source_id: source.id, status: "active", kinds: ["original"] });
  await assert.rejects(state.engine.run("wf_erase", started.job.job_id), (error) => error.code === "KDLC_ERASURE_POLICY_DENIED");
  assert.equal(await state.store.exists("sources/original/private.txt"), true);
  assert.equal((await state.engine.jobs.get(started.job.job_id)).state, "queued");
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
