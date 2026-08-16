import assert from "node:assert/strict";
import test from "node:test";

import { descriptors, normalize } from "../../packages/normalizers/index.mjs";

const boundary = "kdlc-boundary-1";
const message = [
  "From: Ana Lima <ana@example.com>",
  "To: team@example.com",
  "Subject: =?UTF-8?B?UTMgYXJjaGl0ZWN0dXJlIHJldmlldyDinIU=?=",
  "Date: Mon, 10 Aug 2026 09:00:00 +0000",
  "Message-ID: <m1@example.com>",
  "MIME-Version: 1.0",
  `Content-Type: multipart/mixed; boundary="${boundary}"`,
  "",
  `--${boundary}`,
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "The failover timeout is 30 seconds =E2=80=94 confirmed.",
  `--${boundary}`,
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><body><h1>Summary</h1><p>See the <b>attached</b> deck.</p><script>evil()</script></body></html>",
  `--${boundary}`,
  "Content-Type: application/pdf",
  "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="review-deck.pdf"',
  "",
  Buffer.from("%PDF-1.4 fake").toString("base64"),
  `--${boundary}--`,
  ""
].join("\r\n");

test("FEAT-019: eml descriptor is registered and derives into the format profiles", async () => {
  assert.ok(descriptors.eml);
  assert.deepEqual(descriptors.eml.accepted.extensions, [".eml"]);
  assert.deepEqual(descriptors.eml.locator_kinds, ["header", "mime-part"]);
  const { distributionDefinition } = await import("../../packages/adapters/definitions.mjs");
  assert.ok(distributionDefinition.format_profiles.includes("eml"));
});

test("FEAT-019: a multipart email yields decoded headers, bodies, and an attachment inventory", async () => {
  const result = await normalize({ bytes: Buffer.from(message), filename: "review.eml" });
  assert.equal(result.manifest.format, "eml");
  assert.equal(result.manifest.status, "complete");

  const structure = result.units.find(({ kind }) => kind === "email-structure");
  assert.equal(structure.structured_data.from, "Ana Lima <ana@example.com>");
  assert.equal(structure.structured_data.subject, "Q3 architecture review ✅", "RFC 2047 B-encoding decoded");

  const bodies = result.units.filter(({ kind }) => kind === "email-body");
  assert.match(bodies[0].text, /30 seconds — confirmed/, "quoted-printable decoded to UTF-8");
  assert.match(bodies[1].text, /Summary\s+See the attached deck\./);
  assert.ok(!bodies[1].text.includes("evil"), "script content stripped");
  assert.ok(bodies[1].quality_warnings.includes("html-tags-stripped"));

  // CodeQL round: spaced close tags and staged entities cannot leak or double-decode.
  const tricky = await normalize({
    bytes: Buffer.from('From: a@b.c\r\nSubject: t\r\nContent-Type: text/html\r\n\r\n<script foo="bar">leak()</script ><p>&amp;lt;kept&amp;gt; &amp; done</p>'),
    filename: "tricky.eml"
  });
  const trickyBody = tricky.units.find(({ kind }) => kind === "email-body").text;
  assert.ok(!trickyBody.includes("leak"), "spaced/attributed close tag still strips the block");
  assert.match(trickyBody, /&lt;kept&gt; & done/, "&amp;lt; decodes once, never twice");

  const attachment = result.units.find(({ kind }) => kind === "email-attachment");
  assert.equal(attachment.structured_data.filename, "review-deck.pdf");
  assert.equal(attachment.structured_data.media_type, "application/pdf");
  assert.match(attachment.structured_data.content_hash, /^sha256:[a-f0-9]{64}$/);
  assert.ok(attachment.quality_warnings[0].includes("separate source"));
  assert.ok(!("text" in attachment) || !attachment.text, "attachment content never becomes text");

  assert.ok(result.units.every(({ locator }) => ["header", "mime-part"].includes(locator.kind)));
  assert.ok(result.manifest.quality_warnings.includes("attachments-inventoried-not-extracted"));
});

test("FEAT-019: non-mail input and unbounded nesting quarantine instead of crashing", async () => {
  const notMail = await normalize({ bytes: Buffer.from("just some notes\nwithout headers\n"), filename: "notes.eml" });
  assert.equal(notMail.manifest.status, "quarantined");
  assert.equal(notMail.manifest.quarantine.code, "malformed");

  let bomb = "Content-Type: text/plain\r\n\r\ndeep";
  for (let index = 0; index < 12; index += 1) {
    bomb = `Content-Type: multipart/mixed; boundary="b${index}"\r\n\r\n--b${index}\r\n${bomb}\r\n--b${index}--\r\n`;
  }
  const nested = await normalize({ bytes: Buffer.from(`From: a@b.c\r\nSubject: bomb\r\n${bomb}`), filename: "bomb.eml" });
  assert.equal(nested.manifest.status, "quarantined");
  assert.equal(nested.manifest.quarantine.code, "limit-exceeded");
});

test("FEAT-019: latin1 bodies fall back with a warning; unknown charsets never lose header bytes", async () => {
  const latin = Buffer.concat([
    Buffer.from("From: a@b.c\r\nSubject: caf\r\nContent-Type: text/plain; charset=iso-8859-1\r\n\r\n"),
    Buffer.from([0x63, 0x61, 0x66, 0xe9])
  ]);
  const result = await normalize({ bytes: latin, filename: "latin.eml" });
  assert.equal(result.manifest.status, "complete");
  assert.match(result.units.find(({ kind }) => kind === "email-body").text, /café/);

  const weird = await normalize({ bytes: Buffer.from("From: a@b.c\r\nSubject: =?x-mystery?B?QUJD?=\r\n\r\nhi"), filename: "weird.eml" });
  assert.equal(weird.manifest.status, "complete");
  const subject = weird.units.find(({ kind, locator }) => kind === "email-header" && locator.name === "Subject");
  assert.match(subject.text, /=\?x-mystery\?B\?QUJD\?=/, "unknown charset retained verbatim");
  assert.ok(weird.manifest.quality_warnings.includes("unknown-header-charset-retained"));
});
