import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { releaseMatrixCells, releaseMatrixCommandIds, releaseMatrixDifferences } from "../../scripts/release-matrix-definition.mjs";
import { removeReleaseTemporary, withReleaseCleanup } from "../../scripts/release-artifact-cleanup.mjs";
import { parseYamlArtifact } from "../../packages/contracts/index.mjs";

const root = resolve(import.meta.dirname, "../..");
const execute = promisify(execFile);
const evidence = { package: { first_sha256: "a".repeat(64), second_sha256: "a".repeat(64), manifest_sha256: "b".repeat(64), file_count: 178 }, supply_chain: { sbom_sha256: "c".repeat(64), notices_sha256: "d".repeat(64) }, smoke: { cli: true, imports: true } };
const matrixResult = (expected, differences = releaseMatrixDifferences(expected.os)) => ({ api_version: "kdlc.dev/release-matrix-result/v1alpha1", cell: expected.cell, head_sha: "e".repeat(40), runtime: { node: expected.node, npm: "11.5.1" }, platform: { os: expected.os, arch: "test" }, commands: releaseMatrixCommandIds.map((id) => ({ id, status: "passed" })), differences, observed_evidence: structuredClone(evidence) });
const verifierEnvironment = async (directory) => { const path = resolve(directory, "derived.json"); await writeFile(path, JSON.stringify({ head_sha: "e".repeat(40), ...evidence })); return { ...process.env, KDLC_HEAD_SHA: "e".repeat(40), KDLC_TRUSTED_ARTIFACT_EVIDENCE: path }; };
test("REL-001 release matrix declares exact six platform/runtime cells and stable aggregator", async () => {
  assert.deepEqual(releaseMatrixCells.map(({ cell }) => cell), ["ubuntu-node22", "ubuntu-node24", "windows-node22", "windows-node24", "macos-node22", "macos-node24"]);
  assert.deepEqual(new Set(releaseMatrixCells.map(({ node }) => node)), new Set(["22.23.2", "24.5.0"]));
  assert.deepEqual(new Set(releaseMatrixCells.map(({ os }) => os)), new Set(["linux", "win32", "darwin"]));
  assert.deepEqual(releaseMatrixCommandIds, ["full", "offline", "release", "statistical", "clean-rebuild", "supply-chain", "pack", "cli", "import"]);
  const workflow = await readFile(resolve(root, ".github/workflows/release-matrix.yml"), "utf8");
  const attributes = await readFile(resolve(root, ".gitattributes"), "utf8");
  const parsedWorkflow = parseYamlArtifact(workflow);
  assert.match(attributes, /^\* text=auto eol=lf$/m);
  assert.match(workflow, /release-matrix:\r?\n    name: Release matrix/); assert.match(workflow, /npm install --global npm@11\.5\.1/); assert.match(workflow, /needs\.matrix\.result != 'success'/);
  assert.match(workflow, /name: Bind exact installed npm CLI/); assert.match(workflow, /test "\$\(node "\$npm_cli" --version\)" = 11\.5\.1/); assert.match(workflow, /KDLC_NPM_CLI/);
  const aggregatorSteps = parsedWorkflow.jobs["release-matrix"].steps;
  const trustedCheckout = aggregatorSteps.find((step) => step.name === "Check out trusted release verifier");
  assert.equal(trustedCheckout.with.ref, "${{ github.event.pull_request.base.sha || github.sha }}");
  assert.equal(trustedCheckout.with.path, "trusted");
  assert.ok(aggregatorSteps.some((step) => step.run === "npm ci --ignore-scripts --prefix trusted"));
  const derivation = aggregatorSteps.find((step) => step.name === "Derive candidate artifacts in the tokenless aggregator");
  assert.match(derivation.run, /npm ci --ignore-scripts/); assert.match(derivation.run, /trusted\/scripts\/derive-release-artifacts\.mjs/);
  const trustedVerification = aggregatorSteps.find((step) => step.name === "Verify results with trusted code and locked dependencies").run;
  assert.match(trustedVerification, /cd trusted && KDLC_CANDIDATE_ROOT=\.\. node scripts\/verify-release-matrix\.mjs \.\.\/matrix-results/);
  assert.match(trustedVerification, /if test -f trusted\/scripts\/verify-release-matrix\.mjs/);
  assert.match(trustedVerification, /test "\$KDLC_PR_NUMBER" = 38/);
  assert.match(trustedVerification, /test "\$KDLC_BASE_SHA" = fbdf6119c884484974c0b5075fcc60fc97454d5f/);
  const stateSteps = parsedWorkflow.jobs["release-state"].steps;
  assert.equal(stateSteps.filter((step) => step.uses?.startsWith("actions/checkout@")).length, 1);
  assert.equal(stateSteps.find((step) => step.name === "Check out trusted release-state collector").with.ref, "${{ github.event.pull_request.base.sha || github.sha }}");
  assert.match(stateSteps.find((step) => step.name === "Collect live state without candidate checkout or execution").run, /node trusted\/scripts\/collect-release-state\.mjs/);
});

test("REL-001 release matrix aggregator rejects missing or substituted cells", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "kdlc-release-matrix-")); context.after(() => rm(directory, { recursive: true, force: true }));
  for (const expected of releaseMatrixCells) {
    const target = resolve(directory, expected.cell); await mkdir(target);
    const result = matrixResult(expected);
    await writeFile(resolve(target, "result.json"), `${JSON.stringify(result)}\n`);
  }
  const env = await verifierEnvironment(directory); await execute(process.execPath, ["scripts/verify-release-matrix.mjs", directory], { cwd: root, env });
  await rm(resolve(directory, "windows-node24"), { recursive: true });
  await assert.rejects(execute(process.execPath, ["scripts/verify-release-matrix.mjs", directory], { cwd: root, env }), /expected exactly six/);
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
      const result = matrixResult(expected, differences);
      await writeFile(resolve(target, "result.json"), `${JSON.stringify(result)}\n`);
    }
    await assert.rejects(execute(process.execPath, ["scripts/verify-release-matrix.mjs", directory], { cwd: root, env: await verifierEnvironment(directory) }), undefined, mutation);
  }
});

test("REL-001 trusted artifact derivation removes readonly output without masking a primary failure", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "kdlc-derived-cleanup-")); await mkdir(resolve(directory, "nested")); await writeFile(resolve(directory, "nested/readonly.json"), "{}\n"); await chmod(resolve(directory, "nested/readonly.json"), 0o400); await chmod(resolve(directory, "nested"), 0o500);
  await removeReleaseTemporary(directory);
  const primary = new Error("primary"); const cleanup = new Error("cleanup");
  await assert.rejects(withReleaseCleanup(async () => { throw primary; }, async () => { throw cleanup; }), (error) => error === primary);
  await assert.rejects(withReleaseCleanup(async () => "ok", async () => { throw cleanup; }), (error) => error === cleanup);
});
