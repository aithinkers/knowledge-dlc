import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { KdlcEngine, createLocalProjectEngine, parseCli } from "../../packages/cli/index.mjs";

async function completedIngest(engine, root, filename, content) {
  await writeFile(join(root, filename), content);
  const started = await engine.execute("ingest_start", { sources: [filename], idempotency_key: `fixture-${filename}` });
  let job = started;
  for (let attempt = 0; attempt < 100 && !["completed", "failed"].includes(job.state); attempt += 1) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
    job = await engine.execute("job_status", { id: started.id });
  }
  assert.equal(job.state, "completed");
  return job;
}

test("FEAT-030: scaffold → fill → submit → review → publish runs end to end on a live project", async () => {
  const root = await mkdtemp(join(tmpdir(), "kdlc-scaffold-"));
  await new KdlcEngine({ root }).execute("init", { project_id: "scaffold.fixture" });
  const engine = createLocalProjectEngine({ root });
  const job = await completedIngest(engine, root, "spec.md", "# Spec\n\n## Token lifetime\n\nProduction API tokens expire after 60 minutes.\n");

  // Governance inputs are explicit, never defaulted.
  await assert.rejects(engine.execute("proposal", { scaffold: { job_id: job.id, license: "LicenseRef-Internal" } }), /access classification is a governance decision/);
  await assert.rejects(engine.execute("proposal", { scaffold: { job_id: job.id, access: "internal" } }), /license is a governance decision/);
  await assert.rejects(engine.execute("proposal", { scaffold: { job_id: "job_0000000000000000", access: "internal", license: "L" } }), /unavailable/);

  const scaffold = await engine.execute("proposal", { scaffold: { job_id: job.id, access: "internal", license: "LicenseRef-Internal" } });
  assert.match(scaffold.workflow_id, /^wf_[a-z0-9]+$/, "workflow id satisfies the concept-proposal schema");
  assert.ok(scaffold.units >= 2);
  const kit = join(root, ".kdlc/drafting", scaffold.workflow_id);
  const readme = await readFile(join(kit, "README.md"), "utf8");
  assert.match(readme, /kdlc proposal/);
  assert.match(readme, /claim_decisions/);
  assert.match(readme, /kdlc publish/);
  const evidence = JSON.parse(await readFile(join(kit, "normalized-evidence.json"), "utf8"));
  const template = JSON.parse(await readFile(join(kit, "recording-template.json"), "utf8"));

  // Re-running with the same workflow refuses rather than clobbering.
  await assert.rejects(engine.execute("proposal", { scaffold: { job_id: job.id, access: "internal", license: "LicenseRef-Internal", workflow_id: scaffold.workflow_id } }), /already has a review context/);

  // Fill the template the way the README instructs.
  const unit = evidence.units.find(({ text }) => /expire/.test(text));
  const rights = { license: "LicenseRef-Internal", redistribution: "prohibited", derivative_use: "allowed", commercial_use: "prohibited" };
  template.model.model = "test-model";
  template.model.prompt = "drafting-fixture";
  template.claims = [{
    id: "clmtoken", text: "Production API tokens expire after 60 minutes.",
    source_id: evidence.source_id, source_hash: evidence.source_hash, locator: unit.locator,
    extraction: "explicit", status: "accepted", access: { classification: "internal" }, rights
  }];
  template.claims[0].id = "clm_token";
  template.proposals = [{
    api_version: "kdlc.dev/concept-proposal/v1alpha1", id: "pr_token", workflow_id: scaffold.workflow_id,
    task: "ingest", state: "review_pending",
    target: { knowledge_base_id: "local.scaffold-fixture", revision: "rev-1", subject: "kb://local.scaffold-fixture/policies/token-lifetime" },
    concept: { before: null, after: { frontmatter: { type: "Policy", title: "API token lifetime", description: "Token lifetime policy.", status: "stable", access: { classification: "internal" }, generated: { by: "kdlc-integrator/0.2.0", at: "2026-08-16T20:30:00Z" }, sources: [{ id: "spec", resource: "file:spec.md", source_hash: evidence.source_hash, access: { classification: "internal" }, rights }], stale_after: "2030-01-01" }, body: "# API token lifetime\n\nProduction API tokens expire after 60 minutes.\n" } },
    claim_ids: ["clm_token"],
    claim_decisions: [{ claim_id: "clm_token", disposition: "accepted", rationale: "explicit statement" }],
    created_by: "kdlc-integrator/0.2.0"
  }];

  const submitted = await engine.execute("proposal", { proposal: { workflow_id: scaffold.workflow_id, task: "ingest", recording: template, normalized_evidence: evidence } });
  assert.equal(submitted.proposals.length, 1);
  assert.match(submitted.proposals[0].packet_hash, /^sha256:[a-f0-9]{64}$/);

  const decision = await engine.execute("review", { proposal_id: "pr_token", decision: "approved", receipt_id: "rr_token" });
  assert.equal(decision.receipt.decision, "approved");
  assert.equal(decision.receipt.packet_hash, submitted.proposals[0].packet_hash);

  const context = JSON.parse(await readFile(join(root, ".kdlc/governed/review-contexts", `${scaffold.workflow_id}.json`), "utf8")).context;
  const current = {
    concept: template.proposals[0].concept.after, target_revision: "rev-1",
    source_hashes: [evidence.source_hash],
    resolved_dependencies: context.resolved.dependencies, profile: context.resolved.profile, policies: context.resolved.policies
  };
  const publication = await engine.execute("publish", { proposal_id: "pr_token", receipt_id: "rr_token", current });
  assert.equal(publication.intent.proposal_id, "pr_token");
  assert.equal(publication.intent.packet_hash, submitted.proposals[0].packet_hash);
  // FEAT-033: the last mile — concept file, index, catalog land atomically…
  assert.equal(publication.published.materialized, true);
  const conceptText = await readFile(join(root, publication.published.concept), "utf8");
  assert.match(conceptText, /^---\n/);
  assert.match(conceptText, /Production API tokens expire after 60 minutes\./);
  assert.match(await readFile(join(root, "knowledge/primary/index.md"), "utf8"), /API token lifetime/);
  // …republish is idempotent…
  const again = await engine.execute("publish", { proposal_id: "pr_token", receipt_id: "rr_token", current });
  assert.equal(again.published.already_published, true);
  // …and query answers with revision-pinned citations immediately.
  const answer = await engine.execute("query", { question: "what is the token lifetime?" });
  assert.equal(answer.status, "ok");
  assert.equal(answer.results[0].title, "API token lifetime");
  assert.match(answer.citations[0].concept, /^kb:\/\/scaffold\.fixture@sha256:[a-f0-9]{64}\//);
});

test("FEAT-033: bare publish lists the gate; --approve chains decision and atomic landing with auto current-context", async () => {
  const root = await mkdtemp(join(tmpdir(), "kdlc-gate-"));
  await new KdlcEngine({ root }).execute("init", { project_id: "gate.fixture" });
  const engine = createLocalProjectEngine({ root });
  const job = await completedIngest(engine, root, "spec.md", "# Spec\n\n## Retention\n\nBackups are kept for 35 days.\n");
  const scaffold = await engine.execute("proposal", { scaffold: { job_id: job.id, access: "internal", license: "LicenseRef-Internal" } });
  const kit = join(root, ".kdlc/drafting", scaffold.workflow_id);
  const evidence = JSON.parse(await readFile(join(kit, "normalized-evidence.json"), "utf8"));
  const template = JSON.parse(await readFile(join(kit, "recording-template.json"), "utf8"));
  const unit = evidence.units.find(({ text }) => /35 days/.test(text));
  const rights = { license: "LicenseRef-Internal", redistribution: "prohibited", derivative_use: "allowed", commercial_use: "prohibited" };
  template.model = { provider: "recorded", model: "test-model", prompt: "gate", recorded_at: template.model.recorded_at };
  template.claims = [{ id: "clm_ret", text: unit.text, source_id: evidence.source_id, source_hash: evidence.source_hash, locator: unit.locator, extraction: "explicit", status: "accepted", access: { classification: "internal" }, rights }];
  template.proposals = [{ api_version: "kdlc.dev/concept-proposal/v1alpha1", id: "pr_ret", workflow_id: scaffold.workflow_id, task: "ingest", state: "review_pending", target: { knowledge_base_id: "local.gate.fixture", revision: "rev-1", subject: "kb://local.gate.fixture/policies/retention" }, concept: { before: null, after: { frontmatter: { type: "Policy", title: "Backup retention", description: "Retention policy.", status: "stable", access: { classification: "internal" }, generated: { by: "kdlc-integrator/0.2.0", at: "2026-08-16T20:30:00Z" }, sources: [{ id: "spec", resource: "file:spec.md", source_hash: evidence.source_hash, access: { classification: "internal" }, rights }], stale_after: "2030-01-01" }, body: "# Backup retention\n\nBackups are kept for 35 days.\n" } }, claim_ids: ["clm_ret"], claim_decisions: [{ claim_id: "clm_ret", disposition: "accepted", rationale: "explicit" }], created_by: "kdlc-integrator/0.2.0" }];
  await writeFile(join(kit, "recording-template.json"), JSON.stringify(template));
  await engine.execute("proposal", { submit: { workflow_id: scaffold.workflow_id } });

  const gate = await engine.execute("publish", {});
  assert.equal(gate.pending.length, 1);
  assert.equal(gate.pending[0].proposal_id, "pr_ret");
  assert.match(gate.pending[0].next, /--approve/);

  const landed = await engine.execute("publish", { proposal_id: "pr_ret", decide: "approved", reason: "explicit and anchored" });
  assert.equal(landed.published.materialized, true, JSON.stringify(landed.published));
  assert.equal((await engine.execute("publish", {})).pending.length, 0);
  const answer = await engine.execute("query", { question: "how long are backups kept?" });
  assert.equal(answer.status, "ok");
  assert.match(answer.results[0].title, /Backup retention/);

  // Rejection path never publishes.
  const job2 = await completedIngest(engine, root, "note.md", "# N\n\n## Extra\n\nAnother fact here.\n");
  const scaffold2 = await engine.execute("proposal", { scaffold: { job_id: job2.id, access: "internal", license: "LicenseRef-Internal" } });
  const kit2 = join(root, ".kdlc/drafting", scaffold2.workflow_id);
  const evidence2 = JSON.parse(await readFile(join(kit2, "normalized-evidence.json"), "utf8"));
  const template2 = JSON.parse(await readFile(join(kit2, "recording-template.json"), "utf8"));
  const unit2 = evidence2.units.find(({ text }) => /Another fact/.test(text));
  template2.model = { provider: "recorded", model: "test-model", prompt: "gate", recorded_at: template2.model.recorded_at };
  template2.claims = [{ id: "clm_x", text: unit2.text, source_id: evidence2.source_id, source_hash: evidence2.source_hash, locator: unit2.locator, extraction: "explicit", status: "accepted", access: { classification: "internal" }, rights }];
  template2.proposals = [{ ...template.proposals[0], id: "pr_x", workflow_id: scaffold2.workflow_id, target: { knowledge_base_id: "local.gate.fixture", revision: "rev-1", subject: "kb://local.gate.fixture/notes/extra" }, claim_ids: ["clm_x"], claim_decisions: [{ claim_id: "clm_x", disposition: "accepted", rationale: "r" }] }];
  template2.proposals[0].concept = { before: null, after: { ...template.proposals[0].concept.after, frontmatter: { ...template.proposals[0].concept.after.frontmatter, title: "Extra note", sources: [{ id: "note", resource: "file:note.md", source_hash: evidence2.source_hash, access: { classification: "internal" }, rights }] } } };
  await writeFile(join(kit2, "recording-template.json"), JSON.stringify(template2));
  await engine.execute("proposal", { submit: { workflow_id: scaffold2.workflow_id } });
  const rejected = await engine.execute("publish", { proposal_id: "pr_x", decide: "rejected", reason: "not needed" });
  assert.equal(rejected.published, null);
  assert.ok(!(await readFile(join(root, "knowledge/primary/index.md"), "utf8")).includes("Extra note"));
});

test("FEAT-030: the CLI accepts the scaffold flags and refuses malformed access", async () => {
  const parsed = parseCli(["proposal", "--scaffold", "job_0123456789abcdef", "--access", "internal", "--license", "LicenseRef-Internal", "--workflow", "wf_custom1"]);
  assert.deepEqual(parsed.input.scaffold, { job_id: "job_0123456789abcdef", access: "internal", license: "LicenseRef-Internal", workflow_id: "wf_custom1" });
  const root = await mkdtemp(join(tmpdir(), "kdlc-scaffold-cli-"));
  await new KdlcEngine({ root }).execute("init", { project_id: "scaffold.cli" });
  const engine = createLocalProjectEngine({ root });
  const job = await completedIngest(engine, root, "n.md", "# N\n\nA fact.\n");
  await assert.rejects(engine.execute("proposal", { scaffold: { job_id: job.id, access: "secret", license: "L" } }), /--access <public\|internal\|restricted>/);
  await assert.rejects(engine.execute("proposal", { scaffold: { job_id: job.id, access: "internal", license: "LicenseRef-X", workflow_id: "wf-bad-hyphen" } }), /wf_<lowercase letters and digits>/);
});

test("FEAT-032: submit-from-kit runs the loop without inline evidence; unfilled kits refuse helpfully", async () => {
  const root = await mkdtemp(join(tmpdir(), "kdlc-kit-submit-"));
  await new KdlcEngine({ root }).execute("init", { project_id: "kit.submit" });
  const engine = createLocalProjectEngine({ root });
  const job = await completedIngest(engine, root, "spec.md", "# Spec\n\n## Token lifetime\n\nProduction API tokens expire after 60 minutes.\n");
  const scaffold = await engine.execute("proposal", { scaffold: { job_id: job.id, access: "internal", license: "LicenseRef-Internal" } });
  await assert.rejects(engine.execute("proposal", { submit: { workflow_id: scaffold.workflow_id } }), /empty claims or proposals — fill it/);
  await assert.rejects(engine.execute("proposal", { submit: { workflow_id: "wf_nokit" } }), /missing recording-template\.json/);

  const kit = join(root, ".kdlc/drafting", scaffold.workflow_id);
  const evidence = JSON.parse(await readFile(join(kit, "normalized-evidence.json"), "utf8"));
  const template = JSON.parse(await readFile(join(kit, "recording-template.json"), "utf8"));
  const unit = evidence.units.find(({ text }) => /expire/.test(text));
  const rights = { license: "LicenseRef-Internal", redistribution: "prohibited", derivative_use: "allowed", commercial_use: "prohibited" };
  template.model = { provider: "recorded", model: "test-model", prompt: "kit-submit", recorded_at: template.model.recorded_at };
  template.claims = [{ id: "clm_kit", text: unit.text, source_id: evidence.source_id, source_hash: evidence.source_hash, locator: unit.locator, extraction: "explicit", status: "accepted", access: { classification: "internal" }, rights }];
  template.proposals = [{ api_version: "kdlc.dev/concept-proposal/v1alpha1", id: "pr_kit", workflow_id: scaffold.workflow_id, task: "ingest", state: "review_pending", target: { knowledge_base_id: "local.kit.submit", revision: "rev-1", subject: "kb://local.kit.submit/policies/tokens" }, concept: { before: null, after: { frontmatter: { type: "Policy", title: "Tokens", description: "d", status: "stable", generated: { by: "kdlc-integrator/0.2.0", at: "2026-08-16T20:30:00Z" }, sources: [{ id: "spec", source_hash: evidence.source_hash }], stale_after: "2030-01-01" }, body: "# T\n\nx\n" } }, claim_ids: ["clm_kit"], claim_decisions: [{ claim_id: "clm_kit", disposition: "accepted", rationale: "explicit" }], created_by: "kdlc-integrator/0.2.0" }];
  await writeFile(join(kit, "recording-template.json"), JSON.stringify(template));
  const submitted = await engine.execute("proposal", { submit: { workflow_id: scaffold.workflow_id } });
  assert.match(submitted.proposals[0].packet_hash, /^sha256:[a-f0-9]{64}$/);
});

test("FEAT-032: multi-document jobs scaffold per source, never silently first-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "kdlc-multi-"));
  await new KdlcEngine({ root }).execute("init", { project_id: "multi.fixture" });
  const engine = createLocalProjectEngine({ root });
  await writeFile(join(root, "a.md"), "# A\n\nFact A.\n");
  await writeFile(join(root, "b.md"), "# B\n\nFact B.\n");
  const started = await engine.execute("ingest_start", { sources: ["a.md", "b.md"], idempotency_key: "multi-1" });
  let job = started;
  for (let attempt = 0; attempt < 100 && !["completed", "failed"].includes(job.state); attempt += 1) {
    await new Promise((r) => setTimeout(r, 50));
    job = await engine.execute("job_status", { id: started.id });
  }
  assert.equal(job.state, "completed");
  await assert.rejects(engine.execute("proposal", { scaffold: { job_id: job.id, access: "internal", license: "L" } }), /ingested 2 documents — pick one with --source <n> or scaffold every document with --all-sources/);
  const all = await engine.execute("proposal", { scaffold: { job_id: job.id, access: "internal", license: "LicenseRef-Internal", all_sources: true } });
  assert.equal(all.scaffolds.length, 2);
  assert.notEqual(all.scaffolds[0].workflow_id, all.scaffolds[1].workflow_id);
  assert.deepEqual(all.scaffolds.map(({ source }) => source), ["a.md", "b.md"]);
});

test("FEAT-032: unit slicing drafts a section whose anchors still verify; text output elides unit bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "kdlc-slice-"));
  await new KdlcEngine({ root }).execute("init", { project_id: "slice.fixture" });
  const engine = createLocalProjectEngine({ root });
  const job = await completedIngest(engine, root, "spec.md", "# Spec\n\n## One\n\nFirst fact.\n\n## Two\n\nSecond fact.\n\n## Three\n\nThird fact.\n");
  const sliced = await engine.execute("proposal", { scaffold: { job_id: job.id, access: "internal", license: "LicenseRef-Internal", units: "2-3" } });
  assert.equal(sliced.units, 2);
  assert.match(sliced.slice, /^2-3 of \d+ text units$/);
  await assert.rejects(engine.execute("proposal", { scaffold: { job_id: job.id, access: "internal", license: "L", workflow_id: "wf_slicebad", units: "9-4" } }), /--units range/);

  const { renderEnvelope } = await import("../../packages/cli/index.mjs");
  const envelope = await engine.envelope("job_status", { id: job.id });
  const text = renderEnvelope(envelope, "text");
  assert.ok(!text.includes("First fact."), "unit bodies never appear in text output");
  assert.match(text, /units elided/);
  const json = renderEnvelope(envelope, "json");
  assert.ok(json.includes("First fact."), "JSON envelope keeps full fidelity");
});

test("FEAT-033: sanitized-subject collisions refuse instead of silently destroying reviewed concepts (review HIGH)", async () => {
  const root = await mkdtemp(join(tmpdir(), "kdlc-collide-"));
  await new KdlcEngine({ root }).execute("init", { project_id: "collide.fixture" });
  const engine = createLocalProjectEngine({ root });
  const rights = { license: "LicenseRef-Internal", redistribution: "prohibited", derivative_use: "allowed", commercial_use: "prohibited" };
  const publishOne = async (tag, subject, body) => {
    const job = await completedIngest(engine, root, `${tag}.md`, `# ${tag}\n\n## Fact\n\nThe ${tag} fact is recorded here.\n`);
    const scaffold = await engine.execute("proposal", { scaffold: { job_id: job.id, access: "internal", license: "LicenseRef-Internal" } });
    const kit = join(root, ".kdlc/drafting", scaffold.workflow_id);
    const evidence = JSON.parse(await readFile(join(kit, "normalized-evidence.json"), "utf8"));
    const template = JSON.parse(await readFile(join(kit, "recording-template.json"), "utf8"));
    const unit = evidence.units.find(({ text }) => /fact is recorded/.test(text));
    template.model = { provider: "recorded", model: "t", prompt: "p", recorded_at: template.model.recorded_at };
    template.claims = [{ id: `clm_${tag}`, text: unit.text, source_id: evidence.source_id, source_hash: evidence.source_hash, locator: unit.locator, extraction: "explicit", status: "accepted", access: { classification: "internal" }, rights }];
    template.proposals = [{ api_version: "kdlc.dev/concept-proposal/v1alpha1", id: `pr_${tag}`, workflow_id: scaffold.workflow_id, task: "ingest", state: "review_pending", target: { knowledge_base_id: "local.collide", revision: "rev-1", subject }, concept: { before: null, after: { frontmatter: { type: "Policy", title: `T ${tag}`, description: "d", status: "stable", access: { classification: "internal" }, generated: { by: "kdlc-integrator/0.2.0", at: "2026-08-16T20:30:00Z" }, sources: [{ id: tag, resource: `file:${tag}.md`, source_hash: evidence.source_hash, access: { classification: "internal" }, rights }], stale_after: "2030-01-01" }, body: `# ${tag}\n\n${body}\n` } }, claim_ids: [`clm_${tag}`], claim_decisions: [{ claim_id: `clm_${tag}`, disposition: "accepted", rationale: "r" }], created_by: "kdlc-integrator/0.2.0" }];
    await writeFile(join(kit, "recording-template.json"), JSON.stringify(template));
    await engine.execute("proposal", { submit: { workflow_id: scaffold.workflow_id } });
    return engine.execute("publish", { proposal_id: `pr_${tag}`, decide: "approved", reason: "test" });
  };
  const first = await publishOne("alpha", "kb://local.collide/policies/my-topic", "First content.");
  assert.equal(first.published.materialized, true);
  const firstBytes = await readFile(join(root, first.published.concept), "utf8");
  // Distinct subject, same sanitized path — must refuse, first concept intact.
  await assert.rejects(publishOne("beta", "kb://local.collide/policies/My.Topic", "Attacker content."),
    (error) => error.code === "KDLC_STATE_CONFLICT" && /reviewed as a creation/.test(error.message));
  assert.equal(await readFile(join(root, first.published.concept), "utf8"), firstBytes, "first concept untouched");
  // Rationale sidecar persisted for the approval.
  const rationale = JSON.parse(await readFile(join(root, `.kdlc/governed/workflow/runs/${first.intent.workflow_id}/reviews/pr_alpha/rationale.json`), "utf8"));
  assert.equal(rationale.reason, "test");
  assert.match(rationale.decided_by, /^human:/);
  // Duplicate --approve gets an actionable message naming the receipt.
  await assert.rejects(engine.execute("publish", { proposal_id: "pr_alpha", decide: "approved" }),
    (error) => error.code === "KDLC_STATE_CONFLICT" && /already has a recorded decision/.test(error.message) && /kdlc publish pr_alpha rr_/.test(error.message));
});

test("FEAT-034: saved project defaults fill governance flags; absence still fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "kdlc-defaults-"));
  await new KdlcEngine({ root }).execute("init", { project_id: "defaults.fixture" });
  const engine = createLocalProjectEngine({ root });
  const job = await completedIngest(engine, root, "a.md", "# A\n\n## F\n\nFact A stands.\n");
  await assert.rejects(engine.execute("proposal", { scaffold: { job_id: job.id } }), /saved project defaults via --save-defaults/);
  const first = await engine.execute("proposal", { scaffold: { job_id: job.id, access: "internal", license: "LicenseRef-Internal", save_defaults: true } });
  assert.equal(first.defaults, undefined, "explicit flags carry no defaults note");
  const job2 = await completedIngest(engine, root, "b.md", "# B\n\n## G\n\nFact B stands.\n");
  const second = await engine.execute("proposal", { scaffold: { job_id: job2.id } });
  assert.match(second.defaults, /using saved project defaults: internal \/ LicenseRef-Internal/);
  assert.equal(second.access.classification, "internal");
});

test("FEAT-034: auto mode publishes drafts only, at the draft tier; revisit ratifies into default answers", async () => {
  const root = await mkdtemp(join(tmpdir(), "kdlc-auto-"));
  await new KdlcEngine({ root }).execute("init", { project_id: "auto.fixture" });
  const engine = createLocalProjectEngine({ root });
  const rights = { license: "LicenseRef-Internal", redistribution: "prohibited", derivative_use: "allowed", commercial_use: "prohibited" };
  const job = await completedIngest(engine, root, "spec.md", "# Spec\n\n## Quota\n\nEach tenant gets 500 requests per minute.\n");
  const scaffold = await engine.execute("proposal", { scaffold: { job_id: job.id, access: "internal", license: "LicenseRef-Internal" } });
  const kit = join(root, ".kdlc/drafting", scaffold.workflow_id);
  const evidence = JSON.parse(await readFile(join(kit, "normalized-evidence.json"), "utf8"));
  const template = JSON.parse(await readFile(join(kit, "recording-template.json"), "utf8"));
  const unit = evidence.units.find(({ text }) => /500 requests/.test(text));
  template.model = { provider: "recorded", model: "t", prompt: "auto", recorded_at: template.model.recorded_at };
  template.claims = [{ id: "clm_quota", text: unit.text, source_id: evidence.source_id, source_hash: evidence.source_hash, locator: unit.locator, extraction: "explicit", status: "accepted", access: { classification: "internal" }, rights }];
  const proposal = (status) => [{ api_version: "kdlc.dev/concept-proposal/v1alpha1", id: "pr_quota", workflow_id: scaffold.workflow_id, task: "ingest", state: "review_pending", target: { knowledge_base_id: "local.auto", revision: "rev-1", subject: "kb://local.auto/limits/tenant-quota" }, concept: { before: null, after: { frontmatter: { type: "Policy", title: "Tenant quota", description: "Rate limit policy.", status, access: { classification: "internal" }, generated: { by: "kdlc-integrator/0.2.0", at: "2026-08-16T20:30:00Z" }, sources: [{ id: "spec", resource: "file:spec.md", source_hash: evidence.source_hash, access: { classification: "internal" }, rights }], stale_after: "2030-01-01" }, body: "# Tenant quota\n\nEach tenant gets 500 requests per minute.\n" } }, claim_ids: ["clm_quota"], claim_decisions: [{ claim_id: "clm_quota", disposition: "accepted", rationale: "explicit" }], created_by: "kdlc-integrator/0.2.0" }];

  // stable + --auto refuses
  template.proposals = proposal("stable");
  await writeFile(join(kit, "recording-template.json"), JSON.stringify(template));
  await assert.rejects(engine.execute("proposal", { submit: { workflow_id: scaffold.workflow_id, auto: true } }), /--auto only publishes draft-tier/);

  // draft + --auto lands without a human pause
  template.proposals = proposal("draft");
  await writeFile(join(kit, "recording-template.json"), JSON.stringify(template));
  const submitted = await engine.execute("proposal", { submit: { workflow_id: scaffold.workflow_id, auto: true } });
  assert.equal(submitted.auto_published.length, 1);
  assert.equal(submitted.auto_published[0].published.materialized, true);

  // draft tier: default answers exclude it; exploratory sees it as unverified
  const wiki = await engine.execute("query", { question: "tenant quota" });
  assert.equal(wiki.status, "not_found", "drafts never enter default wiki answers");
  const exploratory = await engine.execute("query", { question: "tenant quota", mode: "exploratory" });
  assert.equal(exploratory.status, "ok");
  assert.equal(exploratory.results[0].trust, "unverified");

  // revisit lists it; ratification promotes through a real reviewed update
  const queue = await engine.execute("revisit", {});
  assert.equal(queue.awaiting_ratification.length, 1);
  assert.equal(queue.awaiting_ratification[0].proposal_id, "pr_quota");
  await assert.rejects(engine.execute("revisit", { proposal_id: "pr_quota" }), /requires --ratify/);
  const promoted = await engine.execute("revisit", { proposal_id: "pr_quota", reason: "verified against the spec" });
  assert.equal(promoted.published.materialized, true);
  assert.equal((await engine.execute("revisit", {})).awaiting_ratification.length, 0);
  const answer = await engine.execute("query", { question: "tenant quota" });
  assert.equal(answer.status, "ok", "ratified concept enters default answers");
  assert.match(answer.results[0].title, /Tenant quota/);
  // ratifying twice refuses
  await assert.rejects(engine.execute("revisit", { proposal_id: "pr_quota", reason: "again" }), /already ratified/);
});

test("FEAT-034: auto mode requires an explicit draft status — omission and casing cannot reach default answers (review CRITICAL)", async () => {
  const root = await mkdtemp(join(tmpdir(), "kdlc-autoguard-"));
  await new KdlcEngine({ root }).execute("init", { project_id: "autoguard.fixture" });
  const engine = createLocalProjectEngine({ root });
  const rights = { license: "LicenseRef-Internal", redistribution: "prohibited", derivative_use: "allowed", commercial_use: "prohibited" };
  const job = await completedIngest(engine, root, "s.md", "# S\n\n## F\n\nThe guarded fact stands.\n");
  const scaffold = await engine.execute("proposal", { scaffold: { job_id: job.id, access: "internal", license: "LicenseRef-Internal" } });
  const kit = join(root, ".kdlc/drafting", scaffold.workflow_id);
  const evidence = JSON.parse(await readFile(join(kit, "normalized-evidence.json"), "utf8"));
  const template = JSON.parse(await readFile(join(kit, "recording-template.json"), "utf8"));
  const unit = evidence.units.find(({ text }) => /guarded fact/.test(text));
  template.model = { provider: "recorded", model: "t", prompt: "g", recorded_at: template.model.recorded_at };
  template.claims = [{ id: "clm_g", text: unit.text, source_id: evidence.source_id, source_hash: evidence.source_hash, locator: unit.locator, extraction: "explicit", status: "accepted", access: { classification: "internal" }, rights }];
  const proposalWith = (frontmatterStatus) => {
    const frontmatter = { type: "Policy", title: "Guarded", description: "d", access: { classification: "internal" }, generated: { by: "kdlc-integrator/0.2.0", at: "2026-08-16T20:30:00Z" }, sources: [{ id: "s", resource: "file:s.md", source_hash: evidence.source_hash, access: { classification: "internal" }, rights }], stale_after: "2030-01-01" };
    if (frontmatterStatus !== undefined) frontmatter.status = frontmatterStatus;
    return [{ api_version: "kdlc.dev/concept-proposal/v1alpha1", id: "pr_g", workflow_id: scaffold.workflow_id, task: "ingest", state: "review_pending", target: { knowledge_base_id: "local.autoguard", revision: "rev-1", subject: "kb://local.autoguard/g" }, concept: { before: null, after: { frontmatter, body: "# G\n\nThe guarded fact stands.\n" } }, claim_ids: ["clm_g"], claim_decisions: [{ claim_id: "clm_g", disposition: "accepted", rationale: "r" }], created_by: "kdlc-integrator/0.2.0" }];
  };
  for (const status of [undefined, "Stable", "stable", "Draft"]) {
    template.proposals = proposalWith(status);
    await writeFile(join(kit, "recording-template.json"), JSON.stringify(template));
    await assert.rejects(engine.execute("proposal", { submit: { workflow_id: scaffold.workflow_id, auto: true } }), /explicitly declare status: "draft"/, `status=${status}`);
  }
  // Nothing reached default answers through any refused attempt.
  assert.equal((await engine.execute("query", { question: "guarded fact" })).status, "not_found");
});
