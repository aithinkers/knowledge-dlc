import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { releaseMatrixCells, releaseMatrixCommandIds, releaseMatrixDifferences } from "../../scripts/release-matrix-definition.mjs";
import { parseYamlArtifact } from "../../packages/contracts/index.mjs";

const root = resolve(import.meta.dirname, "../..");
const execute = promisify(execFile);
test("REL-001 release matrix declares exact six platform/runtime cells and stable aggregator", async () => {
  assert.deepEqual(releaseMatrixCells.map(({ cell }) => cell), ["ubuntu-node22", "ubuntu-node24", "windows-node22", "windows-node24", "macos-node22", "macos-node24"]);
  assert.deepEqual(new Set(releaseMatrixCells.map(({ node }) => node)), new Set(["22.23.2", "24.5.0"]));
  assert.deepEqual(new Set(releaseMatrixCells.map(({ os }) => os)), new Set(["linux", "win32", "darwin"]));
  assert.deepEqual(releaseMatrixCommandIds, ["full", "offline", "release", "statistical", "clean-rebuild", "pack", "cli", "import"]);
  const workflow = await readFile(resolve(root, ".github/workflows/release-matrix.yml"), "utf8");
  const attributes = await readFile(resolve(root, ".gitattributes"), "utf8");
  const parsedWorkflow = parseYamlArtifact(workflow);
  assert.match(attributes, /^\* text=auto eol=lf$/m);
  assert.match(workflow, /release-matrix:\r?\n    name: Release matrix/); assert.match(workflow, /npm install --global npm@11\.5\.1/); assert.match(workflow, /needs\.matrix\.result != 'success'/);
  const aggregatorSteps = parsedWorkflow.jobs["release-matrix"].steps;
  const trustedCheckout = aggregatorSteps.find((step) => step.name === "Check out trusted release verifier");
  assert.equal(trustedCheckout.with.ref, "${{ github.event.pull_request.base.sha || github.sha }}");
  assert.equal(trustedCheckout.with.path, "trusted");
  assert.ok(aggregatorSteps.some((step) => step.run === "npm ci --ignore-scripts --prefix trusted"));
  const trustedVerification = aggregatorSteps.find((step) => step.name === "Verify results with trusted code and locked dependencies").run;
  assert.match(trustedVerification, /cd trusted && KDLC_CANDIDATE_ROOT=\.\. node scripts\/verify-release-matrix\.mjs \.\.\/matrix-results/);
  assert.match(trustedVerification, /if test -f trusted\/scripts\/verify-release-matrix\.mjs/);
  assert.match(trustedVerification, /test "\$KDLC_PR_NUMBER" = 38/);
  assert.match(trustedVerification, /test "\$KDLC_BASE_SHA" = fbdf6119c884484974c0b5075fcc60fc97454d5f/);
});

test("REL-001 release matrix aggregator rejects missing or substituted cells", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "kdlc-release-matrix-")); context.after(() => rm(directory, { recursive: true, force: true }));
  for (const expected of releaseMatrixCells) {
    const target = resolve(directory, expected.cell); await mkdir(target);
    const result = { api_version: "kdlc.dev/release-matrix-result/v1alpha1", cell: expected.cell, runtime: { node: expected.node, npm: "11.5.1" }, platform: { os: expected.os, arch: "test" }, commands: releaseMatrixCommandIds.map((id) => ({ id, status: "passed" })), differences: releaseMatrixDifferences(expected.os) };
    await writeFile(resolve(target, "result.json"), `${JSON.stringify(result)}\n`);
  }
  await execute(process.execPath, ["scripts/verify-release-matrix.mjs", directory], { cwd: root });
  await rm(resolve(directory, "windows-node24"), { recursive: true });
  await assert.rejects(execute(process.execPath, ["scripts/verify-release-matrix.mjs", directory], { cwd: root }), /expected exactly six/);
});

test("REL-001 release matrix requires exact OS-bound platform differences", async (context) => {
  for (const mutation of ["missing", "duplicate", "extra", "value"]) {
    const directory = await mkdtemp(resolve(tmpdir(), `kdlc-release-matrix-${mutation}-`)); context.after(() => rm(directory, { recursive: true, force: true }));
    for (const expected of releaseMatrixCells) {
      const target = resolve(directory, expected.cell); await mkdir(target);
      const differences = structuredClone(releaseMatrixDifferences(expected.os));
      if (expected.cell === "windows-node24") {
        if (mutation === "missing") differences.pop();
        if (mutation === "duplicate") differences[2] = structuredClone(differences[0]);
        if (mutation === "extra") differences.push({ key: "line_ending", value: "lf-generated-evidence" });
        if (mutation === "value") differences[0].value = "slash";
      }
      const result = { api_version: "kdlc.dev/release-matrix-result/v1alpha1", cell: expected.cell, runtime: { node: expected.node, npm: "11.5.1" }, platform: { os: expected.os, arch: "test" }, commands: releaseMatrixCommandIds.map((id) => ({ id, status: "passed" })), differences };
      await writeFile(resolve(target, "result.json"), `${JSON.stringify(result)}\n`);
    }
    await assert.rejects(execute(process.execPath, ["scripts/verify-release-matrix.mjs", directory], { cwd: root }), undefined, mutation);
  }
});
