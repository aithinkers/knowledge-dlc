#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import process from "node:process";

const requirementPattern = /\b(?:REQ-[A-Z]+-\d{3}|FEAT-\d{3}|ADR-\d{3}|REL-\d{3})\b/g;

export function validatePullRequest({ body, head, traceability, commitSubjects }) {
  const failures = [];
  const branchMatch = head.match(/^(?:feat|fix|docs|chore|test|refactor|security|release)\/(\d+)-[a-z0-9-]+$/);
  const branchIssue = branchMatch ? Number(branchMatch[1]) : null;
  if (!branchMatch) failures.push("branch must follow <type>/<issue>-<slug>");

  const closingIssues = new Set(
    [...body.matchAll(/\b(?:closes|fixes|resolves)\s+#(\d+)\b/gi)].map((match) => Number(match[1]))
  );
  if (closingIssues.size === 0) {
    failures.push("PR body must close an issue using Closes/Fixes/Resolves #<number>");
  } else if (branchIssue !== null && !closingIssues.has(branchIssue)) {
    failures.push(`branch issue #${branchIssue} must be one of the closing issues`);
  }

  const requirementLine = body.match(/^- Requirement IDs:\s*(.+)$/mi)?.[1] ?? "";
  const declaredIds = [...new Set(requirementLine.match(requirementPattern) ?? [])];
  if (declaredIds.length === 0) failures.push("PR Traceability section must declare at least one Requirement ID");

  const requirements = traceability?.requirements ?? [];
  const mappedRequirements = declaredIds.map((id) => requirements.find((entry) => entry.id === id));
  for (const [index, requirement] of mappedRequirements.entries()) {
    if (!requirement) failures.push(`declared requirement is missing from docs/traceability.json: ${declaredIds[index]}`);
  }
  const primaryMappings = mappedRequirements.filter((entry) => entry?.issue === branchIssue);
  if (branchIssue !== null && primaryMappings.length === 0) {
    failures.push(`at least one declared Requirement ID must map to branch issue #${branchIssue}`);
  }

  if (!/(?:§|section(?:s)?\s+)\d+/i.test(body)) {
    failures.push("PR body must identify specification section(s)");
  }
  if (!/Commands and results:[\s\S]*```(?:text)?\s*\S+/i.test(body)) {
    failures.push("PR body must include non-empty verification commands and results");
  }

  const primaryIds = primaryMappings.map(({ id }) => id);
  if (!Array.isArray(commitSubjects) || commitSubjects.length === 0) {
    failures.push("PR must contain at least one commit subject for validation");
  } else if (branchIssue !== null && primaryIds.length > 0) {
    for (const subject of commitSubjects) {
      if (!subject.includes(`#${branchIssue}`) || !primaryIds.some((id) => subject.includes(id))) {
        failures.push(`commit subject must contain #${branchIssue} and a mapped Requirement ID: ${subject}`);
      }
    }
  }

  return { failures, branchIssue };
}

export function validateIssueBody(issue, expectedNumber) {
  const failures = [];
  if (issue.number !== expectedNumber) failures.push(`GitHub issue #${expectedNumber} could not be resolved`);
  const body = issue.body ?? "";
  for (const heading of ["Requirement", "Specification trace", "Acceptance criteria"]) {
    if (!new RegExp(`^## ${heading}$`, "mi").test(body)) failures.push(`issue #${expectedNumber} is missing heading: ${heading}`);
  }
  return failures;
}

async function fetchIssue(repository, issueNumber, token) {
  const response = await fetch(`https://api.github.com/repos/${repository}/issues/${issueNumber}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (!response.ok) throw new Error(`GitHub issue lookup failed with HTTP ${response.status}`);
  return response.json();
}

function loadCommitSubjects(baseSha) {
  if (!baseSha) throw new Error("KDLC_BASE_SHA is required for commit traceability validation");
  return execFileSync("git", ["log", "--format=%s", `${baseSha}..HEAD`], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

async function main() {
  const traceability = JSON.parse(await readFile("docs/traceability.json", "utf8"));
  const result = validatePullRequest({
    body: process.env.KDLC_PR_BODY ?? "",
    head: process.env.KDLC_PR_HEAD ?? "",
    traceability,
    commitSubjects: loadCommitSubjects(process.env.KDLC_BASE_SHA ?? "")
  });
  const failures = [...result.failures];

  const repository = process.env.KDLC_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !token) {
    failures.push("KDLC_REPOSITORY and GITHUB_TOKEN are required for issue validation");
  } else if (result.branchIssue !== null) {
    try {
      failures.push(...validateIssueBody(await fetchIssue(repository, result.branchIssue, token), result.branchIssue));
    } catch (error) {
      failures.push(error.message);
    }
  }

  if (failures.length) {
    console.error(failures.map((failure) => `ERROR: ${failure}`).join("\n"));
    process.exit(1);
  }
  console.log("Pull request traceability verified.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
