import assert from "node:assert/strict";
import test from "node:test";

import { byteHash } from "../../packages/core/index.mjs";
import {
  ConfluenceConnector,
  CONFLUENCE_CAPABILITIES,
  ConnectorError,
  GraphConnector,
  GRAPH_CAPABILITIES,
  assessReceipts
} from "../../packages/connectors/index.mjs";
import { bindReceipt, validateRemoteDescriptor } from "../../packages/sources/index.mjs";
import { normalize } from "../../packages/normalizers/index.mjs";

/** Recorded transport: exact-URL canned responses; no network ever. */
function recorded(routes) {
  const calls = [];
  return {
    calls,
    request: async ({ method, url }) => {
      calls.push(`${method} ${url}`);
      const route = routes[url];
      if (!route) return { status: 404 };
      return route;
    }
  };
}

const docBytes = new TextEncoder().encode("# Design\n\nGraph-fetched design note.\n");
const GRAPH = "https://graph.microsoft.com/v1.0";
const driveRoutes = {
  [`${GRAPH}/drives/d1/items/i1`]: { status: 200, json: () => ({ name: "design.md", eTag: '"etag-7"', cTag: "ctag-3", file: { mimeType: "text/markdown" }, shared: { scope: "organization" } }) },
  [`${GRAPH}/drives/d1/items/i1/content`]: { status: 200, bytes: () => docBytes },
  [`${GRAPH}/drives/d1/items/gone`]: { status: 404 },
  [`${GRAPH}/drives/d1/items/secret`]: { status: 403 },
};

test("FEAT-023: Graph drive items yield valid descriptors bound to the fetched bytes", async () => {
  const connector = new GraphConnector(recorded(driveRoutes), { provider: "onedrive" });
  const fetched = await connector.fetchDriveItem({ driveId: "d1", itemId: "i1", acquiredAt: "2026-08-16T12:00:00Z" });
  assert.deepEqual(validateRemoteDescriptor(fetched.descriptor), []);
  assert.equal(fetched.descriptor.revision.kind, "etag");
  assert.equal(fetched.descriptor.access_context.visibility, "internal");
  const receipt = bindReceipt(fetched.descriptor, fetched.bytes, { sourceId: "src_0000000000000001", receivedAt: "2026-08-16T12:00:01Z" });
  assert.equal(receipt.content_hash, byteHash(docBytes));
  // And the bytes flow through the ordinary normalizer pipeline.
  const result = await normalize({ bytes: Buffer.from(fetched.bytes), filename: fetched.filename });
  assert.equal(result.manifest.format, "markdown");
});

test("FEAT-023: deleted, denied, and folder items fail closed with plain reasons", async () => {
  const connector = new GraphConnector(recorded(driveRoutes), { provider: "onedrive" });
  await assert.rejects(connector.fetchDriveItem({ driveId: "d1", itemId: "gone" }), /not found — the item may be deleted or moved/);
  await assert.rejects(connector.fetchDriveItem({ driveId: "d1", itemId: "secret" }), /access denied/);
  const folderRoutes = { [`${GRAPH}/drives/d1/items/f1`]: { status: 200, json: () => ({ name: "Folder", folder: {} }) } };
  await assert.rejects(new GraphConnector(recorded(folderRoutes), { provider: "onedrive" }).fetchDriveItem({ driveId: "d1", itemId: "f1" }), /not a file/);
  assert.throws(() => new GraphConnector(recorded({}), { provider: "google-drive" }), ConnectorError);
});

test("FEAT-023: SharePoint site pages assemble web parts into html-normalizer-ready bytes", async () => {
  const pageRoutes = {
    [`${GRAPH}/sites/s1/pages/p1/microsoft.graph.sitePage?$expand=canvasLayout`]: {
      status: 200,
      json: () => ({
        title: "Team Charter <2026>", name: "charter", eTag: '"p-9"',
        canvasLayout: { horizontalSections: [{ columns: [{ webparts: [{ innerHtml: "<h1>Charter</h1><p>We ship weekly.</p>" }] }] }] }
      })
    }
  };
  const connector = new GraphConnector(recorded(pageRoutes), { provider: "sharepoint" });
  const fetched = await connector.fetchSitePage({ siteId: "s1", pageId: "p1", acquiredAt: "2026-08-16T12:00:00Z" });
  assert.deepEqual(validateRemoteDescriptor(fetched.descriptor), []);
  assert.equal(fetched.descriptor.remote_id, "site:s1:page:p1");
  const result = await normalize({ bytes: Buffer.from(fetched.bytes), filename: fetched.filename });
  assert.equal(result.manifest.format, "html");
  assert.equal(result.units.find(({ kind }) => kind === "html-metadata").structured_data.title, "Team Charter <2026>", "title escaped into the wrapper, decoded back out");
  assert.ok(result.units.some(({ kind, text }) => kind === "heading" && text === "Charter"));
  await assert.rejects(new GraphConnector(recorded({}), { provider: "onedrive" }).fetchSitePage({ siteId: "s", pageId: "p" }), /only on the sharepoint provider/);
});

test("FEAT-023: Confluence pages carry version-number revisions and space access context", async () => {
  const base = "https://org.atlassian.net/wiki";
  const routes = {
    [`${base}/api/v2/pages/777?body-format=storage`]: {
      status: 200,
      json: () => ({ title: "Runbook", spaceId: "ENG", version: { number: 12 }, body: { storage: { value: "<h2>Failover</h2><p>30 seconds &amp; confirmed.</p>" } } })
    },
    [`${base}/api/v2/pages/777`]: { status: 200, json: () => ({ title: "Runbook", version: { number: 13 } }) }
  };
  const connector = new ConfluenceConnector(recorded(routes), { baseUrl: base });
  const fetched = await connector.fetchPage({ pageId: "777", spaceKey: "ENG", acquiredAt: "2026-08-16T12:00:00Z" });
  assert.deepEqual(validateRemoteDescriptor(fetched.descriptor), []);
  assert.deepEqual(fetched.descriptor.revision, { kind: "version-number", value: "12" });
  assert.match(fetched.descriptor.access_context.detail, /space ENG/);
  const result = await normalize({ bytes: Buffer.from(fetched.bytes), filename: fetched.filename });
  assert.equal(result.manifest.format, "html");
  assert.equal(result.units.find(({ kind }) => kind === "paragraph").text, "30 seconds & confirmed.");
  // The cheap probe sees the newer version without fetching the body.
  const receipt = bindReceipt(fetched.descriptor, fetched.bytes, { sourceId: "src_0000000000000002", receivedAt: "2026-08-16T12:00:01Z" });
  assert.deepEqual(await connector.probe(receipt), { kind: "version-number", value: "13" });
  assert.throws(() => new ConfluenceConnector(recorded({}), { baseUrl: "http://insecure" }), ConnectorError);
});

test("FEAT-023: receipt assessment turns probes into refresh and investigate proposals", async () => {
  const make = (id, provider, kind, value, name) => bindReceipt(
    { provider, remote_id: id, revision: { kind, value }, acquired_via: "connector", acquired_at: "2026-08-16T12:00:00Z", content_hash: byteHash(docBytes), access_context: { visibility: "internal" }, display_name: name },
    docBytes, { sourceId: `src_${id.replace(/[^a-f0-9]/g, "0").padEnd(16, "0").slice(0, 16)}`, receivedAt: "2026-08-16T12:00:01Z" }
  );
  const current = make("d1:a1", "onedrive", "etag", "same", "Current Doc");
  const stale = make("ENG:9", "confluence", "version-number", "4", "Stale Page");
  const lost = make("d1:b2", "sharepoint", "etag", "x", "Lost Doc");
  const proposals = await assessReceipts([current, stale, lost], (receipt) => {
    if (receipt === current) return Promise.resolve({ kind: "etag", value: "same" });
    if (receipt === stale) return Promise.resolve({ kind: "version-number", value: "6" });
    return Promise.resolve(null); // deleted / permission lost
  });
  assert.equal(proposals.length, 2);
  assert.equal(proposals[0].kind, "refresh");
  assert.match(proposals[0].reason, /4 → 6/);
  assert.equal(proposals[1].kind, "investigate-source");
  assert.match(proposals[1].reason, /deleted, moved, or access may have been lost/);
});

test("FEAT-023: capabilities declare read-only scopes and honest deferrals; no credentials appear anywhere", async () => {
  assert.equal(GRAPH_CAPABILITIES.writes, false);
  assert.equal(CONFLUENCE_CAPABILITIES.writes, false);
  assert.ok(GRAPH_CAPABILITIES.deferrals.length > 0 && CONFLUENCE_CAPABILITIES.deferrals.length > 0);
  const transport = recorded(driveRoutes);
  const connector = new GraphConnector(transport, { provider: "onedrive" });
  const fetched = await connector.fetchDriveItem({ driveId: "d1", itemId: "i1" });
  const blob = JSON.stringify({ descriptor: fetched.descriptor, calls: transport.calls });
  assert.ok(!/authorization|bearer|token|secret/i.test(blob), "no credential material in outputs or recorded calls");
});
