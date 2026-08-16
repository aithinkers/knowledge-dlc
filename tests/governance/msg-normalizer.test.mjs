import assert from "node:assert/strict";
import test from "node:test";

import { descriptors, normalize } from "../../packages/normalizers/index.mjs";

const SECTOR = 512;
const utf16le = (value) => { const out = Buffer.alloc(value.length * 2); for (let i = 0; i < value.length; i += 1) out.writeUInt16LE(value.charCodeAt(i), i * 2); return out; };

/**
 * Minimal CFBF v3 writer for fixtures: mini-stream cutoff is set to 0 so every
 * stream lives on regular FAT chains. `nodes` is a flat list of
 * {name, type, content?, left?, right?, child?} with index 0 = root.
 */
function buildCfb(nodes) {
  const directorySectors = Math.ceil((nodes.length * 128) / SECTOR);
  let nextSector = 1 + directorySectors;
  const placements = nodes.map((node) => {
    if (!node.content || node.content.length === 0) return { start: 0xfffffffe, size: node.content?.length ?? 0 };
    const start = nextSector; const count = Math.ceil(node.content.length / SECTOR);
    nextSector += count;
    return { start, size: node.content.length, count };
  });
  const totalSectors = nextSector;
  const fat = new Array(totalSectors).fill(0xfffffffe);
  fat[0] = 0xfffffffd; // FAT sector marker
  for (let i = 1; i < 1 + directorySectors; i += 1) fat[i] = i + 1 < 1 + directorySectors ? i + 1 : 0xfffffffe;
  placements.forEach((placement) => {
    if (placement.start === 0xfffffffe) return;
    for (let i = 0; i < placement.count; i += 1) fat[placement.start + i] = i + 1 < placement.count ? placement.start + i + 1 : 0xfffffffe;
  });
  const file = Buffer.alloc(512 + totalSectors * SECTOR);
  // header
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(file, 0);
  file.writeUInt16LE(0x003e, 24); file.writeUInt16LE(0x0003, 26); file.writeUInt16LE(0xfffe, 28);
  file.writeUInt16LE(9, 30); file.writeUInt16LE(6, 32);
  file.writeUInt32LE(1, 44);            // one FAT sector
  file.writeUInt32LE(1, 48);            // first directory sector
  file.writeUInt32LE(0, 56);            // mini cutoff 0: everything on FAT
  file.writeUInt32LE(0xfffffffe, 60); file.writeUInt32LE(0, 64);
  file.writeUInt32LE(0xfffffffe, 68); file.writeUInt32LE(0, 72);
  file.writeUInt32LE(0, 76);            // DIFAT[0] -> FAT at sector 0
  for (let i = 1; i < 109; i += 1) file.writeUInt32LE(0xffffffff, 76 + i * 4);
  fat.forEach((entry, index) => file.writeUInt32LE(entry >>> 0, 512 + index * 4));
  nodes.forEach((node, index) => {
    const offset = 512 + SECTOR + index * 128;
    const name = utf16le(node.name); name.copy(file, offset);
    file.writeUInt16LE(name.length + 2, offset + 64);
    file.writeUInt8(node.type, offset + 66); file.writeUInt8(1, offset + 67);
    file.writeInt32LE(node.left ?? -1, offset + 68); file.writeInt32LE(node.right ?? -1, offset + 72); file.writeInt32LE(node.child ?? -1, offset + 76);
    file.writeUInt32LE(placements[index].start >>> 0, offset + 116); file.writeUInt32LE(placements[index].size, offset + 120);
  });
  placements.forEach((placement, index) => {
    if (placement.start !== 0xfffffffe) Buffer.from(nodes[index].content).copy(file, 512 + placement.start * SECTOR);
  });
  return file;
}

const attachmentBytes = Buffer.from("%PDF-1.4 fixture");
const fixture = buildCfb([
  { name: "Root Entry", type: 5, child: 1 },
  { name: "__substg1.0_0037001F", type: 2, content: utf16le("Quarterly review"), right: 2 },
  { name: "__substg1.0_0C1A001F", type: 2, content: utf16le("Ana Lima"), right: 3 },
  { name: "__substg1.0_1000001F", type: 2, content: utf16le("Timeout is 30 seconds.\nConfirmed in the meeting."), right: 4 },
  { name: "__substg1.0_007D001F", type: 2, content: utf16le("From: ana@example.com\r\nTo: team@example.com\r\nSubject: =?UTF-8?B?UTMg4pyF?=\r\n"), right: 5 },
  { name: "__attach_version1.0_#00000000", type: 1, child: 6 },
  { name: "__substg1.0_3707001F", type: 2, content: utf16le("deck.pdf"), right: 7 },
  { name: "__substg1.0_37010102", type: 2, content: attachmentBytes }
]);

test("FEAT-020: msg descriptor registered; format profiles derive", async () => {
  assert.ok(descriptors.msg);
  assert.deepEqual(descriptors.msg.locator_kinds, ["header", "mime-part"]);
  const { distributionDefinition } = await import("../../packages/adapters/definitions.mjs");
  assert.ok(distributionDefinition.format_profiles.includes("msg"));
});

test("FEAT-020: an Outlook message yields structure, decoded headers, body, and attachment inventory", async () => {
  const result = await normalize({ bytes: fixture, filename: "review.msg" });
  assert.equal(result.manifest.format, "msg");
  assert.equal(result.manifest.status, "complete");

  const structure = result.units.find(({ kind }) => kind === "email-structure");
  assert.equal(structure.structured_data.subject, "Quarterly review");
  assert.equal(structure.structured_data.from, "Ana Lima");
  assert.equal(structure.structured_data.header_count, 3, "transport headers parsed");

  const subjectHeader = result.units.find(({ kind, locator }) => kind === "email-header" && locator.name === "Subject");
  assert.equal(subjectHeader.text, "Q3 ✅", "RFC 2047 decoding shared with eml");

  const body = result.units.find(({ kind }) => kind === "email-body");
  assert.match(body.text, /Timeout is 30 seconds\./);

  const attachment = result.units.find(({ kind }) => kind === "email-attachment");
  assert.equal(attachment.structured_data.filename, "deck.pdf");
  assert.equal(attachment.structured_data.bytes, attachmentBytes.length);
  assert.match(attachment.structured_data.content_hash, /^sha256:[a-f0-9]{64}$/);
  assert.ok(attachment.quality_warnings[0].includes("separate source"));
  assert.ok(result.manifest.quality_warnings.includes("attachments-inventoried-not-extracted"));
  assert.ok(result.units.every(({ locator }) => ["header", "mime-part"].includes(locator.kind)));
});

test("FEAT-020: msg output is deterministic", async () => {
  const first = await normalize({ bytes: fixture, filename: "review.msg" });
  const second = await normalize({ bytes: fixture, filename: "review.msg" });
  assert.deepEqual(first, second);
});

test("FEAT-020: non-msg CFBF and malformed containers quarantine, never crash", async () => {
  const legacy = buildCfb([
    { name: "Root Entry", type: 5, child: 1 },
    { name: "WordDocument", type: 2, content: Buffer.from("legacy doc bytes") }
  ]);
  const legacyResult = await normalize({ bytes: legacy, filename: "old.doc" });
  assert.equal(legacyResult.manifest.status, "quarantined");
  assert.equal(legacyResult.manifest.quarantine.code, "unsupported");
  assert.match(legacyResult.manifest.quarantine.message, /legacy Office/);

  const truncated = fixture.subarray(0, 400);
  const truncatedResult = await normalize({ bytes: Buffer.from(truncated), filename: "broken.msg" });
  assert.equal(truncatedResult.manifest.status, "quarantined");
  assert.equal(truncatedResult.manifest.quarantine.code, "malformed");

  // FAT loop: point a stream chain at itself.
  const loop = Buffer.from(fixture);
  loop.writeUInt32LE(3, 512 + 3 * 4); // sector 3 -> itself
  const loopResult = await normalize({ bytes: loop, filename: "loop.msg" });
  assert.equal(loopResult.manifest.status, "quarantined");
  assert.equal(loopResult.manifest.quarantine.code, "malformed");

  // Directory tree cycle: root child points at an entry whose right pointer returns to it.
  const cycle = Buffer.from(fixture);
  cycle.writeInt32LE(1, 512 + SECTOR + 2 * 128 + 72); // entry2.right -> entry1 (already visited)
  const cycleResult = await normalize({ bytes: cycle, filename: "cycle.msg" });
  assert.equal(cycleResult.manifest.status, "quarantined");
  assert.equal(cycleResult.manifest.quarantine.code, "malformed");
});

test("FEAT-020: RTF-only bodies surface as a fidelity warning instead of silence", async () => {
  const rtfOnly = buildCfb([
    { name: "Root Entry", type: 5, child: 1 },
    { name: "__substg1.0_0037001F", type: 2, content: utf16le("RTF mail"), right: 2 },
    { name: "__substg1.0_10090102", type: 2, content: Buffer.from([1, 2, 3, 4]) }
  ]);
  const result = await normalize({ bytes: rtfOnly, filename: "rtf.msg" });
  assert.equal(result.manifest.status, "complete");
  assert.ok(result.manifest.quality_warnings.includes("rtf-compressed-body-not-decompressed"));
});
