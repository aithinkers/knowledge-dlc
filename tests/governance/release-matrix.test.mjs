import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { releaseMatrixCells, releaseMatrixCommandIds } from "../../scripts/release-matrix-definition.mjs";
import { parseYamlArtifact } from "../../packages/contracts/index.mjs";

const root = resolve(import.meta.dirname, "../..");
const execute = promisify(execFile);
test("REL-001 release matrix declares exact six platform/runtime cells and stable aggregator", async () => {
  assert.deepEqual(releaseMatrixCells.map(({ cell }) => cell), ["ubuntu-node22", "ubuntu-node24", "windows-node22", "windows-node24", "macos-node22", "macos-node24"]);
  assert.deepEqual(new Set(releaseMatrixCells.map(({ node }) => node)), new Set(["22.23.2", "24.5.0"]));
  assert.deepEqual(new Set(releaseMatrixCells.map(({ os }) => os)), new Set(["linux", "win32", "darwin"]));
  assert.deepEqual(releaseMatrixCommandIds, ["full", "offline", "release", "statistical", "clean-rebuild", "pack", "cli", "import"]);
  const workflow = await readFile(resolve(root, ".github/workflows/release-matrix.yml"), "utf8");
  parseYamlArtifact(workflow);
  assert.match(workflow, /release-matrix:\r?\n    name: Release matrix/); assert.match(workflow, /npm install --global npm@11\.5\.1/); assert.match(workflow, /needs\.matrix\.result != 'success'/);
});

test("REL-001 release matrix aggregator rejects missing or substituted cells", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "kdlc-release-matrix-")); context.after(() => rm(directory, { recursive: true, force: true }));
  for (const expected of releaseMatrixCells) {
    const target = resolve(directory, expected.cell); await mkdir(target);
    const result = { api_version: "kdlc.dev/release-matrix-result/v1alpha1", cell: expected.cell, runtime: { node: expected.node, npm: "11.5.1" }, platform: { os: expected.os, arch: "test" }, commands: releaseMatrixCommandIds.map((id) => ({ id, status: "passed" })), differences: [] };
    await writeFile(resolve(target, "result.json"), `${JSON.stringify(result)}\n`);
  }
  await execute(process.execPath, ["scripts/verify-release-matrix.mjs", directory], { cwd: root });
  await rm(resolve(directory, "windows-node24"), { recursive: true });
  await assert.rejects(execute(process.execPath, ["scripts/verify-release-matrix.mjs", directory], { cwd: root }), /expected exactly six/);
});
