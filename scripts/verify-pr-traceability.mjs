#!/usr/bin/env node

import process from "node:process";

export function validatePullRequest({ title, body, head }) {
  const failures = [];
  const text = `${title}\n${body}`;
  if (!/\b(?:closes|fixes|resolves)\s+#\d+\b/i.test(body)) {
    failures.push("PR body must close an issue using Closes/Fixes/Resolves #<number>");
  }
  if (!/\b(?:REQ-[A-Z]+-\d{3}|FEAT-\d{3}|ADR-\d{3}|REL-\d{3})\b/.test(text)) {
    failures.push("PR must include a stable traceability ID");
  }
  if (!/(?:§|section(?:s)?\s+)\d+/i.test(body)) {
    failures.push("PR body must identify specification section(s)");
  }
  if (!/Commands and results:[\s\S]*```(?:text)?\s*\S+/i.test(body)) {
    failures.push("PR body must include non-empty verification commands and results");
  }
  if (!/^(?:feat|fix|docs|chore|test|refactor|security|release)\/\d+-[a-z0-9-]+$/.test(head)) {
    failures.push("branch must follow <type>/<issue>-<slug>");
  }
  return failures;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const failures = validatePullRequest({
    title: process.env.KDLC_PR_TITLE ?? "",
    body: process.env.KDLC_PR_BODY ?? "",
    head: process.env.KDLC_PR_HEAD ?? ""
  });
  if (failures.length) {
    console.error(failures.map((failure) => `ERROR: ${failure}`).join("\n"));
    process.exit(1);
  }
  console.log("Pull request traceability verified.");
}
