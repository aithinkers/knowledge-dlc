#!/usr/bin/env node
// K-DLC guard for Kiro IDE (FEAT-040): blocks direct edits to governed state
// so all changes flow through the reviewed pipeline. The hook is scoped to
// write tools by its .kiro.hook manifest; the payload is the 1.x stdin JSON
// { tool_name, tool_input }. Unknown payloads fail open — the deterministic
// engine remains the real enforcement. Exit 2 = block with reason.
import { relative, resolve, sep } from "node:path";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let input = {};
try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { process.exit(0); }
const raw = String(input.tool_input?.file_path ?? input.tool_input?.path ?? input.tool_input?.notebook_path ?? "");
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
