#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, opendir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { promisify } from "node:util";

import { releaseMatrixCells, releaseMatrixDifferences } from "./release-matrix-definition.mjs";

const execute = promisify(execFile); const [cellFlag, cell, outputFlag, output] = process.argv.slice(2);
if (cellFlag !== "--cell" || !cell || outputFlag !== "--output" || !output) throw new Error("usage: node scripts/run-release-matrix-cell.mjs --cell <cell> --output <result.json>");
const declared = releaseMatrixCells.find((item) => item.cell === cell); if (!declared) throw new Error("undeclared release matrix cell");
const nodeVersion = process.versions.node; const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmOptions = process.platform === "win32" ? { shell: true } : {};
const { stdout: npmVersionOutput } = await execute(npmCommand, ["--version"], npmOptions); const npmVersion = npmVersionOutput.trim();
if (process.platform !== declared.os || nodeVersion !== declared.node || npmVersion !== "11.5.1") throw new Error(`runtime mismatch for ${cell}: ${process.platform}/${nodeVersion}/npm-${npmVersion}`);
const root = process.cwd(); const temporary = await mkdtemp(resolve(tmpdir(), "kdlc-matrix-")); const commands = [];
async function makeRemovable(path) {
  let metadata; try { metadata = await lstat(path); } catch { return; }
  if (metadata.isDirectory()) { await chmod(path, 0o700); const directory = await opendir(path); for await (const entry of directory) await makeRemovable(resolve(path, entry.name)); }
  else if (!metadata.isSymbolicLink()) await chmod(path, 0o600);
}
const run = async (id, command, args, options = {}) => {
  await new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...(process.platform === "win32" && command === npmCommand ? { shell: true } : {}), ...options });
    child.once("error", reject); child.once("exit", (code, signal) => code === 0 ? accept() : reject(new Error(`${id} failed with ${signal ?? `exit ${code}`}`)));
  });
  commands.push({ id, status: "passed" });
};
try {
  await run("full", npmCommand, ["test"]);
  await run("offline", npmCommand, ["run", "test:release-evaluation"]);
  await run("release", npmCommand, ["run", "check:release-evidence"]);
  await run("statistical", npmCommand, ["run", "check:statistical-evidence"]);
  await run("clean-rebuild", process.execPath, ["--test", "--test-name-pattern", "^REL-001 clean rebuild removes caches and indexes then reproduces retrieval records and bytes$", "tests/governance/release-evidence.test.mjs"]);
  const { stdout } = await execute(npmCommand, ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], { cwd: root, maxBuffer: 16 * 1024 * 1024, ...npmOptions });
  const pack = JSON.parse(stdout); if (!Array.isArray(pack) || pack.length !== 1 || !pack[0].filename) throw new Error("npm pack did not return one artifact"); commands.push({ id: "pack", status: "passed" });
  const consumer = resolve(temporary, "consumer"); await import("node:fs/promises").then(({ mkdir }) => mkdir(consumer)); await writeFile(resolve(consumer, "package.json"), '{"name":"kdlc-release-smoke","private":true,"type":"module"}\n');
  await execute(npmCommand, ["install", "--ignore-scripts", "--no-audit", "--no-fund", resolve(temporary, pack[0].filename)], { cwd: consumer, maxBuffer: 32 * 1024 * 1024, ...npmOptions });
  const bin = resolve(consumer, "node_modules", "knowledge-dlc", "packages", "cli", "bin.mjs");
  await execute(process.execPath, [bin, "init", "--output", "json"], { cwd: consumer, maxBuffer: 16 * 1024 * 1024 });
  await execute(process.execPath, [bin, "doctor", "--output", "json"], { cwd: consumer, maxBuffer: 16 * 1024 * 1024 }); commands.push({ id: "cli", status: "passed" });
  await execute(process.execPath, ["--input-type=module", "--eval", "await import('knowledge-dlc/cli'); await import('knowledge-dlc/adapters');"], { cwd: consumer, env: { ...process.env, NODE_PATH: resolve(consumer, "node_modules").split(delimiter).join(delimiter) } }); commands.push({ id: "import", status: "passed" });
  const result = { api_version: "kdlc.dev/release-matrix-result/v1alpha1", cell, runtime: { node: nodeVersion, npm: npmVersion }, platform: { os: process.platform, arch: process.arch }, commands, differences: releaseMatrixDifferences(process.platform) };
  await writeFile(resolve(output), `${JSON.stringify(result, null, 2)}\n`);
} finally { await makeRemovable(temporary); await rm(temporary, { recursive: true, force: true }); }
