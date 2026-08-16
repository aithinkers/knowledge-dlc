import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../core/index.mjs";
import { distributionDefinition as definition } from "./definitions.mjs";
import { AGENT_DEFINITIONS, renderAgentMarkdown, renderCodexAgentMarkdown, renderCodexAgentToml, renderKiroAgentManifest, renderKiroAgentPrompt } from "../agents/definitions/index.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// In-harness surfaces exclude `setup`: it installs harness surfaces and is
// circular from inside one (FEAT-029, #116). The CLI operation is unchanged.
const surfaceCommands = definition.cli_commands.filter((command) => command !== "setup");

// Plain-language guidance rendered above each command's host binding. Written
// for the humans invoking the command — knowledge owners, analysts, reviewers
// — not for engineers; the binding line below it remains the contract.
const COMMAND_GUIDANCE = {
  init: {
    when: "You're starting a brand-new K-DLC project in this repository.",
    give: "A project name and, optionally, a scope profile.",
    get: "A governed project skeleton with its policy, state, and knowledge-base layout.",
    next: "kdlc ingest to bring in your first sources.",
  },
  setup: {
    when: "You want to install K-DLC's surface into ANOTHER tool (codex, kiro, kiro-ide, an MCP client) — from inside an already-installed harness like this one, there is nothing to set up.",
    give: "A target tool and a project directory: setup <tool> <dir>.",
    get: "That tool's commands/agents written into the project (or install instructions).",
    next: "kdlc status — or just start working; this harness is already set up.",
  },
  adopt: {
    when: "Existing documents or knowledge should be brought under K-DLC governance.",
    give: "The paths or references to adopt.",
    get: "Adoption candidates recorded for curation — nothing is published yet.",
    next: "kdlc proposal to review what adoption proposed.",
  },
  ingest: {
    when: "New source material should enter the pipeline (documents, pages, exports).",
    give: "The source location and any scoping hints.",
    get: "Normalized evidence with provenance, ready for claim extraction.",
    next: "kdlc status to watch progress; kdlc proposal when candidates appear.",
  },
  query: {
    when: "You want an answer from the knowledge base with citations you can defend.",
    give: "Your question and, optionally, a query mode.",
    get: "An answer with qualified citations, plus trust, freshness, and conflict warnings.",
    next: "kdlc conflicts if a warning points at a recorded disagreement.",
  },
  proposal: {
    when: "Evidence is ingested and you want it drafted into reviewable knowledge — or you want to submit a filled drafting kit.",
    give: "To begin: --scaffold <ingest-job-id> --access <public|internal|restricted> --license <license> (add --source <n>/--all-sources for multi-document jobs, --units a-b to slice a large document). To submit a filled kit: --submit <workflow-id>.",
    get: "A drafting kit (scaffold), or review packets with hashes (submit) — proposals only become knowledge after review.",
    next: "Fill the kit per its README, submit, then kdlc review for the decision.",
  },
  review: {
    when: "A proposal or publication request needs an accountable decision.",
    give: "The review packet reference and your decision with reasons.",
    get: "A durable review receipt bound to exactly what you reviewed.",
    next: "kdlc publish for approved content; kdlc proposal to rework rejections.",
  },
  publish: {
    when: "You want to see what's waiting on your decision, or decide it — this is the human gate.",
    give: "Nothing to list pending review packets; or <proposal-id> --approve \"reason\" (or --reject / --request-changes) to decide and land it in one step.",
    get: "On approval: the concept file, index, and retrieval catalog updated atomically — kdlc query answers with citations immediately. Refusals and rejections change nothing.",
    next: "kdlc query to see it live; kdlc status for the audit trail.",
  },
  status: {
    when: "You want to know where everything stands — runs, gates, pending work.",
    give: "Nothing, or a specific run to inspect.",
    get: "The current workflow state, what's blocked on whom, and what's next.",
    next: "Whatever it names as the next step.",
  },
  lint: {
    when: "You want the project checked for structural or policy problems.",
    give: "Nothing — it checks the whole project.",
    get: "Findings with what each one means and how to fix it; no changes are made.",
    next: "kdlc doctor for guided repair of anything it flags.",
  },
  refresh: {
    when: "Published knowledge may be stale and should be re-checked against its sources.",
    give: "The concepts or scope to refresh, or nothing for a full sweep.",
    get: "Refresh proposals for anything out of date — existing content is untouched.",
    next: "kdlc review to act on the refresh proposals.",
  },
  trace: {
    when: "You need the full history of a piece of knowledge: sources, claims, decisions.",
    give: "The concept or claim to trace.",
    get: "Its complete provenance chain, end to end.",
    next: "kdlc query to explore related knowledge.",
  },
  conflicts: {
    when: "You want to see recorded disagreements between sources.",
    give: "Nothing, or a scope to filter.",
    get: "Each open conflict with the positions, sources, and applicable scopes.",
    next: "kdlc proposal to resolve one with an accountable change.",
  },
  gaps: {
    when: "You want to know what the knowledge base should cover but doesn't.",
    give: "Nothing, or a scope to examine.",
    get: "Identified coverage gaps as reviewable findings.",
    next: "kdlc ingest to fill a gap from a new source.",
  },
  migrate: {
    when: "The project needs moving to a newer K-DLC format or profile version.",
    give: "The target version; run it before anything else after an upgrade.",
    get: "A migrated project, or a precise report of what blocks migration.",
    next: "kdlc status to confirm health on the new version.",
  },
  doctor: {
    when: "Something is off and you want diagnosis plus safe, guided repair.",
    give: "Nothing — it inspects the project itself.",
    get: "What's wrong in plain terms and which repairs it can apply safely.",
    next: "kdlc status once repairs are applied.",
  },
  "reconcile-edits": {
    when: "Files were edited outside the governed flow and must be reconciled.",
    give: "Nothing — it detects out-of-band edits itself.",
    get: "Each edit turned into reviewable work; nothing is silently accepted or lost.",
    next: "kdlc review to decide each reconciled edit.",
  },
  jobs: {
    when: "You want to see or manage long-running background work.",
    give: "Nothing to list jobs, or a job ID to inspect or cancel.",
    get: "Job states, progress, and outcomes.",
    next: "kdlc status for the wider picture.",
  },
  revisit: {
    when: "Auto mode published drafts without you — see what's awaiting your ratification, or ratify one.",
    give: "Nothing to list; or <proposal-id> --ratify \"reason\" to promote a draft to stable through a real reviewed update.",
    get: "Ratified concepts enter default query answers; unratified drafts stay at the draft trust tier (exploratory queries only).",
    next: "kdlc query to see promoted knowledge live.",
  },
  sources: {
    when: "You want to see the remote sources this project ingested — where each came from, which revision, and how it was acquired.",
    give: "Nothing — it lists the acquisition receipts.",
    get: "Each remote source's provider, revision identity, acquisition path, content hash, and access context.",
    next: "kdlc refresh to re-check published knowledge against its sources.",
  },
};

const START_SURFACE = `**When to use:** You want to work on this knowledge base and don't want to
learn the command palette — start here, or say "pick up where we left off".

**What happens:** The assistant assesses where things stand and offers the
right next step; you choose in plain language.

Follow this routine (read-only assessment first — never mutate while assessing):

1. Invoke the \`status\`, \`jobs\`, and \`sources\` operations (JSON output)
   through the governed runner.
2. Route by what they show, offering at most three next actions:
   - Project not initialized → offer to run \`init\`.
   - Jobs still running → report progress and what they will produce.
   - Evidence exists but nothing proposed → offer the drafting path: run the
     \`proposal\` operation with \`--scaffold <ingest-job-id>\` (asking the
     user for --access and --license — governance decisions), then follow the
     kit README under \`.kdlc/drafting/<workflow>/\` to draft and submit.
     Work in the foreground and report the returned packet hashes.
   - Proposals pending review → run \`publish\` bare to list them, present
     each packet and hash, and record the user's decision with
     \`publish <proposal-id> --approve|--reject|--request-changes\` — on
     approval the concept lands atomically and query answers immediately.
   - Published knowledge present → offer \`query\`, \`refresh\`, or \`gaps\`.
   - Remote connectors configured but not ready → point at the
     connector-setup agent and \`sources\` readiness.
3. Do the chosen step, then repeat the assessment and offer what's next.

Never bypass review, routing, or publication policy; approval decisions are
never inferred from conversation.
`;

function guidanceBlock(command) {
  const guide = COMMAND_GUIDANCE[command];
  if (!guide) return "";
  return `**When to use:** ${guide.when}\n\n**What you give it:** ${guide.give}\n\n**What you get back:** ${guide.get}\n\n**Usually next:** ${guide.next}\n\n`;
}

// FEAT-018 (#86): plain-language workflow guides, authored once and rendered
// into every harness tree. Written for knowledge owners, analysts, and
// reviewers; commands are named, internals are not.
const WORKFLOW_GUIDES = {
  "bringing-knowledge-in": `# Bringing knowledge in

Getting a document, wiki export, or page into the knowledge base is a
pipeline, and nothing you feed it changes published knowledge until it has
been reviewed. The normal path:

1. **kdlc ingest** — hand it the source. It is normalized into evidence with
   provenance: where it came from, which version, when.
2. The **source-analyst** turns evidence into claims, each pinned to the exact
   place in the source it came from and labeled explicit, inferred, or
   computed.
3. The **curator** decides what belongs, guided by the project purpose you
   configured. Borderline calls come back to you as questions.
4. The **integrator** reconciles new claims with what the knowledge base
   already holds — agreements merge, real disagreements stay visible as
   recorded conflicts.
5. What survives becomes a **proposal**. Check on it with **kdlc proposal**;
   nothing publishes without review.

Already-written material that should come under governance wholesale goes
through **kdlc adopt** instead. Watch any long run with **kdlc status** or
**kdlc jobs**.

## Sources that live somewhere else

Documents in Google Drive, OneDrive, SharePoint, or Confluence can be
ingested with their provenance intact. The interactive path: have your
assistant fetch the **original file bytes** (through an MCP server or a
download — never an extracted-text rendering), save them locally, and run
**kdlc ingest** with a remote descriptor (\`--remote-json\`) naming the
provider, the item's ID, its revision (Drive revision ID, OneDrive/SharePoint
eTag, Confluence version number), how it was acquired, the content hash, and
the source's access sensitivity. K-DLC verifies the hash against the actual
bytes — a transport that delivered different content than it claims is
refused — and records an acquisition receipt you can list with
**kdlc sources**. Those revision identities are what later staleness checks
compare against.
`,
  "review-and-publish": `# Reviewing and publishing

Proposals become knowledge only through an accountable decision. Two reviews
guard the door:

- The **trust-reviewer** asks: is the evidence really there, from where it
  claims, and fresh enough to act on?
- The **governance-reviewer** asks: is publishing this allowed — policy,
  privacy, rights, access level?

Run **kdlc review** with your decision and reasons. The decision binds to the
exact packet you reviewed (its review hash), so what was approved is provable
later. A comment, a chat message, or a thumbs-up is never an approval.

Once approvals are in place, **kdlc publish** makes the content visible at
its access level — and refuses, with the reason, if anything required is
missing. The audit trail is always available through **kdlc trace**.

If a review requests changes, rework the proposal with **kdlc proposal** and
resubmit; the cycle is normal, not a failure.
`,
  "asking-questions": `# Asking the knowledge base questions

**kdlc query** answers from published knowledge with citations you can
defend: which concept, which source, how fresh, how trusted. Warnings ride
along when trust or freshness is in doubt, and if a recorded conflict touches
your question, you will see both positions rather than a silent winner.

Useful follow-ups:

- **kdlc trace** — the full history behind an answer: sources, claims,
  reviews, decisions, end to end.
- **kdlc conflicts** — every open disagreement between sources, with the
  positions and the scopes where each applies.
- **kdlc gaps** — what the knowledge base should cover but doesn't yet.

You only see knowledge you are authorized to see; an answer that cites
nothing you can check is a bug, not a feature.
`,
  "keeping-it-healthy": `# Keeping published knowledge healthy

Knowledge rots quietly: sources change or vanish, links break, reviews age.
The **maintainer** watches for this and turns findings into ordinary
reviewable work — refresh, deprecate, or archive proposals — so nothing is
ever silently rewritten.

Your habits:

- **kdlc refresh** — re-check published knowledge against its sources; out-of-
  date content becomes refresh proposals for review.
- **kdlc lint** — structural and policy problems across the project, each
  finding with what it means and how to fix it.
- **kdlc status** — where everything stands: runs in flight, gates waiting on
  decisions, work parked on budget.

If files were changed outside the governed flow — a hand-edit, a bulk
search-replace — **kdlc reconcile-edits** turns each edit into reviewable
work instead of losing it or silently accepting it.
`,
  "connecting-remote-sources": `# Connecting remote sources

K-DLC can pull knowledge straight from Google Drive, OneDrive, SharePoint,
and Confluence. The **connector-setup** agent walks you through it — say
"connect our Confluence" (or Drive, or SharePoint) and answer a few
questions.

What the setup produces is a small file, \`.kdlc/connectors.json\`, that
names where knowledge comes from and **which environment variables** hold
the credentials. The credential values themselves never go in the file, in
the chat, or anywhere K-DLC stores — you set them in the environment
yourself, and the engine refuses any config that looks like it contains a
secret.

What each provider needs (read-only access only):

- **Google Drive** — a service account or OAuth client with the
  drive.readonly scope; credentials referenced by \`KDLC_GDRIVE_CREDENTIALS\`.
- **OneDrive / SharePoint** — one Microsoft Entra app registration covers
  both, with Files.Read.All and Sites.Read.All (your admin consents once);
  tenant, client ID, and secret in the \`KDLC_GRAPH_*\` variables.
- **Confluence** — an API token for an account that can read the spaces you
  want, plus your site URL; \`KDLC_CONFLUENCE_EMAIL\` and
  \`KDLC_CONFLUENCE_API_TOKEN\`.

**kdlc sources** shows each connector's readiness — which variables are set
(shown only as yes/no, never the values) and what remains to do. Once a
connector is ready, ingested items carry full provenance (which file, which
revision) and staleness checks can tell you when the original changed.
`,
  "when-something-is-wrong": `# When something looks wrong

Start with **kdlc doctor**: it inspects the project, explains problems in
plain terms, and applies only repairs that are safe. **kdlc lint** lists
findings without changing anything, if you want to look before touching.

Reading a failure message: every command reports the same way — what didn't
happen, what it means for you, and whether retrying is safe. Add
\`--output human\` to any command for the plain-language form.

Three rules that keep trouble small:

- Never hand-edit files under \`knowledge-bases/\` — the guard hook will stop
  the attempt, and **kdlc reconcile-edits** exists for edits that already
  happened.
- A failed publish or review changes nothing; the governed state is protected
  by design.
- After upgrading K-DLC, run **kdlc migrate** before anything else.
`,
};

const CLAUDE_HOOKS_MANIFEST = `${canonicalJson({
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: "node \${CLAUDE_PLUGIN_ROOT}/hooks/orient.mjs" }] }],
    PreToolUse: [{ matcher: "Write|Edit|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: "node \${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs" }] }],
  },
})}\n`;

const ORIENT_HOOK = `#!/usr/bin/env node
// K-DLC session orientation (FEAT-018). Dependency-free; prints a short
// plain-language bearing at session start and never fails the session.
import { existsSync, readdirSync } from "node:fs";
try {
  const lines = [];
  if (existsSync("knowledge-bases") || existsSync(".kdlc")) {
    lines.push("This project is governed by K-DLC.");
    try {
      const runs = readdirSync("workflow/runs").length;
      if (runs > 0) lines.push(\`Workflow runs on record: \${runs} — "kdlc status --output human" shows where they stand.\`);
    } catch { /* no runs yet */ }
    lines.push("Knowledge changes flow through proposals and review — never edit files under knowledge-bases/ directly; use the kdlc commands or agents.");
    lines.push("New here? The kdlc plugin ships plain-language guides (guides/ in the plugin directory) covering bringing knowledge in, reviewing, querying, and upkeep.");
  } else {
    lines.push("No K-DLC project detected in this directory. \\"kdlc init\\" starts one; \\"kdlc adopt\\" brings existing documents under governance.");
  }
  process.stdout.write(lines.join("\\n") + "\\n");
} catch { /* orientation is best-effort */ }
`;

const GUARD_HOOK = `#!/usr/bin/env node
// K-DLC guard (FEAT-018): blocks direct file edits to governed state so all
// changes flow through the reviewed pipeline. Exit 2 = block with reason.
import { relative, resolve, sep } from "node:path";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let input = {};
try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { process.exit(0); }
if (!["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(input.tool_name ?? "")) process.exit(0);
const raw = String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? "");
if (!raw) process.exit(0);
// Normalize before judging: backslashes, duplicate slashes, and ./.. hops
// must not smuggle a governed path past the prefix check.
const cleaned = raw.replaceAll("\\\\", "/").replace(/\\/{2,}/g, "/");
const path = relative(process.cwd(), resolve(process.cwd(), cleaned)).split(sep).join("/");
// Case-insensitive compare: on APFS/NTFS (the default desktop filesystems)
// KNOWLEDGE-BASES/x lands in knowledge-bases/. Symlink aliasing is out of
// scope — creating one needs Bash, which this matcher does not cover.
const judged = path.toLowerCase();
const inside = (root) => judged === root || judged.startsWith(root + "/");
if (!path.startsWith("..") && (inside("knowledge-bases") || inside("workflow"))) {
  process.stderr.write(
    \`Direct edits to \${path} are not allowed: this file is governed K-DLC state, and hand edits would bypass review and break provenance. \` +
    "Use the kdlc commands instead (kdlc proposal to change content, kdlc review to decide, kdlc reconcile-edits for edits that already happened outside the flow).\\n",
  );
  process.exit(2);
}
process.exit(0);
`;
const commandLines = definition.cli_commands
  .map((command) => `- /kdlc:${command} → \`kdlc ${command} --output json\``)
  .join("\n");
const adapterRunner = `#!/usr/bin/env node
const marker = process.argv.indexOf("--host-args-json");
let hostError = null;
if (marker !== -1) {
  let args;
  try { args = JSON.parse(process.argv[marker + 1]); } catch { hostError = "Host arguments must be a JSON array"; }
  if (!hostError && (!Array.isArray(args) || args.some((value) => typeof value !== "string"))) hostError = "Host arguments must be a JSON string array";
  if (!hostError) process.argv.splice(marker, 2, ...args);
}
if (hostError) {
  const { KdlcEngine, renderEnvelope, EXIT } = await import("../../packages/cli/index.mjs");
  const operation = process.argv[2] ?? "adapter";
  const envelope = await new KdlcEngine().envelope(operation, {});
  envelope.ok = false; envelope.result = null; envelope.error = { code: "KDLC_INPUT_INVALID", message: hostError, class: EXIT.input, details: {} };
  const output = process.argv.includes("--output") && process.argv[process.argv.indexOf("--output") + 1] === "json" ? "json" : "text";
  process.stderr.write(renderEnvelope(envelope, output)); process.exitCode = EXIT.input;
} else await import("../../packages/cli/bin.mjs");
`;
const generated = new Map([
  [
    "distribution/claude-code/run.mjs",
    adapterRunner,
  ],
  [
    "distribution/codex/run.mjs",
    adapterRunner,
  ],
  [
    "distribution/claude-code/.claude-plugin/plugin.json",
    // agents/ and commands/ are auto-discovered at the plugin root (the
    // documented default); the previous directory-string form was rejected
    // by current Claude Code manifest validation (FEAT-028 round 2).
    `${canonicalJson({ name: "kdlc", version: "0.2.0", description: "Governed K-DLC CLI adapter" })}\n`,
  ],
  [
    "distribution/claude-code/COMMANDS.md",
    `<!-- generated: packages/adapters/generate.mjs -->\n# K-DLC Claude Code commands\n\nAll operations invoke the same governed CLI engine. The slash-command palette\ncarries the human tier only — /kdlc:start, /kdlc:init, /kdlc:ingest,\n/kdlc:query, /kdlc:publish, /kdlc:revisit, /kdlc:status, /kdlc:doctor. The\nrows below document the FULL operation → CLI mapping; operations without a\npalette entry are invoked through the governed runner\n(distribution/claude-code/run.mjs), which is how the kdlc agents drive them.\n\n${commandLines}\n`,
  ],
  [
    "distribution/codex/SKILL.md",
    `---\nname: kdlc\ndescription: Operate a K-DLC project through its governed CLI engine.\nargument-hint: JSON string array\n---\n\n# K-DLC\n\nThe native host binding is \`$ARGUMENTS\`. Interpret it as the JSON serialization of the user argument vector and invoke [\"node\", \"distribution/codex/run.mjs\", operation, \"--output\", \"json\", \"--host-args-json\", \"$ARGUMENTS\"] directly without a shell. Do not bypass review, routing, or publication policy. Supported operations: ${definition.cli_commands.join(", ")}. When the user does not name an operation, follow the start routine: assess with status/jobs/sources, then offer the right next step.\n`,
  ],
  [
    "distribution/mcp/desktop.json",
    `${canonicalJson({ name: "kdlc", version: "0.2.0", transport: { type: "stdio", command: "node", args: ["packages/mcp/stdio.mjs"] }, requested_roots: ["project"] })}\n`,
  ],
  [
    "distribution/mcp/custom-app.json",
    `${canonicalJson({ name: "kdlc", version: "0.2.0", transport: { type: "streamable-http", endpoint: "CONFIGURE_HTTPS_ENDPOINT/mcp", authentication: "bearer-mapped-server-side" }, requires_configuration: true, tools: definition.mcp_tools })}\n`,
  ],
  [
    "distribution/conformance.json",
    `${canonicalJson({ api_version: "kdlc.dev/conformance/v1", specification_version: definition.specification, canonicalization: definition.canonicalization, modules: definition.conformance_modules, transports: definition.transports, formats: definition.format_profiles, tools: definition.mcp_tools, repository_analysis: false })}\n`,
  ],
]);
// FEAT-036 (#131): the Claude Code palette carries only the human tier —
// every other operation stays invocable through the governed runner (agents
// use it directly) and documented in COMMANDS.md. Files are named without
// the kdlc- prefix: the plugin namespace already provides it.
const claudePalette = ["init", "ingest", "query", "publish", "revisit", "status", "doctor"];
// Pinned release-corpus compatibility: the distribution test reads this exact
// legacy filename. It stays as a thin alias of /kdlc:query.
generated.set(
  "distribution/claude-code/commands/kdlc-query.md",
  `---\ndescription: Alias of /kdlc:query\nargument-hint: JSON string array\n---\n\nThis command is a legacy alias. Interpret \`$ARGUMENTS\` exactly as /kdlc:query does and invoke ["node", "distribution/claude-code/run.mjs", "query", "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Return the exact versioned envelope and do not infer success when \`ok\` is false.\n`,
);
for (const command of claudePalette)
  generated.set(
    `distribution/claude-code/commands/${command}.md`,
    `---\ndescription: ${(COMMAND_GUIDANCE[command]?.when ?? `Run the governed K-DLC ${command} operation`).replace(/\n/g, " ").slice(0, 120)}\nargument-hint: JSON string array\n---\n\n${guidanceBlock(command)}The native Claude Code binding is \`$ARGUMENTS\`. Interpret it as the JSON serialization of the user argument vector and invoke [\"node\", \"distribution/claude-code/run.mjs\", \"${command}\", \"--output\", \"json\", \"--host-args-json\", \"$ARGUMENTS\"] directly without a shell. Return the exact versioned envelope and do not infer success when \`ok\` is false.\n`,
  );
generated.set(
  "distribution/claude-code/commands/start.md",
  `---\ndescription: Start or resume K-DLC work — assesses state and offers the right next step\nargument-hint: optional goal in plain language\n---\n\n${START_SURFACE.replace("through the governed runner.", 'by invoking ["node", "distribution/claude-code/run.mjs", <operation>, "--output", "json"] directly without a shell.')}`,
);
generated.set("distribution/claude-code/hooks/hooks.json", CLAUDE_HOOKS_MANIFEST);
generated.set("distribution/claude-code/hooks/orient.mjs", ORIENT_HOOK);
generated.set("distribution/claude-code/hooks/guard.mjs", GUARD_HOOK);
for (const harness of ["claude-code", "codex", "kiro", "kiro-ide"]) {
  for (const [slug, body] of Object.entries(WORKFLOW_GUIDES))
    generated.set(`distribution/${harness}/guides/${slug}.md`, `<!-- generated: packages/adapters/generate.mjs -->\n${body}`);
}
for (const agent of AGENT_DEFINITIONS) {
  generated.set(`distribution/claude-code/agents/${agent.role}.md`, renderAgentMarkdown(agent));
  generated.set(`distribution/codex/.codex/agents/${agent.role}.md`, renderCodexAgentMarkdown(agent));
  generated.set(`distribution/codex/.codex/agents/${agent.role}.toml`, renderCodexAgentToml(agent));
}
for (const harness of ["kiro", "kiro-ide"]) {
  generated.set(`distribution/${harness}/run.mjs`, adapterRunner);
  generated.set(
    `distribution/${harness}/AGENTS.md`,
    `<!-- generated: packages/adapters/generate.mjs -->\n# K-DLC on ${harness === "kiro" ? "Kiro CLI" : "Kiro IDE"}\n\nAll operations invoke the same governed CLI engine and return its versioned\nJSON envelope. Do not bypass review, routing, or publication policy, and never\nedit canonical knowledge-base files directly. Invoke operations as\n[\"node\", \"distribution/${harness}/run.mjs\", <operation>, \"--output\", \"json\", ...args]\ndirectly without a shell. Supported operations: ${definition.cli_commands.join(", ")}. When the user does not name an operation, follow the start routine: assess with status/jobs/sources, then offer the right next step.\n`,
  );
  for (const command of surfaceCommands)
    generated.set(
      `distribution/${harness}/.kiro/skills/kdlc-${command}/SKILL.md`,
      `---\nname: kdlc-${command}\ndescription: Run the governed K-DLC ${command} operation\nuser-invocable: true\n---\n\n${guidanceBlock(command)}Interpret the user arguments as a JSON string array and invoke [\"node\", \"distribution/${harness}/run.mjs\", \"${command}\", \"--output\", \"json\", \"--host-args-json\", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when \`ok\` is false.\n`,
    );
  generated.set(
    `distribution/${harness}/.kiro/skills/kdlc-start/SKILL.md`,
    `---\nname: kdlc-start\ndescription: Start or resume K-DLC work — assesses state and offers the right next step\nuser-invocable: true\n---\n\n${START_SURFACE.replace("through the governed runner.", `by invoking ["node", "distribution/${harness}/run.mjs", <operation>, "--output", "json"] directly without a shell.`)}`,
  );
  for (const agent of AGENT_DEFINITIONS) {
    generated.set(`distribution/${harness}/.kiro/agents/${agent.role}.md`, renderKiroAgentPrompt(agent));
    generated.set(`distribution/${harness}/.kiro/agents/${agent.role}.json`, `${canonicalJson(renderKiroAgentManifest(agent, { harness }))}\n`);
  }
}
let drift = false;
for (const [relative, content] of generated) {
  const path = resolve(root, relative);
  if (process.argv.includes("--check")) {
    let actual = "";
    try {
      actual = await readFile(path, "utf8");
    } catch {}
    if (actual !== content) {
      drift = true;
      process.stderr.write(`Generated distribution drift: ${relative}\n`);
    }
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}
if (drift) process.exitCode = 1;
