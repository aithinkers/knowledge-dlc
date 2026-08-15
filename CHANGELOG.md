# Changelog

## 1.0.0 — 2026-08-15

First public release candidate of K-DLC, implementing specification 0.2.0.

- Core: portable OKF 0.2 artifacts, deterministic indexes, `kdlc-c14n-1`
  canonicalization, and bounded normalization for ten document formats.
- Lifecycle: deterministic stage engine with checkpoints, advisory locks,
  transactional publication, and asynchronous jobs.
- Governed: nine-role agent layer with runtime-enforced capabilities, review
  packets/receipts, governance-gate sensors, sixteen §26 core lint sensors,
  revocation impact analysis, and verified erasure.
- Federated: explicit mounts, locked resolutions, write routing, and lexical
  retrieval with access-intersection non-disclosure.
- Served: `kdlc` CLI, MCP project server (stdio + streamable HTTP), and
  generated Claude Code, Codex, Kiro CLI, and Kiro IDE adapters from one
  authored core.
- Release evidence: nine offline structural cases (zero live model calls) and
  a qualified 30-trial statistical evaluation against the frozen
  anthropic/claude-sonnet-5 manifest — every Wilson lower bound, per-case
  floor, and the exact-rate security fail-closed gate (210/210) passed.
