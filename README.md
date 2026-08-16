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
# get started (Node 22+, from a checkout)
npm ci && npm link
kdlc setup claude-code ~/my-project   # or codex | kiro | kiro-ide | mcp
# then, inside your AI tool: "init a knowledge base and ingest ./docs"
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

## Step 1 — add K-DLC to your AI tool

K-DLC is designed to be used *inside* your AI tool: the agents drive the
lifecycle (ingest → claims → concepts → review → publish) and stop at the
review gates for your decisions. One setup command installs any harness
surface into your project, with runner paths resolved against this
installation — the installed files work from any directory:

```bash
kdlc setup <claude-code|codex|kiro|kiro-ide|mcp>[,...] <project-directory>
```

| Harness | Setup | Invoke |
| --- | --- | --- |
| **Claude Code** | `kdlc setup claude-code .` prints the marketplace add + `claude plugin install kdlc@kdlc` commands | `/kdlc:<operation>`, `kdlc:<role>` agents |
| **Codex CLI** (≥ 0.145) | `kdlc setup codex <project>` writes `.codex/` (skill + agents) into your project; surface source in `distribution/codex/` | `$kdlc` skill, `.codex/agents/<role>` |
| **Kiro CLI** (≥ 2.6) | `kdlc setup kiro <project>` writes `.kiro/` (skills + agents) into your project; surface source in `distribution/kiro/.kiro/` | `/kdlc-<operation>`, `.kiro/agents/<role>` |
| **Kiro IDE** | `kdlc setup kiro-ide <project>`; surface source in `distribution/kiro-ide/.kiro/` | `/kdlc-<operation>`, `.kiro/agents/<role>` |
| **Any MCP client** | `kdlc setup mcp <project>` writes a stdio config; HTTP packaging in `distribution/mcp/` | `kb_search`, `kb_fetch`, `proposal_create`, … |

Adapters differ only in packaging: stage requirements, security policy, state
transitions, and artifact contracts are identical everywhere (spec §25), and
every distribution tree is generated from the authored core — CI fails on
drift.

## Step 2 — talk to it

Inside the harness, work conversationally; the agents run the engine and
surface decisions:

```text
you>  /kdlc:init, then ingest everything under ./docs and our Confluence ENG space
kdlc> 12 sources normalized (494 evidence units). The curator proposes 9 for
      adoption and asks: is the vendor pricing page in scope?
you>  no — defer it. Draft concepts for the rest.
kdlc> 7 concept proposals ready for review — packet hash a41c… Approve?
you>  approved
kdlc> Published 7 concepts. Try: /kdlc:query ["what is our failover timeout?"]
```

Remote sources (Confluence, SharePoint, OneDrive, Google Drive) connect
through the guided `connector-setup` agent — read-only scopes, secrets stay
in environment variables ([guide](distribution/claude-code/guides/connecting-remote-sources.md)).

## The five verbs

Day to day you only need these — everything else is automation or inspection:

```bash
kdlc                    # start or resume: where you are + the next step
kdlc ingest <files>     # feed it (folders, PDFs, Office, email, HTML, …)
kdlc query "…"          # ask it — answers carry citations
kdlc publish            # your gate: list what awaits you; <id> --approve "reason" lands it
kdlc revisit            # ratify auto-published drafts into default answers
```

## Automation & CI — the engine directly

The same `kdlc` CLI the harnesses invoke is a stable surface for scripts and
pipelines — no agent in the loop:

```bash
kdlc ingest docs/spec.md        # queues a background job; evidence, not answers
kdlc lint                       # structural/policy findings for CI
kdlc refresh                    # re-check published knowledge against sources
kdlc publish                    # governed publication in a release pipeline
```

Heads up if you drive it by hand: `query` answers only from **published**
knowledge. Evidence produced by `ingest` becomes queryable after
`proposal` → `review` → `publish` — the full sequence is the walkthrough in
[docs/getting-started.md](docs/getting-started.md), executed end-to-end by a
test on every change. In a harness the agents run that middle stretch for you.

## Inspecting your project

Read-only commands you can run anytime, even mid-conversation:

```bash
kdlc status     # where everything stands
kdlc jobs       # background work and results
kdlc sources    # remote-source receipts and connector readiness
kdlc trace kb://<kb>/<concept>   # full provenance chain
kdlc doctor     # diagnosis and safe repair
```

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
