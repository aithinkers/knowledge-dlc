// Remote source contract (FEAT-021, #95). Provider-neutral descriptors and
// acquisition receipts so bytes fetched from Google Drive, OneDrive,
// SharePoint, or Confluence carry verifiable provenance regardless of the
// transport that delivered them (deterministic connector, MCP-assisted
// interactive fetch, or a manual download). Validation fails closed; a
// receipt binds the descriptor to the exact ingested bytes.

import { byteHash } from "../core/index.mjs";

export const REMOTE_PROVIDERS = Object.freeze(["google-drive", "onedrive", "sharepoint", "confluence"]);
export const ACQUISITION_VIAS = Object.freeze(["connector", "mcp", "manual"]);
/** Revision identity kinds by provider — the cheap staleness probe each API offers. */
export const REVISION_KINDS = Object.freeze({
  "google-drive": ["revision-id"],
  onedrive: ["etag", "ctag"],
  sharepoint: ["etag", "ctag", "version-number"],
  confluence: ["version-number"],
});
const VISIBILITIES = Object.freeze(["public", "internal", "restricted", "unknown"]);
const rfc3339Instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Validate a remote source descriptor. Returns an array of plain-language
 * failures; empty means usable. Never throws on malformed input.
 */
export function validateRemoteDescriptor(descriptor) {
  const failures = [];
  if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    return ["remote descriptor must be an object"];
  }
  if (!REMOTE_PROVIDERS.includes(descriptor.provider)) {
    failures.push(`provider must be one of ${REMOTE_PROVIDERS.join(", ")}, not ${JSON.stringify(descriptor.provider)}`);
  }
  if (typeof descriptor.remote_id !== "string" || descriptor.remote_id.length === 0 || descriptor.remote_id.length > 2048) {
    failures.push("remote_id must be a non-empty string (the provider's stable item identity)");
  }
  const revision = descriptor.revision;
  if (revision === null || typeof revision !== "object" || Array.isArray(revision) || typeof revision.value !== "string" || revision.value.length === 0) {
    failures.push("revision must be an object { kind, value } carrying the provider's version identity");
  } else if (REMOTE_PROVIDERS.includes(descriptor.provider) && !REVISION_KINDS[descriptor.provider].includes(revision.kind)) {
    failures.push(`revision.kind for ${descriptor.provider} must be one of ${REVISION_KINDS[descriptor.provider].join(", ")}, not ${JSON.stringify(revision.kind)}`);
  }
  if (!ACQUISITION_VIAS.includes(descriptor.acquired_via)) {
    failures.push(`acquired_via must be one of ${ACQUISITION_VIAS.join(", ")}`);
  }
  if (typeof descriptor.acquired_at !== "string" || !rfc3339Instant.test(descriptor.acquired_at)) {
    failures.push("acquired_at must be an RFC 3339 instant");
  }
  if (typeof descriptor.content_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(descriptor.content_hash)) {
    failures.push("content_hash must be sha256:<64 hex> of the original acquired bytes");
  }
  const access = descriptor.access_context;
  if (access === null || typeof access !== "object" || Array.isArray(access) || !VISIBILITIES.includes(access.visibility)) {
    failures.push(`access_context.visibility must be one of ${VISIBILITIES.join(", ")} — publication review needs the source's sensitivity`);
  } else if (access.detail !== undefined && typeof access.detail !== "string") {
    failures.push("access_context.detail must be a string when present");
  }
  if (descriptor.display_name !== undefined && typeof descriptor.display_name !== "string") {
    failures.push("display_name must be a string when present");
  }
  return failures;
}

export class RemoteSourceError extends Error {
  constructor(message, failures = []) {
    super(message);
    this.name = "RemoteSourceError";
    this.failures = failures;
  }
}

/**
 * Bind a validated descriptor to the exact bytes being ingested. The declared
 * content_hash MUST match the bytes — an agent or MCP server that handed over
 * different content (extracted text, a re-render, truncation) is rejected so
 * provenance never lies. Returns a frozen acquisition receipt.
 */
export function bindReceipt(descriptor, bytes, { sourceId, receivedAt }) {
  const failures = validateRemoteDescriptor(descriptor);
  if (failures.length > 0) throw new RemoteSourceError("remote descriptor is invalid", failures);
  // Snapshot once: a live object with a content_hash getter must not be able
  // to pass the comparison and persist a different value in the receipt.
  const declaredHash = descriptor.content_hash;
  const actual = byteHash(bytes);
  if (actual !== declaredHash) {
    throw new RemoteSourceError(
      "acquired bytes do not match the declared content_hash — the transport delivered different content than it claimed (extracted text instead of original bytes is the usual cause)",
      [`declared ${descriptor.content_hash}`, `actual ${actual}`],
    );
  }
  return Object.freeze({
    api_version: "kdlc.dev/remote-source-receipt/v1",
    source_id: sourceId,
    provider: descriptor.provider,
    remote_id: descriptor.remote_id,
    revision: Object.freeze({ kind: descriptor.revision.kind, value: descriptor.revision.value }),
    acquired_via: descriptor.acquired_via,
    acquired_at: descriptor.acquired_at,
    received_at: receivedAt,
    content_hash: declaredHash,
    byte_length: bytes.byteLength,
    access_context: Object.freeze({ visibility: descriptor.access_context.visibility, ...(descriptor.access_context.detail ? { detail: descriptor.access_context.detail } : {}) }),
    ...(descriptor.display_name ? { display_name: descriptor.display_name } : {}),
  });
}

/**
 * Compare a stored receipt with a live revision probe. Deterministic: the
 * caller supplies the live value; this only judges.
 */
export function receiptStaleness(receipt, live) {
  if (live === null || live === undefined) {
    return { state: "unreachable", reason: "the source could not be probed — it may be deleted, moved, or access may have been lost" };
  }
  if (typeof live !== "object" || typeof live.value !== "string" || live.value.length === 0) {
    return { state: "unreachable", reason: "the live revision probe returned no usable version identity" };
  }
  if (live.kind !== receipt.revision.kind) {
    return { state: "indeterminate", reason: `stored revision is ${receipt.revision.kind} but the probe returned ${live.kind} — compare after re-acquiring` };
  }
  return live.value === receipt.revision.value
    ? { state: "current", reason: "the provider's version identity is unchanged" }
    : { state: "stale", reason: `the source changed at the provider (${receipt.revision.kind} ${receipt.revision.value} → ${live.value}) — re-ingest to refresh` };
}
