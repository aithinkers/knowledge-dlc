import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readme = await readFile("README.md", "utf8");

test("FEAT-014 README keeps the pre-release and review-everything posture", () => {
  assert.ok(readme.includes("pre-release MVP development"), "pre-release notice must stay");
  assert.ok(readme.includes("It is not a supported release."));
  assert.ok(readme.includes("Generative AI can make mistakes"));
});

test("FEAT-014 every relative README link resolves to a repository path", async () => {
  const links = [...readme.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/gu)]
    .map(([, target]) => target)
    .filter((target) => !/^[a-z]+:/u.test(target));
  assert.ok(links.length >= 15, "README must keep its repository links");
  for (const target of links) await assert.doesNotReject(access(target), `README links to a missing path: ${target}`);
});

test("FEAT-014 the harness table names every generated distribution", () => {
  for (const harness of ["claude-code", "codex", "kiro", "kiro-ide", "mcp"]) {
    assert.ok(readme.includes(`distribution/${harness}`), `harness table must reference distribution/${harness}`);
  }
});
