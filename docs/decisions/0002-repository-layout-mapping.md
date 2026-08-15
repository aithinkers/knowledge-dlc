# ADR-002: Repository layout mapping for specification §9.1

- Status: accepted
- Issue: #54
- Traceability: ADR-002
- Specification sections: 9.1, 34

## Context

Specification §9.1 illustrates the authored framework repository as a
`core/`-rooted tree (`core/skills/`, `core/stages/`, `core/agents/`,
`core/sensors/`, `core/tools/`, `core/normalizers/`, `core/server/mcp/`) with
`harness/` adapters and a generated `dist/` output. The implementation was
built as an npm-workspace layout instead. The equivalence was real but
unrecorded, so a conformance reader comparing the tree to the repository would
conclude the structure is nonconforming.

## Decision

The repository keeps the workspace layout and records the following normative
mapping. Specification §9.1 is amended in the same change to reference this
mapping. The generated-distribution drift rule is unchanged: every
`distribution/<harness>/` tree is produced by `packages/adapters/generate.mjs`
from authored sources, and `npm run check:distribution` fails when generated
output differs from a fresh build.

| Specification §9.1 path | Repository path |
|---|---|
| `core/schemas/` (incl. `okf-0.2/`, `manifests/`) | `core/schemas/` |
| `core/profiles/` | `core/profiles/` |
| `core/policies/` | `core/profiles/kdlc-base/profile.json` (policy defaults) |
| `core/stages/` | `packages/workflows/stages/` |
| `core/agents/` | `packages/agents/roles/` (runtime permission descriptors) and `packages/agents/definitions/` (authored harness agent sources; FEAT-010) |
| `core/skills/` | authored command definitions in `packages/adapters/definitions.mjs` |
| `core/sensors/` | `packages/lifecycle/src/sensors.mjs` and `packages/governance/src/controls.mjs` |
| `core/tools/` | `packages/core/src/`, `packages/contracts/`, `packages/federation/src/`, `packages/retrieval/src/`, `packages/erasure/src/`, `packages/extensions/src/` |
| `core/normalizers/` | `packages/normalizers/src/` with the restricted worker in `workers/normalizer/` |
| `core/server/mcp/` | `packages/mcp/` |
| `harness/claude/`, `harness/codex/` | harness adapter definitions in `packages/adapters/` |
| `packages/claude-desktop/`, `packages/chatgpt-app/` | `distribution/mcp/desktop.json`, `distribution/mcp/custom-app.json` |
| `dist/<harness>/` | `distribution/claude-code/`, `distribution/codex/`, `distribution/mcp/` |
| `plugins/` | not yet implemented (extension SDK scaffolding in `packages/extensions/`) |
| `scripts/` | `scripts/` |
| `tests/` | `tests/` |
| `docs/` | `docs/` |

## Compatibility analysis

- No artifact contract, schema, identifier, manifest, or tool behavior changes.
  The deviation is purely physical file placement inside the framework
  repository; user project workspaces (§9.2) and knowledge-base layouts (§9.3)
  are unaffected.
- The §9.1 requirement with normative force — generated harness output is
  never hand-authored and CI fails on drift — is preserved by
  `check:distribution` and the existing distribution tests.
- Generic consumers never depend on the framework repository layout; they
  consume published bundles and manifests, which are unchanged.

## Migration decision

No migration. Restructuring the repository to the illustrative tree was
rejected: it would churn every import path, CI check, and evidence hash for no
behavioral benefit. The specification text is amended instead, and this ADR is
the durable record required by `docs/specification-baseline.md`.
