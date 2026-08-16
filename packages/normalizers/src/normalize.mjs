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
const rfc3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function validRfc3339(value) {
  if (typeof value !== "string") return false;
  const match = rfc3339.exec(value); if (!match) return false;
  const [, year, month, day, hour, minute, second, , offsetHour = "00", offsetMinute = "00"] = match;
  const numbers = [year, month, day, hour, minute, second, offsetHour, offsetMinute].map(Number);
  const [y, m, d, h, min, sec, oh, om] = numbers;
  if (m < 1 || m > 12 || h > 23 || min > 59 || sec > 59 || oh > 23 || om > 59) return false;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d >= 1 && d <= days[m - 1];
}

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
  if (prefix.startsWith("ÐÏà¡±á")) return "cfb";
  // .eml may be latin1; route on extension/media type before the strict UTF-8
  // sample decode (the eml profile handles its own charset fallback).
  if (ext === ".eml" || mediaType === "message/rfc822") return "eml";
  // HTML may be latin1 too; route before the strict UTF-8 sample decode.
  if ([".html", ".htm", ".xhtml"].includes(ext) || ["text/html", "application/xhtml+xml"].includes(mediaType)) return "html";
  let sample; try { sample = text(bytes.subarray(0, Math.min(bytes.length, 4096))); } catch { throw new Quarantine("unsupported", "Unknown binary content signature"); }
  if (/^\s*<mxfile(?:\s|>)/.test(sample)) return "drawio";
  if (/^\s*(?:<!DOCTYPE\s+html|<html\b)/i.test(sample)) return "html";
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

// RFC 822 / MIME (FEAT-019). Deterministic and bounded: headers are unfolded
// and RFC 2047-decoded, text bodies are decoded (base64/quoted-printable) and
// HTML is tag-stripped, attachments are inventoried with content hashes and
// never expanded in place. Everything else quarantines.
const MIME_MAX_DEPTH = 10;
function emlDecodeBytes(bytes, warnings) {
  try { return decoder.decode(bytes).normalize("NFC").replace(/\r\n?/g, "\n"); }
  catch { if (!warnings.includes("non-utf8-decoded-as-latin1")) warnings.push("non-utf8-decoded-as-latin1"); return new TextDecoder("latin1").decode(bytes).normalize("NFC").replace(/\r\n?/g, "\n"); }
}
function decodeEncodedWords(value, warnings) {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset, scheme, payload) => {
    const lower = charset.toLowerCase().split("*")[0];
    if (!["utf-8", "us-ascii", "iso-8859-1", "latin1", "windows-1252"].includes(lower)) { if (!warnings.includes("unknown-header-charset-retained")) warnings.push("unknown-header-charset-retained"); return whole; }
    try {
      const raw = /b/i.test(scheme)
        ? Uint8Array.from(Buffer.from(payload, "base64"))
        : Uint8Array.from(payload.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16))), (char) => char.charCodeAt(0));
      return new TextDecoder(lower === "utf-8" || lower === "us-ascii" ? "utf-8" : "latin1", { fatal: false }).decode(raw);
    } catch { if (!warnings.includes("unknown-header-charset-retained")) warnings.push("unknown-header-charset-retained"); return whole; }
  });
}
function parseHeaderBlock(raw) {
  const headers = [];
  for (const line of raw.split("\n")) {
    if (/^[ \t]/.test(line) && headers.length > 0) headers[headers.length - 1].value += ` ${line.trim()}`;
    else { const match = /^([!-9;-~]+):[ \t]?(.*)$/.exec(line); if (match) headers.push({ name: match[1], value: match[2] }); else if (line.trim()) return null; }
  }
  return headers;
}
const headerValue = (headers, name) => headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? null;
function contentTypeOf(headers) {
  const raw = headerValue(headers, "Content-Type") ?? "text/plain";
  const type = raw.split(";")[0].trim().toLowerCase() || "text/plain";
  const boundary = /boundary\s*=\s*"([^"]+)"/i.exec(raw)?.[1] ?? /boundary\s*=\s*([^;\s]+)/i.exec(raw)?.[1] ?? null;
  const charset = (/charset\s*=\s*"?([A-Za-z0-9._-]+)"?/i.exec(raw)?.[1] ?? "utf-8").toLowerCase();
  return { type, boundary, charset };
}
function decodeBody(body, encoding, warnings) {
  const declared = (encoding ?? "7bit").trim().toLowerCase();
  if (declared === "base64") { try { return Uint8Array.from(Buffer.from(body.replace(/\s+/g, ""), "base64")); } catch { throw new Quarantine("malformed", "Malformed base64 body part"); } }
  if (declared === "quoted-printable") {
    const decoded = body.replace(/=\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
    return Uint8Array.from(decoded, (char) => char.charCodeAt(0) & 0xff);
  }
  if (!["7bit", "8bit", "binary", ""].includes(declared)) warnings.push("unknown-transfer-encoding-treated-as-identity");
  return new TextEncoder().encode(body);
}
function emlProfile(bytes, sourceHash, limits) {
  const descriptor = descriptors.eml; const make = unitFactory(sourceHash, descriptor); const warnings = []; const units = [];
  const raw = emlDecodeBytes(bytes, warnings);
  const separator = raw.indexOf("\n\n");
  const headerText = separator === -1 ? raw : raw.slice(0, separator);
  const headers = parseHeaderBlock(headerText);
  if (!headers || headers.length === 0 || !headers.some(({ name }) => /^(from|to|subject|date|received|message-id|return-path|mime-version)$/i.test(name))) {
    throw new Quarantine("malformed", "Input does not carry RFC 822 message headers");
  }
  let partCount = 0; let attachmentCount = 0;
  const coreHeaders = {};
  for (const name of ["From", "To", "Cc", "Subject", "Date", "Message-ID", "In-Reply-To", "References"]) {
    const value = headerValue(headers, name);
    if (value !== null) coreHeaders[name.toLowerCase().replace(/-/g, "_")] = decodeEncodedWords(value, warnings);
  }
  units.push(make("email-structure", { kind: "header", name: "*" }, { structured_data: { ...coreHeaders, header_count: headers.length } }));
  for (const header of headers) {
    units.push(make("email-header", { kind: "header", name: header.name }, { text: decodeEncodedWords(header.value, warnings) }));
  }
  const walk = (headersHere, body, depth) => {
    if (depth > MIME_MAX_DEPTH) throw new Quarantine("limit-exceeded", "MIME nesting exceeds depth limit", { maximum: MIME_MAX_DEPTH });
    const { type, boundary, charset } = contentTypeOf(headersHere);
    if (type.startsWith("multipart/")) {
      if (!boundary) throw new Quarantine("malformed", "Multipart body without a boundary");
      const pieces = body.split(`--${boundary}`).slice(1);
      for (const piece of pieces) {
        if (piece === "--" || piece.startsWith("--\n") || piece.trim() === "--") break;
        const segment = piece.replace(/^\n/, "");
        const split = segment.indexOf("\n\n");
        const childHeaders = parseHeaderBlock(split === -1 ? segment : segment.slice(0, split)) ?? [];
        walk(childHeaders, split === -1 ? "" : segment.slice(split + 2), depth + 1);
      }
      return;
    }
    partCount += 1; exceed("shapes", partCount, limits.shapes);
    const part = partCount;
    const disposition = (headerValue(headersHere, "Content-Disposition") ?? "").toLowerCase();
    const filename = decodeEncodedWords(/filename\s*=\s*"([^"]+)"/i.exec(headerValue(headersHere, "Content-Disposition") ?? "")?.[1] ?? /name\s*=\s*"([^"]+)"/i.exec(headerValue(headersHere, "Content-Type") ?? "")?.[1] ?? "", warnings) || null;
    const transferEncoding = (headerValue(headersHere, "Content-Transfer-Encoding") ?? "7bit").trim().toLowerCase();
    const identity = !["base64", "quoted-printable"].includes(transferEncoding);
    const decoded = decodeBody(body, transferEncoding, warnings);
    const isAttachment = disposition.startsWith("attachment") || (!type.startsWith("text/") && type !== "message/rfc822");
    if (isAttachment) {
      attachmentCount += 1;
      units.push(make("email-attachment", { kind: "mime-part", part }, { structured_data: { filename, media_type: type, bytes: decoded.byteLength, content_hash: byteHash(decoded), disposition: disposition.split(";")[0] || "inline" } }, ["attachment-content-not-extracted; ingest it as a separate source"]));
      return;
    }
    if (type === "message/rfc822") { units.push(make("email-attached-message", { kind: "mime-part", part }, { structured_data: { media_type: type, bytes: decoded.byteLength, content_hash: byteHash(decoded) } }, ["attached-message-not-recursed; ingest it as a separate source"])); return; }
    // Identity-encoded bodies were already charset-decoded with the whole
    // message; re-decoding their UTF-16 round-trip would mojibake latin1.
    let value = identity
      ? body
      : charset === "utf-8" || charset === "us-ascii"
        ? emlDecodeBytes(decoded, warnings)
        : new TextDecoder("latin1").decode(decoded).normalize("NFC").replace(/\r\n?/g, "\n");
    const partWarnings = [];
    // Close-tag matching tolerates whitespace/attributes (</script >), and
    // entity unescaping resolves &amp; LAST so &amp;lt; cannot double-decode.
    if (type === "text/html") { value = value.replace(/<(?:style|script)\b[\s\S]*?<\/\s*(?:style|script)\b[^>]*>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&").replace(/[ \t]+/g, " "); partWarnings.push("html-tags-stripped"); }
    const trimmed = value.split("\n").map((line) => line.trimEnd()).join("\n").trim();
    if (trimmed) units.push(make("email-body", { kind: "mime-part", part }, { text: trimmed, structured_data: { media_type: type, ...(filename ? { filename } : {}) } }, partWarnings));
  };
  walk(headers, separator === -1 ? "" : raw.slice(separator + 2), 0);
  return { descriptor, units, discovered: partCount + headers.length, warnings: [...warnings, ...(attachmentCount > 0 ? ["attachments-inventoried-not-extracted"] : [])] };
}

// HTML (FEAT-022, #96). A deterministic, tolerant tokenizer — not a spec
// parser — that recovers structure from real-world markup: headings,
// paragraphs, tables, and links as units with DOM-path locators. Scripts,
// styles, comments, and active link targets are removed with the hardened
// patterns from the eml/msg work; nothing is ever fetched.
const HTML_VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const HTML_BLOCK = new Set(["p", "li", "dd", "dt", "blockquote", "pre", "figcaption", "caption", "summary"]);
const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', copy: "©", reg: "®", trade: "™", colon: ":", sol: "/", tab: "\t", newline: "\n" };
// Single pass: each entity site decodes at most once, so &amp;lt; → &lt;
// (never <) by construction.
const decodeHtmlEntities = (value) => value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
  if (body[0] === "#") {
    const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  }
  return HTML_ENTITIES[body.toLowerCase()] ?? whole;
});
const collapseSpace = (value) => value.replace(/\s+/g, " ").trim();
function htmlProfile(bytes, sourceHash, limits) {
  const descriptor = descriptors.html; const make = unitFactory(sourceHash, descriptor); const warnings = []; const units = [];
  let raw;
  try { raw = decoder.decode(bytes).normalize("NFC"); }
  catch { warnings.push("non-utf8-decoded-as-latin1"); raw = new TextDecoder("latin1").decode(bytes).normalize("NFC"); }
  // Sanitize before tokenizing: comments/CDATA/doctype, then script/style
  // blocks (whitespace/attribute-tolerant close tags; unterminated blocks are
  // dropped to end-of-input rather than leaking their content as text).
  let value = raw.replace(/<!--[\s\S]*?(?:-->|$)/g, " ").replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, " ").replace(/<!DOCTYPE[^>]*>/gi, " ");
  const activeBefore = value.length;
  value = value.replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/\s*(?:script|style)\b[^>]*>/gi, " ").replace(/<(?:script|style)\b[^>]*>[\s\S]*$/gi, " ");
  if (value.length !== activeBefore) warnings.push("scripts-and-styles-removed");
  const language = /<html\b[^>]*\blang\s*=\s*["']?([A-Za-z0-9-]+)/i.exec(value)?.[1] ?? null;
  const title = collapseSpace(decodeHtmlEntities(/<title\b[^>]*>([\s\S]*?)<\/\s*title\b[^>]*>/i.exec(value)?.[1] ?? "").replace(/<[^>]*>/g, " ")) || null;

  units.push(make("html-metadata", { kind: "dom-path", path: "/" }, { structured_data: { title, language } }));
  const stack = []; const childCounts = [new Map()];
  const domPath = () => `/${stack.map((frame) => `${frame.name}[${frame.index}]`).join("/")}` || "/";
  let tags = 0; let activeLinksDropped = 0;
  const flush = { text: "", path: "/", cells: null, rowPath: null, link: null };
  const emitBlock = (kindName, path) => {
    const text = collapseSpace(flush.text);
    flush.text = "";
    if (text) units.push(make(kindName, { kind: "dom-path", path }, { text }));
  };
  const tokens = value.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)\/?>|([^<]+)/g);
  for (const token of tokens) {
    if (token[3] !== undefined) {
      const text = decodeHtmlEntities(token[3]);
      flush.text += text;
      if (flush.link) flush.link.text += text;
      // Cells accumulate already-decoded text; the close handler must not
      // decode again (single-pass invariant, review round MEDIUM 1).
      if (flush.cells && flush.cells.open) flush.cells.current += text;
      continue;
    }
    const name = token[1].toLowerCase(); const closing = token[0][1] === "/";
    tags += 1; exceed("shapes", tags, limits.shapes);
    if (!closing) {
      if (HTML_VOID.has(name)) { if (name === "br") flush.text += "\n"; continue; }
      if (stack.length >= 100) throw new Quarantine("limit-exceeded", "HTML nesting exceeds depth limit", { maximum: 100 });
      const counts = childCounts[childCounts.length - 1];
      const index = (counts.get(name) ?? 0) + 1; counts.set(name, index);
      stack.push({ name, index }); childCounts.push(new Map());
      if (/^h[1-6]$/.test(name) || HTML_BLOCK.has(name)) { emitBlock("block", domPath()); flush.text = ""; }
      if (name === "a") {
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(token[2] ?? "");
        const target = (href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
        // Judge the scheme on the decoded, control-stripped form: entity or
        // whitespace obfuscation (java\tscript:, &#106;avascript:) must not
        // slip an active target past the filter (review round MEDIUM 2).
        const judged = decodeHtmlEntities(target).replace(/[\s -]+/g, "").toLowerCase();
        if (/^(?:javascript|data|vbscript):/.test(judged)) { activeLinksDropped += 1; flush.link = { text: "", href: null, path: domPath() }; }
        else flush.link = { text: "", href: target || null, path: domPath() };
      }
      if (name === "tr") { flush.cells = { row: [], open: false, current: "", path: domPath() }; }
      if ((name === "td" || name === "th") && flush.cells) { flush.cells.open = true; flush.cells.current = ""; }
      continue;
    }
    // closing tag: pop to the matching frame if present (tolerates mis-nesting)
    const at = stack.map((frame) => frame.name).lastIndexOf(name);
    if (at === -1) continue;
    const path = `/${stack.slice(0, at + 1).map((frame) => `${frame.name}[${frame.index}]`).join("/")}`;
    if (/^h[1-6]$/.test(name)) { units.push(make("heading", { kind: "dom-path", path }, { text: collapseSpace(flush.text) || "(empty heading)", structured_data: { level: Number(name[1]) } })); flush.text = ""; }
    else if (HTML_BLOCK.has(name)) emitBlock(name === "li" ? "list-item" : "paragraph", path);
    if (name === "a" && flush.link) {
      const text = collapseSpace(flush.link.text);
      if (flush.link.href && text) units.push(make("link", { kind: "dom-path", path: flush.link.path }, { text, structured_data: { destination: flush.link.href } }));
      flush.link = null;
    }
    if ((name === "td" || name === "th") && flush.cells?.open) { flush.cells.row.push(collapseSpace(flush.cells.current)); flush.cells.open = false; }
    if (name === "tr" && flush.cells) {
      if (flush.cells.row.length > 0) units.push(make("table-row", { kind: "dom-path", path: flush.cells.path }, { structured_data: { cells: flush.cells.row } }));
      flush.cells = null;
    }
    while (stack.length > at) { stack.pop(); childCounts.pop(); }
  }
  emitBlock("block", "/");
  if (activeLinksDropped > 0) warnings.push("active-link-targets-dropped");
  if (units.length <= 1 && !title) throw new Quarantine("malformed", "Input carries no extractable HTML content");
  return { descriptor, units, discovered: tags, warnings };
}

// CFBF / Outlook .msg (FEAT-020). A bounded, loop-safe Compound File Binary
// reader plus MAPI property-stream extraction. Attachments are inventoried
// with content hashes and never expanded; non-msg CFBF (legacy .doc/.xls)
// quarantines as unsupported instead of misparsing.
const CFB_FREE = 0xfffffffe + 1; // sentinel space: >= 0xfffffffa are specials
function cfbParse(bytes, limits) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 512) throw new Quarantine("malformed", "CFBF container is truncated");
  const sectorShift = view.getUint16(30, true);
  if (![9, 12].includes(sectorShift)) throw new Quarantine("malformed", "CFBF sector size is not v3/v4");
  const sectorSize = 1 << sectorShift;
  const miniSectorSize = 1 << view.getUint16(32, true);
  if (miniSectorSize !== 64) throw new Quarantine("malformed", "CFBF mini sector size is not 64");
  const sectorCount = Math.ceil((bytes.byteLength - 512) / sectorSize);
  exceed("expanded_bytes", sectorCount * sectorSize, limits.expanded_bytes);
  const sectorAt = (index) => {
    const start = 512 + index * sectorSize;
    if (index < 0 || index >= 0xfffffffa || start + sectorSize > bytes.byteLength + sectorSize - 1) throw new Quarantine("malformed", "CFBF sector index out of range", { sector: index });
    return bytes.subarray(start, Math.min(start + sectorSize, bytes.byteLength));
  };
  // DIFAT -> FAT sector list
  const fatSectors = [];
  for (let index = 0; index < 109; index += 1) { const entry = view.getUint32(76 + index * 4, true); if (entry < 0xfffffffa) fatSectors.push(entry); }
  let difat = view.getUint32(68, true); const difatSeen = new Set();
  while (difat < 0xfffffffa) {
    if (difatSeen.has(difat) || difatSeen.size > sectorCount) throw new Quarantine("malformed", "CFBF DIFAT chain loops");
    difatSeen.add(difat);
    const sector = sectorAt(difat); const entries = sectorSize / 4;
    const sectorView = new DataView(sector.buffer, sector.byteOffset, sector.byteLength);
    for (let index = 0; index < entries - 1; index += 1) { const entry = sectorView.getUint32(index * 4, true); if (entry < 0xfffffffa) fatSectors.push(entry); }
    difat = sectorView.getUint32((entries - 1) * 4, true);
  }
  const fat = new Uint32Array(fatSectors.length * (sectorSize / 4));
  fatSectors.forEach((fatSector, position) => {
    const sector = sectorAt(fatSector); const sectorView = new DataView(sector.buffer, sector.byteOffset, sector.byteLength);
    for (let index = 0; index < sectorSize / 4; index += 1) fat[position * (sectorSize / 4) + index] = sectorView.getUint32(index * 4, true);
  });
  const chain = (start, table, guard) => {
    const sectors = []; const seen = new Set(); let cursor = start;
    while (cursor < 0xfffffffa) {
      if (seen.has(cursor) || sectors.length > guard) throw new Quarantine("malformed", "CFBF chain loops or exceeds bounds");
      seen.add(cursor); sectors.push(cursor); cursor = table[cursor] ?? CFB_FREE;
    }
    return sectors;
  };
  const readChain = (start, size) => {
    const sectors = chain(start, fat, sectorCount + 1); const out = new Uint8Array(Math.min(size, sectors.length * sectorSize));
    let offset = 0;
    for (const index of sectors) { const sector = sectorAt(index); const take = Math.min(sector.byteLength, out.byteLength - offset); out.set(sector.subarray(0, take), offset); offset += take; if (offset >= out.byteLength) break; }
    return out;
  };
  // Directory
  const directoryBytes = readChain(view.getUint32(48, true), sectorCount * sectorSize);
  const entries = [];
  for (let offset = 0; offset + 128 <= directoryBytes.byteLength; offset += 128) {
    const entryView = new DataView(directoryBytes.buffer, directoryBytes.byteOffset + offset, 128);
    const nameLength = entryView.getUint16(64, true); const type = entryView.getUint8(66);
    if (type === 0 || nameLength < 2 || nameLength > 64) { entries.push(null); continue; }
    let name = ""; for (let index = 0; index < nameLength - 2; index += 2) name += String.fromCharCode(entryView.getUint16(index, true));
    entries.push({ name, type, left: entryView.getInt32(68, true), right: entryView.getInt32(72, true), child: entryView.getInt32(76, true), start: entryView.getUint32(116, true), size: entryView.getUint32(120, true) });
  }
  if (!entries[0] || entries[0].type !== 5) throw new Quarantine("malformed", "CFBF root storage missing");
  // Mini stream
  const cutoff = view.getUint32(56, true);
  const miniFatBytes = view.getUint32(64, true) > 0 ? readChain(view.getUint32(60, true), view.getUint32(64, true) * sectorSize) : new Uint8Array(0);
  const miniFat = new Uint32Array(miniFatBytes.buffer, miniFatBytes.byteOffset, Math.floor(miniFatBytes.byteLength / 4));
  const miniStream = entries[0].size > 0 ? readChain(entries[0].start, entries[0].size) : new Uint8Array(0);
  const readStream = (entry) => {
    exceed("expanded_bytes", entry.size, limits.expanded_bytes);
    if (entry.size >= cutoff) return readChain(entry.start, entry.size);
    const sectors = chain(entry.start, miniFat, Math.ceil(miniStream.byteLength / miniSectorSize) + 1);
    const out = new Uint8Array(entry.size); let offset = 0;
    for (const index of sectors) {
      const start = index * miniSectorSize;
      if (start >= miniStream.byteLength) throw new Quarantine("malformed", "CFBF mini sector out of range");
      const take = Math.min(miniSectorSize, out.byteLength - offset);
      out.set(miniStream.subarray(start, start + take), offset); offset += take; if (offset >= out.byteLength) break;
    }
    return out;
  };
  // Tree traversal -> path map (bounded, cycle-safe)
  const tree = new Map(); const visited = new Set();
  const visit = (index, path) => {
    if (index < 0 || index >= entries.length || !entries[index]) return;
    if (visited.has(index)) throw new Quarantine("malformed", "CFBF directory tree loops");
    visited.add(index);
    const entry = entries[index];
    visit(entry.left, path);
    visit(entry.right, path);
    const full = path ? `${path}/${entry.name}` : entry.name;
    tree.set(full, entry);
    if (entry.type === 1 || entry.type === 5) visit(entry.child, entry.type === 5 ? "" : full);
  };
  visit(0, null);
  return { tree, readStream };
}
const utf16 = (bytes) => { let out = ""; for (let index = 0; index + 1 < bytes.byteLength; index += 2) out += String.fromCharCode(bytes[index] | (bytes[index + 1] << 8)); return out.normalize("NFC").replace(/\r\n?/g, "\n").replace(/\0+$/, ""); };
function msgProfile(bytes, sourceHash, limits) {
  const descriptor = descriptors.msg; const make = unitFactory(sourceHash, descriptor); const warnings = []; const units = [];
  const { tree, readStream } = cfbParse(bytes, limits);
  const isMsg = [...tree.keys()].some((name) => name.startsWith("__substg1.0_") || name === "__properties_version1.0");
  if (!isMsg) throw new Quarantine("unsupported", "CFBF container is not an Outlook message (legacy Office documents are not supported)");
  const prop = (path, id) => {
    for (const [suffix, decode] of [["001F", (entry) => utf16(readStream(entry))], ["001E", (entry) => new TextDecoder("latin1").decode(readStream(entry)).normalize("NFC").replace(/\r\n?/g, "\n").replace(/\0+$/, "")]]) {
      const entry = tree.get(`${path}__substg1.0_${id}${suffix}`);
      if (entry) return decode(entry);
    }
    return null;
  };
  const binaryProp = (path, id) => tree.get(`${path}__substg1.0_${id}0102`) ?? null;
  const structured = {};
  for (const [key, id] of [["subject", "0037"], ["from", "0C1A"], ["to", "0E04"], ["cc", "0E03"]]) {
    const value = prop("", id); if (value) structured[key] = value;
  }
  const transport = prop("", "007D");
  const headers = transport ? parseHeaderBlock(transport.split("\n\n")[0]) ?? [] : [];
  units.push(make("email-structure", { kind: "header", name: "*" }, { structured_data: { ...structured, header_count: headers.length } }));
  for (const header of headers) units.push(make("email-header", { kind: "header", name: header.name }, { text: decodeEncodedWords(header.value, warnings) }));
  let part = 0;
  const body = prop("", "1000");
  if (body?.trim()) { part += 1; units.push(make("email-body", { kind: "mime-part", part }, { text: body.trim(), structured_data: { media_type: "text/plain" } })); }
  const html = binaryProp("", "1013");
  if (html) {
    part += 1;
    let value; try { value = decoder.decode(readStream(html)); } catch { value = new TextDecoder("latin1").decode(readStream(html)); }
    value = value.replace(/<(?:style|script)\b[\s\S]*?<\/\s*(?:style|script)\b[^>]*>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&").replace(/[ \t]+/g, " ").trim();
    if (value) units.push(make("email-body", { kind: "mime-part", part }, { text: value, structured_data: { media_type: "text/html" } }, ["html-tags-stripped"]));
  }
  if (!body?.trim() && !html && [...tree.keys()].some((name) => name === "__substg1.0_10090102")) warnings.push("rtf-compressed-body-not-decompressed");
  let attachments = 0;
  for (const [name, entry] of tree) {
    const match = /^__attach_version1\.0_#(\d{8})$/.exec(name);
    if (!match || entry.type !== 1) continue;
    attachments += 1; part += 1; exceed("shapes", part, limits.shapes);
    const prefix = `${name}/`;
    const filename = prop(prefix, "3707") ?? prop(prefix, "3704");
    const mediaType = prop(prefix, "370E");
    const data = binaryProp(prefix, "3701");
    const embedded = tree.get(`${prefix}__substg1.0_3701000D`);
    if (data) {
      const content = readStream(data);
      units.push(make("email-attachment", { kind: "mime-part", part }, { structured_data: { filename: filename ?? null, media_type: mediaType ?? null, bytes: content.byteLength, content_hash: byteHash(content), disposition: "attachment" } }, ["attachment-content-not-extracted; ingest it as a separate source"]));
    } else if (embedded) {
      units.push(make("email-attached-message", { kind: "mime-part", part }, { structured_data: { filename: filename ?? null, media_type: "application/vnd.ms-outlook" } }, ["attached-message-not-recursed; ingest it as a separate source"]));
    }
  }
  if (units.length <= 1 && Object.keys(structured).length === 0) throw new Quarantine("malformed", "Outlook message carries no extractable content");
  return { descriptor, units, discovered: tree.size, warnings: [...warnings, ...(attachments > 0 ? ["attachments-inventoried-not-extracted"] : [])] };
}

function serializable(value, fallback = {}) { try { return JSON.parse(canonicalJson(value)); } catch { return fallback; } }
function safeQuarantineSettings(settings) {
  if (!plainObject(settings)) return {};
  const safe = serializable(settings); if (!plainObject(safe) || Object.keys(safe).some((name) => !["language", "delimiter", "sample_rows", "sample_frames"].includes(name))) return {};
  if ((safe.language !== undefined && !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(safe.language)) || (safe.delimiter !== undefined && (typeof safe.delimiter !== "string" || safe.delimiter.length !== 1 || /[\r\n"']/.test(safe.delimiter))) || [safe.sample_rows, safe.sample_frames].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value <= 0))) return {};
  return safe;
}
function quarantineManifest(sourceId, sourceHash, normalizedAt, settings, error) {
  return { api_version: "kdlc.dev/normalization-manifest/v1", source_id: sourceId, source_hash: sourceHash, normalized_at: normalizedAt, status: "quarantined", format: null, normalizer: null, settings: safeQuarantineSettings(settings), coverage: { discovered: 0, emitted: 0 }, omissions: [], quality_warnings: [], outputs: [], security, quarantine: { code: String(error.code ?? "malformed"), message: String(error.message ?? "Normalizer failed safely"), details: serializable(error.details) } };
}
function semanticIdentity({ descriptor, units, probabilisticUnits, manifest }) { const { semantics_hash: ignored, ...manifestSemantics } = manifest; return byteHash(canonicalJson({ descriptor, units, probabilisticUnits, manifest: manifestSemantics })); }
function bindSemanticIdentity(normalized) { normalized.manifest.semantics_hash = semanticIdentity(normalized); return normalized; }
function assertSupportedSemantics(format, settings, coverage, emitted) {
  const allowed = { csv: new Set(["delimiter", "sample_rows", "language"]), gif: new Set(["sample_frames", "language"]) }[format] ?? new Set(["language"]);
  if (Object.keys(settings).some((name) => !allowed.has(name)) || (settings.language !== undefined && !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(settings.language)) || (settings.delimiter !== undefined && (typeof settings.delimiter !== "string" || settings.delimiter.length !== 1 || /[\r\n"']/.test(settings.delimiter))) || [settings.sample_rows, settings.sample_frames].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value <= 0))) throw new Error("Manifest settings do not match the supported format profile");
  const expectedCoverage = format === "gif" ? ["discovered", "duration_ms", "emitted", "height", "width"] : ["discovered", "emitted"];
  if (canonicalJson(Object.keys(coverage).sort()) !== canonicalJson(expectedCoverage) || coverage.emitted !== emitted || !Number.isSafeInteger(coverage.discovered) || coverage.discovered < 0 || (coverage.discovered === 0 && (format !== "markdown" || emitted !== 0))) throw new Error("Manifest coverage does not match the supported format profile");
}

export async function normalizeInRestrictedWorker({ bytes, filename = "", mediaType = "", sourceId, normalizedAt = "1970-01-01T00:00:00.000Z", sourceHash, settings = {}, limits = {}, probabilisticUnits = [] }) {
  if (process.env.KDLC_RESTRICTED_WORKER !== "1" || !process.permission || process.permission.has("child") || process.permission.has("fs.write", "/")) throw new Error("Direct normalization requires the restricted worker capability boundary");
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); const computedHash = byteHash(input); const hash = computedHash; sourceId ??= `source-${hash.slice(7, 23)}`;
  try {
    if (typeof sourceId !== "string" || !portableSourceId.test(sourceId) || !validRfc3339(normalizedAt)) throw new Quarantine("invalid-source-metadata", "Portable source ID and RFC3339 normalization timestamp are required");
    if (!plainObject(settings)) throw new Quarantine("invalid-settings", "Normalization settings must be a plain JSON object");
    const resolvedLimits = { ...defaultLimits };
    for (const [name, value] of Object.entries(limits)) { if (!(name in defaultLimits) || !Number.isSafeInteger(value) || value <= 0 || value > defaultLimits[name]) throw new Quarantine("invalid-limits", "Normalizer limits may only tighten trusted ceilings", { limit: name }); resolvedLimits[name] = value; }
    if (sourceHash && sourceHash !== computedHash) throw new Quarantine("source-hash-mismatch", "Declared source hash does not match input bytes", { declared: sourceHash, actual: computedHash });
    settings = JSON.parse(canonicalJson(settings));
    if (Object.keys(settings).some((name) => !["language", "delimiter", "sample_rows", "sample_frames"].includes(name)) || (settings.sample_rows !== undefined && (!Number.isSafeInteger(settings.sample_rows) || settings.sample_rows <= 0)) || (settings.sample_frames !== undefined && (!Number.isSafeInteger(settings.sample_frames) || settings.sample_frames <= 0))) throw new Quarantine("invalid-settings", "Normalization settings are unsupported or invalid");
    exceed("source_bytes", input.byteLength, resolvedLimits.source_bytes); const started = performance.now(); let format = detect(input, filename, mediaType); let result;
    if (format === "zip") result = officeProfile(input, hash, resolvedLimits);
    else if (format === "markdown" || format === "text") result = linesProfile(input, format, hash);
    else if (format === "csv") result = csvProfile(input, hash, settings, resolvedLimits);
    else if (format === "eml") result = emlProfile(input, hash, resolvedLimits);
    else if (format === "html") result = htmlProfile(input, hash, resolvedLimits);
    else if (format === "cfb") { result = msgProfile(input, hash, resolvedLimits); format = "msg"; }
    else if (format === "pdf") result = await pdfProfile(input, hash, resolvedLimits);
    else if (format === "drawio") result = drawioProfile(input, hash, resolvedLimits);
    else if (format === "gif") result = gifProfile(input, hash, settings, resolvedLimits);
    format = result.descriptor.id.slice(5); exceed("processing_ms", performance.now() - started, resolvedLimits.processing_ms);
    try { assertSupportedSemantics(format, settings, { discovered: result.discovered, emitted: result.units.length, ...(result.coverage ?? {}) }, result.units.length); } catch (error) { throw new Quarantine("invalid-settings", error.message); }
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
    const manifest = { api_version: "kdlc.dev/normalization-manifest/v1", source_id: sourceId, source_hash: hash, normalized_at: normalizedAt, status: omissions.length ? "partial" : "complete", format, normalizer: { id: result.descriptor.id, version: result.descriptor.version, parser: result.descriptor.parser }, settings, coverage: { discovered: result.discovered, emitted: result.units.length, ...(result.coverage ?? {}) }, omissions, quality_warnings: qualityWarnings, outputs, security };
    const normalized = bindSemanticIdentity({ descriptor: result.descriptor, units: result.units, probabilisticUnits, manifest });
    if (!validateManifest(normalized.manifest)) throw new Quarantine("invalid-output-schema", "Normalizer manifest failed its schema contract");
    return normalized;
  } catch (error) {
    const quarantined = error instanceof Quarantine ? error : new Quarantine("malformed", "Normalizer failed safely", { parser: error.message });
    const safeSourceId = typeof sourceId === "string" && portableSourceId.test(sourceId) ? sourceId : `source-${hash.slice(7, 23)}`;
    const safeNormalizedAt = validRfc3339(normalizedAt) ? normalizedAt : "1970-01-01T00:00:00.000Z";
    const normalized = bindSemanticIdentity({ descriptor: null, units: [], probabilisticUnits: [], manifest: quarantineManifest(safeSourceId, hash, safeNormalizedAt, quarantined.code === "invalid-settings" ? {} : settings, quarantined) });
    if (!validateManifest(normalized.manifest)) throw new Error("Quarantine manifest failed its schema contract");
    return normalized;
  }
}

export function portableArtifacts(result, sourceId) {
  if (!portableSourceId.test(sourceId)) throw new Error("Source ID is not portable");
  if (sourceId !== result?.manifest?.source_id) throw new Error("Source ID does not match the normalization manifest");
  if (!validateManifest(result.manifest)) throw new Error("Normalization manifest is invalid");
  if (result.manifest.semantics_hash !== semanticIdentity(result)) throw new Error("Normalization descriptor or manifest semantics were mutated");
  const quarantined = result.manifest.status === "quarantined";
  if (quarantined) {
    if (result.descriptor !== null || result.units.length || result.probabilisticUnits.length || result.manifest.format !== null || result.manifest.normalizer !== null || result.manifest.coverage.discovered !== 0 || result.manifest.coverage.emitted !== 0 || result.manifest.outputs.length) throw new Error("Quarantine result semantics are inconsistent");
  } else {
    const expectedDescriptor = descriptors[result.manifest.format];
    if (!expectedDescriptor || canonicalJson(result.descriptor) !== canonicalJson(expectedDescriptor)) throw new Error("Normalizer descriptor does not match the trusted format profile");
    if (result.manifest.normalizer.id !== result.descriptor.id || result.manifest.normalizer.version !== result.descriptor.version || canonicalJson(result.manifest.normalizer.parser) !== canonicalJson(result.descriptor.parser)) throw new Error("Manifest normalizer provenance does not match its descriptor");
    if (result.manifest.coverage.emitted !== result.units.length || (result.manifest.status === "complete") !== (result.manifest.omissions.length === 0) || (result.manifest.status === "partial") !== (result.manifest.omissions.length > 0)) throw new Error("Manifest coverage or omission semantics are inconsistent");
    assertSupportedSemantics(result.manifest.format, result.manifest.settings, result.manifest.coverage, result.units.length);
    const allowed = new Set(result.descriptor.locator_kinds);
    if (result.units.some((unit) => unit.extraction_method.mode !== "deterministic" || unit.extraction_method.normalizer !== result.descriptor.id || unit.extraction_method.version !== result.descriptor.version || !allowed.has(unit.locator.kind)) || result.probabilisticUnits.some((unit) => unit.extraction_method.mode !== "probabilistic" || !allowed.has(unit.locator.kind))) throw new Error("Unit extraction provenance does not match its descriptor");
    if (result.manifest.settings.language && result.units.some((unit) => unit.language !== result.manifest.settings.language)) throw new Error("Unit language does not match manifest settings");
  }
  const deterministic = `${result.units.map((unit) => canonicalJson(unit)).join("\n")}${result.units.length ? "\n" : ""}`;
  const probabilistic = `${result.probabilisticUnits.map((unit) => canonicalJson(unit)).join("\n")}${result.probabilisticUnits.length ? "\n" : ""}`;
  if (result.units.some((unit) => !validateUnit(unit) || unit.source_hash !== result.manifest.source_hash) || result.probabilisticUnits.some((unit) => !validateUnit(unit) || unit.source_hash !== result.manifest.source_hash)) throw new Error("Normalized units are invalid or source-unbound");
  const expectedOutputs = quarantined ? [] : [{ path: "units.jsonl", hash: byteHash(deterministic), bytes: Buffer.byteLength(deterministic), mode: "deterministic" }, ...(result.probabilisticUnits.length ? [{ path: "probabilistic-units.jsonl", hash: byteHash(probabilistic), bytes: Buffer.byteLength(probabilistic), mode: "probabilistic" }] : [])];
  if (canonicalJson(result.manifest.outputs) !== canonicalJson(expectedOutputs)) throw new Error("Normalization manifest output hashes do not match serialized bytes");
  const basis = result.manifest.semantics_hash;
  const directory = `sources/normalized/${sourceId}/${basis.replace("sha256:", "sha256-")}`;
  const files = { [`${directory}/manifest.json`]: `${canonicalJson(result.manifest)}\n` };
  if (result.manifest.status !== "quarantined") {
    files[`${directory}/units.jsonl`] = deterministic;
    if (result.probabilisticUnits.length) files[`${directory}/probabilistic-units.jsonl`] = probabilistic;
  }
  return { directory, files };
}

export { descriptors, defaultLimits } from "./descriptors.mjs";
