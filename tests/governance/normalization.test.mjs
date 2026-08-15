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
const manifestAjv = new Ajv2020({ strict: true, allErrors: true }); addFormats(manifestAjv);
const manifestValidator = manifestAjv.compile(JSON.parse(await readFile(join(root, "core/schemas/normalization/normalization-manifest.schema.json"), "utf8")));

function makePdf(value = "Hello PDF", catalogAction = "") {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${catalogAction} >>`,
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

const opc = (part, contentType) => ({ "[Content_Types].xml": strToU8(`<Types><Override PartName='/${part}' ContentType='${contentType}'/></Types>`), "_rels/.rels": strToU8(`<Relationships><Relationship Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument' Target='${part}'/></Relationships>`) });
const packages = {
  docx: () => zipSync({ ...opc("word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"), "word/document.xml": strToU8("<w:document xmlns:w='w'><w:body><w:p><w:r><w:t>Heading</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>") }),
  xlsx: () => zipSync({ ...opc("xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"), "xl/workbook.xml": strToU8("<workbook><sheets><sheet name='Data' sheetId='1'/></sheets><definedNames><definedName name='Area'>Data!A1:B2</definedName></definedNames></workbook>"), "xl/worksheets/sheet1.xml": strToU8("<worksheet><dimension ref='A1:B2'/><sheetData><row r='1'><c r='A1'><v>1</v></c><c r='B1'><f>A1+1</f><v>2</v></c></row></sheetData></worksheet>") }),
  pptx: () => zipSync({ ...opc("ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"), "ppt/presentation.xml": strToU8("<p:presentation xmlns:p='p'/>"), "ppt/slides/slide1.xml": strToU8("<p:sld xmlns:p='p' xmlns:a='a'><p:sp><a:t>Title</a:t></p:sp><p:cxnSp/></p:sld>") }),
  vsdx: () => zipSync({ ...opc("visio/document.xml", "application/vnd.ms-visio.drawing.main+xml"), "visio/document.xml": strToU8("<VisioDocument/>"), "visio/pages/page1.xml": strToU8("<PageContents><Shapes><Shape ID='1' NameU='Start'><Text>Start</Text></Shape><Shape ID='2' NameU='Next'><Text>Next</Text></Shape></Shapes><Connect FromSheet='1' ToSheet='2'/></PageContents>") })
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
  const derived = { unit_id: "unit_0123456789abcdef", kind: "ocr", parent_id: null, order: 0, text: "model text", locator: { kind: "line-range", start_line: 1, end_line: 1 }, source_hash: sourceHash, extraction_method: { mode: "probabilistic", normalizer: "kdlc.ocr", version: "1.0.0", model: { id: "fixture", version: "1", provider: "recorded-fixture", recorded_output_hash: `sha256:${"b".repeat(64)}` } }, quality_warnings: ["probabilistic"] };
  const result = await normalize({ bytes, filename: "source.txt", sourceId: "src_fixture", probabilisticUnits: [derived] });
  assert(result.units.length > 0); assert.equal(result.probabilisticUnits.length, 1); assert.deepEqual(result.manifest.outputs.map(({ mode }) => mode), ["deterministic", "probabilistic"]);
  await assert.rejects(normalize({ bytes, filename: "source.txt", probabilisticUnits: [{ ...derived, extraction_method: { ...derived.extraction_method, model: undefined } }] }), /plain data/);
  const invalidLocator = await normalize({ bytes, filename: "source.txt", probabilisticUnits: [{ ...derived, locator: { kind: "page" } }] }); assert.equal(invalidLocator.manifest.quarantine.code, "invalid-probabilistic-output");
  const wrongProfileLocator = await normalize({ bytes, filename: "source.txt", probabilisticUnits: [{ ...derived, locator: { kind: "page", page: 1 } }] }); assert.equal(wrongProfileLocator.manifest.quarantine.code, "invalid-probabilistic-output");
  const localized = await normalize({ bytes, filename: "source.txt", settings: { language: "en-US" } }); assert(localized.units.every(({ language }) => language === "en-US"));
  const artifacts = portableArtifacts(result, "src_fixture"); assert.match(artifacts.directory, /^sources\/normalized\/src_fixture\/sha256-[a-f0-9]{64}$/); assert(!artifacts.directory.includes(":")); assert(Object.keys(artifacts.files).some((path) => path.endsWith("manifest.json")));
});

test("FEAT-003 restricted JSONL worker refuses active policy and returns bounded output", async () => {
  const { normalizeInRestrictedWorker } = await import("../../packages/normalizers/src/normalize.mjs");
  await assert.rejects(normalizeInRestrictedWorker({ bytes: Buffer.from("bypass") }), /restricted worker capability/);
  const child = spawn(process.execPath, ["--permission", "--allow-worker", "--allow-addons", `--allow-fs-read=${root}`, join(root, "workers/normalizer/worker.mjs")], { shell: false, env: { PATH: process.env.PATH, KDLC_RESTRICTED_WORKER: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { output += chunk; });
  child.stdin.end(`${JSON.stringify({ id: "ok", bytes_base64: Buffer.from("safe").toString("base64"), filename: "safe.txt", network: false, execute: false })}\n${JSON.stringify({ id: "deny", bytes_base64: "", filename: "safe.txt", network: true })}\n`);
  await once(child, "exit"); const records = output.trim().split("\n").map(JSON.parse); assert.equal(records[0].ok, true); assert.equal(records[1].ok, false); assert.match(records[1].error.message, /forbids/);
  const isolated = await runRestrictedNormalizer({ id: "isolated", bytes_base64: Buffer.from("bounded").toString("base64"), filename: "safe.txt" }, { timeoutMs: 5_000 });
  assert.equal(isolated.manifest.security.network, false); assert.equal(isolated.units.find(({ kind }) => kind === "line").text, "bounded");
  await assert.rejects(runRestrictedNormalizer({ id: "limited", bytes_base64: Buffer.from("bounded").toString("base64"), filename: "safe.txt" }, { outputBytes: 1 }), /output limit/);
  await assert.rejects(runRestrictedNormalizer({ id: "too-many", bytes_base64: Buffer.from("bounded").toString("base64"), filename: "safe.txt", probabilisticUnits: Array.from({ length: 10_001 }, () => null) }), /count exceeds/);
  const nearMegabyte = { text: "x".repeat(999_000) };
  await assert.rejects(runRestrictedNormalizer({ id: "cumulative", bytes_base64: "", filename: "safe.txt", probabilisticUnits: Array(10_000).fill(nearMegabyte) }), /serialized size limit/);
  await assert.rejects(normalize({ bytes: new Uint8Array(25_000_001), filename: "huge.txt" }), /Raw normalization source/);
  let getterCalls = 0; const getterUnit = {}; Object.defineProperty(getterUnit, "text", { enumerable: true, get() { getterCalls += 1; return "changed"; } });
  await assert.rejects(runRestrictedNormalizer({ id: "getter", bytes_base64: "", probabilisticUnits: [getterUnit] }), /accessors/); assert.equal(getterCalls, 0);
  let toJsonCalls = 0; const toJsonUnit = { toJSON() { toJsonCalls += 1; return { text: "changed" }; } };
  await assert.rejects(runRestrictedNormalizer({ id: "tojson", bytes_base64: "", probabilisticUnits: [toJsonUnit] }), /toJSON/); assert.equal(toJsonCalls, 0);
});

test("FEAT-003 trusted ceilings, package identity, provenance, and portable paths fail closed", async () => {
  await assert.rejects(() => normalize({ bytes: Buffer.from("safe"), filename: "safe.txt", limits: { source_bytes: 99_000_000 } }), /cannot relax/);
  await assert.rejects(runRestrictedNormalizer({ id: "relax", bytes_base64: "", filename: "safe.txt", limits: { processing_ms: 99_000 } }), /cannot relax/);
  const spoofed = zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8("<w:document/>") });
  assert.equal((await normalize({ bytes: spoofed, filename: "spoof.docx" })).manifest.quarantine.code, "malformed");
  const lookalikeRelationship = zipSync({ ...opc("word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"), "_rels/.rels": strToU8("<Relationships><Relationship Type='https://attacker.invalid/officeDocument' Target='word/document.xml'/></Relationships>"), "word/document.xml": strToU8("<w:document/>") });
  assert.equal((await normalize({ bytes: lookalikeRelationship, filename: "spoof.docx" })).manifest.quarantine.code, "malformed");
  const activePdf = await normalize({ bytes: makePdf("linked", "/OpenAction << /S /URI /URI (https://example.invalid) >>"), filename: "linked.pdf" });
  assert.equal(activePdf.manifest.quarantine.code, "external-relationship");
  const externalDrawio = await normalize({ bytes: Buffer.from("<mxfile><diagram><mxGraphModel><root><mxCell id='1' href='https://example.invalid'/></root></mxGraphModel></diagram></mxfile>"), filename: "external.drawio" });
  assert.equal(externalDrawio.manifest.quarantine.code, "external-relationship");
  const bomb = Buffer.from(deflateSync(strToU8(encodeURIComponent(`<mxGraphModel><root>${" ".repeat(50_000)}</root></mxGraphModel>`)))).toString("base64");
  assert.equal((await normalize({ bytes: Buffer.from(`<mxfile><diagram>${bomb}</diagram></mxfile>`), filename: "bomb.drawio" })).manifest.quarantine.code, "limit-exceeded");
  await assert.rejects(() => normalize({ bytes: Buffer.from("safe"), filename: "safe.txt", settings: { invalid: 1n } }), /JSON serializable/);
  const quarantined = await normalize({ bytes: Buffer.from([0, 1, 2]), filename: "bad.bin" }); assert.doesNotThrow(() => JSON.stringify(quarantined.manifest));
  assert.doesNotThrow(() => portableArtifacts(quarantined, quarantined.manifest.source_id));
  const safe = await normalize({ bytes: Buffer.from("safe"), filename: "safe.txt" }); assert.throws(() => portableArtifacts(safe, ".."), /portable/);
  assert.throws(() => portableArtifacts(safe, "different"), /does not match/);
  const badMetadata = await normalize({ bytes: Buffer.from("safe"), filename: "safe.txt", sourceId: "../escape", normalizedAt: "not-a-time" });
  assert.equal(badMetadata.manifest.status, "quarantined"); assert.match(badMetadata.manifest.source_id, /^source-/); assert.equal(badMetadata.manifest.normalized_at, "1970-01-01T00:00:00.000Z");
  for (const settings of [[], null]) {
    const invalidSettings = await normalize({ bytes: Buffer.from("safe"), filename: "safe.txt", settings });
    assert.equal(invalidSettings.manifest.quarantine.code, "invalid-settings"); assert.deepEqual(invalidSettings.manifest.settings, {}); assert.equal(manifestValidator(invalidSettings.manifest), true, JSON.stringify(manifestValidator.errors));
  }
  const invalidCalendar = await normalize({ bytes: Buffer.from("safe"), filename: "safe.txt", normalizedAt: "2026-02-30T00:00:00Z" });
  assert.equal(invalidCalendar.manifest.quarantine.code, "invalid-source-metadata"); assert.equal(invalidCalendar.manifest.normalized_at, "1970-01-01T00:00:00.000Z"); assert.equal(manifestValidator(invalidCalendar.manifest), true, JSON.stringify(manifestValidator.errors));
  const valid = await normalize({ bytes: Buffer.from("safe"), filename: "safe.txt", sourceId: "source-7", normalizedAt: "2026-08-15T00:00:00Z" });
  assert.equal(valid.manifest.source_id, "source-7"); assert.equal(valid.manifest.normalized_at, "2026-08-15T00:00:00Z"); assert.equal(manifestValidator(valid.manifest), true, JSON.stringify(manifestValidator.errors));
  assert.match(valid.manifest.semantics_hash, /^sha256:[a-f0-9]{64}$/);
  const later = await normalize({ bytes: Buffer.from("safe"), filename: "safe.txt", sourceId: "source-7", normalizedAt: "2026-08-15T00:00:01Z" });
  assert.notEqual(portableArtifacts(valid, "source-7").directory, portableArtifacts(later, "source-7").directory);
  const changedUnit = structuredClone(valid); changedUnit.units[0].source_hash = `sha256:${"0".repeat(64)}`;
  assert.throws(() => portableArtifacts(changedUnit, "source-7"), /semantics|source-unbound/);
  const changedManifest = structuredClone(valid); changedManifest.manifest.outputs[0].hash = `sha256:${"0".repeat(64)}`;
  assert.throws(() => portableArtifacts(changedManifest, "source-7"), /semantics|output hashes/);
  for (const mutate of [
    (copy) => { copy.manifest.normalizer.version = "9.9.9"; },
    (copy) => { copy.manifest.settings = { language: "fr" }; },
    (copy) => { copy.manifest.coverage.emitted += 1; },
    (copy) => { copy.descriptor.version = "9.9.9"; }
  ]) {
    const changed = structuredClone(valid); mutate(changed);
    assert.throws(() => portableArtifacts(changed, "source-7"), /semantics were mutated/);
  }
});
