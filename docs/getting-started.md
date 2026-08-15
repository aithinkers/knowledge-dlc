# Getting started with K-DLC

This walkthrough takes a fresh directory to an initialized project with
ingested, queryable evidence using only the governed CLI. Every step below is
validated by `tests/governance/getting-started.test.mjs`.

## Prerequisites

- Node.js 24 (see `.nvmrc`).
- A clone of this repository with `npm ci` run once.

## 1. Install the CLI

From the repository root:

```bash
npm ci
npm link        # exposes the `kdlc` executable on PATH
```

`npm link` is optional: every command below also works as
`node <repo>/packages/cli/bin.mjs <operation>`.

Every command supports `--output text|json`. JSON output is a versioned
envelope with `ok`, `operation`, `correlation_id`, `result`, `warnings`, and
`error`; exit classes follow specification §25 (0 success, 2 input, 3 policy,
4 conflict, 5 dependency, 6 transient, 7 internal).

## 2. Initialize a project workspace

```bash
mkdir my-knowledge && cd my-knowledge
kdlc init
```

`init` scaffolds the §9.2 workspace: `knowledge-project.yaml`, `purpose.md`,
`knowledge.lock`, a colocated primary knowledge base under
`knowledge/primary/` (with `knowledge-base.yaml` and a reproducible
`index.md`), and a local principal policy under `.kdlc/`. The first local
principal is bootstrap-restricted to initialization; `init` grants the
workspace owner read/mutate/review/publish scopes for this project. Edit
`purpose.md` before ingesting: curation decisions are evaluated against it.

Check health at any time:

```bash
kdlc status
kdlc doctor
```

On a fresh workspace, `doctor` reports `healthy: true` with three expected
warnings — `dependencies.lock`, `cache.integrity`, and
`policies.compatibility` are `missing` until you mount a dependency knowledge
base and resolve policies. They need no action for a single-base project.

## 3. Ingest a source

```bash
printf '# Token policy\n\nProduction API tokens expire after 60 minutes.\n' > note.md
kdlc ingest note.md
kdlc jobs
```

Ingestion returns a job immediately (§16.5) and normalizes the source into
anchored, deterministic evidence units with a coverage manifest. Source
records, originals, and normalized artifacts land under `sources/`. Unchanged
sources are skipped by content hash on re-ingest; the same idempotency key
resumes rather than duplicates a job.

Validate and inspect:

```bash
kdlc lint
kdlc query "token lifetime"
```

`query` searches published concepts; freshly ingested evidence that has not
yet been synthesized and published returns `not_found` rather than leaking
drafts into trusted answers.

## 4. Propose, review, publish

Draft synthesis is governed: proposals are created from recorded model outputs
(schema `core/schemas/agents/recorded-model-output.schema.json`), reviewed
against an exact review packet hash, and published transactionally.

```bash
kdlc proposal '<json: {workflow_id, task, recording, normalized_evidence}>'
kdlc review <proposal-id> approved <receipt-id>
kdlc publish <proposal-id> <receipt-id>
```

A review decision binds the reviewer to the exact `review_hash`; any covered
change invalidates the receipt. Publication re-verifies every expected hash
before applying changes atomically (§17). Direct edits to published concepts
are detected by `kdlc lint` and reconciled with `kdlc reconcile-edits`.

## 5. Claude Code plugin

The generated plugin lives at `distribution/claude-code/`:

```bash
claude plugin install <repo>/distribution/claude-code
```

It exposes the `/kdlc:<operation>` commands listed in
`distribution/claude-code/COMMANDS.md` and the nine `kdlc:<role>` agents under
`distribution/claude-code/agents/` (conductor, curator, source-analyst,
integrator, librarian, trust-reviewer, retrieval-agent, maintainer,
governance-reviewer). Agent capabilities are enforced by the runtime role
descriptors, not by prompt text.

## 6. Pick your harness

| Harness | Setup | Invoke |
|---|---|---|
| Claude Code | `claude plugin install <repo>/distribution/claude-code` | `/kdlc:<operation>` commands, `kdlc:<role>` agents |
| Codex CLI (≥ 0.145) | point Codex at this checkout; skills/agents in `distribution/codex/` | `$kdlc` skill (`SKILL.md`), `.codex/agents/<role>` |
| Kiro CLI (≥ 2.6) | point Kiro at this checkout; skills/agents in `distribution/kiro/.kiro/` | `/kdlc-<operation>` skills, `.kiro/agents/<role>` |
| Kiro IDE | point Kiro at this checkout; skills/agents in `distribution/kiro-ide/.kiro/` | `/kdlc-<operation>` skills, `.kiro/agents/<role>` |
| Any MCP client | `distribution/mcp/desktop.json` (stdio) or `custom-app.json` (HTTP) | `kb_search`, `kb_fetch`, `proposal_create`, … |

Every harness invokes the same governed CLI engine and returns the same
versioned JSON envelope; adapters never change stage requirements, security
policy, state transitions, or artifact contracts (§25).

IMPORTANT: the Codex and Kiro skill files invoke
`node distribution/<harness>/run.mjs`, whose imports resolve relative to this
repository. Run those harnesses with this checkout as the working directory
(your knowledge project can live anywhere; pass its path in the operation
arguments), or use the Claude Code plugin / MCP server, which carry their own
location. Do not copy `.kiro/` alone into another project — the runner will
not resolve. A self-contained packaged runner is tracked as a follow-up.

## 7. MCP server

Local stdio configuration (Claude Desktop and other spawning clients) is
generated at `distribution/mcp/desktop.json`; it runs
`node packages/mcp/stdio.mjs` against the current project root. Remote
streamable-HTTP packaging is described by `distribution/mcp/custom-app.json`
and requires a configured authenticated endpoint — never expose an
unauthenticated project server.

## Command reference

Argument-free: `init`, `status`, `doctor`, `lint`, `jobs`, `conflicts`,
`gaps`, `refresh`, `reconcile-edits`. Require arguments: `adopt <source...>`,
`ingest <source...>`, `query <question>`, `trace <kb://...>`,
`review <proposal-id> <decision> <receipt-id>`,
`publish <proposal-id> <receipt-id>`, `proposal <json>`, `migrate <json>`.
See `distribution/claude-code/COMMANDS.md` for the harness bindings.
