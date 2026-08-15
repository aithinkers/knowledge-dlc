export const cleanRebuildIndexes = Object.freeze([
  Object.freeze({ path: "tests/fixtures/federation/base-primary/index.md", sha256: "sha256:e36010c85d8d2c96c1687440b8959759ac7f0fb39408b026cc49b2ed5e75aa0a" }),
  Object.freeze({ path: "tests/fixtures/federation/base-primary/policies/index.md", sha256: "sha256:156e6989f8f3c94b9c2ef902870cb975a6fadfbf003d93220689b712aad15d37" }),
  Object.freeze({ path: "tests/fixtures/federation/base-primary/references/index.md", sha256: "sha256:877cc3f4b741e1af3d061dc90e8541939fb51736178e4bc1b2a0dd743f5e1e19" }),
  Object.freeze({ path: "tests/fixtures/federation/base-primary/references/sources/index.md", sha256: "sha256:b3dacbade91ef79e8f5aa9154831b1d9d5b96be3afb14fa3fadd8f1fb8ff795a" }),
]);

export const mandatoryReleaseCases = Object.freeze({
  "recorded-ingest": Object.freeze({ requirements: ["FEAT-004"], evidence: "tests/governance/agent-workflows.test.mjs", tests: [
    "FEAT-004 ingest and adoption replay schema-valid recorded model outputs",
  ] }),
  "governed-publication": Object.freeze({ requirements: ["FEAT-004", "FEAT-008"], evidence: "tests/governance/agent-workflows.test.mjs", tests: [
    "FEAT-004 approved human review binds the exact packet and permits stable publication intent",
    "FEAT-004 stable publication fails closed and later decisions revoke approval",
  ] }),
  "adversarial-governance": Object.freeze({ requirements: ["FEAT-008"], evidence: "tests/governance/governed-controls.test.mjs", tests: [
    "FEAT-008 secret and prompt-injection fixtures block before model routing without disclosure",
    "FEAT-008 falsehood, authority spoofing, and duplicate-source laundering block review",
  ] }),
  "bounded-normalization": Object.freeze({ requirements: ["FEAT-003"], evidence: "tests/governance/normalization.test.mjs", tests: [
    "FEAT-003 descriptor, manifest, and unit schemas validate every deterministic profile",
    "FEAT-003 corrupt, encrypted, oversized, archive-bomb, external, macro, and unsupported inputs quarantine",
  ] }),
  "federated-nondisclosure": Object.freeze({ requirements: ["FEAT-005", "FEAT-008"], evidence: "tests/governance/release-evidence.test.mjs", tests: [
    "REL-001 federated evidence denies unauthorized local concepts without disclosure and detects cache drift",
  ] }),
  "durable-concurrency": Object.freeze({ requirements: ["FEAT-002"], evidence: "tests/governance/lifecycle-concurrency.test.mjs", tests: [
    "FEAT-002 finalizing publication recovers forward after audit without rollback",
    "FEAT-002 finalizing crash recovery reacquires dead target leases durably",
  ] }),
  "transport-equivalence": Object.freeze({ requirements: ["FEAT-006"], evidence: "tests/governance/distribution.test.mjs", tests: [
    "FEAT-006 one engine produces equivalent direct, MCP, and generated-adapter outcomes",
  ] }),
  "clean-rebuild": Object.freeze({ requirements: ["FEAT-001", "FEAT-005"], fixtures: Object.freeze([
    Object.freeze({ path: "tests/fixtures/federation/base-primary/retrieval-catalog.json", sha256: "sha256:c63dfa1e176cb686704813a203da897facc971d423d4afc8fb5bdcaa6fd29c69" }),
    ...cleanRebuildIndexes,
  ]), evidence: "tests/governance/release-evidence.test.mjs", tests: [
    "REL-001 clean rebuild removes caches and indexes then reproduces retrieval records and bytes",
  ] }),
  "governed-revocation-erasure": Object.freeze({ requirements: ["FEAT-008", "FEAT-009"], evidence: "tests/governance/revocation-erasure.test.mjs", tests: [
    "FEAT-008 FEAT-009 exposes only instance-bound evidence derived from a verified durable purge",
    "FEAT-009 same-ID path substitution and post-audit late copies cannot receive a receipt",
    "FEAT-009 a concurrent retrieval finishing after barrier installation cannot disclose revoked content",
  ] }),
});

export const mandatoryProfileRequirements = Object.freeze([
  "FEAT-001", "FEAT-002", "FEAT-003", "FEAT-004", "FEAT-005", "FEAT-006", "FEAT-008", "FEAT-009",
]);

export const conformanceModules = Object.freeze({
  Core: Object.freeze({ requirements: ["FEAT-001", "FEAT-003"], evidence: ["tests/governance/core-contracts.test.mjs", "tests/governance/core-runtime.test.mjs", "tests/governance/normalization.test.mjs"] }),
  Lifecycle: Object.freeze({ requirements: ["FEAT-002"], evidence: ["tests/governance/lifecycle-concurrency.test.mjs", "tests/governance/lifecycle.test.mjs"] }),
  Governed: Object.freeze({ requirements: ["FEAT-004", "FEAT-008", "FEAT-009"], evidence: ["tests/governance/agent-workflows.test.mjs", "tests/governance/governed-controls.test.mjs", "tests/governance/revocation-erasure.test.mjs"] }),
  Federated: Object.freeze({ requirements: ["FEAT-005"], evidence: ["tests/governance/federation-retrieval.test.mjs"] }),
  Served: Object.freeze({ requirements: ["FEAT-006"], evidence: ["tests/governance/distribution.test.mjs"] }),
});
