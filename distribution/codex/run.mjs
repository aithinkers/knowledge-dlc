#!/usr/bin/env node
const marker = process.argv.indexOf("--host-args-json");
if (marker !== -1) {
  let args;
  try { args = JSON.parse(process.argv[marker + 1]); } catch { throw Object.assign(new Error("Host arguments must be a JSON array"), { code: "KDLC_INPUT_INVALID" }); }
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) throw Object.assign(new Error("Host arguments must be a JSON string array"), { code: "KDLC_INPUT_INVALID" });
  process.argv.splice(marker, 2, ...args);
}
await import("../../packages/cli/bin.mjs");
