#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deriveRulesetState } from "./release-state-derivation.mjs";

const [output] = process.argv.slice(2); if (!output || process.argv.length !== 3) throw new Error("usage: node scripts/collect-release-state.mjs <output-directory>");
const [owner, repository] = (process.env.GITHUB_REPOSITORY ?? "").split("/"); const token = process.env.GH_TOKEN; const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
if (!owner || !repository || !token || !event.pull_request) throw new Error("trusted GitHub release-state inputs are unavailable");
const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
const api = async (path) => { const response = await fetch(`https://api.github.com/repos/${owner}/${repository}${path}`, { headers }); if (!response.ok) throw new Error(`${path}: ${response.status}`); return response.json(); };
const apiAll = async (path) => { const values = []; for (let page = 1; ; page += 1) { const batch = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`); values.push(...batch); if (batch.length < 100) return values; } };
const [repo, workflowPermissions] = await Promise.all([api(""), api("/actions/permissions/workflow")]);
const dependencies = await Promise.all(Array.from({ length: 8 }, (_, index) => api(`/issues/${index + 2}`)));
const summaries = await api("/rulesets?includes_parents=true&per_page=100");
const rulesets = await Promise.all(summaries.filter(({ target, enforcement }) => target === "branch" && enforcement === "active").map(({ id }) => api(`/rulesets/${id}`)));
const derivedRuleset = deriveRulesetState(rulesets, { baseRef: event.pull_request.base.ref, defaultBranch: repo.default_branch });
const settings = {
  visibility: repo.visibility ?? "unknown",
  actions: { default_workflow_permissions: workflowPermissions.default_workflow_permissions ?? "unknown", can_approve_pull_request_reviews: workflowPermissions.can_approve_pull_request_reviews === true },
  release_blocking_issues_closed: dependencies.every(({ state, pull_request }) => state === "closed" && !pull_request),
  ruleset: derivedRuleset
};

const head = event.pull_request.head.sha; const [reviews, comments] = await Promise.all([apiAll(`/pulls/${event.pull_request.number}/reviews`), apiAll(`/issues/${event.pull_request.number}/comments`)]);
const events = [];
for (const review of reviews) if (review.commit_id === head && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) events.push({ at: review.submitted_at, decision: review.state === "APPROVED" ? "approved" : "unapproved", kind: "formal-review", id: review.id, url: review.html_url, actor: review.user?.login ?? null });
for (const comment of comments) {
  const body = comment.body ?? ""; const bindsHead = body.includes(head); const independent = /^Independent\b/iu.test(body.trim()); const approve = /\bAPPROVE(?:D)?\b/iu.test(body); const reject = /\bREQUEST CHANGES\b/iu.test(body);
  if (bindsHead && independent && (approve || reject)) events.push({ at: comment.created_at, decision: reject ? "unapproved" : "approved", kind: "independent-agent-comment", id: comment.id, url: comment.html_url, actor: comment.user?.login ?? null });
}
events.sort((left, right) => new Date(left.at) - new Date(right.at)); const disposition = events.at(-1);
const review = { head_sha: head, decision: disposition?.decision ?? "unapproved", evidence_kind: disposition?.kind ?? "none", evidence_id: disposition?.id ?? null, evidence_url: disposition?.url ?? null, actor: disposition?.actor ?? null, observed_at: disposition?.at ?? null };
await mkdir(resolve(output), { recursive: true }); await writeFile(resolve(output, "repository-settings.json"), `${JSON.stringify(settings, null, 2)}\n`); await writeFile(resolve(output, "independent-review.json"), `${JSON.stringify(review, null, 2)}\n`);
