import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { deflateSync, zipSync, strToU8 } from "fflate";

import { byteHash } from "../../packages/core/index.mjs";
import { descriptors, normalize, portableArtifacts, runRestrictedNormalizer } from "../../packages/normalizers/index.mjs";

const root = process.cwd();
const fixture = (name) => readFile(join(root, "fixtures/normalization", name));

function makePdf(value = "Hello PDF") {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${value.length + 31} >>\nstream\nBT /F1 12 Tf 72 72 Td (${value}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let body = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body); body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

const packages = {
  docx: () => zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8("<w:document xmlns:w='w'><w:body><w:p><w:r><w:t>Heading</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>") }),
  xlsx: () => zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "xl/workbook.xml": strToU8("<workbook><sheets><sheet name='Data' sheetId='1'/></sheets><definedNames><definedName name='Area'>Data!A1:B2</definedName></definedNames></workbook>"), "xl/worksheets/sheet1.xml": strToU8("<worksheet><dimension ref='A1:B2'/><sheetData><row r='1'><c r='A1'><v>1</v></c><c r='B1'><f>A1+1</f><v>2</v></c></row></sheetData></worksheet>") }),
  pptx: () => zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "ppt/presentation.xml": strToU8("<p:presentation xmlns:p='p'/>"), "ppt/slides/slide1.xml": strToU8("<p:sld xmlns:p='p' xmlns:a='a'><p:sp><a:t>Title</a:t></p:sp><p:cxnSp/></p:sld>") }),
  vsdx: () => zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "visio/pages/page1.xml": strToU8("<PageContents><Shapes><Shape ID='1' NameU='Start'><Text>Start</Text></Shape><Shape ID='2' NameU='Next'><Text>Next</Text></Shape></Shapes><Connect FromSheet='1' ToSheet='2'/></PageContents>") })
};

test("FEAT-003 descriptor, manifest, and unit schemas validate every deterministic profile", async () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true }); addFormats(ajv);
  const schemas = await Promise.all(["normalizer-descriptor", "normalization-manifest", "normalized-unit"].map(async (name) => JSON.parse(await readFile(join(root, `core/schemas/normalization/${name}.schema.json`), "utf8"))));
  const [descriptorSchema, manifestSchema, unitSchema] = schemas.map((schema) => ajv.compile(schema));
  for (const descriptor of Object.values(descriptors)) assert.equal(descriptorSchema(descriptor), true, JSON.stringify(descriptorSchema.errors));
  const result = await normalize({ bytes: await fixture("sample.md"), filename: "sample.md" });
  assert.equal(manifestSchema(result.manifest), true, JSON.stringify(manifestSchema.errors));
  for (const unit of result.units) assert.equal(unitSchema(unit), true, JSON.stringify(unitSchema.errors));
});

test("FEAT-003 Markdown, text, and CSV locators are deterministic and bounded", async () => {
  const markdown = await normalize({ bytes: await fixture("sample.md"), filename: "sample.md" });
  assert(markdown.units.some(({ locator }) => locator.kind === "heading")); assert(markdown.units.some(({ kind }) => kind === "code-fence"));
  const again = await normalize({ bytes: await fixture("sample.md"), filename: "sample.md" }); assert.deepEqual(again, markdown);
  const plain = await normalize({ bytes: Buffer.from("First\nSecond\n"), filename: "notes.txt" }); assert.deepEqual(plain.units.find(({ text }) => text === "Second").locator, { kind: "line-range", start_line: 2, end_line: 2 }); assert.equal(plain.units[0].structured_data.encoding, "utf-8");
  const csv = await normalize({ bytes: await fixture("sample.csv"), filename: "sample.csv", settings: { sample_rows: 2 } });
  assert.equal(csv.units[0].locator.kind, "range"); assert.equal(csv.units[0].structured_data.row_count, 3); assert.equal(csv.manifest.status, "partial");
});

test("FEAT-003 PDF and GIF profiles expose page/bounding and frame/time contracts", async () => {
  const pdf = await normalize({ bytes: makePdf(), filename: "misleading.txt" }); assert.equal(pdf.manifest.format, "pdf"); assert(pdf.units.some(({ locator }) => locator.kind === "page-bbox")); assert.match(pdf.units.find(({ kind }) => kind === "pdf-page").text, /Hello PDF/);
  const gif = await normalize({ bytes: Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"), filename: "pixel.gif" });
  assert.equal(gif.manifest.format, "gif"); assert(gif.units.some(({ locator }) => locator.kind === "frame")); assert(gif.units.some(({ locator }) => locator.kind === "time-range")); assert.equal(gif.manifest.coverage.discovered, 1);
});

test("FEAT-003 OOXML and VSDX signatures select allowlisted structural profiles and locators", async () => {
  for (const [format, create] of Object.entries(packages)) {
    const result = await normalize({ bytes: create(), filename: `wrong.${format === "docx" ? "xlsx" : "docx"}` });
    assert.equal(result.manifest.format, format); assert(result.units.length > 0); assert(result.units.every(({ locator }) => typeof locator.kind === "string"));
    for (const locatorKind of descriptors[format].locator_kinds) assert(result.units.some(({ locator }) => locator.kind === locatorKind), `${format} missing ${locatorKind}`);
  }
});

test("FEAT-003 Draw.io inventory is structural and active content quarantines", async () => {
  const safe = await normalize({ bytes: await fixture("sample.drawio"), filename: "diagram.drawio" });
  assert.equal(safe.units.filter(({ kind }) => kind === "connector").length, 1); assert.equal(safe.units.at(-1).locator.kind, "diagram-cell");
  const unsafe = await normalize({ bytes: await fixture("malicious.drawio"), filename: "diagram.drawio" }); assert.equal(unsafe.manifest.quarantine.code, "unsafe-active-content");
  const compressed = Buffer.from(deflateSync(strToU8(encodeURIComponent("<mxGraphModel><root><mxCell id='compressed' value='Safe'/></root></mxGraphModel>")))).toString("base64");
  const decoded = await normalize({ bytes: Buffer.from(`<mxfile><diagram>${compressed}</diagram></mxfile>`), filename: "compressed.drawio" }); assert.equal(decoded.units[0].locator.cell, "compressed");
});

test("FEAT-003 corrupt, encrypted, oversized, archive-bomb, external, macro, and unsupported inputs quarantine", async () => {
  const cases = [
    [await fixture("corrupt.pdf"), "bad.pdf", "malformed", {}],
    [Buffer.from("%PDF-1.7\n/Encrypt 1 0 R\n"), "locked.pdf", "encrypted", {}],
    [Buffer.from("too large"), "large.txt", "limit-exceeded", { source_bytes: 2 }],
    [Buffer.from([0, 1, 2, 3]), "unknown.bin", "unsupported", {}],
    [zipSync({ "word/document.xml": strToU8("<w:document/>"), "word/_rels/document.xml.rels": strToU8("<Relationships><Relationship TargetMode='External' Target='https://example.invalid'/></Relationships>") }), "bad.docx", "external-relationship", {}],
    [zipSync({ "word/document.xml": strToU8("<w:document/>"), "word/vbaProject.bin": new Uint8Array([1]) }), "macro.docx", "unsafe-active-content", {}],
    [zipSync({ "word/document.xml": new Uint8Array(10_000) }), "bomb.docx", "limit-exceeded", { expanded_bytes: 100 }]
  ];
  for (const [bytes, filename, code, limits] of cases) assert.equal((await normalize({ bytes, filename, limits })).manifest.quarantine.code, code);
  assert.equal((await normalize({ bytes: Buffer.from("safe"), filename: "safe.txt", sourceHash: `sha256:${"0".repeat(64)}` })).manifest.quarantine.code, "source-hash-mismatch");
});

test("FEAT-003 deterministic units and probabilistic model-derived units remain separate", async () => {
  const bytes = Buffer.from("evidence"); const sourceHash = byteHash(bytes);
  const derived = { unit_id: "unit_0123456789abcdef", kind: "ocr", parent_id: null, order: 0, text: "model text", locator: { kind: "line-range", start_line: 1, end_line: 1 }, source_hash: sourceHash, extraction_method: { mode: "probabilistic", normalizer: "kdlc.ocr", version: "1.0.0", model: { id: "fixture", version: "1" } }, quality_warnings: ["probabilistic"] };
  const result = await normalize({ bytes, filename: "source.txt", probabilisticUnits: [derived] });
  assert(result.units.length > 0); assert.equal(result.probabilisticUnits.length, 1); assert.deepEqual(result.manifest.outputs.map(({ mode }) => mode), ["deterministic", "probabilistic"]);
  const invalid = await normalize({ bytes, filename: "source.txt", probabilisticUnits: [{ ...derived, extraction_method: { ...derived.extraction_method, model: undefined } }] }); assert.equal(invalid.manifest.status, "quarantined");
  const localized = await normalize({ bytes, filename: "source.txt", settings: { language: "en-US" } }); assert(localized.units.every(({ language }) => language === "en-US"));
  const artifacts = portableArtifacts(result, "src_fixture"); assert.match(artifacts.directory, /^sources\/normalized\/src_fixture\/sha256-[a-f0-9]{64}$/); assert(!artifacts.directory.includes(":")); assert(Object.keys(artifacts.files).some((path) => path.endsWith("manifest.json")));
});

test("FEAT-003 restricted JSONL worker refuses active policy and returns bounded output", async () => {
  const child = spawn(process.execPath, [join(root, "workers/normalizer/worker.mjs")], { shell: false, env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { output += chunk; });
  child.stdin.end(`${JSON.stringify({ id: "ok", bytes_base64: Buffer.from("safe").toString("base64"), filename: "safe.txt", network: false, execute: false })}\n${JSON.stringify({ id: "deny", bytes_base64: "", filename: "safe.txt", network: true })}\n`);
  await once(child, "exit"); const records = output.trim().split("\n").map(JSON.parse); assert.equal(records[0].ok, true); assert.equal(records[1].ok, false); assert.match(records[1].error.message, /forbids/);
  const isolated = await runRestrictedNormalizer({ id: "isolated", bytes_base64: Buffer.from("bounded").toString("base64"), filename: "safe.txt" }, { timeoutMs: 5_000 });
  assert.equal(isolated.manifest.security.network, false); assert.equal(isolated.units.find(({ kind }) => kind === "line").text, "bounded");
  await assert.rejects(runRestrictedNormalizer({ id: "limited", bytes_base64: Buffer.from("bounded").toString("base64"), filename: "safe.txt" }, { outputBytes: 1 }), /output limit/);
});
