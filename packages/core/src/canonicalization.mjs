import { createHash } from "node:crypto";

import { fail } from "./errors.mjs";

export const CANONICALIZATION_ID = "kdlc-c14n-1";
export const REVIEW_PROJECTION_ID = "kdlc-review-1";

export const BASE_REVIEW_FIELDS = Object.freeze([
  "body",
  "type",
  "title",
  "description",
  "resource",
  "sources",
  "relationships",
  "access",
  "status"
]);

function normalizeString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("KDLC_CANONICAL_INVALID", "Canonical text rejects lone Unicode surrogates");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail("KDLC_CANONICAL_INVALID", "Canonical text rejects lone Unicode surrogates");
    }
  }
  return value.normalize("NFC");
}

function normalizeJson(value, seen = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value === "string" ? normalizeString(value) : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("KDLC_CANONICAL_INVALID", "Canonical JSON rejects non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    fail("KDLC_CANONICAL_INVALID", `Canonical JSON rejects values of type ${typeof value}`);
  }
  if (seen.has(value)) fail("KDLC_CANONICAL_INVALID", "Canonical JSON rejects cyclic values");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).some((key) => !/^\d+$/.test(key) || Number(key) >= value.length)) {
        fail("KDLC_CANONICAL_INVALID", "Canonical JSON rejects arrays with custom properties");
      }
      const normalized = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) fail("KDLC_CANONICAL_INVALID", "Canonical JSON rejects sparse arrays");
        normalized.push(normalizeJson(value[index], seen));
      }
      return normalized;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      fail("KDLC_CANONICAL_INVALID", "Canonical JSON accepts only plain objects");
    }
    const normalized = Object.create(null);
    for (const key of Object.keys(value)) {
      const normalizedKey = normalizeString(key);
      if (Object.hasOwn(normalized, normalizedKey)) {
        fail("KDLC_CANONICAL_COLLISION", `Unicode normalization creates duplicate key: ${normalizedKey}`);
      }
      normalized[normalizedKey] = normalizeJson(value[key], seen);
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

function encodeCanonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(encodeCanonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${encodeCanonical(value[key])}`).join(",")}}`;
}

export function canonicalJson(value) {
  return encodeCanonical(normalizeJson(value));
}

export function canonicalText(value) {
  if (typeof value !== "string") fail("KDLC_CANONICAL_INVALID", "Canonical text input must be a string");
  return `${normalizeString(value).replace(/\r\n?/g, "\n").replace(/\n*$/, "")}\n`;
}

export function canonicalMarkdownProjection({ frontmatter, body }) {
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    fail("KDLC_CANONICAL_INVALID", "Markdown frontmatter must be a mapping");
  }
  return canonicalJson({ frontmatter, body: canonicalText(body) });
}

export function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function byteHash(bytes) {
  if (typeof bytes === "string") return sha256(Buffer.from(bytes, "utf8"));
  if (!(bytes instanceof Uint8Array)) fail("KDLC_HASH_INPUT", "byteHash requires a string or Uint8Array");
  return sha256(bytes);
}

export function artifactHash(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

export function markdownArtifactHash(document) {
  return sha256(Buffer.from(canonicalMarkdownProjection(document), "utf8"));
}

export function reviewProjection(concept, fields = BASE_REVIEW_FIELDS) {
  if (!concept || typeof concept !== "object") fail("KDLC_REVIEW_INPUT", "Concept must be an object");
  const frontmatter = concept.frontmatter ?? {};
  const projection = Object.create(null);
  for (const field of [...new Set(fields)].sort()) {
    if (field === "body") projection.body = canonicalText(concept.body ?? "");
    else if (Object.hasOwn(frontmatter, field)) projection[field] = frontmatter[field];
  }
  return {
    canonicalization: CANONICALIZATION_ID,
    projection: REVIEW_PROJECTION_ID,
    fields: Object.keys(projection),
    value: projection
  };
}

export function reviewHash(concept, fields = BASE_REVIEW_FIELDS) {
  return artifactHash(reviewProjection(concept, fields));
}
