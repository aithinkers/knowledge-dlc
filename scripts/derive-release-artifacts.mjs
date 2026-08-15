#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { promisify } from "node:util";
import { inspectPackageArchive, normalizeNpmPackPath } from "./supply-chain-validation.mjs";
import { removeReleaseTemporary, validateInstalledCliSmoke, withReleaseCleanup } from "./release-artifact-cleanup.mjs";

const execute = promisify(execFile); const [candidateArgument, outputArgument] = process.argv.slice(2);
if (!candidateArgument || !outputArgument || process.argv.length !== 4) throw new Error("usage: node scripts/derive-release-artifacts.mjs <candidate-root> <output.json>");
const candidate = resolve(candidateArgument); const output = resolve(outputArgument); const temporary = await mkdtemp(resolve(tmpdir(), "kdlc-derived-release-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm"; const npmOptions = process.platform === "win32" ? { shell: true } : {};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const safeEnvironment = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT, TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP, npm_config_cache: resolve(temporary, "npm-cache") };
await withReleaseCleanup(async () => {
  await execute(process.execPath, [resolve(import.meta.dirname, "verify-supply-chain.mjs")], { cwd: import.meta.dirname, env: { ...safeEnvironment, KDLC_CANDIDATE_ROOT: candidate }, maxBuffer: 32 * 1024 * 1024 });
  const destinations = [resolve(temporary, "pack-one"), resolve(temporary, "pack-two")]; await Promise.all(destinations.map((path) => mkdir(path)));
  const builds = [];
  for (const destination of destinations) {
    const { stdout } = await execute(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], { cwd: candidate, env: safeEnvironment, maxBuffer: 32 * 1024 * 1024, ...npmOptions });
    const parsed = JSON.parse(stdout); if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0].filename || !Array.isArray(parsed[0].files)) throw new Error("npm pack did not emit one artifact and exact manifest");
    const manifest = parsed[0].files.map(({ path, size, mode }) => ({ path: normalizeNpmPackPath(path), size, mode })).sort((left, right) => left.path.localeCompare(right.path, "en")); const archive = resolve(destination, parsed[0].filename); const bytes = await readFile(archive); const contents = await inspectPackageArchive(archive, resolve(destination, "extracted"));
    builds.push({ filename: parsed[0].filename, sha256: digest(bytes), manifest_sha256: digest(JSON.stringify(manifest)), content_sha256: contents.content_sha256, file_count: manifest.length });
  }
  if (builds[0].sha256 !== builds[1].sha256 || builds[0].manifest_sha256 !== builds[1].manifest_sha256 || builds[0].content_sha256 !== builds[1].content_sha256 || builds[0].file_count !== builds[1].file_count) throw new Error("trusted double-package derivation is not reproducible");
  const consumer = resolve(temporary, "consumer"); await mkdir(consumer); await writeFile(resolve(consumer, "package.json"), '{"name":"kdlc-trusted-release-smoke","private":true,"type":"module"}\n');
  await execute(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", resolve(destinations[0], builds[0].filename)], { cwd: consumer, env: safeEnvironment, maxBuffer: 32 * 1024 * 1024, ...npmOptions });
  const canonicalConsumer = await realpath(consumer);
  const bin = resolve(canonicalConsumer, "node_modules", "knowledge-dlc", "packages", "cli", "bin.mjs"); const readable = [`--allow-fs-read=${canonicalConsumer}`, `--allow-fs-read=${consumer}`];
  const writable = [`--allow-fs-write=${canonicalConsumer}`, `--allow-fs-write=${consumer}`];
  const initialized = JSON.parse((await execute(process.execPath, ["--permission", ...readable, ...writable, bin, "init", "--output", "json"], { cwd: canonicalConsumer, env: safeEnvironment, maxBuffer: 16 * 1024 * 1024 })).stdout);
  const diagnosed = JSON.parse((await execute(process.execPath, ["--permission", ...readable, ...writable, bin, "doctor", "--output", "json"], { cwd: canonicalConsumer, env: safeEnvironment, maxBuffer: 16 * 1024 * 1024 })).stdout);
  validateInstalledCliSmoke(initialized, diagnosed);
  await execute(process.execPath, ["--permission", ...readable, "--input-type=module", "--eval", "await import('knowledge-dlc/cli'); await import('knowledge-dlc/adapters');"], { cwd: canonicalConsumer, env: { ...safeEnvironment, NODE_PATH: resolve(canonicalConsumer, "node_modules").split(delimiter).join(delimiter) }, maxBuffer: 16 * 1024 * 1024 });
  const policy = JSON.parse(await readFile(resolve(candidate, "security/supply-chain-policy.json"), "utf8")); const head = process.env.KDLC_HEAD_SHA;
  if (!/^[0-9a-f]{40}$/u.test(head ?? "")) throw new Error("trusted candidate head is unavailable");
  const result = { head_sha: head, package: { first_sha256: builds[0].sha256, second_sha256: builds[1].sha256, manifest_sha256: builds[0].manifest_sha256, content_sha256: builds[0].content_sha256, file_count: builds[0].file_count }, supply_chain: { sbom_sha256: digest(await readFile(resolve(candidate, policy.sbom))), notices_sha256: digest(await readFile(resolve(candidate, policy.notices))) }, smoke: { cli: true, imports: true } };
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
}, () => removeReleaseTemporary(temporary));
