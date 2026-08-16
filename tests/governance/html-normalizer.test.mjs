import assert from "node:assert/strict";
import test from "node:test";

import { descriptors, normalize } from "../../packages/normalizers/index.mjs";

const page = `<!DOCTYPE html>
<html lang="en">
<head><title>Failover &amp; Recovery</title><style>p { color: red }</style></head>
<body>
<h1>Failover</h1>
<p>The timeout is <b>30 seconds</b> &mdash; confirmed.</p>
<script type="text/javascript">steal(document.cookie)</script>
<h2>Steps</h2>
<ul><li>Drain traffic</li><li>Promote replica</li></ul>
<table><tr><th>Cluster</th><th>Timeout</th></tr><tr><td>legacy</td><td>90s</td></tr></table>
<p>See <a href="https://wiki.example/runbook">the runbook</a> and
<a href="javascript:alert(1)">click me</a>.</p>
</body></html>`;

test("FEAT-022: html descriptor registered; format profiles derive", async () => {
  assert.ok(descriptors.html);
  assert.deepEqual(descriptors.html.locator_kinds, ["dom-path"]);
  const { distributionDefinition } = await import("../../packages/adapters/definitions.mjs");
  assert.ok(distributionDefinition.format_profiles.includes("html"));
});

test("FEAT-022: a page yields metadata, headings, paragraphs, lists, tables, and safe links", async () => {
  const result = await normalize({ bytes: Buffer.from(page), filename: "runbook.html" });
  assert.equal(result.manifest.format, "html");
  assert.equal(result.manifest.status, "complete");

  const metadata = result.units.find(({ kind }) => kind === "html-metadata");
  assert.equal(metadata.structured_data.title, "Failover & Recovery");
  assert.equal(metadata.structured_data.language, "en");

  const headings = result.units.filter(({ kind }) => kind === "heading");
  assert.deepEqual(headings.map(({ text }) => text), ["Failover", "Steps"]);
  assert.deepEqual(headings.map(({ structured_data }) => structured_data.level), [1, 2]);
  assert.match(headings[0].locator.path, /^\/html\[1\]\/body\[1\]\/h1\[1\]$/);

  const paragraph = result.units.find(({ kind }) => kind === "paragraph");
  assert.equal(paragraph.text, "The timeout is 30 seconds — confirmed.");
  assert.ok(!JSON.stringify(result.units).includes("steal"), "script content removed");
  assert.ok(result.manifest.quality_warnings.includes("scripts-and-styles-removed"));

  assert.deepEqual(result.units.filter(({ kind }) => kind === "list-item").map(({ text }) => text), ["Drain traffic", "Promote replica"]);

  const rows = result.units.filter(({ kind }) => kind === "table-row");
  assert.deepEqual(rows[0].structured_data.cells, ["Cluster", "Timeout"]);
  assert.deepEqual(rows[1].structured_data.cells, ["legacy", "90s"]);

  const links = result.units.filter(({ kind }) => kind === "link");
  assert.equal(links.length, 1, "javascript: link dropped");
  assert.equal(links[0].structured_data.destination, "https://wiki.example/runbook");
  assert.ok(result.manifest.quality_warnings.includes("active-link-targets-dropped"));

  assert.ok(result.units.every(({ locator }) => locator.kind === "dom-path"));
});

test("FEAT-022: sanitization survives the CodeQL-class evasions", async () => {
  const tricky = `<html><body>
<script foo="bar">leak()</script ><p>&amp;lt;kept&amp;gt; &amp; done</p>
<style media="all">bad{}</style
><p>after</p>
<script>unterminated to end`;
  const result = await normalize({ bytes: Buffer.from(tricky), filename: "t.html" });
  const blob = JSON.stringify(result.units);
  assert.ok(!blob.includes("leak") && !blob.includes("bad{}") && !blob.includes("unterminated"));
  const first = result.units.find(({ kind }) => kind === "paragraph");
  assert.equal(first.text, "&lt;kept&gt; & done", "single-pass entity decode never double-decodes");
});

test("FEAT-022: table cells honor the single-pass entity invariant; obfuscated active links are dropped (review round)", async () => {
  const page2 = `<html><body>
<table><tr><td>&amp;lt;kept&amp;gt;</td></tr></table>
<p><a href="java\tscript:alert(1)">tab</a>
<a href="&#106;avascript:alert(1)">entity</a>
<a href="javascript&colon;alert(1)">colon-entity</a>
<a href="https://safe.example/x">safe</a></p>
</body></html>`;
  const result = await normalize({ bytes: Buffer.from(page2), filename: "t2.html" });
  const row = result.units.find(({ kind }) => kind === "table-row");
  assert.deepEqual(row.structured_data.cells, ["&lt;kept&gt;"], "cells decode exactly once");
  const links = result.units.filter(({ kind }) => kind === "link");
  // &colon; is not a decoded entity, so that target survives as literal text —
  // but tab and numeric-entity obfuscations must be dropped.
  assert.ok(!links.some(({ structured_data }) => /alert\(1\)/.test(structured_data.destination) && /^java/i.test(structured_data.destination.replace(/[\s]/g, ""))), "obfuscated javascript: targets dropped");
  assert.ok(links.some(({ structured_data }) => structured_data.destination === "https://safe.example/x"));
  assert.ok(result.manifest.quality_warnings.includes("active-link-targets-dropped"));
});

test("FEAT-022: malformed and hostile structures degrade or quarantine deterministically", async () => {
  const misnested = "<html><body><p>one<div>two</p></div><h3>tail</h3>";
  const result = await normalize({ bytes: Buffer.from(misnested), filename: "m.html" });
  assert.equal(result.manifest.status, "complete");
  assert.ok(result.units.some(({ kind, text }) => kind === "heading" && text === "tail"));

  const deep = `<html><body>${"<div>".repeat(150)}x`;
  const nested = await normalize({ bytes: Buffer.from(deep), filename: "d.html" });
  assert.equal(nested.manifest.status, "quarantined");
  assert.equal(nested.manifest.quarantine.code, "limit-exceeded");

  const empty = await normalize({ bytes: Buffer.from("<html></html>"), filename: "e.html" });
  assert.equal(empty.manifest.status, "quarantined");
  assert.equal(empty.manifest.quarantine.code, "malformed");

  const twice = await normalize({ bytes: Buffer.from(page), filename: "runbook.html" });
  const again = await normalize({ bytes: Buffer.from(page), filename: "runbook.html" });
  assert.deepEqual(twice, again, "deterministic");
});

test("FEAT-022: latin1 pages fall back with a warning; signature detection works without extension", async () => {
  const latin = Buffer.concat([Buffer.from("<html><body><p>caf"), Buffer.from([0xe9]), Buffer.from("</p></body></html>")]);
  const result = await normalize({ bytes: latin, filename: "l.html" });
  assert.equal(result.manifest.status, "complete");
  assert.match(result.units.find(({ kind }) => kind === "paragraph").text, /café/);
  assert.ok(result.manifest.quality_warnings.includes("non-utf8-decoded-as-latin1"));

  const sniffed = await normalize({ bytes: Buffer.from("<!DOCTYPE html><html><body><p>hi</p></body></html>"), filename: "download.bin" });
  assert.equal(sniffed.manifest.format, "html");
});
