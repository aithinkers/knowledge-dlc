// Confluence Cloud source connector (FEAT-023, #97). Pages are fetched in
// storage format (XHTML) and wrapped for the FEAT-022 html normalizer; the
// version number is the revision identity. Injected transport owns
// authentication (API token stays outside this module).

import { byteHash } from "../core/index.mjs";
import { ConnectorError, expectJson, instant } from "./transport.mjs";

export class ConfluenceConnector {
  /** @param baseUrl e.g. https://yourorg.atlassian.net/wiki */
  constructor(transport, { baseUrl }) {
    if (typeof baseUrl !== "string" || !/^https:\/\//.test(baseUrl)) throw new ConnectorError("ConfluenceConnector requires an https baseUrl");
    this.transport = transport;
    this.base = baseUrl.replace(/\/+$/, "");
  }

  async #page(pageId, { withBody }) {
    const query = withBody ? "?body-format=storage" : "";
    return expectJson(await this.transport.request({ method: "GET", url: `${this.base}/api/v2/pages/${encodeURIComponent(pageId)}${query}` }), "Confluence page");
  }

  /** Fetch a page as HTML bytes plus its FEAT-021 descriptor. */
  async fetchPage({ pageId, spaceKey = null, acquiredAt = instant() }) {
    const page = await this.#page(pageId, { withBody: true });
    const storage = page.body?.storage?.value;
    if (typeof storage !== "string" || storage.length === 0) throw new ConnectorError(`Confluence page ${pageId} has no storage-format body`);
    const version = page.version?.number;
    if (!Number.isInteger(version) || version < 1) throw new ConnectorError(`Confluence page ${pageId} carries no version number`);
    const title = String(page.title ?? pageId);
    const html = `<html><head><title>${title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</title></head><body>\n${storage}\n</body></html>`;
    const bytes = new TextEncoder().encode(html);
    return {
      bytes,
      filename: `${pageId}.html`,
      mediaType: "text/html",
      descriptor: {
        provider: "confluence",
        remote_id: `${spaceKey ?? page.spaceId ?? "space"}:${pageId}`,
        revision: { kind: "version-number", value: String(version) },
        acquired_via: "connector",
        acquired_at: acquiredAt,
        content_hash: byteHash(bytes),
        access_context: { visibility: "internal", detail: `Confluence page — access follows space ${spaceKey ?? page.spaceId ?? "(unknown)"} permissions` },
        display_name: title,
      },
    };
  }

  /** Cheap staleness probe: version number without the body. */
  async probe(receipt) {
    try {
      const pageId = receipt.remote_id.split(":").pop();
      const page = await this.#page(pageId, { withBody: false });
      const version = page.version?.number;
      return Number.isInteger(version) ? { kind: "version-number", value: String(version) } : null;
    } catch {
      return null;
    }
  }
}

export const CONFLUENCE_CAPABILITIES = Object.freeze({
  providers: ["confluence"],
  operations: ["fetchPage", "probe"],
  scopes_required: ["read:page:confluence", "read:space:confluence"],
  writes: false,
  deferrals: ["attachments listing", "blog posts", "space-wide crawl", "comments"],
});
