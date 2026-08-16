import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../core/index.mjs";
import { distributionDefinition as definition } from "./definitions.mjs";
import { AGENT_DEFINITIONS, renderAgentMarkdown, renderCodexAgentMarkdown, renderCodexAgentToml, renderKiroAgentManifest, renderKiroAgentPrompt } from "../agents/definitions/index.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Plain-language guidance rendered above each command's host binding. Written
// for the humans invoking the command — knowledge owners, analysts, reviewers
// — not for engineers; the binding line below it remains the contract.
const COMMAND_GUIDANCE = {
  init: {
    when: "You're starting a brand-new K-DLC project in this repository.",
    give: "A project name and, optionally, a scope profile.",
    get: "A governed project skeleton with its policy, state, and knowledge-base layout.",
    next: "kdlc setup to configure it, then kdlc ingest to bring in your first sources.",
  },
  setup: {
    when: "A project exists and you need to configure profiles, policies, or mounts.",
    give: "The settings you want changed; everything else keeps its current value.",
    get: "An updated, validated project configuration.",
    next: "kdlc status to confirm the project is healthy.",
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
    when: "You want to see, create, or update proposed knowledge changes awaiting review.",
    give: "A proposal action and its details, or nothing to list what's pending.",
    get: "The proposal record — proposals only become knowledge after review.",
    next: "kdlc review when a proposal is ready for a decision.",
  },
  review: {
    when: "A proposal or publication request needs an accountable decision.",
    give: "The review packet reference and your decision with reasons.",
    get: "A durable review receipt bound to exactly what you reviewed.",
    next: "kdlc publish for approved content; kdlc proposal to rework rejections.",
  },
  publish: {
    when: "Approved knowledge should become visible at its access level.",
    give: "The approved item to publish.",
    get: "Published, versioned knowledge — refused if approvals are missing.",
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
};

function guidanceBlock(command) {
  const guide = COMMAND_GUIDANCE[command];
  if (!guide) return "";
  return `**When to use:** ${guide.when}\n\n**What you give it:** ${guide.give}\n\n**What you get back:** ${guide.get}\n\n**Usually next:** ${guide.next}\n\n`;
}
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
    `${canonicalJson({ agents: "./agents", name: "kdlc", version: "0.2.0", description: "Governed K-DLC CLI adapter", commands: "./commands" })}\n`,
  ],
  [
    "distribution/claude-code/COMMANDS.md",
    `<!-- generated: packages/adapters/generate.mjs -->\n# K-DLC Claude Code commands\n\nAll commands invoke the same governed CLI engine.\n\n${commandLines}\n`,
  ],
  [
    "distribution/codex/SKILL.md",
    `---\nname: kdlc\ndescription: Operate a K-DLC project through its governed CLI engine.\nargument-hint: JSON string array\n---\n\n# K-DLC\n\nThe native host binding is \`$ARGUMENTS\`. Interpret it as the JSON serialization of the user argument vector and invoke [\"node\", \"distribution/codex/run.mjs\", operation, \"--output\", \"json\", \"--host-args-json\", \"$ARGUMENTS\"] directly without a shell. Do not bypass review, routing, or publication policy. Supported operations: ${definition.cli_commands.join(", ")}.\n`,
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
for (const command of definition.cli_commands)
  generated.set(
    `distribution/claude-code/commands/kdlc-${command}.md`,
    `---\ndescription: Run the governed K-DLC ${command} operation\nargument-hint: JSON string array\n---\n\n${guidanceBlock(command)}The native Claude Code binding is \`$ARGUMENTS\`. Interpret it as the JSON serialization of the user argument vector and invoke [\"node\", \"distribution/claude-code/run.mjs\", \"${command}\", \"--output\", \"json\", \"--host-args-json\", \"$ARGUMENTS\"] directly without a shell. Return the exact versioned envelope and do not infer success when \`ok\` is false.\n`,
  );
for (const agent of AGENT_DEFINITIONS) {
  generated.set(`distribution/claude-code/agents/${agent.role}.md`, renderAgentMarkdown(agent));
  generated.set(`distribution/codex/.codex/agents/${agent.role}.md`, renderCodexAgentMarkdown(agent));
  generated.set(`distribution/codex/.codex/agents/${agent.role}.toml`, renderCodexAgentToml(agent));
}
for (const harness of ["kiro", "kiro-ide"]) {
  generated.set(`distribution/${harness}/run.mjs`, adapterRunner);
  generated.set(
    `distribution/${harness}/AGENTS.md`,
    `<!-- generated: packages/adapters/generate.mjs -->\n# K-DLC on ${harness === "kiro" ? "Kiro CLI" : "Kiro IDE"}\n\nAll operations invoke the same governed CLI engine and return its versioned\nJSON envelope. Do not bypass review, routing, or publication policy, and never\nedit canonical knowledge-base files directly. Invoke operations as\n[\"node\", \"distribution/${harness}/run.mjs\", <operation>, \"--output\", \"json\", ...args]\ndirectly without a shell. Supported operations: ${definition.cli_commands.join(", ")}.\n`,
  );
  for (const command of definition.cli_commands)
    generated.set(
      `distribution/${harness}/.kiro/skills/kdlc-${command}/SKILL.md`,
      `---\nname: kdlc-${command}\ndescription: Run the governed K-DLC ${command} operation\nuser-invocable: true\n---\n\n${guidanceBlock(command)}Interpret the user arguments as a JSON string array and invoke [\"node\", \"distribution/${harness}/run.mjs\", \"${command}\", \"--output\", \"json\", \"--host-args-json\", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when \`ok\` is false.\n`,
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
