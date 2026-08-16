import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { byteHash } from "../../packages/core/index.mjs";
import {
  ACQUISITION_VIAS,
  REMOTE_PROVIDERS,
  RemoteSourceError,
  bindReceipt,
  receiptStaleness,
  validateRemoteDescriptor
} from "../../packages/sources/index.mjs";
import { KdlcEngine, createLocalProjectEngine } from "../../packages/cli/index.mjs";

const bytes = Buffer.from("# Runbook\n\nFailover timeout is 30 seconds.\n");
const descriptor = {
  provider: "confluence",
  remote_id: "SPACE:123456",
  revision: { kind: "version-number", value: "7" },
  acquired_via: "mcp",
  acquired_at: "2026-08-16T12:00:00Z",
  content_hash: byteHash(bytes),
  access_context: { visibility: "internal", detail: "ENG space, all engineers" },
  display_name: "Failover Runbook"
};

test("FEAT-021: descriptors validate fail-closed with plain-language findings", () => {
  assert.deepEqual(validateRemoteDescriptor(descriptor), []);
  assert.deepEqual(validateRemoteDescriptor(null), ["remote descriptor must be an object"]);
  const bad = validateRemoteDescriptor({
    provider: "dropbox", remote_id: "", revision: { kind: "etag" },
    acquired_via: "email", acquired_at: "yesterday", content_hash: "abc",
    access_context: { visibility: "secret" }
  });
  assert.equal(bad.length, 7);
  // Revision kinds are provider-specific: a Confluence eTag is a mistake.
  const wrongKind = validateRemoteDescriptor({ ...descriptor, revision: { kind: "etag", value: "x" } });
  assert.ok(wrongKind.some((failure) => /version-number/.test(failure)));
  assert.ok(REMOTE_PROVIDERS.includes("sharepoint") && ACQUISITION_VIAS.includes("connector"));
});

test("FEAT-021: a receipt binds the descriptor to the exact ingested bytes", () => {
  const receipt = bindReceipt(descriptor, bytes, { sourceId: "src_0123456789abcdef", receivedAt: "2026-08-16T12:00:05Z" });
  assert.equal(receipt.provider, "confluence");
  assert.equal(receipt.byte_length, bytes.byteLength);
  assert.equal(receipt.access_context.visibility, "internal");
  assert.ok(Object.isFrozen(receipt) && Object.isFrozen(receipt.revision));
  assert.throws(
    () => bindReceipt(descriptor, Buffer.from("extracted text rendering"), { sourceId: "src_x", receivedAt: "2026-08-16T12:00:05Z" }),
    (error) => error instanceof RemoteSourceError && /different content than it claimed/.test(error.message)
  );
  assert.throws(() => bindReceipt({ ...descriptor, provider: "box" }, bytes, { sourceId: "s", receivedAt: "t" }), RemoteSourceError);
});

test("FEAT-021: staleness judgment covers current, stale, unreachable, and mismatched probes", () => {
  const receipt = bindReceipt(descriptor, bytes, { sourceId: "src_1", receivedAt: "2026-08-16T12:00:05Z" });
  assert.equal(receiptStaleness(receipt, { kind: "version-number", value: "7" }).state, "current");
  const stale = receiptStaleness(receipt, { kind: "version-number", value: "9" });
  assert.equal(stale.state, "stale");
  assert.match(stale.reason, /7 → 9/);
  assert.equal(receiptStaleness(receipt, null).state, "unreachable");
  assert.equal(receiptStaleness(receipt, { kind: "etag", value: "z" }).state, "indeterminate");
});

test("FEAT-021: ingest verifies remote descriptors, persists receipts, and sources lists them", async () => {
  const root = await mkdtemp(join(tmpdir(), "kdlc-remote-"));
  await new KdlcEngine({ root }).execute("init", { project_id: "remote.fixture" });
  const engine = createLocalProjectEngine({ root });
  const file = join(root, "runbook.md");
  await writeFile(file, bytes);

  const started = await engine.execute("ingest_start", { sources: ["runbook.md"], remote: [descriptor], idempotency_key: "fixture-remote-1" });
  let job = started;
  for (let attempt = 0; attempt < 100 && !["completed", "failed"].includes(job.state); attempt += 1) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
    job = await engine.execute("job_status", { id: started.id });
  }
  assert.equal(job.state, "completed", JSON.stringify(job.error ?? job));
  assert.equal(job.result.normalized[0].receipt.provider, "confluence");
  const stored = JSON.parse(await readFile(join(root, ".kdlc/sources", `${job.result.normalized[0].manifest.source_id}.receipt.json`), "utf8"));
  assert.equal(stored.revision.value, "7");

  const listing = await engine.execute("sources", {});
  assert.equal(listing.sources.length, 1);
  assert.equal(listing.sources[0].display_name, "Failover Runbook");

  // Hash mismatch is refused as policy, not accepted with a shrug.
  const lying = { ...descriptor, content_hash: `sha256:${"0".repeat(64)}` };
  const badStart = await engine.execute("ingest_start", { sources: ["runbook.md"], remote: [lying], idempotency_key: "fixture-remote-2" });
  let badJob = badStart;
  for (let attempt = 0; attempt < 100 && !["completed", "failed"].includes(badJob.state); attempt += 1) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
    badJob = await engine.execute("job_status", { id: badStart.id });
  }
  assert.equal(badJob.state, "failed");
  assert.equal(badJob.error.code, "KDLC_POLICY_DENIED", "hash mismatch is refused as policy (detail scrubbed by the job runner)");

  // Misaligned remote arrays fail immediately.
  await assert.rejects(
    engine.execute("ingest", { sources: ["runbook.md"], remote: [descriptor, descriptor], idempotency_key: "fixture-remote-3" }),
    /aligned one-to-one/
  );
});
