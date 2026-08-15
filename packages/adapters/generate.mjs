import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../core/index.mjs";
import { distributionDefinition as definition } from "./definitions.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const commandLines = definition.cli_commands
  .map((command) => `- /kdlc:${command} → \`kdlc ${command} --output json\``)
  .join("\n");
const generated = new Map([
  [
    "distribution/claude-code/run.mjs",
    `#!/usr/bin/env node\nawait import("../../packages/cli/bin.mjs");\n`,
  ],
  [
    "distribution/codex/run.mjs",
    `#!/usr/bin/env node\nawait import("../../packages/cli/bin.mjs");\n`,
  ],
  [
    "distribution/claude-code/.claude-plugin/plugin.json",
    `${canonicalJson({ name: "kdlc", version: "0.2.0", description: "Governed K-DLC CLI adapter", commands: "./commands" })}\n`,
  ],
  [
    "distribution/claude-code/COMMANDS.md",
    `<!-- generated: packages/adapters/generate.mjs -->\n# K-DLC Claude Code commands\n\nAll commands invoke the same governed CLI engine.\n\n${commandLines}\n`,
  ],
  [
    "distribution/codex/SKILL.md",
    `---\nname: kdlc\ndescription: Operate a K-DLC project through its governed CLI engine.\n---\n\n# K-DLC\n\nUse \`kdlc <operation> --output json\`. Do not bypass review, routing, or publication policy. Supported operations: ${definition.cli_commands.join(", ")}.\n`,
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
    `---\ndescription: Run the governed K-DLC ${command} operation\n---\n\nExecute \`kdlc ${command} --output json\` and return its exact versioned envelope. Do not infer success when \`ok\` is false.\n`,
  );
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
