#!/usr/bin/env node
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
