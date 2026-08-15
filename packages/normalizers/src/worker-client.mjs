import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultLimits } from "./descriptors.mjs";

const worker = fileURLToPath(new URL("../../../workers/normalizer/worker.mjs", import.meta.url));

export async function runRestrictedNormalizer(request, { timeoutMs, memoryBytes, outputBytes } = {}) {
  for (const [name, value] of Object.entries(request.limits ?? {})) if (!(name in defaultLimits) || !Number.isSafeInteger(value) || value <= 0 || value > defaultLimits[name]) throw new Error(`Normalizer limit cannot relax trusted ceiling: ${name}`);
  const limits = { ...defaultLimits, ...(request.limits ?? {}) };
  const bounded = (value, ceiling, name) => { if (value === undefined) return ceiling; if (!Number.isSafeInteger(value) || value <= 0 || value > ceiling) throw new Error(`${name} cannot relax trusted worker ceiling`); return value; };
  const timeout = bounded(timeoutMs, limits.processing_ms, "timeoutMs"); const maximumOutput = bounded(outputBytes, limits.output_bytes, "outputBytes"); const maximumMemory = bounded(memoryBytes, limits.memory_bytes, "memoryBytes");
  const directory = await mkdtemp(join(tmpdir(), "kdlc-normalizer-"));
  try {
    const child = spawn(process.execPath, [`--max-old-space-size=${Math.max(16, Math.floor(maximumMemory / 1_048_576))}`, "--disable-proto=throw", worker], { shell: false, cwd: directory, env: { KDLC_RESTRICTED_WORKER: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let exceeded = false;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; if (Buffer.byteLength(stdout) > maximumOutput) { exceeded = true; child.kill("SIGKILL"); } });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (Buffer.byteLength(stderr) > 65_536) child.kill("SIGKILL"); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout); timer.unref();
    child.stdin.end(`${JSON.stringify({ ...request, network: false, execute: false })}\n`);
    const [code, signal] = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (...result) => resolve(result)); }); clearTimeout(timer);
    if (exceeded) throw new Error("Normalizer worker output limit exceeded");
    if (signal === "SIGKILL") throw new Error("Normalizer worker time or memory limit exceeded");
    if (code !== 0) throw new Error(`Normalizer worker failed safely: ${stderr.slice(0, 200)}`);
    const response = JSON.parse(stdout.trim()); if (!response.ok) throw new Error(response.error.message); return response.result;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
