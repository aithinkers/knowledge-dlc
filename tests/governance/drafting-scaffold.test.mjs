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
    concept: { before: null, after: { frontmatter: { type: "Policy", title: "API token lifetime", description: "Token lifetime policy.", status: "stable", generated: { by: "kdlc-integrator/0.2.0", at: "2026-08-16T20:30:00Z" }, sources: [{ id: "spec", source_hash: evidence.source_hash }], stale_after: "2030-01-01" }, body: "# API token lifetime\n\nProduction API tokens expire after 60 minutes.\n" } },
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
