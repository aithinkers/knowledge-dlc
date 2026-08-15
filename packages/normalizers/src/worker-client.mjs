import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultLimits } from "./descriptors.mjs";

const worker = fileURLToPath(new URL("../../../workers/normalizer/worker.mjs", import.meta.url));
const readableRoot = fileURLToPath(new URL("../../../", import.meta.url));
const MAX_PROBABILISTIC_ITEMS = 10_000; const MAX_PROBABILISTIC_ITEM_BYTES = 1_000_000; const MAX_PROBABILISTIC_BYTES = 50_000_000;

function boundedJsonSize(value, maximum) {
  const seen = new Set(); let size = 0; let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 100_000 || depth > 100) throw new Error("Normalizer probabilistic item exceeds structural limits");
    if (item === null || typeof item === "boolean" || typeof item === "number") { size += 16; return; }
    if (typeof item === "string") { size += Buffer.byteLength(item) + 2; return; }
    if (typeof item === "undefined" || typeof item === "function" || typeof item === "symbol") return;
    if (typeof item !== "object" || seen.has(item)) throw new Error("Normalizer probabilistic item must be acyclic JSON data");
    seen.add(item); size += 2;
    for (const [key, nested] of Object.entries(item)) { size += Buffer.byteLength(key) + 3; visit(nested, depth + 1); if (size > maximum) throw new Error("Normalizer probabilistic item exceeds serialized size limit"); }
    seen.delete(item);
  };
  visit(value, 0); return size;
}

export async function runRestrictedNormalizer(request, { timeoutMs, memoryBytes, outputBytes } = {}) {
  for (const [name, value] of Object.entries(request.limits ?? {})) if (!(name in defaultLimits) || !Number.isSafeInteger(value) || value <= 0 || value > defaultLimits[name]) throw new Error(`Normalizer limit cannot relax trusted ceiling: ${name}`);
  const limits = { ...defaultLimits, ...(request.limits ?? {}) };
  const bounded = (value, ceiling, name) => { if (value === undefined) return ceiling; if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) throw new Error(`${name} cannot relax trusted worker ceiling`); return value; };
  const timeout = bounded(timeoutMs, limits.processing_ms, "timeoutMs"); const maximumOutput = bounded(outputBytes, limits.output_bytes, "outputBytes"); const maximumMemory = bounded(memoryBytes, limits.memory_bytes, "memoryBytes");
  const padding = typeof request.bytes_base64 === "string" ? (request.bytes_base64.endsWith("==") ? 2 : request.bytes_base64.endsWith("=") ? 1 : 0) : 0;
  const decodedBytes = typeof request.bytes_base64 === "string" ? Math.floor(request.bytes_base64.length * 3 / 4) - padding : Infinity;
  if (decodedBytes > defaultLimits.source_bytes) throw new Error("Normalizer source exceeds trusted source_bytes ceiling");
  if (request.probabilisticUnits !== undefined && (!Array.isArray(request.probabilisticUnits) || request.probabilisticUnits.length > MAX_PROBABILISTIC_ITEMS)) throw new Error("Normalizer probabilistic unit count exceeds protocol limits");
  let probabilisticBytes = 0;
  for (const unit of request.probabilisticUnits ?? []) { boundedJsonSize(unit, MAX_PROBABILISTIC_ITEM_BYTES); const serialized = JSON.stringify(unit); const bytes = Buffer.byteLength(serialized); if (bytes > MAX_PROBABILISTIC_ITEM_BYTES || (probabilisticBytes += bytes) > MAX_PROBABILISTIC_BYTES) throw new Error("Normalizer probabilistic payload exceeds serialized size limit"); }
  let payload; try { payload = `${JSON.stringify({ ...request, network: false, execute: false })}\n`; } catch { throw new Error("Normalizer worker request must be JSON serializable"); }
  const directory = await mkdtemp(join(tmpdir(), "kdlc-normalizer-"));
  try {
    const child = spawn(process.execPath, ["--permission", "--allow-worker", "--allow-addons", `--allow-fs-read=${readableRoot}`, `--max-old-space-size=${Math.max(16, Math.floor(maximumMemory / 1_048_576))}`, "--disable-proto=throw", worker], { shell: false, cwd: directory, env: { KDLC_RESTRICTED_WORKER: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let exceeded = false;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; if (Buffer.byteLength(stdout) > maximumOutput) { exceeded = true; child.kill("SIGKILL"); } });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (Buffer.byteLength(stderr) > 65_536) child.kill("SIGKILL"); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout); timer.unref();
    child.stdin.end(payload);
    const [code, signal] = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (...result) => resolve(result)); }); clearTimeout(timer);
    if (exceeded) throw new Error("Normalizer worker output limit exceeded");
    if (signal === "SIGKILL") throw new Error("Normalizer worker time or memory limit exceeded");
    if (code !== 0) throw new Error(`Normalizer worker failed safely: ${stderr.slice(0, 200)}`);
    const response = JSON.parse(stdout.trim()); if (!response.ok) throw new Error(response.error.message); return response.result;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
