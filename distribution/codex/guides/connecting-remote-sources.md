<!-- generated: packages/adapters/generate.mjs -->
# Connecting remote sources

K-DLC can pull knowledge straight from Google Drive, OneDrive, SharePoint,
and Confluence. The **connector-setup** agent walks you through it — say
"connect our Confluence" (or Drive, or SharePoint) and answer a few
questions.

What the setup produces is a small file, `.kdlc/connectors.json`, that
names where knowledge comes from and **which environment variables** hold
the credentials. The credential values themselves never go in the file, in
the chat, or anywhere K-DLC stores — you set them in the environment
yourself, and the engine refuses any config that looks like it contains a
secret.

What each provider needs (read-only access only):

- **Google Drive** — a service account or OAuth client with the
  drive.readonly scope; credentials referenced by `KDLC_GDRIVE_CREDENTIALS`.
- **OneDrive / SharePoint** — one Microsoft Entra app registration covers
  both, with Files.Read.All and Sites.Read.All (your admin consents once);
  tenant, client ID, and secret in the `KDLC_GRAPH_*` variables.
- **Confluence** — an API token for an account that can read the spaces you
  want, plus your site URL; `KDLC_CONFLUENCE_EMAIL` and
  `KDLC_CONFLUENCE_API_TOKEN`.

**kdlc sources** shows each connector's readiness — which variables are set
(shown only as yes/no, never the values) and what remains to do. Once a
connector is ready, ingested items carry full provenance (which file, which
revision) and staleness checks can tell you when the original changed.
