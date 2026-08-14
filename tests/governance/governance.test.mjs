import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validatePullRequest } from "../../scripts/verify-pr-traceability.mjs";

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

test("REQ-GOV-001 accepts a fully traceable pull request", () => {
  const failures = validatePullRequest({
    title: "REQ-GOV-001: enforce traceability",
    head: "feat/1-agent-development-harness",
    body: `Closes #1

Specification sections: §5.2, §28, §29, §35

Commands and results:

\`\`\`text
node --test tests/governance/*.test.mjs
pass
\`\`\``
  });
  assert.deepEqual(failures, []);
});

test("REQ-GOV-001 rejects a pull request without issue, requirement, spec, tests, or branch convention", () => {
  const failures = validatePullRequest({ title: "misc changes", body: "looks good", head: "work" });
  assert.equal(failures.length, 5);
});
