const limits = Object.freeze({ source_bytes: 25_000_000, expanded_bytes: 100_000_000, pages: 500, sheets: 100, rows: 100_000, slides: 500, shapes: 50_000, frames: 500, processing_ms: 30_000, memory_bytes: 536_870_912, output_bytes: 50_000_000 });
const capabilities = Object.freeze({ network: false, execute_code: false, macros: false, model: false, native_converter: false });

function descriptor(id, parser, accepted, locatorKinds, fidelity = []) {
  return Object.freeze({
    api_version: "kdlc.dev/normalizer-descriptor/v1", id: `kdlc.${id}`, version: "1.0.0", parser,
    accepted, extraction: "deterministic", output_schema: "kdlc.dev/normalized-unit/v1",
    locator_kinds: locatorKinds, capabilities, limits, encryption: "quarantine",
    failure_modes: ["malformed", "encrypted", "limit-exceeded", "unsupported", "unsafe-active-content"], fidelity_limitations: fidelity
  });
}

export const descriptors = Object.freeze({
  markdown: descriptor("markdown", { name: "kdlc-core-lines", version: "1.0.0", license: "Apache-2.0" }, { media_types: ["text/markdown"], extensions: [".md"] }, ["line-range", "heading"], ["Markdown extensions are retained as text"]),
  text: descriptor("text", { name: "kdlc-core-lines", version: "1.0.0", license: "Apache-2.0" }, { media_types: ["text/plain"], extensions: [".txt"] }, ["line-range"]),
  csv: descriptor("csv", { name: "csv-parse", version: "7.0.2", license: "MIT" }, { media_types: ["text/csv"], extensions: [".csv"] }, ["row", "cell", "range"], ["Type candidates are lexical"]),
  pdf: descriptor("pdf", { name: "pdfjs-dist", version: "6.2.108", license: "Apache-2.0" }, { media_types: ["application/pdf"], extensions: [".pdf"] }, ["page", "page-bbox"], ["Tables and headings are structural heuristics", "OCR is not enabled"]),
  docx: descriptor("docx", { name: "fflate+saxes", version: "0.8.3+6.0.0", license: "MIT+ISC" }, { media_types: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"], extensions: [".docx"] }, ["part-paragraph", "part-table"]),
  xlsx: descriptor("xlsx", { name: "fflate+saxes", version: "0.8.3+6.0.0", license: "MIT+ISC" }, { media_types: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], extensions: [".xlsx"] }, ["sheet-cell", "sheet-range"]),
  pptx: descriptor("pptx", { name: "fflate+saxes", version: "0.8.3+6.0.0", license: "MIT+ISC" }, { media_types: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"], extensions: [".pptx"] }, ["slide", "slide-shape"]),
  drawio: descriptor("drawio", { name: "saxes+fflate", version: "6.0.0+0.8.3", license: "ISC+MIT" }, { media_types: ["application/vnd.jgraph.mxfile", "application/xml"], extensions: [".drawio"] }, ["diagram-cell"]),
  gif: descriptor("gif", { name: "gifuct-js", version: "2.1.2", license: "MIT" }, { media_types: ["image/gif"], extensions: [".gif"] }, ["frame", "time-range"], ["No OCR or generated captions in deterministic output"]),
  html: descriptor("html", { name: "kdlc-core-html", version: "1.0.0", license: "Apache-2.0" }, { media_types: ["text/html", "application/xhtml+xml"], extensions: [".html", ".htm", ".xhtml"] }, ["dom-path"], ["Scripts, styles, comments, and event handlers are removed", "javascript: and data: link targets are dropped", "Layout and visual presentation are not represented", "Malformed markup is recovered token-by-token, not spec-exact"]),
  msg: descriptor("msg", { name: "kdlc-core-cfbf", version: "1.0.0", license: "Apache-2.0" }, { media_types: ["application/vnd.ms-outlook"], extensions: [".msg"] }, ["header", "mime-part"], ["HTML bodies are tag-stripped to text", "Attachments are inventoried with content hashes, not extracted in place — ingest them as separate sources", "RTF-compressed bodies are not decompressed", "Embedded .msg attachments are inventoried, not recursed"]),
  eml: descriptor("eml", { name: "kdlc-core-mime", version: "1.0.0", license: "Apache-2.0" }, { media_types: ["message/rfc822"], extensions: [".eml"] }, ["header", "mime-part"], ["HTML bodies are tag-stripped to text", "Attachments are inventoried with content hashes, not extracted in place — ingest them as separate sources", "Unknown header charsets are retained undecoded"]),
  vsdx: descriptor("vsdx", { name: "fflate+saxes", version: "0.8.3+6.0.0", license: "MIT+ISC" }, { media_types: ["application/vnd.ms-visio.drawing.main+xml", "application/vnd.ms-visio.drawing"], extensions: [".vsdx"] }, ["visio-page", "visio-shape"])
});

export const defaultLimits = limits;
