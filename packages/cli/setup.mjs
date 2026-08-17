// FEAT-016 (#82): materialize a harness surface into a user project with
// runner paths resolved from this installed package or checkout, so the
// installed files work from any directory (no run-from-checkout constraint).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_DEFINITIONS, renderCodexAgentMarkdown, renderCodexAgentToml, renderKiroAgentManifest, renderKiroAgentPrompt } from "../agents/definitions/index.mjs";
import { canonicalJson } from "../core/index.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const SETUP_TOOLS = Object.freeze(["claude-code", "codex", "kiro", "kiro-ide", "mcp"]);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

async function kiroSurface(harness, commands) {
  const runner = resolve(packageRoot, `distribution/${harness}/run.mjs`);
  const files = new Map();
  for (const command of commands) {
    files.set(
      `.kiro/skills/kdlc-${command}/SKILL.md`,
      `---\nname: kdlc-${command}\ndescription: Run the governed K-DLC ${command} operation\nuser-invocable: true\n---\n\nInterpret the user arguments as a JSON string array and invoke ["node", ${JSON.stringify(runner)}, "${command}", "--output", "json", "--host-args-json", <arguments-json>] directly without a shell. Return the exact versioned envelope and do not infer success when \`ok\` is false.\n`,
    );
  }
  for (const agent of AGENT_DEFINITIONS) {
    const manifest = renderKiroAgentManifest(agent, { harness });
    if (manifest.toolsSettings) manifest.toolsSettings.execute_bash.allowedCommands = [`node ${escapeRegex(runner)} [a-z-]+( [A-Za-z0-9@=_"\\[\\],{}:. /-]*)?`];
    // Installed projects keep the K-DLC context under .kiro/kdlc/ so setup
    // never collides with the project's own root files (FEAT-040).
    manifest.resources = [`file://.kiro/agents/${agent.role}.md`, "file://.kiro/kdlc/AGENTS.md", "file://.kiro/kdlc/guides/*.md"];
    files.set(`.kiro/agents/${agent.role}.json`, `${canonicalJson(manifest)}\n`);
    files.set(`.kiro/agents/${agent.role}.md`, renderKiroAgentPrompt(agent));
  }
  const distribution = resolve(packageRoot, `distribution/${harness}`);
  // Copied prose references the checkout-relative runner; installed projects
  // must name the absolute one or the docs contradict the permission gate.
  const rebind = (text) => text.replaceAll(`distribution/${harness}/run.mjs`, runner);
  files.set(".kiro/kdlc/AGENTS.md", rebind(await readFile(resolve(distribution, "AGENTS.md"), "utf8")));
  for (const guide of ["asking-questions", "bringing-knowledge-in", "connecting-remote-sources", "keeping-it-healthy", "review-and-publish", "when-something-is-wrong"]) {
    files.set(`.kiro/kdlc/guides/${guide}.md`, rebind(await readFile(resolve(distribution, `guides/${guide}.md`), "utf8")));
  }
  // The FEAT-035 front-door skill is generated outside CLI_COMMANDS — install
  // it explicitly, rebound like every other skill.
  files.set(".kiro/skills/kdlc-start/SKILL.md", rebind(await readFile(resolve(distribution, ".kiro/skills/kdlc-start/SKILL.md"), "utf8")));
  files.set(".kiro/skills/kdlc-auto/SKILL.md", rebind(await readFile(resolve(distribution, ".kiro/skills/kdlc-auto/SKILL.md"), "utf8")));
  const instructions = [`Kiro skills invoke the governed runner at ${runner}; keep this package installed at that path (reinstall/upgrade re-runs setup).`];
  if (harness === "kiro-ide") {
    // The protective parity tier (FEAT-040): dual-registered hooks and the
    // kdlc front-door agent, with runner paths resolved to this package.
    for (const name of ["kdlc-orient.mjs", "kdlc-guard.mjs", "kdlc-orient.kiro.hook", "kdlc-guard.kiro.hook", "kdlc-orient.json", "kdlc-guard.json"]) {
      files.set(`.kiro/hooks/${name}`, await readFile(resolve(distribution, `.kiro/hooks/${name}`), "utf8"));
    }
    const door = JSON.parse(await readFile(resolve(distribution, ".kiro/agents/kdlc.json"), "utf8"));
    door.toolsSettings.execute_bash.allowedCommands = [`node ${escapeRegex(runner)} [a-z-]+( [A-Za-z0-9@=_"\\[\\],{}:. /-]*)?`];
    door.resources = ["file://.kiro/kdlc/AGENTS.md", "file://.kiro/kdlc/guides/*.md"];
    files.set(".kiro/agents/kdlc.json", `${canonicalJson(door)}\n`);
    files.set(".kiro/agents/kdlc.md", rebind(await readFile(resolve(distribution, ".kiro/agents/kdlc.md"), "utf8")));
    instructions.push("Kiro IDE hooks installed (dual-registered for 0.12 and 1.x): session orientation and a guard blocking direct edits to governed knowledge state.");
  }
  return { files, instructions };
}

function codexSurface(commands) {
  const runner = resolve(packageRoot, "distribution/codex/run.mjs");
  const files = new Map();
  files.set(
    ".codex/kdlc/SKILL.md",
    `---\nname: kdlc\ndescription: Operate a K-DLC project through its governed CLI engine.\nargument-hint: JSON string array\n---\n\n# K-DLC\n\nThe native host binding is \`$ARGUMENTS\`. Interpret it as the JSON serialization of the user argument vector and invoke ["node", ${JSON.stringify(runner)}, operation, "--output", "json", "--host-args-json", "$ARGUMENTS"] directly without a shell. Do not bypass review, routing, or publication policy. Supported operations: ${commands.join(", ")}.\n`,
  );
  for (const agent of AGENT_DEFINITIONS) {
    files.set(`.codex/agents/${agent.role}.md`, renderCodexAgentMarkdown(agent));
    files.set(`.codex/agents/${agent.role}.toml`, renderCodexAgentToml(agent));
  }
  return { files, instructions: [`Codex skill invokes the governed runner at ${runner}.`] };
}

function mcpSurface() {
  const stdio = resolve(packageRoot, "packages/mcp/stdio.mjs");
  const config = { name: "kdlc", version: "0.2.0", transport: { type: "stdio", command: "node", args: [stdio] }, requested_roots: ["project"] };
  return {
    files: new Map([["kdlc.mcp.json", `${canonicalJson(config)}\n`]]),
    instructions: [`Register the stdio server from kdlc.mcp.json in your MCP client (command: node ${stdio}).`],
  };
}

export async function runSetup({ tool, project }) {
  if (typeof tool !== "string" || tool.length === 0) throw new Error("setup requires --tool <claude-code|codex|kiro|kiro-ide|mcp>[,...]");
  if (typeof project !== "string" || project.length === 0) throw new Error("setup requires --project <directory>");
  const tools = tool.split(",").map((value) => value.trim()).filter(Boolean);
  for (const requested of tools) if (!SETUP_TOOLS.includes(requested)) throw new Error(`Unknown setup tool: ${requested}`);
  const { CLI_COMMANDS } = await import("./index.mjs");
  const commands = CLI_COMMANDS.filter((command) => command !== "setup");
  const target = resolve(project);
  const written = [];
  const instructions = [];
  for (const requested of tools) {
    if (requested === "claude-code") {
      instructions.push(`Install the Claude Code plugin (two steps — Claude Code installs plugins from marketplaces, not bare paths): claude plugin marketplace add ${packageRoot} && claude plugin install kdlc@kdlc`);
      instructions.push("The plugin includes session hooks: an orientation note at session start and a guard that blocks direct edits to governed knowledge-bases/ and workflow/ files (use kdlc proposal / kdlc reconcile-edits instead). Plain-language workflow guides are in its guides/ directory.");
      continue;
    }
    const surface = requested === "codex" ? codexSurface(commands) : requested === "mcp" ? mcpSurface() : await kiroSurface(requested, commands);
    for (const [relative, content] of surface.files) {
      const path = resolve(target, relative);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
      written.push(relative);
    }
    instructions.push(...surface.instructions);
  }
  return { tools, project: target, files: written.sort(), instructions };
}
