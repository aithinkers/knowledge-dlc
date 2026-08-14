import { artifactHash } from "./canonicalization.mjs";
import { fail } from "./errors.mjs";
import { posix } from "node:path";

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DISPOSITIONS = new Set(["accepted", "rejected", "merged", "superseded", "conflict"]);
const EXTRACTIONS = new Set(["explicit", "inferred", "computed"]);

function citations(body) {
  const visible = [];
  let fence;
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/i)?.[1];
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      visible.push("");
    } else visible.push(fence ? "" : line.replace(/`+[^`]*`+/g, ""));
  }
  return new Set([...visible.join("\n").matchAll(/\[\^([^\]\s]+)\]/g)].map((match) => match[1]));
}

export function canonicalClaimSidecar(claims) {
  if (!Array.isArray(claims)) fail("KDLC_CLAIM_SIDECAR_INVALID", "Claim sidecar must be an array");
  const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  return [...claims].sort((left, right) => compare(String(left.assertion_key), String(right.assertion_key)) || compare(String(left.id ?? ""), String(right.id ?? "")));
}

function validatePublishedResource(resource) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(resource)) return;
  const normalized = posix.normalize(resource.replace(/^\//, ""));
  if (!normalized || normalized === ".." || normalized.startsWith("../") || normalized.includes("\\") || normalized !== resource.replace(/^\//, "")) {
    fail("KDLC_PROVENANCE_NOT_DURABLE", `Unsafe published source resource: ${resource}`);
  }
}

export function validatePublishedProvenance({ concept, profile = "team", claims, sourceRecords = new Map() }) {
  if (!concept?.id || !concept?.frontmatter || typeof concept.body !== "string") {
    fail("KDLC_CONCEPT_INVALID", "Published concept id, parsed frontmatter, and body are required");
  }
  if (posix.normalize(concept.id) !== concept.id || concept.id.startsWith("/") || concept.id.split("/").some((part) => !part || part === "..")) {
    fail("KDLC_CONCEPT_INVALID", `Unsafe concept ID: ${concept.id}`);
  }
  const sources = concept.frontmatter.sources;
  if (!Array.isArray(sources) || sources.length === 0) fail("KDLC_CITATION_INVALID", "Published concept requires sources");
  const byId = new Map();
  for (const source of sources) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(source?.id ?? "") || !source?.resource) fail("KDLC_CITATION_INVALID", "Each cited source requires a stable id and resource");
    if (byId.has(source.id)) fail("KDLC_CITATION_INVALID", `Duplicate source entry id: ${source.id}`);
    if (/^sources\/records\//.test(source.resource.replace(/^(?:\.\/|\/)/, ""))) {
      fail("KDLC_PROVENANCE_NOT_DURABLE", `Project-local source record cannot be published: ${source.resource}`);
    }
    validatePublishedResource(source.resource);
    if (source.source_hash && !HASH_PATTERN.test(source.source_hash)) fail("KDLC_SOURCE_HASH_INVALID", `Invalid source hash: ${source.id}`);
    if (source.source_record_id) {
      if (!sourceRecords.has(source.source_record_id)) fail("KDLC_SOURCE_RECORD_MISSING", `Reviewed source record is unavailable: ${source.id}`);
      if (sourceRecords.get(source.source_record_id) !== source.source_hash) fail("KDLC_SOURCE_HASH_MISMATCH", `Reviewed source hash does not match: ${source.id}`);
    }
    byId.set(source.id, source);
  }
  for (const label of citations(concept.body)) {
    if (!byId.has(label)) fail("KDLC_CITATION_INVALID", `Footnote has no matching source entry: ${label}`);
  }

  if (["team", "controlled"].includes(profile)) {
    const pointer = concept.frontmatter.claim_provenance;
    if (!pointer?.resource || !HASH_PATTERN.test(pointer.artifact_hash ?? "")) {
      fail("KDLC_CLAIM_SIDECAR_MISSING", `${profile} publication requires a hash-bound claim sidecar`);
    }
    const expectedPath = `references/claims/${concept.id}.jsonl`;
    if (pointer.resource.replace(/^\//, "") !== expectedPath) {
      fail("KDLC_CLAIM_SIDECAR_INVALID", `Claim sidecar must use portable path ${expectedPath}`);
    }
    const canonical = canonicalClaimSidecar(claims);
    if (canonical.length === 0) fail("KDLC_CLAIM_SIDECAR_INVALID", "Governed claim sidecar must contain at least one claim");
    if (pointer.artifact_hash !== artifactHash(canonical)) fail("KDLC_CLAIM_SIDECAR_HASH", "Claim sidecar artifact hash does not match");
    const assertionKeys = new Set();
    for (const claim of canonical) {
      if (!claim.assertion_key?.startsWith(`${concept.id}#`) || claim.assertion_key.length === concept.id.length + 1 || assertionKeys.has(claim.assertion_key)) {
        fail("KDLC_CLAIM_SIDECAR_INVALID", `Claim assertion key is missing, unstable, or duplicate: ${claim.assertion_key}`);
      }
      assertionKeys.add(claim.assertion_key);
      const source = byId.get(claim.source_entry_id);
      if (!source) fail("KDLC_CLAIM_SIDECAR_INVALID", `Claim refers to unknown source entry: ${claim.source_entry_id}`);
      if (claim.source_hash !== source.source_hash || (claim.source_record_id && claim.source_record_id !== source.source_record_id)) {
        fail("KDLC_CLAIM_SIDECAR_INVALID", `Claim source provenance does not match source entry: ${claim.assertion_key}`);
      }
      if (!claim.locator || !EXTRACTIONS.has(claim.extraction) || !DISPOSITIONS.has(claim.disposition) || !claim.assertion || !HASH_PATTERN.test(claim.source_hash ?? "")) {
        fail("KDLC_CLAIM_SIDECAR_INVALID", `Claim is missing locator, extraction, disposition, or assertion: ${claim.assertion_key}`);
      }
    }
  }
  return true;
}
