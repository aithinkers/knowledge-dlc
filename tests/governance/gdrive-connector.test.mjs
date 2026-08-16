import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import test from "node:test";

import { byteHash } from "../../packages/core/index.mjs";
import { DRIVE_EXPORTS, GOOGLE_DRIVE_CAPABILITIES, GoogleDriveConnector } from "../../packages/connectors/index.mjs";
import { bindReceipt, receiptStaleness, validateRemoteDescriptor } from "../../packages/sources/index.mjs";
import { normalize } from "../../packages/normalizers/index.mjs";

function recorded(routes) {
  return { request: async ({ url }) => routes[url] ?? { status: 404 } };
}

const DRIVE = "https://www.googleapis.com/drive/v3";
const FIELDS = encodeURIComponent("id,name,mimeType,headRevisionId,version,trashed,shared,capabilities/canDownload,exportLinks");
const meta = (fileId) => `${DRIVE}/files/${fileId}?supportsAllDrives=true&fields=${FIELDS}`;

// A minimal real .docx so the exported bytes flow through the true normalizer.
const docxBytes = zipSync({
  "[Content_Types].xml": strToU8("<Types><Override PartName='/word/document.xml' ContentType='application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'/></Types>"),
  "_rels/.rels": strToU8("<Relationships><Relationship Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument' Target='word/document.xml'/></Relationships>"),
  "word/document.xml": strToU8("<w:document xmlns:w='w'><w:body><w:p><w:r><w:t>Exported design note</w:t></w:r></w:p></w:body></w:document>")
});
const mdBytes = new TextEncoder().encode("# Note\n\nPlain binary download.\n");

test("FEAT-024: native Google Docs export to docx with fidelity metadata and version-counter revisions", async () => {
  const routes = {
    [meta("doc1")]: { status: 200, json: () => ({ id: "doc1", name: "Design Note", mimeType: "application/vnd.google-apps.document", version: "41", shared: true }) },
    [`${DRIVE}/files/doc1/export?mimeType=${encodeURIComponent(DRIVE_EXPORTS["application/vnd.google-apps.document"].mime)}`]: { status: 200, bytes: () => docxBytes }
  };
  const connector = new GoogleDriveConnector(recorded(routes));
  const fetched = await connector.fetchFile({ fileId: "doc1", acquiredAt: "2026-08-16T12:00:00Z" });
  assert.deepEqual(validateRemoteDescriptor(fetched.descriptor), []);
  assert.deepEqual(fetched.descriptor.revision, { kind: "revision-id", value: "version:41" });
  assert.equal(fetched.filename, "Design Note.docx");
  assert.match(fetched.export_fidelity, /comments, suggestions, and revision history are not carried/);
  assert.equal(fetched.descriptor.access_context.visibility, "internal");
  const result = await normalize({ bytes: Buffer.from(fetched.bytes), filename: fetched.filename });
  assert.equal(result.manifest.format, "docx");
  assert.ok(result.units.some(({ text }) => text === "Exported design note"));
});

test("FEAT-024: binary files download as original bytes with headRevisionId", async () => {
  const routes = {
    [meta("f2")]: { status: 200, json: () => ({ id: "f2", name: "note.md", mimeType: "text/markdown", headRevisionId: "0B-rev-77" }) },
    [`${DRIVE}/files/f2?alt=media&supportsAllDrives=true`]: { status: 200, bytes: () => mdBytes }
  };
  const fetched = await new GoogleDriveConnector(recorded(routes)).fetchFile({ fileId: "f2", acquiredAt: "2026-08-16T12:00:00Z" });
  assert.deepEqual(fetched.descriptor.revision, { kind: "revision-id", value: "0B-rev-77" });
  assert.equal(fetched.descriptor.access_context.visibility, "restricted");
  assert.equal(fetched.export_fidelity, undefined);
  const receipt = bindReceipt(fetched.descriptor, fetched.bytes, { sourceId: "src_00000000000000f2", receivedAt: "2026-08-16T12:00:01Z" });
  assert.equal(receipt.content_hash, byteHash(mdBytes));
  assert.equal((await normalize({ bytes: Buffer.from(fetched.bytes), filename: fetched.filename })).manifest.format, "markdown");
});

test("FEAT-024: trashed, view-only, unexportable, and denied files fail closed with plain reasons", async () => {
  const cases = {
    trash: { status: 200, json: () => ({ id: "trash", trashed: true, mimeType: "text/plain" }) },
    locked: { status: 200, json: () => ({ id: "locked", mimeType: "application/pdf", headRevisionId: "r", capabilities: { canDownload: false } }) },
    form: { status: 200, json: () => ({ id: "form", mimeType: "application/vnd.google-apps.form", version: "3" }) },
    norev: { status: 200, json: () => ({ id: "norev", mimeType: "text/plain" }) }
  };
  const routes = Object.fromEntries(Object.entries(cases).map(([fileId, response]) => [meta(fileId), response]));
  const connector = new GoogleDriveConnector(recorded(routes));
  await assert.rejects(connector.fetchFile({ fileId: "trash" }), /in the trash/);
  await assert.rejects(connector.fetchFile({ fileId: "locked" }), /view-only restriction/);
  await assert.rejects(connector.fetchFile({ fileId: "form" }), /no supported export/);
  await assert.rejects(connector.fetchFile({ fileId: "norev" }), /no usable revision identity/);
  await assert.rejects(connector.fetchFile({ fileId: "missing" }), /not found/);
});

test("FEAT-024: probe feeds staleness — changed version, trashed, and permission-lost paths", async () => {
  const routes = {
    [meta("doc1")]: { status: 200, json: () => ({ id: "doc1", name: "Design Note", mimeType: "application/vnd.google-apps.document", version: "44" }) },
    [meta("gonedoc")]: { status: 200, json: () => ({ id: "gonedoc", trashed: true, mimeType: "text/plain" }) }
  };
  const connector = new GoogleDriveConnector(recorded(routes));
  const receipt = bindReceipt(
    { provider: "google-drive", remote_id: "doc1", revision: { kind: "revision-id", value: "version:41" }, acquired_via: "connector", acquired_at: "2026-08-16T12:00:00Z", content_hash: byteHash(docxBytes), access_context: { visibility: "internal" } },
    docxBytes, { sourceId: "src_0000000000000d01", receivedAt: "2026-08-16T12:00:01Z" }
  );
  const live = await connector.probe(receipt);
  const verdict = receiptStaleness(receipt, live);
  assert.equal(verdict.state, "stale");
  assert.match(verdict.reason, /version:41 → version:44/);
  assert.equal(await connector.probe({ ...receipt, remote_id: "gonedoc" }), null);
  assert.equal(await connector.probe({ ...receipt, remote_id: "vanished" }), null);
});

test("FEAT-024: capabilities are read-only with honest deferrals; no credentials in outputs", async () => {
  assert.equal(GOOGLE_DRIVE_CAPABILITIES.writes, false);
  assert.deepEqual(GOOGLE_DRIVE_CAPABILITIES.scopes_required, ["https://www.googleapis.com/auth/drive.readonly"]);
  assert.ok(GOOGLE_DRIVE_CAPABILITIES.deferrals.includes("folder crawl"));
  const routes = {
    [meta("f2")]: { status: 200, json: () => ({ id: "f2", name: "note.md", mimeType: "text/markdown", headRevisionId: "r1" }) },
    [`${DRIVE}/files/f2?alt=media&supportsAllDrives=true`]: { status: 200, bytes: () => mdBytes }
  };
  const fetched = await new GoogleDriveConnector(recorded(routes)).fetchFile({ fileId: "f2" });
  assert.ok(!/authorization|bearer|token|secret/i.test(JSON.stringify(fetched.descriptor)));
});
