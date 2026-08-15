import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { access, chmod, lstat, mkdtemp, opendir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const repository = resolve(import.meta.dirname, "../..");

async function run(root, ...args) {
  const child = spawn(process.execPath, [resolve(repository, "packages/cli/bin.mjs"), ...args, "--output", "json"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "exit");
  return { code, envelope: JSON.parse(stdout || stderr) };
}

test("FEAT-011 the getting-started walkthrough works exactly as documented", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "kdlc-getting-started-"));
  t.after(async () => {
    const writable = async (path) => {
      let metadata; try { metadata = await lstat(path); } catch { return; }
      if (metadata.isDirectory()) {
        try { await chmod(path, 0o700); } catch (error) { if (error.code === "ENOENT") return; throw error; }
        let directory; try { directory = await opendir(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
        for await (const entry of directory) await writable(resolve(path, entry.name));
      } else if (!metadata.isSymbolicLink()) await chmod(path, 0o600);
    };
    await writable(root);
    await rm(root, { recursive: true, force: true });
  });

  // §2: init scaffolds the documented workspace and is idempotent-conflicting.
  const init = await run(root, "init");
  assert.equal(init.code, 0);
  assert.equal(init.envelope.ok, true);
  for (const path of ["knowledge-project.yaml", "purpose.md", "knowledge/primary/knowledge-base.yaml", "knowledge/primary/index.md"]) {
    await assert.doesNotReject(access(resolve(root, path)), `documented scaffold file must exist: ${path}`);
  }
  const status = await run(root, "status");
  assert.equal(status.envelope.result.state, "ready");
  const doctor = await run(root, "doctor");
  assert.equal(doctor.envelope.result.healthy, true);

  // §3: ingest returns a job, normalizes deterministically, and lint passes.
  await writeFile(resolve(root, "note.md"), "# Token policy\n\nProduction API tokens expire after 60 minutes.\n");
  const ingest = await run(root, "ingest", "note.md");
  assert.equal(ingest.envelope.ok, true);
  assert.equal(ingest.envelope.result.operation, "ingest");
  const jobs = await run(root, "jobs");
  assert.equal(jobs.envelope.result.jobs[0].state, "completed");
  assert.equal(jobs.envelope.result.jobs[0].result.normalized[0].manifest.status, "complete");
  const lint = await run(root, "lint");
  assert.equal(lint.envelope.result.valid, true);

  // §3: unpublished evidence never leaks into trusted query answers.
  const query = await run(root, "query", "token", "lifetime");
  assert.equal(query.envelope.ok, true);
  assert.equal(query.envelope.result.status, "not_found");

  // REQ-UX-001: argument-requiring commands fail with input-class errors, not internal leaks.
  for (const bare of [["trace"], ["migrate"]]) {
    const failed = await run(root, ...bare);
    assert.equal(failed.code, 2, `${bare[0]} without arguments must exit input class`);
    assert.equal(failed.envelope.error.code, "KDLC_INPUT_INVALID", `${bare[0]} must return KDLC_INPUT_INVALID`);
  }

  // Documented command surface stays honest.
  const guide = await readFile(resolve(repository, "docs/getting-started.md"), "utf8");
  const { CLI_COMMANDS } = await import(`file://${resolve(repository, "packages/cli/index.mjs")}`);
  for (const command of CLI_COMMANDS) assert.ok(guide.includes(`\`${command}`), `guide must mention CLI command: ${command}`);
  const packageManifest = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8"));
  assert.equal(packageManifest.bin.kdlc, "./packages/cli/bin.mjs", "npm link instruction requires the kdlc bin entry");
});
