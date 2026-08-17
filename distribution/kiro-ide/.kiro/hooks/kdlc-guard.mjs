#!/usr/bin/env node
// K-DLC guard for Kiro IDE (FEAT-040): blocks direct edits to governed state
// so all changes flow through the reviewed pipeline. Exit 2 + stderr = block.
// Channel handling follows the empirically captured contract (aidlc-workflows
// docs/reference/kiro-ide-hook-payload.md): IDE 0.12 delivers camelCase
// { toolName, toolArgs } via USER_PROMPT with a stdin that never closes, so
// the read is raced against a timeout; IDE 1.x writes snake_case
// { tool_name, tool_input } to stdin and closes it. Unknown payloads fail
// open — the deterministic engine remains the real enforcement.
import { relative, resolve, sep } from "node:path";
async function readPayload() {
  const legacy = process.env.USER_PROMPT ?? "";
  if (legacy.trim().length > 0) return legacy;
  const read = (async () => {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  })();
  const timeout = new Promise((settle) => setTimeout(settle, 2000, "").unref?.());
  return Promise.race([read, timeout]);
}
let input = {};
try { input = JSON.parse(await readPayload()); } catch { process.exit(0); }
const toolInput = input.tool_input ?? input.toolArgs ?? {};
const raw = String(toolInput?.file_path ?? toolInput?.path ?? toolInput?.notebook_path ?? "");
if (!raw) process.exit(0);
const cleaned = raw.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
const path = relative(process.cwd(), resolve(process.cwd(), cleaned)).split(sep).join("/");
const judged = path.toLowerCase();
const inside = (root) => judged === root || judged.startsWith(root + "/");
if (!path.startsWith("..") && (inside("knowledge-bases") || inside("workflow"))) {
  process.stderr.write(
    `Direct edits to ${path} are not allowed: this file is governed K-DLC state, and hand edits would bypass review and break provenance. ` +
    "Use the kdlc skills instead (kdlc-proposal to change content, kdlc-review to decide, kdlc-reconcile-edits for edits that already happened outside the flow).\n",
  );
  process.exit(2);
}
process.exit(0);
