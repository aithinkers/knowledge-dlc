#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, opendir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { promisify } from "node:util";

import { releaseMatrixCells, releaseMatrixDifferences } from "./release-matrix-definition.mjs";
import { inspectPackageArchive, normalizeNpmPackPath, npmCommandInvocation } from "./supply-chain-validation.mjs";

const execute = promisify(execFile); const [cellFlag, cell, outputFlag, output] = process.argv.slice(2);
if (cellFlag !== "--cell" || !cell || outputFlag !== "--output" || !output) throw new Error("usage: node scripts/run-release-matrix-cell.mjs --cell <cell> --output <result.json>");
const declared = releaseMatrixCells.find((item) => item.cell === cell); if (!declared) throw new Error("undeclared release matrix cell");
const nodeVersion = process.versions.node; const npmInvocation = npmCommandInvocation(); const npmCommand = npmInvocation.command;
const npmArgs = (args) => [...npmInvocation.prefix, ...args]; const { stdout: npmVersionOutput } = await execute(npmCommand, npmArgs(["--version"])); const npmVersion = npmVersionOutput.trim();
if (process.platform !== declared.os || nodeVersion !== declared.node || npmVersion !== "11.5.1") throw new Error(`runtime mismatch for ${cell}: ${process.platform}/${nodeVersion}/npm-${npmVersion}`);
const root = process.cwd(); const temporary = await mkdtemp(resolve(tmpdir(), "kdlc-matrix-")); const commands = [];
const digest = (value) => createHash("sha256").update(value).digest("hex");
async function makeRemovable(path) {
  let metadata; try { metadata = await lstat(path); } catch { return; }
  if (metadata.isDirectory()) { await chmod(path, 0o700); const directory = await opendir(path); for await (const entry of directory) await makeRemovable(resolve(path, entry.name)); }
  else if (!metadata.isSymbolicLink()) await chmod(path, 0o600);
}
const run = async (id, command, args, options = {}) => {
  await new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    child.once("error", reject); child.once("exit", (code, signal) => code === 0 ? accept() : reject(new Error(`${id} failed with ${signal ?? `exit ${code}`}`)));
  });
  commands.push({ id, status: "passed" });
};
try {
  await run("full", npmCommand, npmArgs(["test"]));
  await run("offline", npmCommand, npmArgs(["run", "test:release-evaluation"]));
  await run("release", npmCommand, npmArgs(["run", "check:release-evidence"]), { env: { ...process.env, KDLC_RELEASE_MATRIX_PRECHECK: "1" } });
  await run("statistical", npmCommand, npmArgs(["run", "check:statistical-evidence"]));
  await run("clean-rebuild", process.execPath, ["--test", "--test-name-pattern", "^REL-001 clean rebuild removes caches and indexes then reproduces retrieval records and bytes$", "tests/governance/release-evidence.test.mjs"]);
  await run("supply-chain", npmCommand, npmArgs(["run", "check:supply-chain"]));
  const packDirectories = [resolve(temporary, "pack-one"), resolve(temporary, "pack-two")]; await Promise.all(packDirectories.map((path) => mkdir(path)));
  const builds = [];
  for (const destination of packDirectories) {
    const { stdout } = await execute(npmCommand, npmArgs(["pack", "--json", "--ignore-scripts", "--pack-destination", destination]), { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    const parsed = JSON.parse(stdout); if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0].filename || !Array.isArray(parsed[0].files)) throw new Error("npm pack did not return one artifact and manifest");
    const manifest = parsed[0].files.map(({ path, size, mode }) => ({ path: normalizeNpmPackPath(path), size, mode })).sort((left, right) => left.path.localeCompare(right.path, "en"));
    const artifactPath = resolve(destination, parsed[0].filename); const artifact = await readFile(artifactPath); const contents = await inspectPackageArchive(artifactPath); builds.push({ filename: parsed[0].filename, sha256: digest(artifact), manifest_sha256: digest(JSON.stringify(manifest)), content_sha256: contents.content_sha256, file_count: manifest.length });
  }
  if (builds[0].sha256 !== builds[1].sha256 || builds[0].manifest_sha256 !== builds[1].manifest_sha256 || builds[0].content_sha256 !== builds[1].content_sha256 || builds[0].file_count !== builds[1].file_count) throw new Error("two clean package builds are not byte-identical");
  commands.push({ id: "pack", status: "passed" });
  const consumer = resolve(temporary, "consumer"); await import("node:fs/promises").then(({ mkdir }) => mkdir(consumer)); await writeFile(resolve(consumer, "package.json"), '{"name":"kdlc-release-smoke","private":true,"type":"module"}\n');
  await execute(npmCommand, npmArgs(["install", "--ignore-scripts", "--no-audit", "--no-fund", resolve(packDirectories[0], builds[0].filename)]), { cwd: consumer, maxBuffer: 32 * 1024 * 1024 });
  const bin = resolve(consumer, "node_modules", "knowledge-dlc", "packages", "cli", "bin.mjs");
  await execute(process.execPath, [bin, "init", "--output", "json"], { cwd: consumer, maxBuffer: 16 * 1024 * 1024 });
  await execute(process.execPath, [bin, "doctor", "--output", "json"], { cwd: consumer, maxBuffer: 16 * 1024 * 1024 }); commands.push({ id: "cli", status: "passed" });
  await execute(process.execPath, ["--input-type=module", "--eval", "await import('knowledge-dlc/cli'); await import('knowledge-dlc/adapters');"], { cwd: consumer, env: { ...process.env, NODE_PATH: resolve(consumer, "node_modules").split(delimiter).join(delimiter) } }); commands.push({ id: "import", status: "passed" });
  const policy = JSON.parse(await readFile(resolve(root, "security/supply-chain-policy.json"), "utf8"));
  const headSha = process.env.KDLC_HEAD_SHA; if (!/^[0-9a-f]{40}$/u.test(headSha ?? "")) throw new Error("trusted candidate head is unavailable");
  const result = { api_version: "kdlc.dev/release-matrix-result/v1alpha1", cell, head_sha: headSha, runtime: { node: nodeVersion, npm: npmVersion }, platform: { os: process.platform, arch: process.arch }, commands, differences: releaseMatrixDifferences(process.platform), observed_evidence: {
    package: { first_sha256: builds[0].sha256, second_sha256: builds[1].sha256, manifest_sha256: builds[0].manifest_sha256, content_sha256: builds[0].content_sha256, file_count: builds[0].file_count },
    supply_chain: { sbom_sha256: digest(await readFile(resolve(root, policy.sbom))), notices_sha256: digest(await readFile(resolve(root, policy.notices))) }, smoke: { cli: true, imports: true }
  } };
  await writeFile(resolve(output), `${JSON.stringify(result, null, 2)}\n`);
} finally { await makeRemovable(temporary); await rm(temporary, { recursive: true, force: true }); }
