import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { generateHierarchicalIndexes, sha256 } from "../../packages/core/index.mjs";
import { CORE_SENSOR_IDS, createCoreSensors, scanLintContext, SensorRunner } from "../../packages/lifecycle/src/index.mjs";

const runner = () => new SensorRunner({
  sensors: createCoreSensors({ profile: null }),
  clock: { now: () => "2026-08-15T00:00:00Z", millis: () => Date.parse("2026-08-15T00:00:00Z") },
});

async function workspace(t, concepts, { extraFiles = {}, indexes = "generated" } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "kdlc-core-sensors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const kb = resolve(root, "knowledge/primary");
  for (const [path, text] of Object.entries(concepts)) {
    await mkdir(resolve(kb, path, ".."), { recursive: true });
    await writeFile(resolve(kb, path), text);
  }
  if (indexes === "generated") {
    const parsed = Object.entries(concepts).filter(([path]) => path.endsWith(".md")).map(([path, text]) => {
      const title = /title: (.+)/u.exec(text)?.[1] ?? path;
      const description = /description: (.+)/u.exec(text)?.[1] ?? "";
      return { path, title, description };
    });
    for (const [indexPath, text] of generateHierarchicalIndexes(parsed)) {
      await mkdir(resolve(kb, indexPath, ".."), { recursive: true });
      await writeFile(resolve(kb, indexPath), text);
    }
  }
  for (const [path, text] of Object.entries(extraFiles)) {
    await mkdir(resolve(root, path, ".."), { recursive: true });
    await writeFile(resolve(root, path), text);
  }
  await writeFile(resolve(root, "knowledge-project.yaml"), "api_version: kdlc.dev/v1alpha1\nkind: Project\n");
  await writeFile(resolve(root, "knowledge.lock"), "api_version: kdlc.dev/v1alpha1\n");
  return root;
}

async function lint(root) {
  const context = await scanLintContext({ root, today: "2026-08-15" });
  const report = await runner().run(CORE_SENSOR_IDS, { ...context, scope: "lint" });
  return report.results.flatMap(({ findings }) => findings ?? []);
}

const codes = (findings) => findings.map(({ code }) => code).sort();

const CLEAN = `---
type: Policy
title: Clean Policy
description: A well-formed stable concept.
status: stable
generated: { by: kdlc-synthesizer/1.0, at: 2026-08-01T00:00:00Z }
verified: { by: human:reviewer, at: 2026-08-02T00:00:00Z }
stale_after: 2030-01-01
sources:
  - { id: standard, resource: "https://example.invalid/standard" }
---
Clean claim.[^standard]

[^standard]: Standard
`;

test("FEAT-015 a clean knowledge base passes every core sensor", async (t) => {
  const root = await workspace(t, { "policies/clean.md": CLEAN });
  assert.deepEqual(await lint(root), []);
});

test("FEAT-015 sensors are registered for every §26 category slice", () => {
  assert.deepEqual([...CORE_SENSOR_IDS].sort(), [
    "alias-cycles", "claim-sidecar-consistency", "duplicate-concepts", "index-completeness",
    "index-reproducibility", "lifecycle-transitions", "link-resolution", "lock-drift",
    "okf-conformance", "profile-frontmatter", "relationship-compatibility", "review-binding",
    "source-resolvability", "stale-verification", "ungrounded-claims", "workflow-integrity",
  ]);
});

test("FEAT-015 provenance sensors catch unresolved sources, ungrounded citations, and sidecar drift", async (t) => {
  const sidecar = '{"assertion":"a"}\n';
  const root = await workspace(t, {
    "policies/broken.md": `---
type: Policy
title: Broken Policy
description: Broken provenance.
status: stable
generated: { by: kdlc-synthesizer/1.0, at: 2026-08-01T00:00:00Z }
verified: { by: human:reviewer, at: 2026-08-02T00:00:00Z }
stale_after: 2030-01-01
claim_provenance: { resource: /references/claims/policies/broken.jsonl, artifact_hash: "sha256:${"0".repeat(64)}" }
sources:
  - { id: gone, resource: /references/sources/gone.md }
---
Grounded.[^gone] Ungrounded.[^ghost]

[^gone]: Gone
[^ghost]: Ghost
`,
    "references/claims/policies/broken.jsonl": sidecar,
  });
  const findings = await lint(root);
  for (const expected of ["KDLC_SOURCE_UNRESOLVED", "KDLC_CITATION_UNGROUNDED", "KDLC_CLAIM_SIDECAR_DRIFT"]) {
    assert.ok(codes(findings).includes(expected), `expected ${expected} in ${codes(findings)}`);
  }
  // Correct hash clears the sidecar finding.
  const fixed = await workspace(t, {
    "policies/bound.md": `---
type: Policy
title: Bound Policy
description: Correct sidecar binding.
status: stable
generated: { by: kdlc-synthesizer/1.0, at: 2026-08-01T00:00:00Z }
verified: { by: human:reviewer, at: 2026-08-02T00:00:00Z }
stale_after: 2030-01-01
claim_provenance: { resource: /references/claims/policies/bound.jsonl, artifact_hash: "${sha256(Buffer.from(sidecar))}" }
sources:
  - { id: ok, resource: "https://example.invalid/ok" }
---
Fine.[^ok]

[^ok]: OK
`,
    "references/claims/policies/bound.jsonl": sidecar,
  });
  assert.ok(!codes(await lint(fixed)).some((code) => code.startsWith("KDLC_CLAIM_SIDECAR")));
});

test("FEAT-015 graph sensors catch alias cycles, duplicates, bad relationships, orphans, and index drift", async (t) => {
  const alias = (name, target) => `---
type: Alias
title: Alias ${name}
description: Redirect.
status: deprecated
relationships:
  - { type: redirects_to, target: /${target}.md }
---
Moved.
`;
  const root = await workspace(t, {
    "a.md": alias("A", "b"),
    "b.md": alias("B", "a"),
    "policies/one.md": CLEAN,
    "policies/two.md": CLEAN.replace("Clean Policy", "Clean  policy"),
    "policies/rel.md": CLEAN.replace("title: Clean Policy", "title: Rel Policy").replace("---\nClean", "relationships:\n  - { type: made_up_type, target: /policies/one.md }\n---\nClean"),
  });
  const findings = await lint(root);
  for (const expected of ["KDLC_ALIAS_CYCLE", "KDLC_DUPLICATE_CANDIDATE", "KDLC_RELATIONSHIP_UNKNOWN"]) {
    assert.ok(codes(findings).includes(expected), `expected ${expected} in ${codes(findings)}`);
  }
  const orphaned = await workspace(t, { "policies/orphan.md": CLEAN }, { indexes: "none" });
  assert.ok(codes(await lint(orphaned)).includes("KDLC_INDEX_MISSING"));
  const drifted = await workspace(t, { "policies/drift.md": CLEAN });
  await writeFile(resolve(drifted, "knowledge/primary/policies/index.md"), "<!-- generated by kdlc; do not edit -->\n# Policies\n\n* [Hand edited](drift.md)\n");
  assert.ok(codes(await lint(drifted)).includes("KDLC_INDEX_DRIFT"));
});

test("FEAT-015 state sensors catch review drift, lifecycle violations, stale locks, and bad jobs", async (t) => {
  const root = await workspace(t, {
    "policies/reviewed.md": CLEAN.replace("---\nClean claim", `review_receipts:\n  - { resource: /references/reviews/rr.json, artifact_hash: "sha256:${"1".repeat(64)}" }\n---\nClean claim`),
    "policies/tombstone.md": CLEAN.replace("title: Clean Policy", "title: Tombstone").replace("status: stable", "status: stable\nlifecycle: { disposition: tombstone }"),
    "references/reviews/rr.json": "{}\n",
  }, {
    extraFiles: {
      "workflow/locks/kb.json": '{"owner":"x","lease_expires_at":"2020-01-01T00:00:00Z"}\n',
      "workflow/jobs/bad.json": "not json\n",
    },
  });
  const findings = await lint(root);
  for (const expected of ["KDLC_MODIFIED_AFTER_REVIEW", "KDLC_LIFECYCLE_INVALID", "KDLC_LOCK_STALE", "KDLC_JOB_RECORD_INVALID"]) {
    assert.ok(codes(findings).includes(expected), `expected ${expected} in ${codes(findings)}`);
  }
});

test("FEAT-015 lock-drift sensor warns without a lock and errors with unlocked remote mounts", async (t) => {
  const root = await workspace(t, { "policies/clean.md": CLEAN });
  await rm(resolve(root, "knowledge.lock"));
  let findings = await lint(root);
  assert.ok(findings.some(({ code, severity }) => code === "KDLC_LOCK_MISSING" && severity === "warning"));
  await writeFile(resolve(root, "knowledge-project.yaml"), 'api_version: kdlc.dev/v1alpha1\nkind: Project\nknowledge_bases:\n  - { name: security, uri: "git+ssh://git@example.invalid/security.git", mode: read-only }\n');
  findings = await lint(root);
  assert.ok(findings.some(({ code, severity }) => code === "KDLC_LOCK_MISSING" && severity === "error"));
});

test("FEAT-015 freshness sensor flags stale and unverified stable concepts", async (t) => {
  const root = await workspace(t, {
    "policies/stale.md": CLEAN.replace("stale_after: 2030-01-01", "stale_after: 2026-01-01").replace("verified: { by: human:reviewer, at: 2026-08-02T00:00:00Z }\n", ""),
  });
  const findings = await lint(root);
  assert.ok(codes(findings).includes("KDLC_CONCEPT_STALE"));
  assert.ok(codes(findings).includes("KDLC_VERIFICATION_MISSING"));
});
