import { parse as parseCsv } from "csv-parse/sync";
import { inflateSync, unzipSync } from "fflate";
import { decompressFrames, parseGIF } from "gifuct-js";
import { SaxesParser } from "saxes";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFile } from "node:fs/promises";

import { byteHash, canonicalJson } from "../../core/index.mjs";
import { defaultLimits, descriptors } from "./descriptors.mjs";

const decoder = new TextDecoder("utf-8", { fatal: true });
const security = Object.freeze({ network: false, executed_code: false, macros: false, external_relationships: false });
const MAX_RATIO = 100;
const unitAjv = new Ajv2020({ strict: true, allErrors: true }); addFormats(unitAjv);
unitAjv.addSchema(JSON.parse(await readFile(new URL("../../../core/schemas/common.schema.json", import.meta.url), "utf8")));
const validateUnit = unitAjv.compile(JSON.parse(await readFile(new URL("../../../core/schemas/normalization/normalized-unit.schema.json", import.meta.url), "utf8")));
const validateManifest = unitAjv.compile(JSON.parse(await readFile(new URL("../../../core/schemas/normalization/normalization-manifest.schema.json", import.meta.url), "utf8")));
const portableSourceId = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

class Quarantine extends Error { constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; } }
const exceed = (name, actual, maximum) => { if (actual > maximum) throw new Quarantine("limit-exceeded", `${name} exceeds configured limit`, { limit: name, actual, maximum }); };
const text = (bytes) => { try { return decoder.decode(bytes).normalize("NFC").replace(/\r\n?/g, "\n"); } catch { throw new Quarantine("malformed", "Input is not valid UTF-8"); } };
const xmlText = (bytes) => text(bytes).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

function parseXml(value, handlers = {}) {
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", (node) => handlers.open?.(node)); parser.on("text", (valueText) => handlers.text?.(valueText)); parser.on("closetag", (node) => handlers.close?.(node));
  parser.on("error", (error) => { throw new Quarantine("malformed", "Malformed XML", { parser: error.message }); });
  parser.write(value).close();
}

function zipParts(bytes, limits) {
  let parts; let declaredExpanded = 0; let entries = 0;
  try { parts = unzipSync(bytes, { filter(info) { entries += 1; if (entries > 10_000) throw new Quarantine("limit-exceeded", "Archive part count exceeds limit", { maximum: 10_000 }); if (info.name.split("/").includes("..")) throw new Quarantine("malformed", "Archive contains a traversal path"); declaredExpanded += info.originalSize; exceed("expanded_bytes", declaredExpanded, limits.expanded_bytes); if (info.originalSize / Math.max(info.size, 1) > 100) throw new Quarantine("limit-exceeded", "Archive entry decompression ratio exceeds limit", { part: info.name, maximum: 100 }); return true; } }); }
  catch (error) { if (error instanceof Quarantine) throw error; throw new Quarantine("malformed", "Malformed or encrypted ZIP package"); }
  const names = Object.keys(parts).sort();
  if (names.some((name) => /(^|\/)(EncryptionInfo|EncryptedPackage)$/i.test(name))) throw new Quarantine("encrypted", "Encrypted package is not supported");
  if (names.some((name) => /vbaProject|activeX|customUI|javascript/i.test(name))) throw new Quarantine("unsafe-active-content", "Package contains macros or active content");
  if (names.filter((name) => /\.xml$/i.test(name)).some((name) => /<!DOCTYPE|<!ENTITY/i.test(text(parts[name])))) throw new Quarantine("unsafe-active-content", "Package XML declarations with entities are disabled");
  const expanded = names.reduce((sum, name) => sum + parts[name].byteLength, 0); exceed("expanded_bytes", expanded, limits.expanded_bytes);
  if (expanded / Math.max(bytes.byteLength, 1) > 100) throw new Quarantine("limit-exceeded", "Archive decompression ratio exceeds limit", { ratio: expanded / Math.max(bytes.byteLength, 1), maximum: 100 });
  for (const name of names.filter((name) => name.endsWith(".rels"))) {
    const relationships = text(parts[name]);
    if (/TargetMode\s*=\s*["']External["']/i.test(relationships)) throw new Quarantine("external-relationship", "External package relationships are disabled", { part: name });
  }
  return parts;
}

function detect(bytes, filename = "", mediaType = "") {
  const prefix = new TextDecoder("latin1").decode(bytes.subarray(0, 16)); const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (prefix.startsWith("%PDF-")) return "pdf";
  if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) return "gif";
  if (prefix.startsWith("PK\x03\x04")) return "zip";
  let sample; try { sample = text(bytes.subarray(0, Math.min(bytes.length, 4096))); } catch { throw new Quarantine("unsupported", "Unknown binary content signature"); }
  if (/^\s*<mxfile(?:\s|>)/.test(sample)) return "drawio";
  if (ext === ".md" || mediaType === "text/markdown") return "markdown";
  if (ext === ".csv" || mediaType === "text/csv") return "csv";
  if (ext === ".txt" || mediaType === "text/plain") return "text";
  throw new Quarantine("unsupported", "Unsupported content signature");
}

function unitFactory(sourceHash, descriptor) {
  let order = 0;
  return (kind, locator, payload, warnings = [], mode = "deterministic") => {
    const current = order++;
    return { unit_id: `unit_${byteHash(canonicalJson({ sourceHash, kind, locator, current })).slice(7, 23)}`, kind, parent_id: null, order: current, ...payload, locator, source_hash: sourceHash, extraction_method: { mode, normalizer: descriptor.id, version: descriptor.version }, quality_warnings: warnings };
  };
}

function linesProfile(bytes, format, sourceHash) {
  const descriptor = descriptors[format]; const make = unitFactory(sourceHash, descriptor); const lines = text(bytes).split("\n"); const units = [];
  if (format === "markdown") {
    let fenceStart = null; let blockStart = 1; let heading = null;
    if (lines[0] === "---") { const end = lines.indexOf("---", 1); if (end > 0) { units.push(make("frontmatter", { kind: "line-range", start_line: 1, end_line: end + 1 }, { text: lines.slice(1, end).join("\n") })); blockStart = end + 2; } }
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]; const match = /^(#{1,6})\s+(.+)$/.exec(line);
      for (const link of line.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) units.push(make("link", { kind: "line-range", start_line: index + 1, end_line: index + 1 }, { text: link[1], structured_data: { destination: link[2] } }));
      if (/^\s*\|.*\|\s*$/.test(line) && !/^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(line)) units.push(make("table-row", { kind: "line-range", start_line: index + 1, end_line: index + 1 }, { structured_data: { cells: line.trim().slice(1, -1).split("|").map((cell) => cell.trim()) } }));
      if (/^```/.test(line)) { if (fenceStart === null) fenceStart = index; else { units.push(make("code-fence", { kind: "line-range", start_line: fenceStart + 1, end_line: index + 1, ...(heading ? { heading } : {}) }, { text: lines.slice(fenceStart, index + 1).join("\n") })); fenceStart = null; blockStart = index + 2; } continue; }
      if (match) { heading = match[2]; units.push(make("heading", { kind: "heading", heading, line: index + 1 }, { text: heading })); blockStart = index + 2; }
      else if (fenceStart === null && line.trim() && (!lines[index + 1]?.trim() || index === lines.length - 1)) units.push(make("block", { kind: "line-range", start_line: blockStart, end_line: index + 1, ...(heading ? { heading } : {}) }, { text: lines.slice(blockStart - 1, index + 1).join("\n") }));
    }
  } else {
    units.push(make("text-metadata", { kind: "line-range", start_line: 0, end_line: 0 }, { structured_data: { encoding: "utf-8", line_count: lines.length } }));
    lines.forEach((line, index) => { if (line.length) units.push(make("line", { kind: "line-range", start_line: index + 1, end_line: index + 1 }, { text: line })); });
  }
  return { descriptor, units, discovered: units.length, warnings: [] };
}

function csvProfile(bytes, sourceHash, settings, limits) {
  const descriptor = descriptors.csv; const make = unitFactory(sourceHash, descriptor); const input = text(bytes); let records;
  const delimiter = settings.delimiter ?? [",", "\t", ";", "|"].sort((left, right) => (input.split(right).length - input.split(left).length) || left.localeCompare(right))[0];
  if (typeof delimiter !== "string" || delimiter.length !== 1 || /[\r\n"']/.test(delimiter)) throw new Quarantine("malformed", "CSV delimiter must be one safe character");
  try { records = parseCsv(input, { bom: true, delimiter, relax_column_count: true, skip_empty_lines: false, to_line: limits.rows + 1 }); }
  catch (error) { throw new Quarantine("malformed", "Malformed CSV", { parser: error.message }); }
  exceed("rows", records.length, limits.rows); const columns = Math.max(0, ...records.map((row) => row.length)); const sampleLimit = Math.min(settings.sample_rows ?? 20, records.length);
  const units = [make("csv-structure", { kind: "range", start_row: 1, end_row: records.length, start_column: 1, end_column: columns }, { structured_data: { delimiter, encoding: "utf-8", headers: records[0] ?? [], row_count: records.length, column_count: columns, sample: records.slice(0, sampleLimit), type_candidates: (records[0] ?? []).map((header, column) => ({ header, type: records.slice(1, sampleLimit).every((row) => row[column] === "" || Number.isFinite(Number(row[column]))) ? "number" : "string" })) } })];
  records.slice(0, sampleLimit).forEach((row, rowIndex) => { units.push(make("csv-row", { kind: "row", row: rowIndex + 1 }, { structured_data: { values: row } })); row.forEach((value, columnIndex) => units.push(make("csv-cell", { kind: "cell", row: rowIndex + 1, column: columnIndex + 1 }, { text: value }))); });
  return { descriptor, units, discovered: records.length, warnings: sampleLimit < records.length ? ["rows-sampled"] : [] };
}

async function pdfProfile(bytes, sourceHash, limits) {
  const pdfSource = new TextDecoder("latin1").decode(bytes);
  if (pdfSource.includes("/Encrypt")) throw new Quarantine("encrypted", "Encrypted PDF is not supported");
  if (/\/S\s*\/(?:URI|GoToR|Launch|SubmitForm)\b|\/URI\s*(?:\(|<)/.test(pdfSource)) throw new Quarantine("external-relationship", "External PDF catalog, outline, and action relationships are disabled");
  const descriptor = descriptors.pdf; const make = unitFactory(sourceHash, descriptor); let document;
  try { const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); document = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useWorkerFetch: false, disableFontFace: true }).promise; }
  catch (error) { if (error?.name === "PasswordException") throw new Quarantine("encrypted", "Encrypted PDF is not supported"); throw new Quarantine("malformed", "PDF parsing failed", { parser: error.message }); }
  exceed("pages", document.numPages, limits.pages); const units = [];
  let metadata; let outline; let actions; let openAction;
  try { metadata = await document.getMetadata(); outline = await document.getOutline(); actions = await document.getJSActions(); openAction = await document.getOpenAction(); }
  catch { throw new Quarantine("malformed", "PDF catalog and action coverage could not be verified"); }
  const outlineEntries = []; const visitOutline = (items) => { for (const item of items ?? []) { outlineEntries.push(item); if (typeof (item.url ?? item.unsafeUrl) === "string") throw new Quarantine("external-relationship", "External PDF outline relationships are disabled"); visitOutline(item.items); } };
  visitOutline(outline);
  if (actions && Object.keys(actions).length) throw new Quarantine("unsafe-active-content", "PDF JavaScript actions are disabled");
  if (openAction && typeof (openAction.url ?? openAction.unsafeUrl) === "string") throw new Quarantine("external-relationship", "External PDF catalog actions are disabled");
  units.push(make("pdf-metadata", { kind: "page", page: 0 }, { structured_data: { metadata: metadata.info ?? {}, outline: outlineEntries.map(({ title }) => title), page_count: document.numPages } }));
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber); const content = await page.getTextContent(); const annotations = await page.getAnnotations().catch(() => []);
    if (annotations.some(({ url, unsafeUrl }) => typeof (url ?? unsafeUrl) === "string")) throw new Quarantine("external-relationship", "External PDF relationships are disabled", { page: pageNumber });
    const pageText = content.items.map((item) => item.str).join(" ").trim();
    units.push(make("pdf-page", { kind: "page", page: pageNumber }, { text: pageText || "", structured_data: { width: page.view[2], height: page.view[3], text_blocks: content.items.length, images: null, tables: null, links: annotations.filter(({ subtype }) => subtype === "Link").map(({ dest }) => ({ destination: dest ?? null })) } }, [...(pageText ? [] : ["scanned-or-empty-page; OCR requires probabilistic worker"]), "pdf-images-and-tables-omitted"]));
    for (const item of content.items) if (item.str?.trim()) units.push(make("pdf-text-block", { kind: "page-bbox", page: pageNumber, x: item.transform?.[4] ?? 0, y: item.transform?.[5] ?? 0, width: item.width ?? 0, height: item.height ?? 0 }, { text: item.str }));
  }
  return { descriptor, units, discovered: document.numPages, warnings: [] };
}

function officeKind(parts, requested) {
  if (!parts["[Content_Types].xml"]) throw new Quarantine("malformed", "OPC package lacks [Content_Types].xml");
  const types = text(parts["[Content_Types].xml"]); const declaredTypes = new Map();
  parseXml(types, { open(node) { if (node.name === "Override" || node.name.endsWith(":Override")) { const contentType = node.attributes.ContentType; const partName = node.attributes.PartName; if (typeof contentType === "string" && typeof partName === "string" && /^\/[A-Za-z0-9_.\/-]+$/.test(partName) && !partName.split("/").includes("..")) declaredTypes.set(partName, contentType); } } });
  if (!parts["_rels/.rels"]) throw new Quarantine("malformed", "OPC package lacks the root relationship part");
  const officeRelationships = new Set(["http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument", "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument"]);
  const roots = []; parseXml(text(parts["_rels/.rels"]), { open(node) { if (node.name === "Relationship" || node.name.endsWith(":Relationship")) { const type = String(node.attributes.Type); if (/officeDocument$/i.test(type) && !officeRelationships.has(type)) throw new Quarantine("malformed", "OPC root relationship type is not allowlisted"); if (officeRelationships.has(type)) { if (node.attributes.TargetMode === "External") throw new Quarantine("external-relationship", "External package relationships are disabled"); roots.push(`/${String(node.attributes.Target).replace(/^\//, "")}`); } } } });
  const main = roots.length === 1 ? roots[0] : null; const contentType = main ? declaredTypes.get(main) : null;
  if (main === "/word/document.xml" && contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" && parts["word/document.xml"]) return "docx";
  if (main === "/xl/workbook.xml" && contentType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" && parts["xl/workbook.xml"]) return "xlsx";
  if (main === "/ppt/presentation.xml" && contentType === "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml" && parts["ppt/presentation.xml"]) return "pptx";
  if (main === "/visio/document.xml" && contentType === "application/vnd.ms-visio.drawing.main+xml" && parts["visio/document.xml"] && Object.keys(parts).some((name) => /^visio\/pages\/page\d+\.xml$/i.test(name))) return "vsdx";
  throw new Quarantine("unsupported", `ZIP package is not a supported ${requested ?? "document"}`);
}

function officeProfile(bytes, sourceHash, limits) {
  const parts = zipParts(bytes, limits); const format = officeKind(parts); const descriptor = descriptors[format]; const make = unitFactory(sourceHash, descriptor); const units = []; const warnings = [];
  if (format === "docx") {
    const xml = text(parts["word/document.xml"]); const paragraphs = xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) ?? [];
    units.push(make("document-structure", { kind: "part-paragraph", part: "word/document.xml", paragraph: 0 }, { structured_data: { properties: parts["docProps/core.xml"] ? xmlText(parts["docProps/core.xml"]) : null, paragraph_count: paragraphs.length, headings: paragraphs.filter((fragment) => /w:pStyle[^>]*w:val=["']Heading/i.test(fragment)).length, lists: paragraphs.filter((fragment) => /<w:numPr\b/.test(fragment)).length, tables: (xml.match(/<w:tbl\b/g) ?? []).length, images: Object.keys(parts).filter((name) => name.startsWith("word/media/")).sort(), comments_policy: parts["word/comments.xml"] ? "excluded" : "absent" } }));
    if (parts["word/comments.xml"]) warnings.push("comments-excluded-by-default-policy");
    let paragraph = 0; for (const fragment of paragraphs) { paragraph += 1; const value = xmlText(new TextEncoder().encode(fragment)); if (value) units.push(make(/w:pStyle[^>]*w:val=["']Heading/i.test(fragment) ? "heading" : "paragraph", { kind: "part-paragraph", part: "word/document.xml", paragraph }, { text: value })); }
    (xml.match(/<w:tbl\b[\s\S]*?<\/w:tbl>/g) ?? []).forEach((fragment, index) => units.push(make("table", { kind: "part-table", part: "word/document.xml", table: index + 1 }, { text: xmlText(new TextEncoder().encode(fragment)) })));
    for (const name of ["word/footnotes.xml", "word/endnotes.xml"].filter((name) => parts[name])) units.push(make("notes", { kind: "part-paragraph", part: name, paragraph: 1 }, { text: xmlText(parts[name]) }));
  } else if (format === "xlsx") {
    const workbook = text(parts["xl/workbook.xml"]); const sheets = Object.keys(parts).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)).sort(); exceed("sheets", sheets.length, limits.sheets);
    const sheetNames = [...workbook.matchAll(/<sheet\b[^>]*name=["']([^"']+)/g)].map((match) => match[1]);
    units.push(make("workbook-structure", { kind: "sheet-range", sheet: 0, range: null }, { structured_data: { properties: parts["docProps/core.xml"] ? xmlText(parts["docProps/core.xml"]) : null, sheet_names: sheetNames, named_ranges: [...workbook.matchAll(/<definedName\b[^>]*name=["']([^"']+)["'][^>]*>(.*?)<\/definedName>/g)].map((match) => ({ name: match[1], range: match[2] })), tables: Object.keys(parts).filter((name) => name.startsWith("xl/tables/")), charts: Object.keys(parts).filter((name) => name.startsWith("xl/charts/")) } }));
    for (let index = 0; index < sheets.length; index += 1) { const name = sheets[index]; const xml = text(parts[name]); const cells = [...xml.matchAll(/<c\b[^>]*r=["']([^"']+)["'][^>]*>([\s\S]*?)<\/c>/g)]; exceed("rows", new Set(cells.map((match) => match[1].replace(/\D/g, ""))).size, limits.rows); units.push(make("sheet", { kind: "sheet-range", sheet: index + 1, range: /dimension[^>]*ref=["']([^"']+)/.exec(xml)?.[1] ?? null }, { structured_data: { name: sheetNames[index] ?? name, used_range: /dimension[^>]*ref=["']([^"']+)/.exec(xml)?.[1] ?? null, headers: cells.filter((match) => /1$/.test(match[1])).map((match) => /<v[^>]*>(.*?)<\/v>/.exec(match[2])?.[1] ?? null), cells: cells.slice(0, 100).map((match) => ({ cell: match[1], formula: /<f[^>]*>(.*?)<\/f>/.exec(match[2])?.[1] ?? null, cached_value: /<v[^>]*>(.*?)<\/v>/.exec(match[2])?.[1] ?? null })), formulas_separate: true } }, cells.length > 100 ? ["cells-sampled"] : [])); cells.slice(0, 100).forEach((cell) => units.push(make("cell", { kind: "sheet-cell", sheet: index + 1, cell: cell[1] }, { structured_data: { formula: /<f[^>]*>(.*?)<\/f>/.exec(cell[2])?.[1] ?? null, cached_value: /<v[^>]*>(.*?)<\/v>/.exec(cell[2])?.[1] ?? null } }))); }
  } else {
    const prefix = format === "pptx" ? "ppt/slides/slide" : "visio/pages/page"; const suffix = format === "pptx" ? "slide" : "visio-page";
    const pages = Object.keys(parts).filter((name) => name.startsWith(prefix) && name.endsWith(".xml")).sort(); exceed(format === "pptx" ? "slides" : "pages", pages.length, format === "pptx" ? limits.slides : limits.pages);
    units.push(make(`${format}-structure`, { kind: format === "pptx" ? "slide" : "visio-page", page: 0 }, { structured_data: { properties: parts["docProps/core.xml"] ? xmlText(parts["docProps/core.xml"]) : null, pages: pages.length, masters: Object.keys(parts).filter((name) => name.includes("/masters/")).sort(), charts: Object.keys(parts).filter((name) => name.includes("/charts/")).sort(), images: Object.keys(parts).filter((name) => name.includes("/media/")).sort(), notes_policy: format === "pptx" && Object.keys(parts).some((name) => name.startsWith("ppt/notesSlides/")) ? "excluded" : "absent" } }));
    if (format === "pptx" && Object.keys(parts).some((name) => name.startsWith("ppt/notesSlides/"))) warnings.push("notes-excluded-by-default-policy");
    for (let index = 0; index < pages.length; index += 1) { const xml = text(parts[pages[index]]); const value = xmlText(parts[pages[index]]); const shapes = (xml.match(/<(?:p:sp|Shape)\b/g) ?? []).length; exceed("shapes", shapes, limits.shapes); const labels = [...xml.matchAll(/<(?:a:t|Text)[^>]*>(.*?)<\/(?:a:t|Text)>/g)].map((match) => match[1]); units.push(make(suffix, { kind: format === "pptx" ? "slide" : "visio-page", page: index + 1 }, { text: value, structured_data: { part: pages[index], title: labels[0] ?? null, labels, reading_order: labels, shapes, groups: (xml.match(/<(?:p:grpSp|Shapes)\b/g) ?? []).length, connectors: (xml.match(/<(?:p:cxnSp|Connect)\b/g) ?? []).length, direction: [...xml.matchAll(/<Connect\b[^>]*FromSheet=["']([^"']+)["'][^>]*ToSheet=["']([^"']+)/g)].map((match) => `${match[1]}->${match[2]}`), tables: (xml.match(/<a:tbl\b/g) ?? []).length } })); const shapeMatches = format === "pptx" ? [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)] : [...xml.matchAll(/<Shape\b([^>]*)>[\s\S]*?<\/Shape>/g)]; shapeMatches.forEach((shape, shapeIndex) => units.push(make("shape", { kind: format === "pptx" ? "slide-shape" : "visio-shape", page: index + 1, shape: /(?:ID|id)=["']([^"']+)/.exec(shape[1] ?? shape[0])?.[1] ?? shapeIndex + 1 }, { text: xmlText(new TextEncoder().encode(shape[0])) || "", structured_data: { order: shapeIndex } }))); }
  }
  return { descriptor, units, discovered: units.length, warnings };
}

function drawioProfile(bytes, sourceHash, limits) {
  const descriptor = descriptors.drawio; const make = unitFactory(sourceHash, descriptor); const value = text(bytes);
  if (/<script\b|javascript:/i.test(value)) throw new Quarantine("unsafe-active-content", "Draw.io active content is disabled");
  if (/\b(?:href|link|src|target)\s*=\s*["'][^"']*(?:https?|file):\/\//i.test(value)) throw new Quarantine("external-relationship", "External Draw.io relationships are disabled");
  const units = []; let cells = 0; let expandedTotal = 0; const diagrams = [...value.matchAll(/<diagram\b([^>]*)>([\s\S]*?)<\/diagram>/g)];
  for (let index = 0; index < diagrams.length; index += 1) {
    let contents = diagrams[index][2].trim();
    if (contents && !contents.startsWith("<")) {
      try { const compressed = Buffer.from(contents, "base64"); if (compressed.byteLength * MAX_RATIO > limits.expanded_bytes - expandedTotal) throw new Quarantine("limit-exceeded", "Draw.io declared expansion could exceed the remaining budget", { maximum: limits.expanded_bytes }); const expanded = inflateSync(compressed); expandedTotal += expanded.byteLength; exceed("expanded_bytes", expandedTotal, limits.expanded_bytes); if (expanded.byteLength / Math.max(compressed.byteLength, 1) > MAX_RATIO) throw new Quarantine("limit-exceeded", "Draw.io decompression ratio exceeds limit", { maximum: MAX_RATIO }); contents = decodeURIComponent(text(expanded)); }
      catch (error) { if (error instanceof Quarantine) throw error; throw new Quarantine("malformed", "Malformed compressed Draw.io page"); }
    }
    parseXml(contents, { open(node) { if (node.name === "mxCell") { cells += 1; exceed("shapes", cells, limits.shapes); const a = node.attributes; const activeReference = [a.href, a.link, a.style].filter(Boolean).find((entry) => /(?:https?|file):\/\//i.test(String(entry))); if (activeReference) throw new Quarantine("external-relationship", "External Draw.io relationships are disabled"); units.push(make(a.edge === "1" ? "connector" : "diagram-cell", { kind: "diagram-cell", page: index + 1, cell: String(a.id ?? cells) }, { text: String(a.value ?? ""), structured_data: { parent: a.parent ?? null, source: a.source ?? null, target: a.target ?? null, edge: a.edge === "1", direction: a.source && a.target ? `${a.source}->${a.target}` : null, group: a.vertex !== "1", layer: a.parent ?? null, embedded_resource: /data:image\//i.test(String(a.style ?? "")) } })); } } });
  }
  return { descriptor, units, discovered: cells, warnings: [] };
}

function gifProfile(bytes, sourceHash, settings, limits) {
  const descriptor = descriptors.gif; const make = unitFactory(sourceHash, descriptor); let gif, frames;
  try { gif = parseGIF(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); frames = decompressFrames(gif, false); } catch { throw new Quarantine("malformed", "Malformed GIF"); }
  exceed("frames", frames.length, limits.frames); const sampleCount = Math.min(settings.sample_frames ?? 10, frames.length); const picks = new Set(Array.from({ length: sampleCount }, (_, index) => Math.floor(index * Math.max(frames.length - 1, 0) / Math.max(sampleCount - 1, 1)))); let elapsed = 0;
  const starts = frames.map((frame) => { const start = elapsed; elapsed += (frame.delay ?? 10) * 10; return start; });
  const units = []; for (const index of picks) { units.push(make("gif-frame", { kind: "frame", frame: index }, { structured_data: { dimensions: frames[index].dims, representative: true } })); units.push(make("gif-time", { kind: "time-range", frame: index, start_ms: starts[index], end_ms: starts[index] + (frames[index].delay ?? 10) * 10 }, { structured_data: { representative: true } })); }
  return { descriptor, units, discovered: frames.length, warnings: sampleCount < frames.length ? ["frames-sampled"] : [], coverage: { duration_ms: elapsed, width: gif.lsd.width, height: gif.lsd.height } };
}

function serializable(value, fallback = {}) { try { return JSON.parse(canonicalJson(value)); } catch { return fallback; } }
function quarantineManifest(sourceId, sourceHash, normalizedAt, settings, error) {
  return { api_version: "kdlc.dev/normalization-manifest/v1", source_id: sourceId, source_hash: sourceHash, normalized_at: normalizedAt, status: "quarantined", format: null, normalizer: null, settings: serializable(settings), coverage: { discovered: 0, emitted: 0 }, omissions: [], quality_warnings: [], outputs: [], security, quarantine: { code: String(error.code ?? "malformed"), message: String(error.message ?? "Normalizer failed safely"), details: serializable(error.details) } };
}

export async function normalizeInRestrictedWorker({ bytes, filename = "", mediaType = "", sourceId, normalizedAt = "1970-01-01T00:00:00.000Z", sourceHash, settings = {}, limits = {}, probabilisticUnits = [] }) {
  if (process.env.KDLC_RESTRICTED_WORKER !== "1" || !process.permission || process.permission.has("child") || process.permission.has("fs.write", "/")) throw new Error("Direct normalization requires the restricted worker capability boundary");
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); const computedHash = byteHash(input); const hash = computedHash; sourceId ??= `source-${hash.slice(7, 23)}`;
  try {
    if (typeof sourceId !== "string" || !portableSourceId.test(sourceId) || typeof normalizedAt !== "string" || !rfc3339.test(normalizedAt) || !Number.isFinite(Date.parse(normalizedAt))) throw new Quarantine("invalid-source-metadata", "Portable source ID and RFC3339 normalization timestamp are required");
    const resolvedLimits = { ...defaultLimits };
    for (const [name, value] of Object.entries(limits)) { if (!(name in defaultLimits) || !Number.isSafeInteger(value) || value <= 0 || value > defaultLimits[name]) throw new Quarantine("invalid-limits", "Normalizer limits may only tighten trusted ceilings", { limit: name }); resolvedLimits[name] = value; }
    if (sourceHash && sourceHash !== computedHash) throw new Quarantine("source-hash-mismatch", "Declared source hash does not match input bytes", { declared: sourceHash, actual: computedHash });
    settings = JSON.parse(canonicalJson(settings));
    exceed("source_bytes", input.byteLength, resolvedLimits.source_bytes); const started = performance.now(); let format = detect(input, filename, mediaType); let result;
    if (format === "zip") result = officeProfile(input, hash, resolvedLimits);
    else if (format === "markdown" || format === "text") result = linesProfile(input, format, hash);
    else if (format === "csv") result = csvProfile(input, hash, settings, resolvedLimits);
    else if (format === "pdf") result = await pdfProfile(input, hash, resolvedLimits);
    else if (format === "drawio") result = drawioProfile(input, hash, resolvedLimits);
    else if (format === "gif") result = gifProfile(input, hash, settings, resolvedLimits);
    format = result.descriptor.id.slice(5); exceed("processing_ms", performance.now() - started, resolvedLimits.processing_ms);
    if (settings.language) {
      if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(settings.language)) throw new Quarantine("invalid-language", "Language must be a BCP 47 tag");
      result.units = result.units.map((unit) => ({ ...unit, language: settings.language }));
    }
    const allowedLocators = new Set(result.descriptor.locator_kinds);
    if (result.units.some((unit) => !validateUnit(unit) || unit.extraction_method?.mode !== "deterministic" || unit.source_hash !== hash || !allowedLocators.has(unit.locator?.kind))) throw new Quarantine("invalid-deterministic-output", "Deterministic units must satisfy their descriptor schema and locator contract");
    if (probabilisticUnits.some((unit) => { const model = unit.extraction_method?.model; return !validateUnit(unit) || !allowedLocators.has(unit.locator?.kind) || unit.extraction_method?.mode !== "probabilistic" || !model?.id || !model?.version || !model?.provider || !/^sha256:[a-f0-9]{64}$/.test(model?.recorded_output_hash ?? "") || unit.source_hash !== hash; })) throw new Quarantine("invalid-probabilistic-output", "Probabilistic units require schema-valid descriptor locators, substantive recorded-model provenance, and matching source identity");
    const deterministicBytes = `${result.units.map((unit) => canonicalJson(unit)).join("\n")}${result.units.length ? "\n" : ""}`; exceed("output_bytes", Buffer.byteLength(deterministicBytes), resolvedLimits.output_bytes);
    const outputs = [{ path: "units.jsonl", hash: byteHash(deterministicBytes), bytes: Buffer.byteLength(deterministicBytes), mode: "deterministic" }];
    if (probabilisticUnits.length) { const derived = `${probabilisticUnits.map((unit) => canonicalJson(unit)).join("\n")}\n`; exceed("output_bytes", Buffer.byteLength(deterministicBytes) + Buffer.byteLength(derived), resolvedLimits.output_bytes); exceed("shapes", probabilisticUnits.length, resolvedLimits.shapes); exceed("processing_ms", performance.now() - started, resolvedLimits.processing_ms); outputs.push({ path: "probabilistic-units.jsonl", hash: byteHash(derived), bytes: Buffer.byteLength(derived), mode: "probabilistic" }); }
    const qualityWarnings = [...new Set([...result.warnings, ...result.units.flatMap((unit) => unit.quality_warnings)])].sort();
    const omissions = qualityWarnings.filter((warning) => /sampled|scanned|omitted|excluded/i.test(warning)).map((reason) => ({ reason }));
    return { descriptor: result.descriptor, units: result.units, probabilisticUnits, manifest: { api_version: "kdlc.dev/normalization-manifest/v1", source_id: sourceId, source_hash: hash, normalized_at: normalizedAt, status: omissions.length ? "partial" : "complete", format, normalizer: { id: result.descriptor.id, version: result.descriptor.version, parser: result.descriptor.parser }, settings, coverage: { discovered: result.discovered, emitted: result.units.length, ...(result.coverage ?? {}) }, omissions, quality_warnings: qualityWarnings, outputs, security } };
  } catch (error) {
    const quarantined = error instanceof Quarantine ? error : new Quarantine("malformed", "Normalizer failed safely", { parser: error.message });
    const safeSourceId = typeof sourceId === "string" && portableSourceId.test(sourceId) ? sourceId : `source-${hash.slice(7, 23)}`;
    const safeNormalizedAt = typeof normalizedAt === "string" && rfc3339.test(normalizedAt) && Number.isFinite(Date.parse(normalizedAt)) ? normalizedAt : "1970-01-01T00:00:00.000Z";
    return { descriptor: null, units: [], probabilisticUnits: [], manifest: quarantineManifest(safeSourceId, hash, safeNormalizedAt, settings, quarantined) };
  }
}

export function portableArtifacts(result, sourceId) {
  if (!portableSourceId.test(sourceId)) throw new Error("Source ID is not portable");
  if (sourceId !== result?.manifest?.source_id) throw new Error("Source ID does not match the normalization manifest");
  if (!validateManifest(result.manifest)) throw new Error("Normalization manifest is invalid");
  const deterministic = `${result.units.map((unit) => canonicalJson(unit)).join("\n")}${result.units.length ? "\n" : ""}`;
  const probabilistic = `${result.probabilisticUnits.map((unit) => canonicalJson(unit)).join("\n")}${result.probabilisticUnits.length ? "\n" : ""}`;
  if (result.units.some((unit) => !validateUnit(unit) || unit.source_hash !== result.manifest.source_hash) || result.probabilisticUnits.some((unit) => !validateUnit(unit) || unit.source_hash !== result.manifest.source_hash)) throw new Error("Normalized units are invalid or source-unbound");
  const expectedOutputs = result.manifest.status === "quarantined" ? [] : [{ path: "units.jsonl", hash: byteHash(deterministic), bytes: Buffer.byteLength(deterministic), mode: "deterministic" }, ...(result.probabilisticUnits.length ? [{ path: "probabilistic-units.jsonl", hash: byteHash(probabilistic), bytes: Buffer.byteLength(probabilistic), mode: "probabilistic" }] : [])];
  if (canonicalJson(result.manifest.outputs) !== canonicalJson(expectedOutputs)) throw new Error("Normalization manifest output hashes do not match serialized bytes");
  const basis = result.manifest.outputs.find(({ mode }) => mode === "deterministic")?.hash ?? result.manifest.source_hash;
  const directory = `sources/normalized/${sourceId}/${basis.replace("sha256:", "sha256-")}`;
  const files = { [`${directory}/manifest.json`]: `${canonicalJson(result.manifest)}\n` };
  if (result.manifest.status !== "quarantined") {
    files[`${directory}/units.jsonl`] = deterministic;
    if (result.probabilisticUnits.length) files[`${directory}/probabilistic-units.jsonl`] = probabilistic;
  }
  return { directory, files };
}

export { descriptors, defaultLimits } from "./descriptors.mjs";
