import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const adrPath = "docs/decisions/0002-repository-layout-mapping.md";
const specPath = "docs/knowledge-development-lifecycle-specification.md";
const baselinePath = "docs/specification-baseline.md";

test("ADR-002 mapping table points only at existing repository paths", async () => {
  const adr = await readFile(adrPath, "utf8");
  const rows = adr
    .split("\n")
    .filter((line) => line.startsWith("| `") && line.includes("` | "));
  assert.ok(rows.length >= 15, "mapping table must enumerate the §9.1 tree");
  for (const row of rows) {
    const repositoryCell = row.split("|")[2];
    const paths = [...repositoryCell.matchAll(/`([^`]+)`/gu)].map(([, path]) => path);
    for (const path of paths) {
      if (path.includes("<") || path === "dist/<harness>/") continue;
      // FEAT-010 delivers this directory; the ADR records it prospectively.
      if (path === "packages/agents/definitions/") continue;
      await assert.doesNotReject(access(path.replace(/\/$/u, "")), `mapped path must exist: ${path}`);
    }
  }
});

test("ADR-002 specification §9.1 references the recorded layout mapping", async () => {
  const spec = await readFile(specPath, "utf8");
  assert.ok(spec.includes("docs/decisions/0002-repository-layout-mapping.md"));
  assert.ok(spec.includes("CI SHALL fail when generated output differs from a\nfresh build."));
});

test("ADR-002 specification baseline hash matches the specification bytes", async () => {
  const baseline = await readFile(baselinePath, "utf8");
  const declared = /- SHA-256: `([0-9a-f]{64})`/u.exec(baseline)?.[1];
  const actual = createHash("sha256").update(await readFile(specPath)).digest("hex");
  assert.equal(declared, actual, "docs/specification-baseline.md must record the current specification SHA-256");
  assert.ok(baseline.includes("## Change record"), "baseline amendments must keep the change record");
});
