// Microsoft Graph source connector (FEAT-023, #97): OneDrive drive items and
// SharePoint drive items + site pages through one deterministic module over
// an injected transport. The transport owns authentication; nothing here ever
// sees or stores a credential, and every fetch yields a FEAT-021 remote
// source descriptor with the provider's native revision identity (eTag/cTag).

import { byteHash } from "../core/index.mjs";
import { ConnectorError, expectJson, expectBytes, instant } from "./transport.mjs";

const GRAPH = "https://graph.microsoft.com/v1.0";

/** Map Graph sharing/permission hints to a FEAT-021 access context. */
function accessContext(item) {
  if (item?.shared?.scope === "anonymous") return { visibility: "public", detail: "shared via anonymous link" };
  if (item?.shared?.scope === "organization") return { visibility: "internal", detail: "shared organization-wide" };
  if (item?.shared) return { visibility: "restricted", detail: "shared with specific people" };
  return { visibility: "restricted", detail: "not shared beyond its container" };
}

export class GraphConnector {
  /**
   * @param transport injected: async request({ method, url, headers? }) →
   *   { status, headers, json?(), bytes?() }. Read-only scopes only
   *   (Files.Read.All, Sites.Read.All).
   * @param provider "onedrive" | "sharepoint" — same API, two provider tags.
   */
  constructor(transport, { provider }) {
    if (!["onedrive", "sharepoint"].includes(provider)) throw new ConnectorError(`GraphConnector provider must be onedrive or sharepoint, not ${provider}`);
    this.transport = transport;
    this.provider = provider;
  }

  async #metadata(driveId, itemId) {
    return expectJson(await this.transport.request({ method: "GET", url: `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}` }), "drive item metadata");
  }

  /** Fetch a drive item's original bytes plus its FEAT-021 descriptor. */
  async fetchDriveItem({ driveId, itemId, acquiredAt = instant() }) {
    const item = await this.#metadata(driveId, itemId);
    if (item.deleted) throw new ConnectorError(`drive item ${itemId} is deleted at the provider`);
    if (!item.file) throw new ConnectorError(`drive item ${itemId} is not a file (folders and notebooks are not ingestable)`);
    const bytes = expectBytes(await this.transport.request({ method: "GET", url: `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content` }), "drive item content");
    const revision = typeof item.eTag === "string" && item.eTag.length > 0
      ? { kind: "etag", value: item.eTag }
      : { kind: "ctag", value: String(item.cTag ?? "") };
    if (!revision.value) throw new ConnectorError(`drive item ${itemId} carries no usable revision identity`);
    return {
      bytes,
      filename: item.name ?? `${itemId}`,
      mediaType: item.file.mimeType ?? "",
      descriptor: {
        provider: this.provider,
        remote_id: `${driveId}:${itemId}`,
        revision,
        acquired_via: "connector",
        acquired_at: acquiredAt,
        content_hash: byteHash(bytes),
        access_context: accessContext(item),
        display_name: item.name ?? undefined,
      },
    };
  }

  /** SharePoint modern page: assemble its text web parts into HTML for the html normalizer. */
  async fetchSitePage({ siteId, pageId, acquiredAt = instant() }) {
    if (this.provider !== "sharepoint") throw new ConnectorError("site pages exist only on the sharepoint provider");
    const page = expectJson(await this.transport.request({ method: "GET", url: `${GRAPH}/sites/${encodeURIComponent(siteId)}/pages/${encodeURIComponent(pageId)}/microsoft.graph.sitePage?$expand=canvasLayout` }), "site page");
    const fragments = [];
    for (const section of page.canvasLayout?.horizontalSections ?? []) {
      for (const column of section.columns ?? []) {
        for (const webpart of column.webparts ?? []) {
          if (typeof webpart.innerHtml === "string") fragments.push(webpart.innerHtml);
        }
      }
    }
    for (const webpart of page.canvasLayout?.verticalSection?.webparts ?? []) {
      if (typeof webpart.innerHtml === "string") fragments.push(webpart.innerHtml);
    }
    const title = String(page.title ?? page.name ?? pageId);
    const html = `<html><head><title>${title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</title></head><body>\n${fragments.join("\n")}\n</body></html>`;
    const bytes = new TextEncoder().encode(html);
    const revision = { kind: "etag", value: String(page.eTag ?? page.lastModifiedDateTime ?? "") };
    if (!revision.value) throw new ConnectorError(`site page ${pageId} carries no usable revision identity`);
    return {
      bytes,
      filename: `${page.name ?? pageId}.html`,
      mediaType: "text/html",
      descriptor: {
        provider: "sharepoint",
        remote_id: `site:${siteId}:page:${pageId}`,
        revision,
        acquired_via: "connector",
        acquired_at: acquiredAt,
        content_hash: byteHash(bytes),
        access_context: { visibility: "internal", detail: "SharePoint site page — access follows the site's permissions" },
        display_name: title,
      },
    };
  }

  /** Cheap staleness probe for receiptStaleness: null means unreachable. */
  async probe(receipt) {
    try {
      if (receipt.remote_id.startsWith("site:")) {
        const [, siteId, , pageId] = receipt.remote_id.split(":");
        const page = expectJson(await this.transport.request({ method: "GET", url: `${GRAPH}/sites/${encodeURIComponent(siteId)}/pages/${encodeURIComponent(pageId)}` }), "site page probe");
        return { kind: "etag", value: String(page.eTag ?? page.lastModifiedDateTime ?? "") || null };
      }
      const [driveId, itemId] = receipt.remote_id.split(":");
      const item = await this.#metadata(driveId, itemId);
      if (item.deleted) return null;
      return receipt.revision.kind === "ctag"
        ? { kind: "ctag", value: String(item.cTag ?? "") || null }
        : { kind: "etag", value: String(item.eTag ?? "") || null };
    } catch {
      return null; // deleted, moved, or permission lost — receiptStaleness reports it plainly
    }
  }
}

export const GRAPH_CAPABILITIES = Object.freeze({
  providers: ["onedrive", "sharepoint"],
  operations: ["fetchDriveItem", "fetchSitePage", "probe"],
  scopes_required: ["Files.Read.All", "Sites.Read.All"],
  writes: false,
  deferrals: ["delta-query bulk sync", "list items and document-set metadata", "page comments"],
});
