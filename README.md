# K-DLC — turn your documents into agent-consumable knowledge

**K-DLC (Knowledge Development Lifecycle)** turns the documents your team
already has — wikis, PDFs, Word docs, emails, spreadsheets, decks, diagrams,
web pages, and pages living in **Confluence, SharePoint, OneDrive, or Google
Drive** — into durable, provenance-bearing knowledge that AI agents can
actually trust: curated, linked Markdown concepts in the
[Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
(schemas vendored at [core/schemas/okf-0.2/](core/schemas/okf-0.2/)), produced through a
governed lifecycle with explicit human approval gates. Think of it as a
governed knowledge base builder for the agent era: every answer cites the
exact page, paragraph, or shape it came from, and staleness, conflicts, and
access rules are first-class instead of afterthoughts.

```bash
# try it in a minute (Node 22+, from a checkout)
npm ci && npm link
mkdir ~/my-knowledge && cd ~/my-knowledge
kdlc init && kdlc ingest notes.md && kdlc query "what do we know?"
```

Once the package is published to npm, the same works with zero install:
`npx knowledge-dlc init` — the CLI ships under both the `kdlc` and
`knowledge-dlc` bin names.

One harness-neutral core, rendered natively for **Claude Code, Codex CLI,
Kiro CLI, Kiro IDE, and any MCP client** — the same governed engine, the same
versioned envelope, everywhere.

```text
Sources -> Evidence -> Claims -> Concepts -> Published knowledge
                 \       |          |
                  \------ provenance + review receipts
```

> [!NOTE]
> This repository is in pre-release MVP development against specification
> version 0.2.0. It is not a supported release. Conformance is declared
> module-by-module; no capability is considered implemented until its linked
> issue, tests, and independent review evidence are complete.

> [!IMPORTANT]
> Generative AI can make mistakes. K-DLC never publishes stable knowledge on
> model confidence alone — review the evidence, claims, and diffs its gates
> put in front of you.

## Why K-DLC

Retrieval over raw documents works until the corpus gets real. Then agents cite
stale pages, contradictions surface mid-answer, and nobody can say where a
"fact" came from. K-DLC puts structure around knowledge the way CI puts
structure around code: every claim traces to a source hash and locator,
every concept records who generated and who verified it, conflicts are
retained instead of silently resolved, and publication is a reviewed, atomic
transaction. Search indexes, embeddings, and graphs stay rebuildable
projections — plain files remain the durable contract.

## Key features

- **Evidence-first ingestion** — bounded, sandboxed normalization of thirteen
  formats — Markdown, text, CSV, PDF, Word (.docx), Excel (.xlsx), PowerPoint
  (.pptx), Visio (.vsdx), draw.io, GIF, **email (.eml and Outlook .msg,
  attachments inventoried by hash)**, and **HTML** — into anchored,
  quality-labeled evidence units ([spec §12](docs/knowledge-development-lifecycle-specification.md))
- **Remote sources with real provenance** — deterministic read-only connectors
  for **Confluence, SharePoint, OneDrive (Microsoft Graph), and Google Drive**
  (native Docs/Sheets/Slides exported to formats the pipeline normalizes);
  every fetch records the provider's revision identity and a content hash, so
  staleness checks can tell you when the original changed. A guided
  `connector-setup` agent walks you through credentials — read-only scopes
  only, secrets live in environment variables and are refused anywhere else
- **Claim-to-source provenance** — every assertion carries its source ID,
  version hash, and locator; inferred claims are never dressed up as explicit
  statements
- **Governed lifecycle** — fifteen core stages across Define → Acquire →
  Understand → Integrate → Govern, with review packets, receipts bound to exact
  review hashes, and transactional publication
- **Nine-role agent roster** — conductor, curator, source-analyst, integrator,
  librarian, trust-reviewer, retrieval-agent, maintainer, governance-reviewer —
  with runtime-enforced read/write capabilities, not prompt-text promises
- **Federation** — mount multiple knowledge bases with explicit modes, locked
  versions, and routing; retrieval rank never grants write authority
- **Access-intersection answers** — a query result is allowed only when the
  requester may see the concept *and* all evidence it discloses
- **Deterministic governance** — sensors, audit trails, traceability, and a
  release evaluation that runs with zero live model calls

## Pick your harness

One setup command installs any harness surface into your project, with runner
paths resolved against this installation — the installed files work from any
directory:

```bash
kdlc setup <claude-code|codex|kiro|kiro-ide|mcp>[,...] <project-directory>
```

| Harness | Setup | Invoke |
| --- | --- | --- |
| **Claude Code** | `kdlc setup claude-code .` prints the `claude plugin install …/distribution/claude-code` command | `/kdlc:<operation>`, `kdlc:<role>` agents |
| **Codex CLI** (≥ 0.145) | `kdlc setup codex <project>` writes `.codex/` (skill + agents) into your project; surface source in `distribution/codex/` | `$kdlc` skill, `.codex/agents/<role>` |
| **Kiro CLI** (≥ 2.6) | `kdlc setup kiro <project>` writes `.kiro/` (17 skills + 9 agents) into your project; surface source in `distribution/kiro/.kiro/` | `/kdlc-<operation>`, `.kiro/agents/<role>` |
| **Kiro IDE** | `kdlc setup kiro-ide <project>`; surface source in `distribution/kiro-ide/.kiro/` | `/kdlc-<operation>`, `.kiro/agents/<role>` |
| **Any MCP client** | `kdlc setup mcp <project>` writes a stdio config; HTTP packaging in `distribution/mcp/` | `kb_search`, `kb_fetch`, `proposal_create`, … |

### Quick start per harness

**Claude Code**
```bash
claude plugin install <this-checkout>/distribution/claude-code
# then, inside any project:
/kdlc:init  →  /kdlc:ingest ["notes.md"]  →  /kdlc:query ["what do we know?"]
```

**Kiro CLI / Kiro IDE**
```bash
kdlc setup kiro ~/my-project        # or kiro-ide
# in Kiro, from ~/my-project:
/kdlc-init  →  /kdlc-ingest  →  /kdlc-query
# the kdlc:<role> agents appear under .kiro/agents/
```

**Codex CLI**
```bash
kdlc setup codex ~/my-project
# in Codex: $kdlc with a JSON argument vector, e.g. ["init"]
```

**MCP (Claude Desktop or any client)**
```bash
kdlc setup mcp ~/my-project         # writes kdlc.mcp.json with absolute stdio paths
```

Adapters differ only in packaging: stage requirements, security policy, state
transitions, and artifact contracts are identical everywhere (spec §25), and
every distribution tree is generated from the authored core — CI fails on
drift. Setup output is derived from those same authored definitions.

## Quick start

From a checkout:

```bash
npm ci && npm link     # exposes the `kdlc` CLI
mkdir my-knowledge && cd my-knowledge
kdlc init              # scaffold a governed project workspace
kdlc ingest notes.md   # normalize a source into anchored evidence
kdlc query "what do we know about tokens?"
kdlc setup claude-code .   # or codex | kiro | kiro-ide | mcp
```

Once published to npm, the zero-install form is
`npx knowledge-dlc <command>` — identical commands, no checkout.

The full walkthrough — install, ingest, review, publish, plugin and MCP
setup — lives in **[docs/getting-started.md](docs/getting-started.md)** and is
executed end-to-end by a test on every change.

## Repository layout

Schemas and profiles live under `core/`; stage, agent, sensor, tool,
normalizer, and server sources live under `packages/`; generated harness
output lives under `distribution/<harness>/`. The complete mapping from the
specification's reference layout is recorded in
[ADR-002](docs/decisions/0002-repository-layout-mapping.md).

## Development status and governance

- [Specification baseline](docs/specification-baseline.md) ([full spec](docs/knowledge-development-lifecycle-specification.md))
- [MVP milestone](https://github.com/aithinkers/knowledge-dlc/milestone/1) and [issue backlog](https://github.com/aithinkers/knowledge-dlc/issues)
- [Traceability index](docs/traceability.json)
- [Agent development contract](AGENTS.md) — issue → plan → implementation → tests → independent review → release evidence
- [Release-readiness gates](docs/release-readiness.md)
- [Machine-readable pre-release conformance](distribution/release/conformance-statement.json) (status: not-ready)
- [Recorded pre-release evaluation](distribution/release/evaluation-report.json) — zero live model calls
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Support](SUPPORT.md) · [Code of Conduct](CODE_OF_CONDUCT.md)

## Local governance checks

```bash
node scripts/verify-governance.mjs
node --test tests/governance/*.test.mjs
npm run check:supply-chain
```

## License

[MIT](LICENSE)
