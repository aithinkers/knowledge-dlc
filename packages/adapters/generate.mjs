import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../core/index.mjs";
import { distributionDefinition as definition } from "./definitions.mjs";
import { AGENT_DEFINITIONS, renderAgentMarkdown } from "../agents/definitions/index.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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
    `---\ndescription: Run the governed K-DLC ${command} operation\nargument-hint: JSON string array\n---\n\nThe native Claude Code binding is \`$ARGUMENTS\`. Interpret it as the JSON serialization of the user argument vector and invoke [\"node\", \"distribution/claude-code/run.mjs\", \"${command}\", \"--output\", \"json\", \"--host-args-json\", \"$ARGUMENTS\"] directly without a shell. Return the exact versioned envelope and do not infer success when \`ok\` is false.\n`,
  );
for (const agent of AGENT_DEFINITIONS)
  generated.set(`distribution/claude-code/agents/${agent.role}.md`, renderAgentMarkdown(agent));
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
