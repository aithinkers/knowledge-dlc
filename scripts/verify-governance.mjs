#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import process from "node:process";

const requiredFiles = [
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "SUPPORT.md",
  ".github/CODEOWNERS",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/feature.yml",
  ".github/ISSUE_TEMPLATE/requirement.yml",
  ".github/ISSUE_TEMPLATE/decision.yml",
  ".github/ISSUE_TEMPLATE/security.yml",
  ".github/workflows/governance.yml",
  "development/agent-workflow.json",
  "development/agent-workflow.schema.json",
  "docs/knowledge-development-lifecycle-specification.md",
  "docs/specification-baseline.md",
  "docs/traceability.json",
  "docs/traceability.schema.json"
];

const failures = [];

for (const file of requiredFiles) {
  try {
    await access(file, constants.R_OK);
  } catch {
    failures.push(`missing required governance file: ${file}`);
  }
}

let agentWorkflow;
try {
  agentWorkflow = JSON.parse(await readFile("development/agent-workflow.json", "utf8"));
} catch (error) {
  failures.push(`agent workflow is not valid JSON: ${error.message}`);
}

if (agentWorkflow) {
  const expectedGates = ["feature-definition", "plan-review", "development", "testing", "final-review"];
  const actualGates = agentWorkflow.gates?.map(({ id }) => id) ?? [];
  if (JSON.stringify(actualGates) !== JSON.stringify(expectedGates)) {
    failures.push(`agent workflow gates must be ordered: ${expectedGates.join(", ")}`);
  }
  for (const gate of agentWorkflow.gates ?? []) {
    if (!gate.role || !gate.approval || !gate.requires?.length || !gate.produces?.length) {
      failures.push(`${gate.id ?? "<missing-gate>"}: role, approval, requires, and produces are required`);
    }
  }
}

let traceability;
try {
  traceability = JSON.parse(await readFile("docs/traceability.json", "utf8"));
} catch (error) {
  failures.push(`traceability index is not valid JSON: ${error.message}`);
}

if (traceability) {
  if (traceability.version !== 1) failures.push("traceability version must be 1");
  if (traceability.specification?.name !== "K-DLC") failures.push("specification name must be K-DLC");
  if (!Array.isArray(traceability.requirements) || traceability.requirements.length === 0) {
    failures.push("traceability requirements must be a non-empty array");
  } else {
    const ids = new Set();
    const issues = new Set();
    const idPattern = /^(REQ-[A-Z]+-[0-9]{3}|FEAT-[0-9]{3}|ADR-[0-9]{3}|REL-[0-9]{3})$/;
    const statuses = new Set(["planned", "in-progress", "blocked", "implemented", "verified", "released"]);

    for (const requirement of traceability.requirements) {
      const prefix = requirement.id ?? "<missing-id>";
      if (!idPattern.test(prefix)) failures.push(`invalid requirement id: ${prefix}`);
      if (ids.has(prefix)) failures.push(`duplicate requirement id: ${prefix}`);
      ids.add(prefix);
      if (!Number.isInteger(requirement.issue) || requirement.issue < 1) {
        failures.push(`${prefix}: issue must be a positive integer`);
      } else if (issues.has(requirement.issue)) {
        failures.push(`${prefix}: duplicate issue mapping #${requirement.issue}`);
      } else {
        issues.add(requirement.issue);
      }
      if (!statuses.has(requirement.status)) failures.push(`${prefix}: invalid status ${requirement.status}`);
      if (!Array.isArray(requirement.specification_sections) || requirement.specification_sections.length === 0) {
        failures.push(`${prefix}: at least one specification section is required`);
      }
      for (const kind of ["implementation", "tests"]) {
        if (!Array.isArray(requirement.evidence?.[kind])) failures.push(`${prefix}: evidence.${kind} must be an array`);
      }
      if (["implemented", "verified", "released"].includes(requirement.status) && requirement.evidence?.implementation?.length === 0) {
        failures.push(`${prefix}: implemented status requires implementation evidence`);
      }
      if (["verified", "released"].includes(requirement.status) && requirement.evidence?.tests?.length === 0) {
        failures.push(`${prefix}: verified status requires test evidence`);
      }
    }
  }
}

if (failures.length) {
  console.error(failures.map((failure) => `ERROR: ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Governance verified: ${traceability.requirements.length} traceable requirements and ${agentWorkflow.gates.length} development gates.`);
