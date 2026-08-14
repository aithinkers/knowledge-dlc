import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateAgainstSchema, validateEvidencePaths, validateHarnessIntegrity } from "../../scripts/governance-validation.mjs";
import { validateIssueBody, validatePullRequest } from "../../scripts/verify-pr-traceability.mjs";

const traceabilityFixture = {
  requirements: [
    {
      id: "REQ-GOV-002",
      issue: 14,
      evidence: { implementation: ["AGENTS.md"], tests: ["tests/governance/governance.test.mjs"] }
    }
  ]
};

const validBody = `Closes #14

## Traceability

- Requirement IDs: REQ-GOV-002
- Specification sections: §5.2, §28, §29, §35

Commands and results:

\`\`\`text
npm test
pass
\`\`\``;

test("REQ-GOV-001 traceability identifiers and issues are unique", async () => {
  const traceability = JSON.parse(await readFile("docs/traceability.json", "utf8"));
  const ids = traceability.requirements.map(({ id }) => id);
  const issues = traceability.requirements.map(({ issue }) => issue);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(issues).size, issues.length);
});

test("REQ-GOV-001 development gates are explicit and ordered", async () => {
  const workflow = JSON.parse(await readFile("development/agent-workflow.json", "utf8"));
  assert.deepEqual(workflow.gates.map(({ id }) => id), [
    "feature-definition",
    "plan-review",
    "development",
    "testing",
    "final-review"
  ]);
  assert.equal(workflow.gates.at(-1).approval, "independent-owner-or-codeowner");
});

test("ADR-001 pins the accepted runtime and package manager", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal((await readFile(".nvmrc", "utf8")).trim(), "24.5.0");
  assert.equal(packageJson.packageManager, "npm@11.5.1");
  assert.equal(packageJson.engines.node, "24.5.0");
  assert.equal(packageJson.engines.npm, "11.5.1");
  assert.match(
    await readFile("docs/decisions/0001-foundational-architecture.md", "utf8"),
    /Status: accepted/
  );
});

test("REQ-GOV-002 accepts a pull request whose branch, issue, requirement, and commit agree", () => {
  const result = validatePullRequest({
    head: "fix/14-traceability-validation",
    body: validBody,
    traceability: traceabilityFixture,
    commitSubjects: ["fix: enforce traceability relationships (#14 REQ-GOV-002)"]
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.branchIssue, 14);
});

test("REQ-GOV-002 rejects mismatched branch and closing issue", () => {
  const result = validatePullRequest({
    head: "fix/999-unrelated",
    body: validBody,
    traceability: traceabilityFixture,
    commitSubjects: ["fix: unrelated (#999 REQ-GOV-002)"]
  });
  assert.ok(result.failures.includes("branch issue #999 must be one of the closing issues"));
});

test("REQ-GOV-002 rejects a requirement that does not map to the branch issue", () => {
  const result = validatePullRequest({
    head: "fix/14-traceability-validation",
    body: validBody.replace("REQ-GOV-002", "REQ-GOV-999"),
    traceability: traceabilityFixture,
    commitSubjects: ["fix: enforce traceability relationships (#14 REQ-GOV-999)"]
  });
  assert.ok(result.failures.includes("declared requirement is missing from docs/traceability.json: REQ-GOV-999"));
  assert.ok(result.failures.includes("at least one declared Requirement ID must map to branch issue #14"));
});

test("REQ-GOV-002 rejects untraceable commit subjects", () => {
  const result = validatePullRequest({
    head: "fix/14-traceability-validation",
    body: validBody,
    traceability: traceabilityFixture,
    commitSubjects: ["misc cleanup"]
  });
  assert.ok(result.failures.some((failure) => failure.startsWith("commit subject must contain #14")));
});

test("REQ-GOV-002 rejects commit identifiers that only share a prefix", () => {
  for (const subject of [
    "fix: wrong issue (#140 REQ-GOV-002)",
    "fix: wrong requirement (#14 REQ-GOV-0020)",
    "fix: wrong issue (#14_0 REQ-GOV-002)",
    "fix: wrong requirement (#14 REQ-GOV-002_bad)"
  ]) {
    const result = validatePullRequest({
      head: "fix/14-traceability-validation",
      body: validBody,
      traceability: traceabilityFixture,
      commitSubjects: [subject]
    });
    assert.ok(result.failures.some((failure) => failure.startsWith("commit subject must contain #14")));
  }
});

test("REQ-GOV-002 validates the linked GitHub issue contract", () => {
  assert.deepEqual(validateIssueBody({ number: 14, body: "## Requirement\nX\n## Specification trace\n§5\n## Acceptance criteria\n- [ ] X" }, 14), []);
  assert.ok(validateIssueBody({ number: 14, body: "## Requirement\nX" }, 14).length > 0);
  assert.ok(validateIssueBody({ number: 14, body: "## Requirement\n\n## Specification trace\n\n## Acceptance criteria\n" }, 14).length > 0);
  assert.ok(validateIssueBody({ number: 14, pull_request: {}, body: "## Requirement\nX\n## Specification trace\n§5\n## Acceptance criteria\n- [ ] X" }, 14).length > 0);
});

test("REQ-GOV-002 enforces committed JSON Schema constraints", async () => {
  const schema = JSON.parse(await readFile("docs/traceability.schema.json", "utf8"));
  const document = JSON.parse(await readFile("docs/traceability.json", "utf8"));
  assert.deepEqual(validateAgainstSchema(document, schema), []);
  assert.ok(validateAgainstSchema({ ...document, unexpected: true }, schema).length > 0);
});

test("REQ-GOV-002 reports missing evidence paths", async () => {
  const failures = await validateEvidencePaths({
    requirements: [{ id: "REQ-GOV-002", evidence: { implementation: ["not/a/real/path"], tests: [] } }]
  });
  assert.deepEqual(failures, ["REQ-GOV-002: evidence.implementation path must be a tracked repository file: not/a/real/path"]);
});

test("REQ-GOV-002 rejects evidence outside Git-tracked regular files", async () => {
  const failures = await validateEvidencePaths({
    requirements: [{
      id: "REQ-GOV-002",
      evidence: { implementation: ["/etc/passwd", "node_modules/ajv", ".github"], tests: [] }
    }]
  });
  assert.deepEqual(failures, [
    "REQ-GOV-002: evidence.implementation path must stay within the repository: /etc/passwd",
    "REQ-GOV-002: evidence.implementation path must be a regular file: node_modules/ajv",
    "REQ-GOV-002: evidence.implementation path must be a regular file: .github"
  ]);
});

test("REQ-GOV-002 rejects a tracked symlink as evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "kdlc-governance-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    await writeFile(join(root, "outside.txt"), "evidence\n");
    await symlink(join(root, "outside.txt"), join(root, "linked.txt"));
    execFileSync("git", ["add", "linked.txt"], { cwd: root });
    const failures = await validateEvidencePaths({
      requirements: [{ id: "REQ-GOV-002", evidence: { implementation: ["linked.txt"], tests: [] } }]
    }, root);
    assert.deepEqual(failures, [
      "REQ-GOV-002: evidence.implementation path must be a regular file: linked.txt"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("REQ-GOV-002 accepts an unchanged protected candidate-test harness", async () => {
  assert.deepEqual(await validateHarnessIntegrity(process.cwd(), process.cwd()), []);
});

test("REQ-GOV-002 rejects no-op or duplicate candidate-test controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "kdlc-harness-"));
  const trusted = join(root, "trusted");
  const candidate = join(root, "candidate");
  try {
    for (const directory of [trusted, candidate]) {
      await mkdir(join(directory, ".github/workflows"), { recursive: true });
    }
    await writeFile(join(trusted, ".github/workflows/candidate-tests.yml"), "name: Candidate tests\n");
    await writeFile(join(candidate, ".github/workflows/candidate-tests.yml"), "name: Candidate tests\njobs: {}\n");
    await writeFile(join(candidate, ".github/workflows/spoof.yml"), 'name: "Candidate tests"\n');
    await writeFile(join(trusted, "package.json"), JSON.stringify({ scripts: { test: "npm run test:governance", "check:governance": "node check", "test:governance": "node test" } }));
    await writeFile(join(candidate, "package.json"), JSON.stringify({ scripts: { test: "true", "check:governance": "node check", "test:governance": "node test" } }));

    const failures = await validateHarnessIntegrity(candidate, trusted);
    assert.ok(failures.includes("protected harness file differs from trusted base: .github/workflows/candidate-tests.yml"));
    assert.ok(failures.includes("protected npm script differs from trusted base: test"));
    assert.ok(failures.includes('reserved check name "Candidate tests" appears in another workflow: spoof.yml'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
