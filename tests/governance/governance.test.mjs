import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateAgainstSchema, validateEvidencePaths } from "../../scripts/governance-validation.mjs";
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
    "fix: wrong requirement (#14 REQ-GOV-0020)"
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
