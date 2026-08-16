#!/usr/bin/env node
import {
  createLocalProjectEngine,
  KdlcEngine,
  parseCli,
  renderEnvelope,
  EXIT,
} from "./index.mjs";
// FEAT-035 (#129): bare `kdlc` (or `kdlc resume`) is the front door — assess
// durable state and say where you are and what's next, instead of a usage
// error. Read-only; the JSON operation surface is untouched.
async function assess() {
  const { existsSync, readdirSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const root = process.cwd();
  const lines = [];
  if (!existsSync(resolve(root, ".kdlc/project.json"))) {
    process.stdout.write("No K-DLC project here yet.\n  Next: kdlc init — then kdlc ingest <files> to bring in sources.\n  (For the guided experience, add K-DLC to your AI tool: kdlc setup <claude-code|codex|kiro|kiro-ide|mcp> <dir>.)\n");
    return;
  }
  const engine = createLocalProjectEngine({ root });
  const jobs = await engine.execute("jobs", {}).catch(() => ({ jobs: [] }));
  const running = jobs.jobs.filter(({ state }) => ["queued", "running"].includes(state));
  const failed = jobs.jobs.filter(({ state }) => state === "failed");
  const draftingRoot = resolve(root, ".kdlc/drafting");
  const kits = existsSync(draftingRoot) ? readdirSync(draftingRoot) : [];
  const gate = await engine.execute("publish", {}).catch(() => ({ pending: [] }));
  const queue = await engine.execute("revisit", {}).catch(() => ({ awaiting_ratification: [] }));
  const sources = await engine.execute("sources", {}).catch(() => ({ sources: [] }));
  lines.push(`Project ready. Evidence jobs: ${jobs.jobs.length} (${running.length} in flight, ${failed.length} failed). Drafting kits: ${kits.length}. Awaiting your decision: ${gate.pending?.length ?? 0}. Awaiting ratification: ${queue.awaiting_ratification?.length ?? 0}.`);
  if (running.length) lines.push(`  Next: kdlc jobs — ${running.length} ingest job${running.length === 1 ? " is" : "s are"} still working.`);
  else if (gate.pending?.length) lines.push(`  Next: kdlc publish — ${gate.pending.length} review packet${gate.pending.length === 1 ? "" : "s"} await${gate.pending.length === 1 ? "s" : ""} your decision (${gate.pending[0].proposal_id}: "${gate.pending[0].title}").`);
  else if (queue.awaiting_ratification?.length) lines.push(`  Next: kdlc revisit — ${queue.awaiting_ratification.length} auto-published draft${queue.awaiting_ratification.length === 1 ? "" : "s"} await your ratification.`);
  else if (kits.length) lines.push(`  Next: a drafting kit is open (${kits[0]}) — fill its recording template per the kit README, then kdlc proposal --submit ${kits[0]}.`);
  else if (jobs.jobs.length && jobs.jobs.some(({ state }) => state === "completed")) lines.push("  Next: evidence is waiting — kdlc proposal --scaffold <job-id> to start drafting (kdlc jobs lists job ids).");
  else lines.push("  Next: kdlc ingest <files> to bring in sources, or kdlc query \"…\" to ask published knowledge.");
  const notReady = (sources.connectors?.connectors ?? []).filter(({ ready }) => !ready);
  if (notReady.length) lines.push(`  Note: ${notReady.length} remote connector${notReady.length === 1 ? " is" : "s are"} not ready — kdlc sources shows what to set.`);
  process.stdout.write(lines.join("\n") + "\n");
}
let parsed;
try {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "resume")) {
    await assess();
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
