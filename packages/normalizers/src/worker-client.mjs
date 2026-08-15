import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";

import { defaultLimits } from "./descriptors.mjs";

const worker = fileURLToPath(new URL("../../../workers/normalizer/worker.mjs", import.meta.url));
const readableRoot = fileURLToPath(new URL("../../../", import.meta.url));
const MAX_PROBABILISTIC_ITEMS = 10_000; const MAX_PROBABILISTIC_ITEM_BYTES = 1_000_000; const MAX_PROBABILISTIC_BYTES = 50_000_000; const MAX_LINE_BYTES = 40_000_000;

function exactJsonBytes(value) {
  if (value === null) return 4;
  if (typeof value === "string") {
    let bytes = 2;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) bytes += 2;
      else if (code <= 0x1f) bytes += 6;
      else if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index += 1; }
      else if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
      else bytes += 3;
    }
    return bytes;
  }
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") return Buffer.byteLength(JSON.stringify(value));
  if (Array.isArray(value)) return 2 + Math.max(0, value.length - 1) + value.reduce((total, item) => total + exactJsonBytes(item), 0);
  const entries = Object.entries(value); return 2 + Math.max(0, entries.length - 1) + entries.reduce((total, [key, item]) => total + exactJsonBytes(key) + 1 + exactJsonBytes(item), 0);
}

function snapshotPlainJson(value, seen = new Set(), depth = 0) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") throw new Error("Normalizer worker request must be JSON serializable plain data");
  if (depth > 100) throw new Error("Normalizer worker request exceeds nesting limit");
  if (seen.has(value)) throw new Error("Normalizer worker request must be acyclic JSON data");
  if (types.isProxy(value)) throw new Error("Normalizer worker request cannot contain proxies");
  const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) throw new Error("Normalizer worker request must use plain JSON objects and arrays");
  if (Array.isArray(value)) { const keys = Object.keys(value); if (value.length > 100_000 || keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw new Error("Normalizer worker request cannot contain sparse or oversized arrays"); }
  if (Object.hasOwn(value, "toJSON")) throw new Error("Normalizer worker request cannot define toJSON");
  if (Object.getOwnPropertySymbols(value).length) throw new Error("Normalizer worker request cannot contain symbol keys");
  seen.add(value); const output = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value)) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || descriptor.get || descriptor.set) throw new Error("Normalizer worker request cannot contain accessors"); output[key] = snapshotPlainJson(descriptor.value, seen, depth + 1); }
  seen.delete(value); return output;
}

export async function runRestrictedNormalizer(request, { timeoutMs, memoryBytes, outputBytes } = {}) {
  request = snapshotPlainJson(request);
  for (const [name, value] of Object.entries(request.limits ?? {})) if (!(name in defaultLimits) || !Number.isSafeInteger(value) || value <= 0 || value > defaultLimits[name]) throw new Error(`Normalizer limit cannot relax trusted ceiling: ${name}`);
  const limits = { ...defaultLimits, ...(request.limits ?? {}) };
  const bounded = (value, ceiling, name) => { if (value === undefined) return ceiling; if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) throw new Error(`${name} cannot relax trusted worker ceiling`); return value; };
  const timeout = bounded(timeoutMs, limits.processing_ms, "timeoutMs"); const maximumOutput = bounded(outputBytes, limits.output_bytes, "outputBytes"); const maximumMemory = bounded(memoryBytes, limits.memory_bytes, "memoryBytes");
  const padding = typeof request.bytes_base64 === "string" ? (request.bytes_base64.endsWith("==") ? 2 : request.bytes_base64.endsWith("=") ? 1 : 0) : 0;
  const decodedBytes = typeof request.bytes_base64 === "string" ? Math.floor(request.bytes_base64.length * 3 / 4) - padding : Infinity;
  if (decodedBytes > defaultLimits.source_bytes) throw new Error("Normalizer source exceeds trusted source_bytes ceiling");
  if (request.probabilisticUnits !== undefined && (!Array.isArray(request.probabilisticUnits) || request.probabilisticUnits.length > MAX_PROBABILISTIC_ITEMS)) throw new Error("Normalizer probabilistic unit count exceeds protocol limits");
  let probabilisticBytes = 0;
  for (const unit of request.probabilisticUnits ?? []) { const bytes = exactJsonBytes(unit); if (bytes > MAX_PROBABILISTIC_ITEM_BYTES || (probabilisticBytes += bytes) > MAX_PROBABILISTIC_BYTES) throw new Error("Normalizer probabilistic payload exceeds serialized size limit"); }
  const wireRequest = { ...request, network: false, execute: false }; const wireBytes = exactJsonBytes(wireRequest) + 1;
  if (wireBytes > MAX_LINE_BYTES) throw new Error("Normalizer worker request line exceeds protocol limit");
  let payload; try { payload = `${JSON.stringify(wireRequest)}\n`; } catch { throw new Error("Normalizer worker request must be JSON serializable"); }
  if (Buffer.byteLength(payload) !== wireBytes) throw new Error("Normalizer worker request wire sizing failed closed");
  const directory = await mkdtemp(join(tmpdir(), "kdlc-normalizer-"));
  try {
    const child = spawn(process.execPath, ["--permission", "--allow-worker", "--allow-addons", `--allow-fs-read=${readableRoot}`, `--max-old-space-size=${Math.max(16, Math.floor(maximumMemory / 1_048_576))}`, "--disable-proto=throw", worker], { shell: false, cwd: directory, env: { KDLC_RESTRICTED_WORKER: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let exceeded = false;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; if (Buffer.byteLength(stdout) > maximumOutput) { exceeded = true; child.kill("SIGKILL"); } });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (Buffer.byteLength(stderr) > 65_536) child.kill("SIGKILL"); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout); timer.unref(); let stdinError;
    const completion = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (...result) => resolve(result)); child.stdin.on("error", (error) => { stdinError = error; child.kill("SIGKILL"); }); });
    child.stdin.end(payload);
    const [code, signal] = await completion; clearTimeout(timer);
    if (stdinError) throw new Error(`Normalizer worker input failed safely: ${stdinError.code ?? stdinError.message}`);
    if (exceeded) throw new Error("Normalizer worker output limit exceeded");
    if (signal === "SIGKILL") throw new Error("Normalizer worker time or memory limit exceeded");
    if (code !== 0) throw new Error(`Normalizer worker failed safely: ${stderr.slice(0, 200)}`);
    const response = JSON.parse(stdout.trim()); if (!response.ok) throw new Error(response.error.message); return response.result;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
