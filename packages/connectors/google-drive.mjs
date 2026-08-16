// Google Drive source connector (FEAT-024, #98). Binary files download as
// original bytes; native Google formats (Docs/Sheets/Slides/Drawings) export
// to OOXML/PDF so the existing normalizers apply, with the export choice
// recorded as fidelity metadata on the descriptor. Injected transport owns
// authentication (drive.readonly); revision IDs are the staleness identity.

import { byteHash } from "../core/index.mjs";
import { ConnectorError, expectBytes, expectJson, instant } from "./transport.mjs";

const DRIVE = "https://www.googleapis.com/drive/v3";
const FIELDS = "id,name,mimeType,headRevisionId,version,trashed,shared,capabilities/canDownload,exportLinks";

/** Native Google formats and the export the pipeline can normalize. */
export const DRIVE_EXPORTS = Object.freeze({
  "application/vnd.google-apps.document": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: ".docx" },
  "application/vnd.google-apps.spreadsheet": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: ".xlsx" },
  "application/vnd.google-apps.presentation": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", extension: ".pptx" },
  "application/vnd.google-apps.drawing": { mime: "application/pdf", extension: ".pdf" },
});

function revisionOf(file) {
  if (typeof file.headRevisionId === "string" && file.headRevisionId.length > 0) return { kind: "revision-id", value: file.headRevisionId };
  // Native Google formats expose no headRevisionId; the monotonic version
  // counter is the documented change signal for them.
  if (file.version !== undefined && String(file.version).length > 0) return { kind: "revision-id", value: `version:${file.version}` };
  return null;
}

export class GoogleDriveConnector {
  constructor(transport) {
    this.transport = transport;
  }

  async #metadata(fileId) {
    return expectJson(await this.transport.request({ method: "GET", url: `${DRIVE}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=${encodeURIComponent(FIELDS)}` }), "Drive file metadata");
  }

  /**
   * Fetch a file's bytes plus its FEAT-021 descriptor. Binary content
   * downloads as-is; native Google formats export per DRIVE_EXPORTS with the
   * choice recorded in export_fidelity.
   */
  async fetchFile({ fileId, acquiredAt = instant() }) {
    const file = await this.#metadata(fileId);
    if (file.trashed) throw new ConnectorError(`Drive file ${fileId} is in the trash — restore it or drop the source`);
    if (file.capabilities && file.capabilities.canDownload === false) {
      throw new ConnectorError(`Drive file ${fileId} cannot be downloaded with this credential (view-only restriction)`);
    }
    const revision = revisionOf(file);
    if (!revision) throw new ConnectorError(`Drive file ${fileId} carries no usable revision identity`);
    const nativeExport = DRIVE_EXPORTS[file.mimeType] ?? null;
    let bytes; let mediaType; let filename; let exportFidelity;
    if (nativeExport) {
      bytes = expectBytes(await this.transport.request({ method: "GET", url: `${DRIVE}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(nativeExport.mime)}` }), "Drive export");
      mediaType = nativeExport.mime;
      filename = `${file.name ?? fileId}${nativeExport.extension}`;
      exportFidelity = `exported from ${file.mimeType} — comments, suggestions, and revision history are not carried`;
    } else if ((file.mimeType ?? "").startsWith("application/vnd.google-apps.")) {
      throw new ConnectorError(`Drive file ${fileId} is a ${file.mimeType} — this native format has no supported export`);
    } else {
      bytes = expectBytes(await this.transport.request({ method: "GET", url: `${DRIVE}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true` }), "Drive download");
      mediaType = file.mimeType ?? "";
      filename = file.name ?? `${fileId}`;
      exportFidelity = null;
    }
    return {
      bytes,
      filename,
      mediaType,
      ...(exportFidelity ? { export_fidelity: exportFidelity } : {}),
      descriptor: {
        provider: "google-drive",
        remote_id: fileId,
        revision,
        acquired_via: "connector",
        acquired_at: acquiredAt,
        content_hash: byteHash(bytes),
        access_context: file.shared
          ? { visibility: "internal", detail: "shared in Google Drive — audience follows the file's sharing settings" }
          : { visibility: "restricted", detail: "not shared beyond its owner" },
        display_name: file.name ?? undefined,
      },
    };
  }

  /** Cheap staleness probe; null means deleted, trashed, or access lost. */
  async probe(receipt) {
    try {
      const file = await this.#metadata(receipt.remote_id);
      if (file.trashed) return null;
      const revision = revisionOf(file);
      return revision ?? null;
    } catch {
      return null;
    }
  }
}

export const GOOGLE_DRIVE_CAPABILITIES = Object.freeze({
  providers: ["google-drive"],
  operations: ["fetchFile", "probe"],
  scopes_required: ["https://www.googleapis.com/auth/drive.readonly"],
  writes: false,
  deferrals: ["folder crawl", "comments", "revision-history diffs", "forms and sites native formats"],
});
