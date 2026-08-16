#!/usr/bin/env node
import {
  createLocalProjectEngine,
  KdlcEngine,
  parseCli,
  renderEnvelope,
  EXIT,
} from "./index.mjs";
// FEAT-035 (#129): bare `kdlc` (or `kdlc resume`) is the front door — a
// PURE-FILESYSTEM assessment of durable state (no engine, no job resumption,
// no writes) that says where you are and what's next.
async function assess(output) {
  const { existsSync, readdirSync, readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const root = process.cwd();
  const readJson = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
  const emit = (summary) => {
    if (output === "json") { process.stdout.write(JSON.stringify(summary) + "\n"); return; }
    process.stdout.write([summary.state, ...(summary.next ? [`  Next: ${summary.next}`] : []), ...(summary.notes ?? []).map((note) => `  Note: ${note}`)].join("\n") + "\n");
  };
  if (!existsSync(resolve(root, ".kdlc/project.json"))) {
    emit({ state: "No K-DLC project here yet.", next: "kdlc init — then kdlc ingest <files> to bring in sources. (For the guided experience: kdlc setup <claude-code|codex|kiro|kiro-ide|mcp> <dir>.)" });
    return;
  }
  if (readJson(resolve(root, ".kdlc/project.json")) === null) {
    emit({ state: "The project record exists but cannot be read.", next: "kdlc doctor — diagnose and repair safely." });
    return;
  }
  const jobsDirectory = resolve(root, ".kdlc/jobs");
  const jobs = existsSync(jobsDirectory)
    ? readdirSync(jobsDirectory).filter((name) => /^job_[a-f0-9]{16}\.json$/.test(name)).map((name) => readJson(resolve(jobsDirectory, name))).filter(Boolean)
    : [];
  const running = jobs.filter(({ state }) => ["queued", "running"].includes(state));
  const failed = jobs.filter(({ state }) => state === "failed");
  const governed = resolve(root, ".kdlc/governed");
  // A drafting kit is OPEN only while its workflow has no submitted proposals.
  const draftingRoot = resolve(root, ".kdlc/drafting");
  const openKits = (existsSync(draftingRoot) ? readdirSync(draftingRoot) : []).filter((workflowId) => {
    const proposalsDirectory = resolve(governed, "workflow/runs", workflowId, "proposals");
    return !existsSync(proposalsDirectory) || readdirSync(proposalsDirectory).length === 0;
  });
  const indexDirectory = resolve(governed, "proposal-index");
  const pending = [];
  if (existsSync(indexDirectory)) {
    for (const name of readdirSync(indexDirectory).filter((item) => /^pr[a-z0-9_]*\.json$/.test(item))) {
      const record = readJson(resolve(indexDirectory, name));
      if (!record) continue;
      if (existsSync(resolve(governed, "workflow/runs", record.workflow_id, "reviews", record.proposal_id, "decision.json"))) continue;
      const proposal = readJson(resolve(governed, "workflow/runs", record.workflow_id, "proposals", `${record.proposal_id}.json`));
      pending.push({ proposal_id: record.proposal_id, title: proposal?.concept?.after?.frontmatter?.title ?? record.proposal_id });
    }
  }
  const awaiting = [];
  const runsDirectory = resolve(governed, "workflow/runs");
  if (existsSync(runsDirectory)) {
    for (const workflowId of readdirSync(runsDirectory)) {
      const reviewsDirectory = resolve(runsDirectory, workflowId, "reviews");
      if (!existsSync(reviewsDirectory)) continue;
      for (const proposalId of readdirSync(reviewsDirectory)) {
        const rationale = readJson(resolve(reviewsDirectory, proposalId, "rationale.json"));
        if (rationale?.auto && !rationale.ratified) awaiting.push(proposalId);
      }
    }
  }
  const notes = [];
  const connectorsPath = resolve(root, ".kdlc/connectors.json");
  if (existsSync(connectorsPath)) {
    const parsed = readJson(connectorsPath);
    if (parsed === null) notes.push("the remote-connector config is unreadable — kdlc sources shows the findings.");
    else {
      try {
        const { connectorReadiness } = await import("../sources/config.mjs");
        const readiness = connectorReadiness(parsed);
        if (!readiness.valid) notes.push("the remote-connector config has problems — kdlc sources shows the findings.");
        else {
          const notReady = readiness.connectors.filter(({ ready }) => !ready);
          if (notReady.length) notes.push(`${notReady.length} remote connector${notReady.length === 1 ? " is" : "s are"} not ready — kdlc sources shows what to set.`);
        }
      } catch { notes.push("the remote-connector config could not be checked — kdlc sources shows the findings."); }
    }
  }
  const plural = (count, singular, pluralForm) => (count === 1 ? singular : pluralForm);
  let published = 0;
  const knowledgeRoot = resolve(root, "knowledge");
  if (existsSync(knowledgeRoot)) {
    for (const mount of readdirSync(knowledgeRoot)) {
      const catalog = readJson(resolve(knowledgeRoot, mount, "retrieval-catalog.json"));
      published += catalog?.concepts?.length ?? 0;
    }
  }
  const state = `Project ready. Evidence jobs: ${jobs.length} (${running.length} in flight, ${failed.length} failed). Published concepts: ${published}. Open drafting kits: ${openKits.length}. Awaiting your decision: ${pending.length}. Awaiting ratification: ${awaiting.length}.`;
  let next;
  if (running.length) next = `kdlc jobs — ${running.length} ingest ${plural(running.length, "job is", "jobs are")} still working.`;
  else if (pending.length) next = `kdlc publish — ${pending.length} review ${plural(pending.length, "packet awaits", "packets await")} your decision (${pending[0].proposal_id}: "${pending[0].title}").`;
  else if (awaiting.length) next = `kdlc revisit — ${awaiting.length} auto-published ${plural(awaiting.length, "draft awaits", "drafts await")} your ratification.`;
  else if (openKits.length) next = `a drafting kit is open (${openKits[0]}) — fill its recording template per the kit README, then kdlc proposal --submit ${openKits[0]}.`;
  else if (failed.length) next = `kdlc jobs — ${failed.length} ${plural(failed.length, "job", "jobs")} failed; inspect and re-run.`;
  else if (published > 0) next = `kdlc query "…" — ${published} ${plural(published, "concept is", "concepts are")} published and citable. Ingest more, or kdlc proposal --scaffold <job-id> to draft further from existing evidence.`;
  else if (jobs.some(({ state: jobState }) => jobState === "completed")) next = "evidence is waiting — kdlc proposal --scaffold <job-id> to start drafting (kdlc jobs lists job ids).";
  else next = 'kdlc ingest <files> to bring in sources, or kdlc query "…" to ask published knowledge.';
  emit({ state, next, ...(notes.length ? { notes } : {}) });
}
let parsed;
try {
  const argv = process.argv.slice(2);
  let assessOutput = "text";
  const bare = [...argv];
  const outputAt = bare.indexOf("--output");
  if (outputAt !== -1 && ["text", "json", "human"].includes(bare[outputAt + 1])) { assessOutput = bare[outputAt + 1] === "human" ? "text" : bare[outputAt + 1]; bare.splice(outputAt, 2); }
  if (bare.length === 0 || (bare.length === 1 && bare[0] === "resume")) {
    await assess(assessOutput);
    process.exitCode = EXIT.success;
  } else {
  parsed = parseCli(argv);
  const envelope = await createLocalProjectEngine().envelope(
    parsed.operation,
    parsed.input,
  );
  process.stdout.write(renderEnvelope(envelope, parsed.output));
  process.exitCode = envelope.ok ? EXIT.success : envelope.error.class;
  }
} catch (error) {
  const engine = new KdlcEngine();
  const envelope = await engine.envelope("cli", { error: error.message });
  envelope.error = {
    code: error.code ?? "KDLC_INPUT_INVALID",
    message: error.message,
    class: error.exitClass ?? EXIT.input,
    details: {},
  };
  const requested =
    parsed?.output ??
    (process.argv.includes("--output") &&
    process.argv[process.argv.indexOf("--output") + 1] === "json"
      ? "json"
      : "text");
  process.stderr.write(renderEnvelope(envelope, requested));
  process.exitCode = envelope.error.class;
}
