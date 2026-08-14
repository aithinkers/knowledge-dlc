# ADR-001: Foundational implementation architecture

- Status: accepted
- Date: 2026-08-14
- Issue: #2
- Specification: §32.6, §37, §38

## Context

K-DLC needs one deterministic engine across its CLI, agent adapters, and MCP
transports, while document parsing requires libraries with different risk and
resource profiles. Its public artifact schemas must also be usable without the
reference implementation. Git integration must preserve explicit user control.

## Decision

### Runtime and repository

The reference implementation is an ESM TypeScript workspace with its controlled
development and release toolchain pinned to Node.js 24.5.0 and npm 11.5.1 by
`.nvmrc` and `package.json#packageManager`. The supported CI/runtime window is
Node.js 22.23.2 through 24.x and npm 10.9.8 through 11.x. Production packages use the `@kdlc/*`
namespace and separate portable contracts, engine behavior, normalizers,
adapters, and transports. The deterministic core does not call a live model.

The core and built-in deterministic parsers run in-process only when they do
not interpret active content. Complex or probabilistic normalization runs via a
versioned JSON-lines worker protocol in a subprocess with a scrubbed
environment, no shell, no network, a temporary working directory, bounded
input/output, time and memory limits, and cancellation. Workers receive bytes
or an explicit read-only file, never ambient repository access.

### Schemas and validation

JSON Schema 2020-12 is the normative contract and is published as a portable
artifact. Ajv 8 in strict mode validates runtime data. TypeScript types are
generated from schemas and drift-checked; handwritten runtime validators are
not an alternative source of truth. YAML is parsed to data and then validated
against the same schemas.

### Git boundary

The engine writes transaction output to a staging area and returns a change
plan by default. Branch creation, commits, pushes, and pull requests occur only
after an explicit command flag or adapter action and are executed through a
narrow Git adapter. The engine never force-pushes, rewrites history, bypasses
protection, or commits unrelated changes. Personal/local use does not require
Git.

### Access, links, sources, and identifiers

The MVP implements the specified access lattice and compartments directly; it
does not embed Cedar or OPA. `kb://` is canonical, with deterministic relative
Markdown projections generated for generic readers. Source records are
project-local. Knowledge-base IDs use reverse-domain identifiers; duplicate IDs
are rejected, while publisher signing and a global registry remain post-MVP.

### Normalizer components

All components are locked, license-audited, and invoked with active behavior
disabled:

| Profile | Component and boundary |
|---|---|
| Markdown, text | Core line and UTF-8 parsers |
| CSV | `csv-parse`, configured for bounded streaming and explicit dialects |
| PDF | Mozilla PDF.js worker; structural text, page, outline, and link extraction |
| DOCX, XLSX, PPTX, VSDX | `fflate` ZIP reader plus `saxes`; allowlisted OOXML/OPC parts only |
| Draw.io | `saxes`; compressed payloads decoded by `fflate` under expansion limits |
| GIF | `gifuct-js`; metadata and bounded frame sampling |
| OCR | Tesseract.js restricted worker, opt-in and always labeled probabilistic |

Macros, embedded scripts, external relationships, automatic conversions, and
network fetches are never executed. Encrypted, malformed, unsupported, or
over-limit inputs are quarantined. Exact library versions become release claims
only when locked by the normalization slice and proven by its format fixtures.

## Alternatives considered

- Python-first provides mature document libraries but complicates identical
  CLI/MCP/harness packaging and cross-language canonicalization.
- A mixed core would broaden the reproducibility boundary too early.
- Zod or TypeBox as schema authority improves TypeScript ergonomics but makes
  generated public schemas secondary.
- Automatic Git commits are convenient but expand authority and make staging,
  review, and rollback less explicit.
- LibreOffice-based conversion covers more formats but executes a much larger
  parser surface; it is excluded from the default MVP path.
- Cedar or OPA is premature before the fixed MVP policy lattice has fixtures.

## Consequences

One JavaScript runtime simplifies deterministic behavior and distribution.
Restricted workers preserve an upgrade path for native or Python normalizers
without coupling them to the core. Structural extraction will initially have
lower fidelity than full office-suite conversion, and every format must report
coverage and omissions honestly. Parser upgrades require lock changes,
compatibility fixtures, license review, and normal security review.

## Verification

Governance tests assert the accepted ADR, exact runtime/package-manager pins,
and traceability evidence. Slice-specific tests must validate the worker
protocol and every parser before conformance is declared.
