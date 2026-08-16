import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AGENT_DEFINITIONS, renderAgentMarkdown, renderKiroAgentManifest } from "../../packages/agents/definitions/index.mjs";
import { CONNECTORS_API_VERSION, PROVIDER_ENV, connectorReadiness, validateConnectorsConfig } from "../../packages/sources/config.mjs";
import { KdlcEngine, createLocalProjectEngine } from "../../packages/cli/index.mjs";

const fakeToken = ["ATATT", "3xFfGF0aBcDeFgHiJkLmNoPqRsTuVwXyZ", "012345"].join("");

const good = {
  api_version: CONNECTORS_API_VERSION,
  connectors: [
    { id: "eng-wiki", provider: "confluence", base_url: "https://org.atlassian.net/wiki", auth_env: { KDLC_CONFLUENCE_EMAIL: "KDLC_CONFLUENCE_EMAIL", KDLC_CONFLUENCE_API_TOKEN: "KDLC_CONFLUENCE_API_TOKEN" } },
    { id: "team-drive", provider: "google-drive", auth_env: { KDLC_GDRIVE_CREDENTIALS: "KDLC_GDRIVE_CREDENTIALS" }, notes: "shared drive: Engineering" }
  ]
};

test("FEAT-025: connector configs validate fail-closed with plain-language findings", () => {
  assert.deepEqual(validateConnectorsConfig(good), []);
  assert.deepEqual(validateConnectorsConfig(null), ["connectors config must be an object"]);
  const failures = validateConnectorsConfig({
    api_version: "wrong",
    connectors: [
      { id: "Bad Slug!", provider: "dropbox" },
      { id: "x", provider: "confluence", auth_env: { KDLC_CONFLUENCE_EMAIL: "KDLC_CONFLUENCE_EMAIL", KDLC_CONFLUENCE_API_TOKEN: "KDLC_CONFLUENCE_API_TOKEN" }, base_url: "ftp://nope", extra: 1 }
    ]
  });
  assert.ok(failures.some((failure) => /api_version/.test(failure)));
  assert.ok(failures.some((failure) => /short lowercase slug/.test(failure)));
  assert.ok(failures.some((failure) => /provider must be one of/.test(failure)));
  assert.ok(failures.some((failure) => /requires base_url/.test(failure)));
  assert.ok(failures.some((failure) => /unknown field "extra"/.test(failure)));
  assert.deepEqual(PROVIDER_ENV.onedrive, PROVIDER_ENV.sharepoint, "one Entra app registration covers both");
});

test("FEAT-025: anything credential-shaped in the config is rejected", () => {
  const withSecret = structuredClone(good);
  withSecret.connectors[0].auth_env.KDLC_CONFLUENCE_API_TOKEN = fakeToken;
  assert.ok(validateConnectorsConfig(withSecret).some((failure) => /environment variable NAME/.test(failure)));
  const jwt = structuredClone(good);
  jwt.connectors[1].notes = `token: ${["eyJ","hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"].join("")}.payload`;
  assert.ok(validateConnectorsConfig(jwt).some((failure) => /contains a credential/.test(failure)));
  const pem = structuredClone(good);
  pem.connectors[1].auth_env.KDLC_GDRIVE_CREDENTIALS = "-----BEGIN PRIVATE KEY-----";
  assert.ok(validateConnectorsConfig(pem).length > 0);

  // Review-round bypasses, all closed:
  const userinfo = structuredClone(good);
  userinfo.connectors[0].base_url = `https://admin:${fakeToken}@org.atlassian.net/wiki`;
  assert.ok(validateConnectorsConfig(userinfo).some((failure) => /must not embed credentials/.test(failure)), "userinfo URLs rejected");
  const arrayValue = structuredClone(good);
  arrayValue.connectors[1].auth_env.EXTRA = [fakeToken];
  assert.ok(validateConnectorsConfig(arrayValue).some((failure) => /auth_env\.EXTRA must be an environment variable NAME/.test(failure)), "non-string auth_env values rejected");
  const objectValue = structuredClone(good);
  objectValue.connectors[1].auth_env.KDLC_GDRIVE_CREDENTIALS = { token: fakeToken };
  assert.ok(validateConnectorsConfig(objectValue).length > 0, "object auth_env values rejected");
  const arrayNotes = structuredClone(good);
  arrayNotes.connectors[1].notes = [fakeToken];
  assert.ok(validateConnectorsConfig(arrayNotes).some((failure) => /notes must be a string/.test(failure)), "non-string notes rejected");
});

test("FEAT-025: readiness reports env presence as booleans only, never values", () => {
  const readiness = connectorReadiness(good, { KDLC_CONFLUENCE_EMAIL: "ana@example.com", KDLC_CONFLUENCE_API_TOKEN: "secret-token-value" });
  assert.equal(readiness.valid, true);
  const wiki = readiness.connectors.find(({ id }) => id === "eng-wiki");
  assert.deepEqual(wiki.env, { KDLC_CONFLUENCE_EMAIL: true, KDLC_CONFLUENCE_API_TOKEN: true });
  assert.equal(wiki.ready, true);
  const drive = readiness.connectors.find(({ id }) => id === "team-drive");
  assert.equal(drive.ready, false);
  assert.match(drive.hint, /set KDLC_GDRIVE_CREDENTIALS/);
  assert.ok(!JSON.stringify(readiness).includes("secret-token-value"), "values never surface");
  assert.equal(connectorReadiness({ api_version: "wrong" }).valid, false);
});

test("FEAT-025: kdlc sources surfaces connector readiness alongside receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "kdlc-connsetup-"));
  await new KdlcEngine({ root }).execute("init", { project_id: "connector.fixture" });
  await mkdir(join(root, ".kdlc"), { recursive: true });
  await writeFile(join(root, ".kdlc/connectors.json"), JSON.stringify(good));
  const engine = createLocalProjectEngine({ root });
  const listing = await engine.execute("sources", {});
  assert.deepEqual(listing.sources, []);
  assert.equal(listing.connectors.valid, true);
  assert.equal(listing.connectors.connectors.length, 2);
  // A corrupt config degrades to findings, not a crash.
  await writeFile(join(root, ".kdlc/connectors.json"), "{not json");
  const broken = await engine.execute("sources", {});
  assert.equal(broken.connectors.valid, false);
});

test("FEAT-025: the connector-setup agent renders with honest enforcement and never requests secrets inline", () => {
  const definition = AGENT_DEFINITIONS.find(({ role }) => role === "connector-setup");
  assert.ok(definition, "connector-setup agent exists");
  const markdown = renderAgentMarkdown(definition);
  assert.ok(markdown.includes("harness-level setup assistant"));
  assert.ok(markdown.includes("never ask for, accept, echo, or write a credential value"));
  assert.ok(markdown.includes("drive.readonly") && markdown.includes("Files.Read.All") && markdown.includes("KDLC_CONFLUENCE_API_TOKEN"));
  assert.ok(!markdown.includes("packages/agents/roles/connector-setup.json"), "no phantom runtime descriptor claimed");
  const manifest = renderKiroAgentManifest(definition, { harness: "kiro" });
  assert.ok(manifest.tools.includes("fs_write"), "setup assistant can write its config on kiro");
});
