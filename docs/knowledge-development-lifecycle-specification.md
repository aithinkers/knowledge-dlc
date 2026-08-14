# Knowledge Development Lifecycle Specification

Status: Draft for implementation  
Framework name: K-DLC  
Repository and machine namespace: `kdlc`  
Specification version: 0.2.0  
Canonical knowledge format: Open Knowledge Format (OKF) 0.2

## 1. Executive Summary

K-DLC is a harness-neutral lifecycle and governance framework for building,
querying, and maintaining agent-authored knowledge bases. It turns retained
source evidence into curated, linked, provenance-bearing Markdown concepts
through controlled workflow stages and explicit human approval gates.

The framework is intended to run natively in Claude Code, Codex, Cursor,
GitHub Copilot, and other capable agent harnesses from one authored core. Thin
harness adapters expose the same lifecycle using each host's native skills,
commands, agents, hooks, and tools.

K-DLC is not a vector database, desktop wiki, document-management system, or
general-purpose agent runtime. It defines and implements the controlled process
by which source evidence becomes durable knowledge. Search indexes, embeddings,
graphs, and user interfaces are replaceable projections over the canonical
files.

The core relationship is:

```text
Sources -> Evidence -> Claims -> Concepts -> Published knowledge
                 \       |          |
                  \------ provenance + review receipts
```

A project composes one or more independently owned knowledge bases. It normally
writes to one primary knowledge base, reads from mounted dependencies, and keeps
unapproved work in a project-local overlay.

## 2. Normative Language

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT,
RECOMMENDED, MAY, and OPTIONAL are to be interpreted as normative requirements.

Examples in this specification use YAML and Markdown for readability. A
conforming implementation MAY keep equivalent runtime state in JSON, SQLite, or
another local representation when the canonical portable artifact remains
available in the specified file format.

### 2.1 Normative references

K-DLC pins external normative dependencies so that validation cannot change
when an upstream branch moves.

| Reference | Pinned revision | SHA-256 of referenced bytes |
|---|---|---|
| [Open Knowledge Format 0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/3fcbb9f828c2f23d109c855ee403c3a4c81f3a96/okf/SPEC.md) | `3fcbb9f828c2f23d109c855ee403c3a4c81f3a96` | `5a3311d270bebb16d558010e75064f5b75323f284992641732b1c8097511f948` |
| [YAML 1.2.2](https://yaml.org/spec/1.2.2/) | `1.2.2` | Versioned standard; implementation fixtures are vendored. |
| [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html) | `RFC 8785` | Immutable RFC. |
| [BCP 47 language tags](https://www.rfc-editor.org/info/bcp47) | `BCP 47` | Versioned RFC set. |
| [Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28) | `2026-07-28` | Required by the `Served` module; protocol schema fixtures are vendored. |

The authored framework SHALL vendor validator schemas, fixtures, and any
compatibility notes derived from the pinned reference under
`core/schemas/okf-0.2/`. CI SHALL verify the vendored reference hash. Updating
the pin requires a K-DLC specification change, compatibility report, and
migration decision; following the upstream `main` branch implicitly is
non-conforming.

OKF-native fields used by K-DLC are `type`, `title`, `description`, `resource`,
`tags`, `sources`, `usage_window`, `generated`, `verified`, `status`, and
`stale_after`, together with OKF actor, link, index, and log conventions. K-DLC
adds project and source manifests, qualified `kb://` links, access metadata,
typed relationships, workflow claims, receipts, routing, and policy contracts.
Generic OKF consumers MUST be allowed to ignore K-DLC extensions; K-DLC
round-trippers MUST preserve unknown OKF and extension fields.

## 3. Goals

K-DLC SHALL:

1. Produce knowledge that is readable without proprietary tooling.
2. Preserve claim-to-source provenance.
3. Separate evidence retained immutably for its retention lifetime from
   agent-authored synthesis.
4. Make trust, freshness, ownership, and lifecycle visible.
5. Support one project using multiple knowledge bases safely.
6. Prevent ambiguous or unauthorized cross-base writes.
7. Run from one harness-neutral methodology across multiple agent tools.
8. Provide deterministic validation, workflow state, audit events, and recovery.
9. Allow users to customize purpose, schemas, policies, workflow scopes,
   retrieval, agents, sensors, outputs, and plugins.
10. Treat search, vector, and graph stores as rebuildable indexes rather than
    the source of truth.
11. Scale from a personal wiki to team-controlled knowledge without requiring a
    different canonical representation.
12. Support Git-based review, versioning, branching, and distribution.
13. Normalize common text, document, spreadsheet, presentation, diagram, and
    image formats into anchored, quality-labeled evidence.
14. Expose one governed project interface to coding agents, Claude Desktop,
    ChatGPT-compatible remote apps, and other MCP clients.
15. Adopt existing knowledge corpora without fabricating missing provenance.

## 4. Non-Goals

K-DLC does not initially:

1. Replace source systems such as GitHub, Confluence, SharePoint, databases, or
   document repositories.
2. Define a universal ontology or central registry of concept types.
3. Guarantee that an LLM-generated claim is true.
4. Make an embedding index or knowledge graph authoritative.
5. Provide a collaborative rich-text editor or full desktop application.
6. Automatically resolve material contradictions.
7. Bypass source access controls when creating normalized artifacts or answers.
8. Permit an agent to publish stable knowledge solely because its generation
   confidence is high.
9. Make projects depend on another project's transient workflow state.
10. Require a cloud service for basic operation.

## 5. Design Principles

### 5.1 Files are the durable contract

Canonical knowledge SHALL be Markdown with YAML frontmatter. Manifests and
workflow receipts SHALL be YAML, JSON, JSON Lines, or Markdown as defined here.
An operator must be able to inspect and recover a workspace using ordinary file
and Git tools.

### 5.2 Agents propose; deterministic controls govern

LLMs MAY interpret, extract, classify, reconcile, synthesize, and suggest links.
Deterministic code SHALL enforce permissions, state transitions, schema rules,
hashes, review requirements, write destinations, and publication transactions.

### 5.3 Evidence is not synthesis

Original sources, normalized evidence, extracted claims, and published concepts
are different artifact classes. The system MUST preserve those boundaries.

### 5.4 Trust is evidence, not a scalar

The system SHOULD expose source authority, provenance, verification actors,
freshness, contradictions, and applicability. It MUST NOT store a single opaque
"truth score" as a substitute for those facts.

### 5.5 Federation is explicit

Knowledge bases do not become one physical knowledge base merely because a project uses
them together. Every mount, version, permission, concept reference, retrieval
scope, and write route SHALL be explicit.

### 5.6 Derived state is disposable

Search indexes, embeddings, graph databases, caches, previews, and rendered
sites MUST be rebuildable from canonical sources, manifests, and wiki content.
Committed `index.md` files are reproducible projections retained for generic
OKF usability; they are never the authority over the concepts they enumerate.

### 5.7 Secure by construction

Source text is untrusted data. Instructions embedded in source material MUST
NOT alter the workflow, tool permissions, policies, or system instructions.
Access to an answer SHALL be no broader than access to the evidence used to
produce it.

### 5.8 Portable core, native shell

Methodology, schemas, stages, and deterministic tools SHALL be authored once.
Each harness adapter SHALL remain thin and SHALL NOT create a divergent version
of the lifecycle.

## 6. Terminology

| Term | Definition |
|---|---|
| Source | Original external or local material used as evidence. |
| Source record | Metadata describing the identity, origin, hash, access, and retrieval state of a source. |
| Evidence artifact | Immutable original content or a deterministic/declared normalization of it. |
| Claim | A source-grounded assertion extracted for evaluation before synthesis. |
| Concept | A single durable knowledge document in an OKF bundle. |
| Knowledge base | An independently owned, versioned, and distributable collection of concepts. |
| Project | A goal-oriented composition of knowledge bases, sources, policies, workflow state, and an optional overlay. |
| Workspace | The local directory and runtime context in which a project operates. |
| Mount | A project's configured reference to a knowledge base. |
| Primary knowledge base | The project's default durable write destination. |
| Overlay | Project-local draft, hypothesis, or unresolved knowledge that is not yet published to a knowledge base. |
| Profile | A domain-specific extension of the base OKF and workflow rules. |
| Scope | A declarative selection of lifecycle stages and default execution settings. |
| Stage | A resumable unit of lifecycle work with declared inputs, outputs, permissions, gates, and sensors. |
| Sensor | A deterministic validation applied to a stage or artifact. |
| Review receipt | Immutable evidence that a reviewer evaluated a particular review hash and packet under resolved policy versions. |
| Principal | An authenticated or locally trusted actor on whose behalf an operation runs. |
| Capability | A permitted operation constrained by identity, mount mode, policy, and resource. |
| Job | A resumable asynchronous execution of one or more stages. |
| Review packet | The complete diff, provenance, evidence, sensor, and impact material presented for an approval decision. |
| Projection | Rebuildable representation such as an index, graph, website, or embedding store. |
| Harness | An agent environment such as Claude Code or Codex. |
| Registry | Optional catalog used to discover knowledge bases and versions. |

## 7. Design Corrections Adopted by This Specification

The initial concept has been adjusted in the following ways:

1. **A project is not a knowledge base.** A project composes mounts and owns
   workflow state; a knowledge base remains independently usable and versioned.
2. **Concept paths are not globally unique.** Cross-base references use stable,
   qualified `kb://` identifiers.
3. **Lifecycle state is split.** Workflow states such as `candidate` and
   `review_pending` do not leak into OKF's published `status` field.
4. **Claims are an intermediate evidence model.** They MAY be retained for
   high-assurance profiles but do not require one file per claim.
5. **Publication is transactional.** Concepts, indexes, receipts, and audit
   entries cannot be left half-updated by a failed agent turn.
6. **Deletion is modeled as revocation and impact analysis.** Removing a source
   does not silently delete every derived concept.
7. **Access is intersection-based.** A query result is allowed only when the
   requester can access the concept and all evidence disclosed by the answer.
8. **Mounted versions are resolved and locked.** Floating Git branches may be
   configured for development, but reproducible workflows record resolved
   commits or immutable versions.
9. **Cross-base writes require routing and capability checks.** Retrieval rank
   never grants write authority.
10. **Source instructions are hostile by default.** Prompt-injection defense is
    part of ingestion and query behavior, not an optional plugin.
11. **Concurrent work is anticipated.** Content hashes, optimistic concurrency,
    Git branches, and merge review prevent silent lost updates.
12. **Profiles and plugins are versioned dependencies.** A workspace records
    the versions used to validate and publish its knowledge.
13. **File classification is not file encryption.** Possession of a plaintext
    bundle grants the ability to read it; restricted material requires separate
    distribution, encryption, or a mediated serving boundary.
14. **Model-backed work is safely repeatable, not assumed deterministic.** A
    retried model stage supersedes its prior attempt atomically and cannot
    duplicate durable artifacts.
15. **Direct edits re-enter governance.** Content changed outside K-DLC loses
    effective verification until reconciled and reviewed.

## 8. Conceptual Model

```text
Organization policies
        |
        v
+------------------- Project --------------------+
| purpose, mounts, routing, policy, workflow     |
|                                                 |
|  primary KB (rw)    dependency KBs (ro/propose)|
|        |                  |          |          |
|        +---------- retrieval federation -------+
|                         |                       |
|                     local overlay               |
+-------------------------------------------------+
                          |
                          v
              harness adapter / MCP / CLI
```

A knowledge base MAY be used by many projects. A project MAY mount many
knowledge bases. A project MUST NOT expose another project's overlay or workflow
state as a mounted dependency. Durable exchange occurs through a published
knowledge base.

## 9. System Architecture

### 9.1 Authored framework repository

```text
kdlc/
  core/
    skills/
    stages/
      define/
      acquire/
      understand/
      integrate/
      govern/
      maintain/
    agents/
    sensors/
    schemas/
      okf-0.2/
      manifests/
    profiles/
    scopes/
    policies/
    templates/
    hooks/
    tools/
    normalizers/
    server/
      mcp/
    knowledge/
  harness/
    claude/
    codex/
    cursor/
    copilot/
  packages/
    claude-desktop/
    chatgpt-app/
  plugins/
  scripts/
  dist/                 # generated; never hand-authored
  tests/
  docs/
```

The build system SHALL generate every `dist/<harness>/` tree from `core/` and
the corresponding adapter. CI SHALL fail when generated output differs from a
fresh build.

### 9.2 User project workspace

```text
project/
  knowledge-project.yaml
  knowledge.lock
  purpose.md
  AGENTS.md
  CLAUDE.md                 # when required by the harness
  sources/
    records/
    original/
    normalized/
    quarantine/
  knowledge/
    primary/                # optional colocated primary KB
  overlay/
    drafts/
    hypotheses/
    conflicts/
  workflow/
    runs/
      <workflow-id>/
        state.json
        plan/
        proposals/
        claims/
        reviews/
        receipts/
        transactions/
        audit.jsonl
    locks/
    jobs/
      <job-id>.json
  .kdlc/
    mounts/                    # ignored materialized dependency cache
  .generated/
    search/
    embeddings/
    graph/
    render/
    cache/
```

Secret values MUST NOT be stored in `knowledge-project.yaml` or committed
runtime state. Configurations SHALL refer to environment variables or host
credential providers.

### 9.3 Knowledge-base layout

```text
knowledge-base/
  knowledge-base.yaml
  index.md
  log.md
  concepts/
  entities/
  systems/
  policies/
  procedures/
  decisions/
  computations/
  references/
    sources/
    claims/                    # governed claim sidecars when required
    reviews/                   # portable review receipts when policy permits
```

`knowledge-base.yaml` and optional non-Markdown claim sidecars are K-DLC-specific.
Concepts, indexes, logs, and source-reference concepts SHOULD remain useful to a
generic OKF consumer that ignores unknown extensions and sidecars.

Every directory containing concepts or child concept directories SHALL have a
reproducible `index.md` in the MVP. It SHALL follow OKF 0.2 index syntax, use
relative links, copy the concept `title` and `description` when present, and
sort entries deterministically by normalized title and then path. Generated
indexes SHOULD begin with `<!-- generated by kdlc; do not edit -->`. They MAY be
committed for portable progressive disclosure, but a clean rebuild MUST produce
the same bytes and manual edits MUST be replaced or reconciled during lint.

### 9.4 Product and namespace contract

The human-facing framework name is **K-DLC**. The lowercase machine namespace
is `kdlc` everywhere a stable identifier is required:

| Surface | Normative name |
|---|---|
| Source repository | `kdlc` |
| CLI executable | `kdlc` |
| Claude plugin name and skill namespace | `kdlc` |
| MCP server label | `kdlc` |
| Local runtime/configuration directory | `.kdlc/` |
| Manifest API namespace | `kdlc.dev` |
| Suggested packages | `@<publisher>/kdlc-core`, `@<publisher>/kdlc-mcp`, `@<publisher>/kdlc-cli` |

Distributed Claude skills SHALL use plugin scoping and appear as
`/kdlc:<operation>`, such as `/kdlc:ingest`. Agent configuration names inside
the plugin use unprefixed lowercase-hyphen role names such as `conductor` and
`source-analyst`; Claude exposes them as `kdlc:conductor` and
`kdlc:source-analyst`. A standalone agent outside the plugin uses
`kdlc-<role>` to prevent collisions. An agent inside the plugin MUST NOT repeat
the prefix, which would produce a redundant scoped name.

Canonical audit and OKF producer actors use `kdlc-<role>/<version>`, for example
`kdlc-integrator/0.2.0`. User-interface labels MAY expand K-DLC to “Knowledge
Development Lifecycle,” but commands, package names, resource schemes, and
actor identifiers MUST NOT use the generic word `knowledge` as their namespace.

## 10. Manifest Contracts

### 10.1 Project manifest

`knowledge-project.yaml` is REQUIRED.

```yaml
api_version: kdlc.dev/v1alpha1
kind: Project

metadata:
  name: payments-modernization
  title: Payments Modernization

purpose: ./purpose.md
profile: software-project@1

knowledge_bases:
  - name: payments
    uri: ./knowledge/primary
    mode: maintain
    role: primary
    priority: 100

  - name: security
    uri: git+ssh://git@github.com/acme/security-knowledge.git
    ref: v2.4.0
    mode: read-only
    priority: 90

  - name: engineering
    uri: ../company-engineering
    mode: propose
    priority: 80

routing:
  default_write_target: payments
  by_type:
    Decision: payments
    Runbook: payments

workflow:
  scope: ingest
  knowledge_depth: standard
  trust_level: team
  autonomy: draft
  approval_policy: publish-only

policies:
  access: acme-access@4
  retention: acme-retention@2

budgets:
  max_model_cost_usd: 25
  max_model_tokens: 500000
  on_exceed: park

retrieval:
  mode: filesystem
  default_bases: [payments, security, engineering]
  minimum_trust: unverified
  stale_behavior: warn
  citation_format: qualified
```

Requirements:

- `metadata.name` MUST be a stable, lowercase, DNS-compatible identifier.
- Mount `name` values MUST be unique within the project.
- Exactly one mount MUST have `role: primary` in an MVP project that permits
  durable writes. A read-only/audit project MAY have none.
- No more than one mount MAY be the default write target.
- When both are present, `routing.default_write_target` MUST identify the
  primary mount. A conflicting manifest is invalid rather than precedence-based.
- Relative URIs resolve against the project manifest directory.
- A resolved mount MUST be recorded in `knowledge.lock` before a workflow writes
  any durable artifact based upon it.

### 10.2 Knowledge-base manifest

`knowledge-base.yaml` is REQUIRED for K-DLC-managed bases.

```yaml
api_version: kdlc.dev/v1alpha1
kind: KnowledgeBase

metadata:
  id: acme.security
  name: security
  title: Company Security Knowledge
  version: 2.4.0

format:
  type: okf
  version: "0.2"

profile: security-policy@2

ownership:
  owner: team:security
  maintainers:
    - team:security-architecture

access:
  classification: internal

publication:
  stable_requires:
    human_verifiers: 1
  default_stale_after: 180d
```

`metadata.id` is the globally stable knowledge-base identifier. A rename of
`metadata.name` MUST NOT change `metadata.id`.

### 10.3 Lock file

`knowledge.lock` SHALL record reproducible resolutions:

```yaml
api_version: kdlc.dev/v1alpha1
project: payments-modernization
resolved_at: 2026-08-14T15:00:00Z

knowledge_bases:
  security:
    id: acme.security
    version: 2.4.0
    uri: git+ssh://git@github.com/acme/security-knowledge.git
    requested_ref: v2.4.0
    resolved_ref: 52f39e8b2c...
    manifest_hash: sha256:...
    tree_hash: sha256:...

profiles:
  software-project:
    version: 1.2.0
    content_hash: sha256:...

policies:
  acme-access:
    version: 4
    content_hash: sha256:...
```

Lock updates MUST be atomic. Production and controlled workflows SHOULD reject
unlocked floating references.

### 10.4 Controlled vocabularies

Every manifest enum SHALL be validated. Profiles MAY add values only when they
define compatibility and behavioral semantics; unknown values MUST NOT silently
fall back to a less restrictive behavior.

| Field | Core values and behavior |
|---|---|
| `workflow.scope` | `adopt`, `ingest`, `refresh`, `curate`, or `audit`; defined below. |
| `knowledge_depth` | `summary` indexes headings and key facts; `standard` extracts anchored claims and concepts; `comprehensive` additionally retains detailed claim decisions and broader reconciliation evidence. |
| `trust_level` | `personal`, `team`, or `controlled`; selects the minimum governance policy, not a claim that content is true. |
| `autonomy` | `read-only`, `propose`, `draft`, or `execute-approved`; an agent never obtains stable-publication authority from this field alone. |
| `approval_policy` | `all-durable-writes`, `publish-only`, or `risk-based`; `risk-based` requires a versioned policy and is not a default MVP behavior. |
| `source_class` | `authoritative`, `official`, `primary`, `secondary`, `observational`, `user-authored`, or `unknown`; it is review evidence, not a truth score. |
| `SourceRecord.status` | `active`, `unavailable`, `superseded`, `revoked`, `deleted`, `access-restricted`, or `quarantined`; meanings follow §12.4–§12.6. |
| `retrieval.mode` | `filesystem`, `indexed`, or `hybrid`; `hybrid` requires declared lexical/vector fusion semantics. |
| `stale_behavior` | `warn`, `exclude`, or `fail`. |
| `citation_format` | `qualified`, `portable`, or `both`. |
| `budgets.on_exceed` | `park` or `fail`; publication and external writes MUST NOT be partially applied on budget exhaustion. |

Autonomy has these exact upper bounds: `read-only` creates no workflow or
content changes; `propose` may create workflow proposals but not destination
drafts; `draft` may write overlay or authorized draft content but not stable
content; `execute-approved` may execute a separately approved plan within its
capabilities but still cannot manufacture review or publication authority.

`all-durable-writes` applies a policy gate before any canonical knowledge-base
write. `publish-only` permits proposals and authorized drafts without a human
gate but requires the configured human receipt for stable publication.
`risk-based` evaluates a versioned change classifier and review policy; it has no
implicit fallback and MUST fail closed when classification is unavailable.

Source classes mean: `authoritative` is policy-designated as controlling for a
scope; `official` is issued by the responsible publisher but not necessarily
controlling; `primary` is first-hand evidence; `secondary` analyzes other
evidence; `observational` is measured or reported behavior; `user-authored` is
existing human material adopted without inferred authority; and `unknown` has
not been classified. The designation, scope, actor, and policy version SHALL be
review-visible.

The core scopes select these stages:

| Scope | Selected behavior |
|---|---|
| `adopt` | Import an existing corpus, propose concept mappings, lint, review, and publish. |
| `ingest` | Purpose/model checks, import, normalize, analyze, extract claims, plan, reconcile, synthesize, link, validate, review, and publish. |
| `refresh` | Re-resolve sources, compare versions, impact-analyze, re-enter affected stages, validate, review, and publish. |
| `curate` | Reconcile identity, structure, links, aliases, conflicts, lifecycle, and indexes for existing concepts. |
| `audit` | Read-only validation, provenance tracing, policy evaluation, and reporting. |

`trust_level: team` requires human review for stable publication. `controlled`
additionally requires authenticated principals, immutable policy resolution,
review receipts, a transaction journal, and governed audit retention. A profile
MAY make these levels stricter but MUST NOT weaken their minimum behavior.

Budget counters SHALL be recorded per workflow. A run override may lower a
budget without additional authority; raising it requires the policy-defined
budget authority.

## 11. Identifiers and Reference Resolution

### 11.1 Knowledge-base identifiers

Knowledge bases use stable reverse-domain or organization-qualified IDs such as
`acme.security`. Mount aliases such as `security` are project-local.

### 11.2 Concept identifiers

Within an OKF bundle, the concept ID is its path without `.md`.

```text
policies/authentication
systems/identity-service
```

The globally qualified reference form is:

```text
kb://<knowledge-base-id>/<concept-id>
```

Example:

```text
kb://acme.security/policies/authentication
```

Cross-base references MUST use the stable knowledge-base ID in canonical
content. A user-facing renderer MAY display or accept a mount alias but SHALL
resolve it before publication.

A version-qualified form MAY be used when a policy requires a frozen historical
reference:

```text
kb://<knowledge-base-id>@<version-or-revision>/<concept-id>
```

Ordinary relationships SHOULD remain unversioned living identifiers. During
review and publication, the trace and receipt SHALL record the exact resolved
base version, tree hash, and target artifact hash for every cross-base
reference. A resolver MUST reject two mounted bases that claim the same stable
knowledge-base ID, even when their mount aliases differ.

### 11.3 Link resolution

Resolution order is:

1. `kb://` qualified reference.
2. Bundle-root absolute Markdown path.
3. Document-relative Markdown path.

The resolver MUST reject traversal outside the mounted root. Broken links MAY
remain in OKF content, but publication policy MAY prevent them from becoming
stable.

### 11.4 Renames and aliases

Concept moves SHOULD leave an alias or redirect concept at the previous ID.
Aliases MUST NOT form cycles. A resolver MUST impose a finite hop limit and
report alias loops.

An alias is an OKF concept with `type: Alias`, `status: deprecated`, and exactly
one `relationships` entry of type `redirects_to`. It MUST NOT carry independent
substantive claims. An overlay conflict is a K-DLC proposal artifact containing
the competing concept or claim IDs, applicability, status, rationale, and the
workflow that detected it; it is not a published OKF concept unless explicitly
promoted to `type: Conflict`.

### 11.5 Canonicalization and hashing

K-DLC 0.2 defines canonicalization identifier `kdlc-c14n-1` and permits SHA-256
as the required MVP digest. Hash values use the form `sha256:<lowercase-hex>`.
An artifact may have three distinct digests:

- `byte_hash`: SHA-256 over the exact stored bytes. Concurrency checks and
  source-original integrity use this digest.
- `artifact_hash`: SHA-256 over the `kdlc-c14n-1` projection. Portable artifact
  integrity, lock files, and transaction verification use this digest.
- `review_hash`: SHA-256 over the versioned review projection actually shown to
  the reviewer. Review receipts use this digest.

For a Markdown concept, `kdlc-c14n-1` SHALL:

1. Decode strict UTF-8, reject duplicate YAML keys, and parse frontmatter using
   the YAML 1.2 core schema.
2. Normalize strings to Unicode NFC and line endings to LF.
3. Preserve list order and Markdown body whitespace other than line-ending
   normalization; ensure exactly one final LF in the body.
4. Encode `{ "frontmatter": <parsed-map>, "body": <normalized-string> }`
   using the JSON Canonicalization Scheme ordering and number rules.
5. Hash the resulting UTF-8 JSON bytes.

Other canonical artifacts SHALL define a schema-specific projection and include
its schema and canonicalization identifiers beside the digest. YAML key order,
line-ending convention, and serializer choice therefore cannot change an
`artifact_hash`; list order and body content can.

The base review projection includes the body and `type`, `title`, `description`,
`resource`, `sources`, `relationships`, `access`, `status`, and any
profile-declared substantive fields. A receipt MUST record the projection
version and covered field paths. `generated.at`, verification-event appends,
and formatting-only serialization changes are excluded by default. A policy
MAY exclude `stale_after` from content review only when a separate freshness
authorization covers that field; changing it is never an unaudited operation.

Changing a covered value invalidates the review receipt. Changing only an
uncovered value preserves the content review but still requires ordinary
permission, transaction, artifact-integrity, and policy validation. No
implementation may claim that `review_hash` proves natural-language semantic
equivalence.

## 12. Source and Evidence Model

### 12.1 Source identity

Each imported or referenced source has a source record under
`sources/records/<source-id>.yaml`.

```yaml
api_version: kdlc.dev/v1alpha1
kind: SourceRecord
id: src_01j5...
source_kind: document
title: Authentication Standard
resource: https://security.acme.example/authentication
source_class: authoritative
media_type: text/html
language: en
retrieved_at: 2026-08-14T14:00:00Z
content_hash: sha256:...
normalizer:
  id: html-to-markdown
  version: 1.1.0
rights:
  license: LicenseRef-Proprietary
  terms: https://security.acme.example/terms
  redistribution: metadata-only
  attribution_required: true
access:
  classification: internal
  policy_ref: acme-access@4
status: active
```

Source IDs MUST remain stable across refreshes of the same logical resource.
Each retrieved version MUST be distinguished by its content hash and retrieval
metadata. `source_kind` is `document`, `dataset`, `web`, `media`, or
`repository`; repository processing is reserved for the next release. The
source record SHALL preserve detected media type, extension when applicable,
source language, and rights metadata. Media type detection MUST inspect content
signatures and MUST NOT trust a filename extension alone.

For a copied source, `content_hash` is the SHA-256 `byte_hash` of the exact
original bytes. For an external non-copied source, the record SHALL state the
provider-specific digest/evidence method and MUST NOT label an unverifiable
identifier as a SHA-256 content hash.

### 12.2 Original evidence

When policy permits copying, original evidence SHALL be stored unchanged under
`sources/original/`. When copying is prohibited, the source record SHALL retain
the external resource identity and retrieval evidence without storing content.

### 12.3 Normalized evidence

Normalized content SHALL record:

- Source ID and content hash.
- Normalizer ID and version.
- Extraction timestamp.
- Page, section, cell, timestamp, or line anchors when available.
- Warnings about OCR, truncation, unsupported content, or encoding loss.
- Extraction coverage and whether each unit is deterministic, OCR-derived,
  model-derived, sampled, or omitted by policy.

Normalization MUST NOT silently replace or reinterpret source facts. LLM-based
captions, OCR correction, and transcription SHALL be marked as probabilistic.
Original formulas, cached values, speaker notes, diagram connector direction,
and similar distinctions MUST remain distinguishable when extracted.

### 12.4 Quarantine

Encrypted, corrupt, malware-positive, unsupported, policy-restricted, or
suspected malicious sources SHALL enter `sources/quarantine/` or remain external
with a quarantined status. Quarantined content MUST NOT participate in synthesis
or retrieval until explicitly released.

### 12.5 Source changes

On refresh, the system SHALL compare content hashes. An unchanged source SHOULD
skip semantic reprocessing. A changed source SHALL trigger impact analysis for
claims and concepts derived from prior versions.

### 12.6 Source removal and revocation

Source removal has distinct meanings:

- `unavailable`: retrieval failed; prior evidence may still be retained.
- `superseded`: a newer source replaces it.
- `revoked`: content must no longer be relied upon.
- `deleted`: local copy removed under retention policy.
- `access-restricted`: current requester can no longer use it.

Revocation MUST trigger impact analysis. Derived concepts SHALL be marked for
review or staleness; they MUST NOT be silently deleted because they may have
other supporting sources or historical value.

### 12.7 Durable provenance at publication

A published knowledge base must remain understandable without the project that
created it. Before publication, every `sources[].resource` SHALL resolve to one
of:

- An independently durable external URI.
- Another published concept identified by a relative, bundle-root, or `kb://`
  reference.
- A source-reference concept copied into the knowledge base under
  `references/sources/`.

A project-local `sources/records/...` path MUST NOT be written directly into a
published concept. When the original evidence cannot be redistributed, the
source-reference concept SHALL preserve permissible metadata, content hash,
access classification, and retrieval instructions without copying restricted
content. This requirement keeps provenance portable while respecting licensing
and access restrictions.

Within a concept, each body footnote label used for attribution MUST match one
`sources[].id` as required by OKF 0.2. A K-DLC-managed source entry SHOULD also
carry `source_record_id`, `source_hash`, and an optional format-specific
`locator`. `source_record_id` joins to the originating SourceRecord; `id` remains
the stable, human-readable footnote key. Publication MUST reject a cited
footnote with no matching source entry or a K-DLC source entry whose recorded
hash does not match the reviewed evidence version.

For `team` and `controlled` profiles, assertion-level claim provenance SHALL be
retained in the published bundle at
`references/claims/<concept-id>.jsonl`. The concept SHALL point to the sidecar
with a `claim_provenance` extension containing its bundle-relative resource and
artifact hash. Each retained claim records the source entry key, SourceRecord
ID when available, source hash, locator, extraction mode, disposition, and the
reviewed concept assertion it supports. Personal profiles MAY omit the sidecar
only when body citations and source entries still resolve.

### 12.8 Adoption of existing knowledge

The `adopt` scope imports an existing wiki, documentation tree, or OKF-like
corpus without pretending that retroactive evidence already exists. Each input
document becomes a `source_class: user-authored` SourceRecord. The document—not
merely its author—is the source. The workflow SHALL preserve the original,
propose one or more concept mappings, retain any known author as an actor or
credibility signal, and mark unavailable provenance explicitly.

Adopted concepts begin effectively `unverified` unless a policy-authorized
reviewer verifies the imported content. Existing links, titles, aliases, and
history SHOULD be preserved when safe. Later provenance enrichment SHALL use
ordinary proposals and review rather than rewriting history silently.

### 12.9 Normalizer contract

Every normalizer SHALL publish a versioned descriptor containing:

- Accepted media types and extensions.
- Parser/converter identity and version.
- Whether extraction is deterministic, probabilistic, or mixed.
- Output schema version and supported locator kinds.
- Whether it may use network access, execute macros or code, invoke a model, or
  call a native converter.
- Maximum source bytes, expanded bytes, pages, sheets, rows, slides, shapes,
  frames, processing time, and memory.
- Password/encryption behavior, failure modes, and fidelity limitations.

Normalized evidence SHALL be an ordered collection of units. A unit contains a
stable unit ID, kind, parent/order, extracted text or structured-data reference,
format-specific locator, source hash, extraction method, and quality warnings.
A source-level normalization manifest records coverage, omitted units, parser
versions, settings, and hashes of all outputs. Partial extraction is valid only
when omissions and limits are explicit; it MUST NOT be represented as complete.

Portable normalized artifacts SHOULD use
`sources/normalized/<source-id>/<algorithm>-<hex>/manifest.json`, `units.jsonl`,
and an optional `blobs/` directory. The filesystem segment uses `sha256-<hex>`
rather than the colon-bearing digest notation for cross-platform portability.
Runtime databases MAY mirror this data but MUST round-trip the manifest and
units without losing locator or provenance fields.

Large normalizations SHALL run as asynchronous jobs. Re-running the same
deterministic normalizer and settings against the same source hash MUST produce
the same normalized artifact hash. A probabilistic step SHALL be stored as a
separate derived unit with model provenance and MUST NOT overwrite deterministic
extraction.

### 12.10 Required document-format profiles

The first release SHALL support the following profiles. “Structural support”
means that headers and navigational structure can be indexed without loading
every cell, shape, or frame into retrieval context.

| Format | Required extraction and locator contract |
|---|---|
| Markdown (`.md`) | Frontmatter, headings, blocks, links, tables, code fences, and line/heading locators. |
| Text (`.txt`) | Encoding, lines, detected headings when reliable, and line-range locators. |
| CSV (`.csv`) | Encoding, delimiter, headers, row/column counts, bounded samples, type candidates, and row/column locators; full row indexing is policy-controlled. |
| PDF (`.pdf`) | Metadata, pages, text blocks, headings when detected, tables/images inventory, and page/bounding-box locators. Scanned pages require explicitly probabilistic OCR. |
| Word (`.docx`) | Properties, headings, paragraphs, lists, tables, footnotes/endnotes, comments policy, images inventory, and part/paragraph/table locators. |
| Excel (`.xlsx`) | Workbook properties, sheet names, used ranges, headers, tables, named ranges, formulas distinct from cached values, charts inventory, bounded samples, and sheet/cell/range locators. |
| PowerPoint (`.pptx`) | Properties, slide titles and text, notes subject to policy, tables, chart/image inventory, reading order, and slide/shape locators. |
| Draw.io (`.drawio`) | Pages, layers, nodes, connectors, direction, labels, groups, embedded-resource inventory, and page/cell locators. |
| GIF (`.gif`) | Dimensions, duration, frame count, bounded representative frames, text/OCR or captions marked probabilistic, and frame/time locators. |
| Visio (`.vsdx`) | Pages, masters, shapes, groups, connectors, direction, labels, metadata, and page/shape locators. |

Legacy binary Office and Visio formats (`.doc`, `.xls`, `.ppt`, `.vsd`) MAY be
supported through an explicitly trusted conversion plugin. The conversion tool
and version, intermediate hash, fidelity warnings, and lost features SHALL be
recorded. If no approved converter is available, the source enters quarantine
as unsupported rather than being silently treated as plain text.

## 13. Claim Model

Claims are workflow artifacts connecting source evidence to concept synthesis.
They MAY be stored as JSON Lines for efficient processing:

```json
{"id":"clm_01j5...","text":"Production API tokens expire after 60 minutes.","source_id":"src_01j5...","source_hash":"sha256:...","locator":{"heading":"Token lifetime"},"extraction":"explicit","applicability":{"environment":"production","effective_from":"2026-04-01"},"status":"candidate"}
```

A claim SHALL include:

- Stable workflow claim ID.
- Exact or faithful normalized assertion.
- Source ID and version hash.
- Source locator when available.
- Extraction mode: `explicit`, `inferred`, or `computed`.
- Applicability or temporal scope when material.
- Processing state.

High-assurance profiles SHOULD retain claims and claim review decisions.
Personal profiles MAY discard intermediate claims after provenance has been
correctly incorporated into concept frontmatter and citations.

An inferred claim MUST NOT be represented as an explicit source statement.

Claim IDs are stable within the originating workflow. Published claim sidecars
MUST also carry a stable assertion key derived from the destination concept ID
and an author-assigned assertion label; they MUST NOT depend on sentence
position alone. A synthesis decision SHALL record whether each candidate claim
was accepted, rejected, merged, superseded, or retained as a conflict and why.

## 14. Canonical Concept Profile

K-DLC concepts SHALL conform to OKF 0.2. The base K-DLC profile makes several
optional OKF fields mandatory for managed publication.

### 14.1 Draft concept

```markdown
---
type: Policy
title: Production API authentication
description: Authentication requirements for production API clients.
status: draft
generated:
  by: kdlc-synthesizer/1.0
  at: 2026-08-14T14:30:00Z
sources:
  - id: auth-standard
    resource: /references/sources/src_01j5.md
    source_record_id: src_01j5...
    source_hash: sha256:...
    title: Authentication Standard
    author: team:security
    last_modified: 2026-08-01
claim_provenance:
  resource: /references/claims/policies/authentication.jsonl
  artifact_hash: sha256:...
review_receipts:
  - resource: /references/reviews/rr_01j5.json
    artifact_hash: sha256:...
tags: [security, authentication, production]
---

# Policy

Production clients authenticate using short-lived service credentials.[^auth-standard]

[^auth-standard]: Authentication Standard
```

### 14.2 Stable publication requirements

Unless a stricter profile applies, a stable K-DLC concept MUST have:

- Non-empty `type`.
- Non-empty `title`.
- `description`.
- At least one `sources` entry, unless explicitly declared `source_exempt` by
  profile for a human-authored glossary seed or another named concept type.
- `generated.by` and `generated.at`.
- A valid `status`.
- A future `stale_after` or a profile-approved `freshness: timeless` extension.
- The required verification events for its trust policy.
- No blocking sensor findings.

`source_exempt` is a K-DLC extension with `reason`, `policy_ref`, `approved_by`,
and `approved_at`. It is allowed only for concept types explicitly named by the
resolved profile and MUST NOT be used merely because evidence is inconvenient
to collect. Generated indexes use the separate reproducible-projection rule and
do not need to masquerade as sourced concepts.

### 14.3 Relationships extension

K-DLC defines an optional structured relationship extension:

```yaml
relationships:
  - type: depends_on
    target: kb://acme.platform/systems/identity-service
  - type: owned_by
    target: kb://acme.organization/teams/platform
```

The body SHOULD also express relationships naturally so a generic OKF consumer
remains useful. Profiles define allowed relationship types and compatible
source/target concept types.

### 14.4 Access extension

Concepts derived from non-public material SHALL carry an access extension:

```yaml
access:
  classification: internal
  compartments: [payments-modernization]
  policy_ref: acme-access@4
```

The field records policy inputs; it is not itself an authentication system. The
runtime SHALL evaluate it using the active access policy and requester identity.
Generic OKF consumers that do not enforce the extension SHOULD be treated as
unsafe for restricted bundles.

The MVP classification order is:

```text
public < internal < confidential < restricted
```

Access is allowed only when the principal's clearance is at least the resource
classification and every resource compartment is present in the principal's
compartment set. Organizations MAY add levels or policy predicates only through
a versioned policy that defines comparison and migration semantics.

K-DLC recognizes three principal establishment modes:

- `local`: the operating-system user launching the engine; suitable only for a
  trusted workspace whose readable files that user is already allowed to see.
- `served`: an authenticated OAuth/OIDC subject with issuer, tenant, groups,
  clearance, compartments, and delegated scopes supplied by a trusted identity
  mapping.
- `automation`: a workload identity with explicitly granted service scopes.

The engine SHALL record the principal mode, stable subject, issuer when
applicable, and effective policy version. It MUST NOT trust principal or
clearance values supplied as ordinary model/tool arguments. The access decision
is the intersection of principal capabilities, mount mode, source/concept
classification, compartments, policy, and operation risk.

Possession of a plaintext local or Git bundle grants practical read access to
its files. A bundle containing material that must be hidden from some recipients
MUST be separately distributed, encrypted, or exposed only through a conforming
served boundary. Access frontmatter alone is not a confidentiality mechanism.

## 15. Lifecycle

K-DLC has six lifecycle phases. The first five contain fifteen core stages for
producing and publishing knowledge. Maintain is a recurring phase whose
operations re-enter the applicable core stages rather than duplicating them.

| Phase | Stage | Required output |
|---|---|---|
| Define | Purpose | Approved purpose artifact |
| Define | Knowledge Model | Resolved profile and policies |
| Define | Collection Plan | Source and ownership plan |
| Acquire | Discover | Candidate source inventory |
| Acquire | Import | Source records and originals/references |
| Acquire | Normalize | Anchored normalized evidence |
| Understand | Analyze | Structured source analysis |
| Understand | Extract Claims | Candidate claim set |
| Understand | Plan Concepts | Proposed create/update/ignore decisions |
| Integrate | Resolve Identity | Entity/concept identity decisions |
| Integrate | Reconcile | Support/conflict/supersession decisions |
| Integrate | Synthesize | Draft concept changes |
| Integrate | Link | Internal and cross-base relationships |
| Govern | Validate | Sensor report and impact report |
| Govern | Review and Publish | Review receipts and atomic publication |
| Maintain | Observe, Refresh, Curate, Deprecate, Archive | Maintenance plan and updated lifecycle state |

Maintenance is a recurring workflow using Observe, Refresh, Curate, Deprecate,
and Archive operations. These operations reuse the relevant core stages instead
of creating an unrelated pipeline.

### 15.1 Stage contract

Every stage definition SHALL declare:

```yaml
name: extract-claims
phase: understand
version: 1
lead_agent: source-analyst
consumes:
  - normalized-evidence
produces:
  - claim-set
permissions:
  read: [sources/normalized/**, workflow/**]
  write: [workflow/claims/**]
sensors:
  - source-anchor-valid
gates:
  before: none
  after: policy-dependent
retry:
  safe: true
```

Deterministic stages MUST be idempotent: identical declared inputs, tool
versions, and settings produce identical output artifact hashes. Model-backed
stages MUST instead be safely re-executable: a retry uses a new attempt ID,
atomically supersedes the prior attempt, produces schema-valid complete
artifacts, and never appends duplicates or partially overwrites outputs. Stage
completion SHALL record hashes of all inputs and outputs, attempt ID, model and
prompt/template identifiers, and whether deterministic idempotency is claimed.

## 16. Workflow State

### 16.1 Workflow states

```text
planned -> running -> awaiting_approval -> running -> completed
                    \-> rejected
running -> failed -> retrying
running -> cancelled
running -> parked -> running
```

Workflow state is not concept lifecycle state. A completed workflow may produce
only drafts; a rejected workflow does not make an existing stable concept
deprecated.

### 16.2 Artifact proposal states

```text
candidate -> planned -> drafted -> review_pending -> approved -> published
                                      |               |
                                      v               v
                                   rejected        superseded
```

On publication, `drafted` or `review_pending` proposals map to OKF
`status: draft`; `published` maps to `stable` only when policy gates pass;
deprecation maps to `status: deprecated`. K-DLC archive and tombstone
dispositions remain `status: deprecated` with a `lifecycle.disposition` of
`archived` or `tombstone` so OKF consumers do not mistake them for current
content. Workflow `completed` never implies concept `stable` by itself.

### 16.3 Checkpoints and resume

Every completed stage SHALL create a checkpoint containing:

- Workflow and stage ID.
- Resolved project and dependency versions.
- Input hashes.
- Output hashes.
- Policy and profile versions.
- Agent identity and model metadata when available.
- Sensor results.
- Approval receipt references.

Resume MUST validate that required inputs have not changed. When they have, the
engine SHALL invalidate the affected stage and all dependent stages rather than
blindly continuing.

### 16.4 Workflow concurrency

Each workflow owns `workflow/runs/<workflow-id>/`. Multiple read-only workflows
MAY run concurrently. Mutations to shared source records, overlay artifacts, and
knowledge-base targets SHALL use advisory locks under `workflow/locks/` plus
expected `byte_hash` or repository revision checks. Lock scope MUST be the
narrowest stable resource that preserves correctness; last-write-wins is
forbidden.

The MVP MAY serialize workflows that would write the same target knowledge base,
but MUST NOT use one mutable global `workflow/state.json`. Stale locks SHALL
carry owner, process, acquisition time, lease/heartbeat, and recovery metadata;
breaking a lock is an auditable administrative action.

### 16.5 Asynchronous jobs

Operations likely to exceed an interactive tool timeout—including document
normalization, large refreshes, index builds, and later repository
reverse-engineering—SHALL return a job ID instead of holding a client call open.
Job states are:

```text
queued -> running -> completed
                 \-> failed
                 \-> cancelled
                 \-> parked -> queued
running -> awaiting_input -> queued
```

A job record contains the principal, project and workflow IDs, operation,
idempotency key, input hashes, resolved dependencies, progress counters,
checkpoints, resource budget, timestamps, result references, structured error,
and cancellation state. Cancellation is cooperative and MUST leave either a
valid checkpoint or no newly visible canonical change. Retrying with the same
idempotency key and unchanged inputs SHALL return or resume the existing logical
job rather than duplicate it.

### 16.6 Out-of-band edits

Lint and publication SHALL compare current `byte_hash`, `artifact_hash`, and
review receipts. A direct edit that changes the review projection makes prior
verification ineffective immediately, without silently rewriting canonical
`status`. Retrieval MUST label the concept `modified-after-review` and treat it
as unverified for trust filtering until reconciled.

`kdlc reconcile-edits` SHALL convert detected drift into a proposal that
shows the direct diff and follows the normal validation and review path.
Serialization-only drift MAY be canonicalized without content review when the
`review_hash` is unchanged and policy permits it.

## 17. Publication Transactions

Publication SHALL be a deterministic transaction. Expensive validation SHOULD
run against a snapshot before the write lock is acquired; the publisher then
acquires a lock or optimistic token and re-verifies every expected hash before
application:

1. Resolve and snapshot the target revision and expected hashes.
2. Validate permissions, routing, concept schema, sources, links, lifecycle,
   rights, access, required reviews, and blocking sensors against a staged tree.
3. Acquire the target knowledge-base write lock or optimistic revision token.
4. Re-read every target and dependency token and verify expected hashes.
5. Stage final concept and index changes in the workflow transaction directory.
6. Apply all canonical file changes atomically where the filesystem permits.
7. Append publication log and audit events.
8. Commit to Git when configured, or leave an explicit ready-to-commit change.
9. Invalidate and rebuild affected projections.

If any step before application fails, no canonical content changes. If a crash
occurs during application, recovery SHALL use the transaction journal to roll
forward or restore the prior file hashes.

## 18. Project Federation

### 18.1 Mount modes

| Mode | Capability |
|---|---|
| `read-only` | Search, read, and cite permitted content. |
| `propose` | Create patch proposals but do not modify the base. |
| `draft` | Create or update draft concepts. |
| `maintain` | Update published concepts subject to policy and review. |
| `publish` | Approve and publish when actor policy permits. |

Mount mode is an upper bound. Repository permissions, user identity, concept
classification, and organizational policy may further restrict it.

### 18.2 Version resolution

Mounts MAY specify a branch, tag, commit, local path, package version, HTTP
bundle version, or MCP endpoint. Every run SHALL record the resolved version.
Controlled workflows MUST use immutable resolution during review and
publication.

`metadata.version` is a knowledge-base release version. SemVer compatibility
applies to machine contracts and stable identity: removing or changing concept
IDs without aliases, making a previously accepted profile/schema incompatible,
or removing an exported contract requires a major bump; additive compatible
concepts and types require at least a minor bump; editorial corrections that do
not change applicability, required action, or identity may use a patch bump. A
material conclusion or policy change requires at least a minor bump and an
explicit changelog entry even when identifiers remain compatible.

Release version does not uniquely identify changing knowledge. Every lock and
publication receipt SHALL also record an immutable repository commit, package
digest, or bundle tree hash. Consumers MUST use that immutable revision for
reproducibility and MUST NOT infer factual equivalence merely from SemVer.

### 18.3 Transitive dependencies

MVP projects resolve only directly declared mounts. A later registry MAY allow a
knowledge base to declare dependencies, but the project SHALL flatten and lock
the resolved graph. Cycles are invalid. Conflicting versions require an explicit
resolution rather than implicit "nearest wins" behavior.

### 18.4 Write routing

Routing precedence is:

1. Explicit user-authorized target for the operation.
2. Existing concept's owning knowledge base.
3. Type or namespace route in the project manifest.
4. Primary/default write target.

If the selected destination is not writable, the engine SHALL create a proposal
for that base. If more than one route remains equally valid, the engine MUST ask
for a target rather than guessing.

Retrieval priority MUST NOT influence write routing.

### 18.5 Overlay

The overlay stores hypotheses, working decisions, unresolved conflicts, and
drafts that do not yet belong in a mounted base. Overlay artifacts MUST be
clearly labeled non-authoritative and SHOULD be excluded from normal trusted
queries unless explicitly requested.

An end-of-project curation workflow SHALL classify overlay artifacts as publish,
merge, retain as project history, reject, or archive.

### 18.6 Mount materialization and cache integrity

Remote and Git mounts SHALL materialize into a content-addressed cache under
`.kdlc/mounts/` or an explicitly configured user cache outside the project. The
cache is ignored runtime state, never a publication source of truth. Its key
SHALL include the knowledge-base ID, immutable resolved revision, and verified
tree or package hash.

`knowledge.lock` SHALL record the manifest hash and full materialized tree or
package hash. On use, the resolver verifies both before exposing a mount. Cache
entries with a mismatched identity or digest are quarantined. Refresh creates a
new immutable entry and atomically advances the workspace reference; it does not
mutate an entry used by an active workflow. Eviction MUST NOT remove entries
referenced by active workflows and SHOULD preserve locked entries needed for
declared offline operation.

## 19. Retrieval Protocol

### 19.1 Query modes

Required modes:

- `wiki-only`: published concepts only.
- `sources-only`: original or normalized evidence only.
- `trusted-only`: concepts meeting the requested verification tier.
- `fresh-only`: excludes stale concepts.
- `exploratory`: may include drafts, overlay content, and conflicts with labels.
- `audit`: exposes claim, source, review, and applicability details.
- `refresh`: searches for evidence needed to reassess existing concepts.

### 19.2 Retrieval pipeline

```text
Interpret question
  -> authorize mounts and query mode
  -> select indexes
  -> lexical/vector retrieval
  -> graph expansion
  -> normalize scores per base
  -> apply access/trust/freshness filters
  -> detect aliases, duplicates, and conflicts
  -> assemble bounded context
  -> answer with qualified citations
  -> record non-sensitive telemetry and feedback
```

Lexical retrieval and hierarchical indexes are REQUIRED for the MVP. Vector and
graph retrieval are OPTIONAL projections.

### 19.3 Cross-base score handling

Raw scores from different indexes are not directly comparable. A federated
retriever SHALL normalize scores by retrieval method and base. Mount priority
MAY be a small ranking feature. Ranking MUST NOT exclude a concept or claim that
participates in a recorded conflict with an item selected for the answer.
Potential conflicts detected within the retrieved candidate set SHALL also be
surfaced. Finding unknown conflicts outside the candidate set is an evaluation
objective, not an impossible per-query guarantee.

### 19.4 Answer contract

An answer produced from K-DLC knowledge SHOULD return:

- Answer text.
- Qualified concept citations.
- Source citations when requested or required by policy.
- Trust and freshness warnings.
- Conflict or applicability notices.
- Retrieval timestamp and resolved base versions in audit mode.

Requester-visible behavior for "not found" and "found but unauthorized" MUST be
indistinguishable and MUST NOT reveal the existence, title, count, snippets, or
timing-sensitive details of unauthorized content. A protected audit event MAY
record the internal distinction with minimized metadata. Retrieval telemetry
and counts MUST apply the same non-disclosure rule.

## 20. Conflict and Applicability Model

Two different statements are not necessarily contradictions. Reconciliation
SHALL classify relationships as:

- supporting
- extending
- superseding
- contradicting
- scope-specific
- temporally different
- terminology-equivalent
- unresolved

Material conflicts SHALL be retained in `overlay/conflicts/` or a governed
Conflict concept. Normal query modes MUST surface unresolved material conflicts
when they affect the answer.

Priority, recency, or source count alone MUST NOT automatically resolve a
conflict. A policy MAY prefer a formally authoritative source, but the discarded
alternative and decision rationale SHALL remain auditable.

## 21. Trust, Verification, and Freshness

K-DLC uses OKF `generated`, `verified`, `status`, and `stale_after` fields.

Default trust tiers are:

- `unverified`: no verification event.
- `machine-confirmed`: verified only by agents or processes.
- `human-reviewed`: at least one `human:` verifier.

Profiles MAY require multiple or role-qualified human reviewers. A review
receipt SHALL bind the reviewer to the exact `review_hash`, review-projection
version and covered fields, source hashes, resolved dependency revisions,
policy/profile versions, review-packet hash, decision, principal, and time. Any
change to a covered value invalidates prior approval. Changes outside that
projection remain subject to their own authorization and audit rules.

Freshness is evaluated per concept. Type-specific defaults MAY apply, but the
publication transaction SHOULD materialize an absolute `stale_after` date in
canonical content. Timeless content requires an explicit profile-approved
declaration.

### 21.1 Review packet and receipt contract

`kdlc review` and every harness-equivalent operation SHALL assemble the
same minimum review packet for each proposal:

- Proposal identity, target base/revision, concept before and after, and a
  rendered structural and textual diff.
- The exact `review_hash`, projection definition, and covered fields.
- Accepted, rejected, merged, and conflicting claims with source locators.
- Bounded source excerpts or safe retrieval links, source authority, access,
  rights, extraction quality, and corroboration warnings.
- Sensor report, impact analysis, affected links/dependents, freshness change,
  and unresolved conflicts.
- Resolved profile, policies, dependencies, model/tool provenance, and budget
  summary.
- The actions available to that reviewer and the consequences of approval.

The canonical packet is JSON at
`workflow/runs/<workflow-id>/reviews/<proposal-id>/packet.json`; the canonical
receipt is JSON at
`workflow/runs/<workflow-id>/receipts/<receipt-id>.json`. Both use versioned
schemas and RFC 8785 canonical JSON for their artifact hashes. The receipt
contains the packet hash and decision but not the packet's potentially
restricted excerpts.

At publication, the concept's `review_receipts` extension SHALL resolve to a
durable external receipt URI or a minimized receipt copied to
`references/reviews/<receipt-id>.json`. A project-local workflow path MUST NOT be
published. Receipt copies inherit the concept's access classification and MUST
not expose reviewer attributes beyond policy.

Minimum receipt shape:

```json
{
  "api_version": "kdlc.dev/review-receipt/v1alpha1",
  "id": "rr_01j5...",
  "proposal_id": "pr_01j5...",
  "subject": "kb://acme.payments/policies/authentication",
  "decision": "approved",
  "reviewer": {
    "actor": "human:reviewer-123",
    "principal_mode": "served",
    "issuer": "https://id.acme.example"
  },
  "review": {
    "algorithm": "sha256",
    "canonicalization": "kdlc-c14n-1",
    "projection": "kdlc-review-1",
    "hash": "sha256:...",
    "fields": [
      "body", "type", "title", "description", "sources", "access", "status"
    ]
  },
  "packet_hash": "sha256:...",
  "source_hashes": ["sha256:..."],
  "resolved_dependencies": {
    "acme.security": {"version": "2.4.0", "tree_hash": "sha256:..."}
  },
  "profile": {
    "id": "software-project", "version": "1.2.0", "hash": "sha256:..."
  },
  "policies": [
    {"id": "team-policy", "version": "7", "hash": "sha256:..."}
  ],
  "reviewed_at": "2026-08-14T15:20:00Z"
}
```

The packet SHALL be immutable once a decision is recorded. If any packet input
changes, the old packet and receipt remain historical but cannot authorize the
new proposal. Reviewers may approve, reject, or request changes; comments do not
constitute approval.

Batch review is allowed only when a versioned policy defines the batch risk
class and the packet still exposes every affected artifact. The default team
profile forbids automatic approval of substantive stable-content changes.
Deterministically classified serialization, index, or other non-content changes
MAY use a separate policy gate without pretending they received content review.

Review queues SHOULD report depth, oldest age, median turnaround, rejection and
change-request rates, and high-risk proposal age without exposing restricted
content.

## 22. Agents and Permissions

Core roles:

| Agent | Primary responsibility | Canonical write access |
|---|---|---|
| Conductor | Plan and coordinate stages | Workflow state only |
| Curator | Apply purpose, taxonomy, and scope | Proposals only |
| Source Analyst | Analyze evidence and extract claims | Claims and analyses |
| Integrator | Resolve identities and reconcile claims | Proposals and drafts |
| Librarian | Organize indexes, aliases, and relationships | Draft/index staging |
| Trust Reviewer | Review provenance, support, and freshness | Review receipts only |
| Retrieval Agent | Search and answer | None by default |
| Maintainer | Detect drift, staleness, and gaps | Proposals and drafts |
| Governance Reviewer | Review policy, privacy, and publication | Review receipts only |

Review-only agents MUST NOT modify the artifacts under review. The runtime SHALL
enforce read and write paths rather than relying on prompt instructions alone.

Agent identity SHALL use an actor convention compatible with OKF. When model and
provider details are available, audit metadata SHOULD record them without
placing secrets in the bundle.

The distributed plugin agent names are `conductor`, `curator`,
`source-analyst`, `integrator`, `librarian`, `trust-reviewer`,
`retrieval-agent`, `maintainer`, and `governance-reviewer`. Their host-scoped
names are `kdlc:<role>`; their canonical producer actors are
`kdlc-<role>/<framework-version>`.

## 23. Customization Model

Configuration precedence is:

```text
framework defaults
  -> template
  -> installed profile
  -> organization policy
  -> team policy
  -> project policy
  -> authorized run override
```

Merge rules SHALL be deterministic:

- Scalars replace at the more specific layer.
- Maps deep-merge.
- Lists declare `append`, `replace`, or `remove` semantics.
- Security restrictions may become stricter downstream but not weaker without a
  separately authorized waiver.
- Mandatory approval gates may be added downstream but not removed by an
  ordinary project override.

Customization surfaces include:

1. Workspace templates.
2. `purpose.md`.
3. Knowledge profiles and concept types.
4. Workflow scopes.
5. Knowledge depth, trust level, and autonomy.
6. Approval policies.
7. Source and retention policies.
8. Freshness policies.
9. Retrieval configuration.
10. Model routing and cost limits.
11. Agents and permissions.
12. Sensors.
13. Renderers and exports.
14. Plugins.

Policies SHALL be addressable by stable ID and version, stored in an installed
policy package or organization-controlled registry, and resolved into
`knowledge.lock` with an artifact hash. An audit value such as
`team-policy@7` is valid only when that exact version and hash can be resolved.

## 24. Plugin Contract

A plugin is an independently versioned, declarative package:

```text
plugins/<name>/
  .kdlc-plugin/plugin.yaml
  profiles/
  stages/
  agents/
  sensors/
  tools/
  templates/
  relationships/
  renderers/
  knowledge/
  tests/
```

Plugins MAY add stages, scopes, profiles, concept types, relationship types,
agents, sensors, normalizers, connectors, and renderers. Plugins SHOULD use
additive contributions rather than modifying core files.

A plugin MUST declare:

- Stable name and semantic version.
- Framework compatibility range.
- Dependencies.
- Capabilities contributed.
- Executable tools included.
- Required filesystem, network, and credential permissions.
- License and publisher identity.

Executable plugins are supply-chain code. Installation MUST require explicit
trust, and controlled environments SHOULD require signature or allowlist
verification. Disabling a plugin required by an active workflow or locked
profile SHALL be rejected until the workflow is completed, migrated, or parked.

Permission declarations are not enforcement by themselves. Executable plugins
SHOULD run out of process with filesystem roots, network destinations,
credentials, subprocess execution, and resource budgets restricted by the
runtime. When the MVP host cannot enforce a declared permission technically,
installation SHALL display that limitation and require explicit trust;
`controlled` conformance MUST reject unsandboxed executable plugins unless an
organization policy records a scoped waiver. Normalizer plugins processing
untrusted binary documents receive no network or macro/code execution by
default.

## 25. Harness Adapters

Each adapter SHALL expose equivalent semantics using the host's native surface.

Minimum commands:

```text
kdlc init
kdlc adopt <source...>
kdlc ingest <source...>
kdlc query <question>
kdlc review
kdlc publish
kdlc status
kdlc lint
kdlc refresh
kdlc trace <concept>
kdlc conflicts
kdlc gaps
kdlc migrate
kdlc doctor
kdlc reconcile-edits
kdlc jobs
```

Examples:

- Claude Code plugin: `/kdlc:init`, `/kdlc:ingest`, `/kdlc:review`, and other
  `/kdlc:<operation>` skills.
- Codex: the `kdlc` CLI or a host-native `kdlc`-namespaced skill.
- Cursor/Copilot: host-native command or skill invocation.
- MCP: structured tools and resources with the same engine underneath.

Adapters MAY differ in packaging and invocation but MUST NOT change stage
requirements, security policy, state transitions, or artifact contracts.

Every command SHALL support `--output text|json`. JSON output uses a versioned
envelope containing `ok`, `operation`, `correlation_id`, `result`, `warnings`,
and `error`. Stable CLI exit classes are: `0` success, `2` input/schema error,
`3` policy denial, `4` state/concurrency conflict, `5` dependency or unsupported
capability, `6` transient external failure, and `7` internal failure. Additional
detail belongs in the structured error code, not in adapter-specific exit codes.

### 25.1 MCP project server

K-DLC SHALL expose one federated MCP server per project. Knowledge bases remain
independently identified resources behind that project server; a client does not
select a write target by connecting to an arbitrary base server. The engine and
policy layer, not the client prompt, perform routing and authorization.

The advertised MCP server label SHALL be `kdlc`. Hosts may render tool names
with their own server-scoping syntax; tool definitions MUST NOT redundantly add a
second `kdlc_` prefix.

Required resource forms include:

```text
kdlc://server/info
kdlc://projects/<project-id>
kdlc://projects/<project-id>/mounts
kb://<knowledge-base-id>/<concept-id>
kdlc://jobs/<job-id>
kdlc://reviews/<proposal-id>/packet
```

The server-info resource SHALL declare the K-DLC specification version,
canonicalization version, supported MCP protocol revision and transports,
project ID, conformance modules, format profiles, tool schemas, and enabled
capabilities.

Minimum read tools are `project_get`, `project_list_mounts`, `kb_search`,
`kb_fetch`, `kb_trace`, `kb_conflicts`, `kb_gaps`, `source_excerpt`, and
`job_status`. Controlled mutation tools are `ingest_start`, `proposal_create`,
`review_submit`, `publish_request`, and `job_cancel`. Repository-analysis tools
are not advertised until the next-release repository capability is installed.

Tools SHALL declare read-only, mutating, idempotency, open-world, and destructive
risk metadata where supported by the MCP revision. Read operations are enabled
by default. Mutation tools require explicit capabilities. `publish_request`
MUST validate a K-DLC review receipt and publication policy; a chat client's
generic tool-confirmation click is not itself a publication approval.

### 25.2 MCP transports and client packaging

The same server implementation SHALL support:

- Local `stdio` for coding agents and desktop clients that spawn local MCP
  processes.
- Streamable HTTP over TLS for remote clients and shared/team deployments.

A local desktop package MAY use an MCPB-compatible extension or client-native
configuration and SHALL request explicit allowed roots. A remote package MAY be
published as a Claude connector, ChatGPT custom app/plugin, or another
MCP-compatible integration. Client UI availability and plan restrictions are
deployment facts, not changes to the K-DLC artifact or tool contract.

Remote served deployments SHALL authenticate per user using OAuth/OIDC or an
equivalent organization-approved mechanism, map identity claims to a K-DLC
principal, and enforce scopes server-side. Private deployments MAY use a secure
tunnel or allowlisted gateway; they MUST NOT expose an unauthenticated project
server to the public internet.

Local clients MAY submit paths only beneath configured allowed roots. Remote
clients MUST use an upload/object handle, registered source URI, or connector
resource; an arbitrary client filesystem path is invalid. Uploads enter the
ordinary quarantine, rights, access, normalization, and audit pipeline.

### 25.3 MCP interaction and conformance

Long-running tools return a job resource immediately. Clients poll or subscribe
to progress when supported and may reconnect without losing job state. Tool
results SHALL return qualified citations, resolved base revisions, warnings,
and correlation IDs in structured fields rather than prose alone.

When the client and server negotiate the MCP Tasks extension, a K-DLC job SHALL
map its durable ID, state, progress, cancellation, input requests, and result to
the corresponding task. Without that extension, the `kdlc://jobs/<job-id>`
resource and job tools provide the same K-DLC lifecycle semantics.

An optional MCP application UI MAY render project selectors, citation cards,
source previews, review packets, diffs, and job status. The UI is a projection;
all decisions and mutations still use the same versioned tools and receipts.
Protocol conformance tests SHALL run identical fixture calls through `stdio` and
Streamable HTTP and compare schemas, authorization decisions, state transitions,
citations, and sensors rather than model wording.

## 26. Deterministic Sensors

Core sensors SHALL cover:

- Manifest schema validity.
- OKF conformance.
- Profile-required frontmatter.
- Source and citation resolvability.
- Source hash and normalized artifact consistency.
- Normalizer coverage, locator, resource-limit, and probabilistic-output labels.
- Internal and cross-base links.
- Duplicate mounted knowledge-base IDs and tree-hash mismatches.
- Alias cycles.
- Duplicate concept candidates.
- Relationship compatibility.
- Index completeness.
- Orphaned concepts.
- Stale and missing verification.
- Unsupported or ungrounded claim markers.
- Missing or inconsistent published claim sidecars.
- Single non-authoritative-source support where policy requires corroboration.
- Access-classification compatibility.
- Rights/license compatibility with the publication target.
- Secret and sensitive-data patterns.
- Invalid lifecycle transitions.
- Review packet/receipt/review-hash binding and direct-edit drift.
- Lock-file drift.
- Stale workflow locks and job-record integrity.
- Non-reproducible committed indexes.
- Generated-distribution drift in the framework repository.

Sensor severities are `info`, `warning`, and `error`. Publication policy SHALL
define which findings block draft writes and stable publication. An error may be
waived only through an auditable policy-defined waiver.

## 27. Security and Governance

### 27.1 Prompt injection

All imported text is untrusted content. Normalizers and prompts SHALL delimit
source content from instructions. Agents MUST ignore embedded requests to run
commands, reveal secrets, alter policies, contact external systems, or change
workflow state. Tool authorization is determined only by the stage and runtime.

### 27.2 Data poisoning and parser isolation

Source content may be false, compromised, manipulated, or selectively
incomplete without containing an explicit prompt injection. Review and
synthesis SHALL surface `source_class`, identity, version, extraction quality,
corroboration, conflicts, and single-source dependence. Profiles MAY require
specific source classes or independent corroboration for consequential concept
types. Source count alone MUST NOT be treated as truth, and an authoritative
label MUST remain attributable to a versioned policy or reviewer.

The evaluation corpus SHALL contain plausible but false sources, compromised
updates, citation laundering, duplicated-source masquerading as corroboration,
and authority-metadata spoofing.

Binary and archive-like sources SHALL be parsed in a restricted worker. Network
access, macros, embedded scripts, external relationships, and child processes
are disabled unless the normalizer descriptor and policy explicitly permit
them. The worker SHALL enforce limits on compressed and expanded bytes,
decompression ratio, recursion, pages/parts/frames, CPU time, memory, and output
size. A limit breach quarantines the source with a structured reason; it MUST
NOT yield silently partial trusted evidence.

### 27.3 Access-control intersection

Before retrieval or synthesis, the engine SHALL determine the requester's
eligible mounts and concept classifications. An answer may disclose evidence
only when the requester is allowed to access it. A less-restricted generated
concept MUST NOT launder facts from a restricted source.

By default, a derived concept's classification SHALL be at least as restrictive
as the most restrictive material source. An authorized reviewer MAY downgrade
classification only through a recorded declassification workflow.

Access denials SHALL follow the requester-visible non-disclosure contract in
§19.4. Protected audit records MAY distinguish denied from absent results but
SHALL minimize resource-identifying metadata.

### 27.4 Secrets and credentials

Credentials MUST remain in environment variables, OS keychains, or host secret
stores. Audit logs MUST redact credentials and sensitive request headers.
Source ingestion SHALL scan for likely secrets before publication or external
model transmission.

### 27.5 External models

Policy SHALL determine which source classifications may be sent to which model
providers. The engine MUST block incompatible routes before invoking a model.

### 27.6 Retention, erasure, and legal hold

Source, claim, audit, and concept retention MAY differ. Deletion workflows MUST
support legal hold, privacy deletion, license restrictions, and evidence
retention. “Immutable evidence” means immutable while retained; it does not
override an authorized erasure obligation.

Before accepting erasable or regulated content, policy SHALL determine whether
it may enter Git, a plaintext bundle, backups, model prompts, or external
projections. Material requiring selective erasure SHOULD remain in an encrypted
evidence store outside ordinary Git, addressed by stable source ID and hash.

An erasure workflow SHALL:

1. Authenticate the authority and check legal holds.
2. Inventory original, normalized, claim, concept, quote, cache, index,
   embedding, graph, export, log, and backup surfaces through provenance.
3. Purge or crypto-shred authorized copies and request deletion from configured
   external processors where applicable.
4. Replace retained references with a minimized tombstone containing only
   legally permissible identity/hash/event facts.
5. Invalidate affected claims and review receipts, re-synthesize or redact
   concepts, rebuild projections, and verify propagation.
6. Record an audit event that proves the workflow occurred without retaining
   the deleted sensitive content.

Crypto-shredding is sufficient only for encrypted copies whose keys and backups
are covered; it does not satisfy deletion of quoted or derived content. If
content already entered immutable Git history, the governed procedure SHALL
either rewrite and redistribute history with downstream invalidation or record
why erasure cannot be guaranteed. The system MUST NOT claim successful erasure
while known copies remain untreated.

### 27.7 Rights and licensing

Rights are obligations and permissions, not a single ordered classification.
SourceRecord rights MAY include an SPDX identifier or `LicenseRef`, terms URI,
attribution, redistribution, derivative-use, commercial-use, confidentiality,
territory, and expiration. Unknown rights default to no redistribution of source
content beyond the authorized workspace.

Publication SHALL evaluate the intended target and transformation against every
material source. It MUST preserve required attribution, prevent prohibited
copying, and produce `legal-review-required` when rights are unknown,
incomparable, incompatible, or depend on a legal judgment. It MUST NOT implement
license propagation as “the most restrictive license wins.” A source-reference
concept may preserve permissible metadata without copying protected text.

When obligations attach to the derived concept or its distribution, the concept
SHALL carry a `rights` extension containing the evaluated disposition
(`allowed`, `restricted`, or `legal-review-required`), applicable obligations,
policy and decision references, and target scope. This summary supplements, and
does not erase, the individual source rights records.

## 28. Concurrency and Git

K-DLC SHALL use optimistic concurrency based on `byte_hash` values or immutable
repository revisions. Before applying a proposal, the publisher MUST verify that
every target still matches the reviewed artifact and expected byte/repository
revision.

Recommended team workflow:

1. Create a branch for the knowledge workflow.
2. Generate draft changes and receipts.
3. Run sensors.
4. Open a pull request.
5. Perform human review.
6. Revalidate against the final merge candidate.
7. Merge and rebuild projections.

The engine MUST detect and report semantic conflicts separately from ordinary
Git text conflicts. It MUST NOT resolve concurrent edits by last-write-wins.

## 29. Audit and Observability

`workflow/runs/<workflow-id>/audit.jsonl` SHALL use append-only structured
events. Separating logs by workflow avoids a global append hotspot and reduces
Git merge conflicts. Each event includes:

```json
{"event_id":"evt_...","timestamp":"2026-08-14T15:30:00Z","project":"payments-modernization","workflow_id":"wf_...","stage":"validate","actor":"process:kdlc-engine","action":"sensor.completed","subject":"kb://acme.payments/decisions/authentication","input_hash":"sha256:...","result":"passed","policy_version":"team-policy@7"}
```

Audit events SHALL cover:

- Workflow creation, resume, park, cancel, and completion.
- Dependency resolution.
- Source import, refresh, quarantine, revocation, and deletion.
- Stage start and completion.
- Tool invocation summaries.
- Proposal creation and modification.
- Sensor results and waivers.
- Approval, rejection, and publication.
- Permission denials.
- Projection rebuilds.

Operational metrics SHOULD include ingestion latency, normalization failures,
claim-to-source coverage, stale concept count, retrieval citation coverage,
contradiction count, review queue depth and age, review turnaround, job queue
depth, cancellation rate, projection age, token use, and model cost. Metrics
MUST NOT expose restricted content.

Local timestamps are evidence from the local clock, not proof of universal
time. Events SHALL also carry monotonic sequence numbers within a workflow.
Governed served deployments SHOULD use authenticated infrastructure time with
monitored synchronization; high-assurance profiles MAY require signed or
externally timestamped receipts. Clock rollback or excessive skew is a sensor
finding and MUST NOT reorder append-only events silently.

## 30. Failure Handling

The system SHALL classify errors as:

- User-correctable input error.
- Policy denial.
- Source unavailable.
- Unsupported format.
- Normalization failure.
- Model or provider failure.
- Sensor failure.
- Concurrency conflict.
- Publication transaction failure.
- Projection failure.
- Internal engine error.

Retry behavior MUST be stage-specific. Deterministic normalization and retrieval
operations MAY retry automatically. Publication, source deletion, external
writes, and costly model operations MUST be idempotent or require confirmation
before a non-idempotent retry.

A projection failure after canonical publication SHALL not roll back valid
knowledge. It SHALL mark the projection stale and schedule or request a rebuild.

Every adapter SHALL return a structured error with `code`, `category`,
`message`, `retryable`, `correlation_id`, and optional redacted `details`. Error
codes are stable, machine-readable names such as `KDLC_POLICY_DENIED`,
`KDLC_HASH_CONFLICT`, `KDLC_FORMAT_UNSUPPORTED`, and
`KDLC_NORMALIZATION_LIMIT`. Human messages may vary; security-sensitive details
MUST NOT be exposed to an unauthorized principal.

## 31. Versioning and Migration

The framework, manifests, profiles, stage contracts, plugins, and knowledge-base
format have separate versions.

- Manifest `api_version` controls parsing and migration.
- OKF version controls concept compatibility.
- Profile version controls local validation rules.
- Plugin version controls contributed behavior.
- Stage version controls resume compatibility.
- Canonicalization version controls portable artifact and receipt hashes.
- MCP tool-schema version controls client compatibility.

Migrations SHALL be explicit, previewable, and reversible when feasible. A
migration MUST produce a report of changed files and semantic effects. The
engine MUST NOT silently rewrite an entire knowledge base during ordinary query
or ingestion.

## 32. Non-Functional Requirements

### 32.1 Portability

Basic read, query, lint, and Git review MUST function without a hosted service.

### 32.2 Reproducibility

A controlled workflow SHALL be reproducible with its project manifest, lock
file, source hashes, profile/plugin versions, and stage checkpoints, subject to
the inherent nondeterminism of model generation. Model output itself need not be
byte-identical, but its inputs and provenance SHALL be recoverable.

### 32.3 Performance

The MVP SHOULD support at least:

- 10,000 Markdown concepts per directly mounted local knowledge base.
- 100,000 indexed concepts across a project using a derived index.
- Incremental refresh without rescanning unchanged source bodies.
- Query startup that reads indexes rather than loading entire bundles.

These are design targets, not release claims, until benchmarked.

Format profiles SHALL benchmark bounded structural extraction separately from
full extraction. A normalizer MUST enforce configured maximum source and
expanded sizes and SHOULD produce useful header/structure indexes without
loading all spreadsheet rows, diagram shapes, or media frames into model
context. Performance claims SHALL publish the corpus, limits, hardware, parser
versions, and cache state used.

### 32.4 Offline behavior

Local mounted bases, cached locked Git bases, filesystem retrieval, validation,
and browsing SHOULD work offline. Remote refresh, remote models, and uncached
mounts MAY report a clear offline limitation.

### 32.5 Accessibility and internationalization

Canonical content SHALL be UTF-8. Tools SHALL preserve source language and
record translation as a derived transformation. Any shipped graphical interface
SHOULD meet applicable accessibility standards.

Source records and normalized units SHALL carry BCP 47 language tags when known.
A translation is a derived unit with source and target language, translator or
model identity, settings, and its own artifact hash; it MUST NOT replace the
source-language evidence.

### 32.6 Conformance modules

Conformance is modular. Every implementation declares the specification version
and modules it implements:

| Module | Required capability |
|---|---|
| `Core` | OKF/K-DLC artifacts, identifiers, canonicalization, manifests, source and citation contracts, lint, and deterministic indexes. |
| `Lifecycle` | Stages, per-workflow state, jobs, checkpoints, proposals, safe retries, and transactions. |
| `Governed` | Authenticated principals where served, access/rights/retention policy, review packets and receipts, audit, and human-gated stable publication. |
| `Federated` | Multiple mounts, locking, cache integrity, `kb://` resolution, retrieval routing, and cross-base trace/conflict behavior. |
| `Served` | MCP resources/tools, `stdio` and/or Streamable HTTP as declared, remote authentication when applicable, and protocol conformance tests. |

`Core` is required. Other modules are independent additions except that
`Governed`, `Federated`, and `Served` depend on `Core`; stable publication by the
reference team profile also requires `Lifecycle` and `Governed`. A personal
implementation may declare `Core+Lifecycle` without pretending to enforce
enterprise access controls. A hosted project claiming access-controlled query
behavior MUST declare `Governed+Served`.

Each normative section belongs to the module whose capability it describes;
cross-cutting security requirements apply whenever the associated feature is
implemented. An implementation SHALL publish a machine-readable conformance
statement and MUST NOT advertise tools or format profiles it does not support.

| Primary sections | Module |
|---|---|
| §2–§14, §26, §30–§31 | `Core` |
| §15–§17, concurrency portions of §28–§29 | `Lifecycle` |
| §21–§24 and §27 | `Governed` when governance features are claimed; artifact schemas remain `Core`. |
| §18–§20 | `Federated` |
| §25.1–§25.3 | `Served` |

An unclaimed optional module does not waive requirements for a feature the
implementation nevertheless exposes. For example, any implementation exposing
`publish_request` must meet its Governed requirements even if its conformance
file accidentally omits `Governed`.

## 33. MVP

### 33.1 Included

1. `Core+Lifecycle+Governed+Federated+Served` reference implementation.
2. Claude Code, Codex, local desktop MCP, and remote MCP project-server
   adapters over one engine.
3. `init`, `adopt`, `ingest`, `query`, `review`, `publish`, `lint`, `status`,
   `trace`, `doctor`, `reconcile-edits`, and job operations.
4. Local and Git knowledge-base mounts.
5. One primary writable base and multiple read-only/propose bases.
6. `knowledge-project.yaml`, `knowledge-base.yaml`, and `knowledge.lock`.
7. Markdown, text, CSV, PDF, DOCX, XLSX, PPTX, Draw.io, GIF, and VSDX format
   profiles at the structural/partial extraction level defined in §12.10.
8. Versioned canonicalization, byte/artifact/review hashes, incremental refresh,
   and direct-edit reconciliation.
9. OKF 0.2 concepts with the K-DLC base profile.
10. Standard Markdown and qualified `kb://` links.
11. Deterministic hierarchical index generation.
12. Filesystem/lexical retrieval.
13. Claim extraction, portable source references, and governed claim sidecars.
14. Minimum review packets, hash-bound receipts, and human-gated stable
    publication.
15. Deterministic sensors.
16. Per-workflow state, asynchronous jobs, optimistic concurrency, mount cache,
    and transaction journal.
17. JSONL audit trail, structured errors, and budget enforcement.
18. Project-local overlay and existing-corpus adoption.
19. Local `stdio` MCP and Streamable HTTP protocol conformance; production
    hosting and organization rollout remain deployment choices.

### 33.2 Deferred

- Legacy binary Office/Visio conversion unless an approved plugin is installed.
- Audio and video beyond GIF frame extraction.
- Vector retrieval and embedding lifecycle.
- Graph database and visualization.
- Remote MCP-backed knowledge-base mounts; MCP project serving is included.
- Knowledge-base registry and transitive dependency resolution.
- Repository ingestion and reverse engineering; this is the first next-release
  capability described in §39.1.
- Multiple writable bases in one transaction.
- Scheduled source monitoring.
- Rich desktop or web UI.
- Autonomous web research.
- Per-claim cryptographic signatures.
- Real-time multi-user editing.

## 34. Implementation Slices

### Slice 1: Portable artifacts

- Pinned OKF reference, manifest schemas, controlled vocabularies, and parsers.
- OKF validator, K-DLC base profile, canonicalization, and digest fixtures.
- Local mount resolver and `kb://` resolver.
- Project/knowledge-base scaffolding.
- Deterministic index and citation/claim-sidecar generation.

### Slice 2: Deterministic lifecycle engine

- Stage graph.
- Per-workflow state, jobs, locks, safe retries, and checkpoints.
- Audit writer.
- Sensors.
- Transaction journal and optimistic concurrency.

### Slice 3: Document normalization

- Normalizer descriptor and normalized-unit schemas.
- Sandboxed parsing, quarantine, limits, and format-specific locators.
- Markdown, text, CSV, PDF, DOCX, XLSX, PPTX, Draw.io, GIF, and VSDX profiles.
- Incremental structural indexes and deterministic/probabilistic separation.

### Slice 4: Agent workflows

- Conductor skill.
- Source Analyst, Integrator, Librarian, and Reviewer roles.
- Ingest and existing-corpus adoption.
- Claim and concept proposal artifacts.
- Review packet, receipt, direct-edit reconciliation, and publication flow.

### Slice 5: Federation and retrieval

- Git mount resolver, content-addressed cache, duplicate-ID sensor, and lock file.
- Cross-base lexical retrieval.
- Access/trust/freshness filters.
- Qualified citations and conflict surfacing.

### Slice 6: Distribution and MCP

- Claude Code adapter.
- Codex adapter.
- MCP project server with local `stdio` and Streamable HTTP.
- Claude Desktop extension packaging and remote custom-app metadata.
- OAuth/OIDC principal mapping for governed remote deployments.
- Generated distribution drift checks.
- Installer and `doctor` command.

### Slice 7: Extension SDK

- Templates, profiles, scopes, sensors, and plugin manifest.
- Plugin permission review.
- Compatibility and migration tooling.

## 35. Acceptance Criteria

MVP release gates use deterministic fixtures and recorded model outputs. A
harness is equivalent when it produces the same required artifact classes and
schemas, valid provenance graph, authorization and routing decisions, state
transitions, transaction results, and sensor outcomes. Generated prose and
claim counts need not be byte-identical.

The deterministic release suite SHALL demonstrate:

1. Initialization and the same fixture workflow succeed through Claude Code,
   Codex, MCP `stdio`, and MCP Streamable HTTP with equivalent engine outcomes.
2. The pinned OKF reference, YAML canonicalization fixtures, byte/artifact/review
   hashes, and review invalidation behavior are stable across platforms.
3. Every required format profile extracts declared structure and valid locators,
   reports partial coverage, and quarantines corrupt, encrypted, oversized, or
   unsupported fixtures safely.
4. Recorded model outputs drive anchored claim, proposal, conflict, and concept
   transitions without a live-model dependency in the release gate.
5. A governed published concept has resolvable footnotes, source entries,
   SourceRecord identity/hash, claim sidecar, review packet, and receipt.
6. Stable publication is impossible without the required receipt and fails when
   any review-covered value, source hash, policy, or dependency revision drifts.
7. Direct edits become `modified-after-review` and reconcile through a proposal.
8. Primary and dependency retrieval, qualified links, duplicate-base-ID
   rejection, cache integrity, read-only proposal routing, and recorded conflict
   surfacing behave deterministically.
9. Through the `Governed+Served` boundary, requester-visible results for absent
   and unauthorized resources are indistinguishable while protected audit
   records retain the minimized denial.
10. Prompt injection, authority spoofing, plausible falsehood, archive-bomb,
    macro, secret, rights-incompatible, and external-model-route fixtures cannot
    expand authority or publish prohibited content.
11. A revoked or erased source produces complete impact analysis; erasure tests
    purge configured derived projections and do not claim success while a test
    copy remains.
12. Concurrent workflows, retry idempotency keys, job cancellation, stale locks,
    changed targets, and a simulated mid-publication crash cannot create partial
    or last-write-wins canonical state.
13. Removing caches and `.generated/` and rebuilding produces byte-identical
    committed indexes and equivalent retrieval records.
14. `doctor` identifies missing parser dependencies, unsafe plugins, invalid
    mounts, duplicate IDs, cache/lock drift, clock skew, and incompatible
    profiles, policies, plugins, or clients.
15. Generated harness/desktop distributions pass byte-drift checks and do not
    advertise unsupported tools, conformance modules, or formats.

## 36. Evaluation Strategy

The test corpus SHOULD contain:

- Supporting sources.
- Direct contradictions.
- Temporally superseded policies.
- Ambiguous entity names.
- Restricted content.
- Prompt-injection text.
- Plausible falsehoods, compromised updates, duplicated-source corroboration,
  and authority spoofing.
- Corrupt, encrypted, oversized, adversarial, and low-fidelity examples for
  every required format profile.
- Broken and cyclic links.
- Revoked sources.
- Concurrent concept modifications.
- Multilingual content.
- Existing human-authored corpora and direct edits.

Quality evaluations SHOULD measure:

- Claim precision and source support.
- Source locator correctness.
- Concept identity/merge accuracy.
- Contradiction recall.
- Citation completeness.
- Retrieval recall and precision by query mode.
- Trust/freshness warning correctness.
- Human reviewer acceptance and edit distance.
- Cost and latency per lifecycle stage.
- Normalization coverage and locator accuracy by format.
- Review queue depth, age, and reviewer decision quality.
- Data-poisoning and unauthorized-existence disclosure resistance.

Structural and security acceptance MUST rely on deterministic tests, not only
LLM-as-judge evaluation. Model quality uses a separate statistical suite with a
versioned corpus, repeated trials, confidence intervals, and profile-defined
thresholds. A statistical regression may block release, but a single live-model
sample MUST NOT be a structural conformance test.

## 37. Initial Decisions

The following decisions are adopted for the first implementation:

1. The content-hash-pinned OKF 0.2 revision in §2.1 is the canonical concept
   format.
2. Markdown and YAML are the portable control surface.
3. One project may mount many bases; a write-enabled MVP project has one primary
   writable base, while a read-only audit project may have none.
4. Cross-base canonical links use stable `kb://` IDs; immutable resolution is
   recorded separately.
5. Workflow state and concept status remain separate.
6. Claims are intermediate artifacts and mandatory in standard/comprehensive
   ingestion.
7. Human review is required for `stable` content under the default team profile.
8. Filesystem search and indexes precede embeddings.
9. Git is recommended but not mandatory for personal/local operation.
10. Plugins are additive and explicitly trusted.
11. Security constraints cannot be weakened by ordinary project overrides.
12. Projects share knowledge only through published knowledge bases.
13. `kdlc-c14n-1` and distinct byte, artifact, and review hashes protect
    concurrency, portability, and approval scope.
14. One MCP project server federates mounted bases and supports local `stdio`
    and remote Streamable HTTP.
15. Plaintext bundle possession grants read access; governed confidentiality is
    enforced through distribution boundaries, encryption, or served principals.
16. Required document formats use bounded structural extraction and explicit
    partial-coverage reporting.
17. Repository reverse engineering is the first post-MVP release item, not an
    MVP requirement.
18. Conformance is declared through modules rather than one monolithic class.
19. K-DLC is the framework name; `kdlc` is the repository, CLI, plugin, MCP, and
    machine namespace.

## 38. Open Decisions Before Implementation

These require prototypes or owner decisions; they are intentionally not hidden
behind defaults:

1. **Implementation language and worker boundary:** TypeScript aligns with
   cross-harness packaging; Python or native workers have stronger document
   libraries. The deterministic core should initially use one language while
   normalizers may run as versioned restricted workers.
2. **Manifest validation:** JSON Schema, TypeBox/Zod, or another schema system.
   Generated JSON Schema is desirable for editors and external consumers.
3. **Git automation boundary:** whether the engine creates commits/branches or
   only stages files by default.
4. **Extended access policy engine:** the MVP lattice and compartment algorithm
   are fixed; a prototype shall determine whether later organization profiles
   embed Cedar, OPA, or another policy language.
5. **Qualified link rendering:** whether generic Markdown consumers receive a
   generated relative-link projection for `kb://` references.
6. **Source record placement for shared sources:** project-local records versus
   a dedicated source/evidence knowledge base. Project-local is recommended for
   MVP.
7. **Knowledge-base ID authority:** reverse-domain IDs are recommended, but
   collision detection and publisher verification need a registry/signing design
   before untrusted third-party bases are federated automatically.
8. **Normalizer implementation set:** select and license the concrete PDF,
   OOXML, diagram, GIF, OCR, and legacy conversion components, then publish
   fidelity fixtures for each.

## 39. Future Directions

### 39.1 Next release: repository reverse engineering

Repository reverse engineering is the first release item after the MVP. It
reuses the SourceRecord, normalizer, locator, job, provenance, proposal, review,
and MCP contracts rather than adding a second knowledge pipeline.

The MVP may ingest an individually selected Markdown, text, configuration, or
other supported file from a checkout as an ordinary document. It does not claim
repository identity, commit-aware provenance, symbol analysis, dependency
analysis, or architectural reverse engineering until this capability is
installed.

A repository SourceRecord SHALL identify the VCS, canonical remote or approved
local root, resolved commit, tree hash, branch/tag requested, submodule
resolutions, access policy, detected licenses, and analysis configuration. An
analysis SHALL be read-only by default and MUST NOT execute repository code,
build scripts, package hooks, tests, macros, or generators unless a separately
approved sandboxed stage declares that permission.

The repository normalizer SHALL produce:

- A file inventory with language, size, generated/vendor/binary classification,
  hashes, and ignore rationale.
- Detected package, module, workspace, build, deployment, API/schema, and
  dependency manifests.
- Symbols and definitions where supported, with repository/commit/path/line or
  symbol locators.
- Import/dependency edges and, when supported and quality-labeled, call and data
  flow edges.
- Documentation, tests, configuration, ownership, and architecture-signal
  inventories.
- Proposed system, component, interface, dependency, decision, glossary,
  runbook, and risk concepts with claim-level code provenance.

Generated, vendored, lock, fixture, and minified content SHALL be excluded or
down-weighted by declared policy, not silently omitted. Secret scanning and
source rights checks occur before any code or derived content is sent to an
external model. Architecture inference is probabilistic synthesis and requires
review; a dependency parsed directly from a pinned manifest remains
deterministic evidence.

Incremental refresh SHALL compare commits and file hashes, re-analyze affected
units and dependency neighborhoods, and produce impact analysis for concepts
whose supporting code changed or disappeared. Repository jobs are resumable and
bounded by file count, bytes, analysis depth, language services, time, memory,
and model budgets.

The release adds `repository_register`, `repository_analyze`,
`repository_diff`, and `repository_trace` MCP/CLI operations. Acceptance
fixtures SHALL cover a polyglot monorepo, renamed symbols, generated/vendor
trees, submodules, dependency cycles, malicious build hooks, secrets, large
binaries, and an incremental commit change. These tools MUST NOT be advertised
by an MVP-only server.

### 39.2 Later directions

After the repository release, likely extensions are:

- Audio/video normalization beyond the required GIF profile.
- Vector and graph projections with index-version receipts.
- Scheduled freshness and source-change monitoring.
- A knowledge-base registry with signed packages and dependency resolution.
- Static MkDocs, Obsidian, JSON-LD, and `llms.txt` projections.
- Review dashboards and graph-based gap discovery.
- Attested computations and deterministic execution receipts.
- Organization policy packs for software architecture, compliance, support,
  research, and data catalogs.

The canonical design remains unchanged: independently owned knowledge bases,
explicitly composed by projects, produced from source evidence through a gated
and auditable lifecycle.

## 40. Revision History

### 0.2.0 — 2026-08-14

- Standardized the framework name as K-DLC and the repository, CLI, plugin, MCP,
  package, and configuration namespace as `kdlc`; plugin scopes use
  `kdlc:<hyphenated-name>`.
- Pinned OKF 0.2 and added canonicalization, digest, review-packet, receipt, and
  published claim-provenance contracts.
- Defined controlled vocabularies, principal establishment, access boundaries,
  conformance modules, rights, erasure, poisoning, parser isolation, direct-edit
  reconciliation, asynchronous jobs, concurrency, and mount caching.
- Added first-release structural normalization profiles for Markdown, text, CSV,
  PDF, DOCX, XLSX, PPTX, Draw.io, GIF, and VSDX.
- Added one MCP project-server contract for Claude, ChatGPT, coding-agent, and
  other compatible clients over local `stdio` and remote Streamable HTTP.
- Added existing-corpus adoption and deterministic/statistical test separation.
- Scheduled repository reverse engineering as the first post-MVP release item.

### 0.1.0 — 2026-08-14

Initial full lifecycle and federation draft.
