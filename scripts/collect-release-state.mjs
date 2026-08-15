#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [output] = process.argv.slice(2); if (!output || process.argv.length !== 3) throw new Error("usage: node scripts/collect-release-state.mjs <output-directory>");
const [owner, repository] = (process.env.GITHUB_REPOSITORY ?? "").split("/"); const token = process.env.GH_TOKEN; const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
if (!owner || !repository || !token || !event.pull_request) throw new Error("trusted GitHub release-state inputs are unavailable");
const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
const api = async (path) => { const response = await fetch(`https://api.github.com/repos/${owner}/${repository}${path}`, { headers }); if (!response.ok) throw new Error(`${path}: ${response.status}`); return response.json(); };
const apiAll = async (path) => { const values = []; for (let page = 1; ; page += 1) { const batch = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`); values.push(...batch); if (batch.length < 100) return values; } };
const repo = await api("");
const dependencies = await Promise.all(Array.from({ length: 8 }, (_, index) => api(`/issues/${index + 2}`)));
const summaries = await api("/rulesets?includes_parents=true&per_page=100");
const rulesets = await Promise.all(summaries.filter(({ target, enforcement }) => target === "branch" && enforcement === "active").map(({ id }) => api(`/rulesets/${id}`)));
const applicable = rulesets.filter(({ conditions }) => conditions?.ref_name?.include?.includes("~DEFAULT_BRANCH"));
const rule = (type) => applicable.flatMap(({ rules }) => rules ?? []).find((candidate) => candidate.type === type);
const pullRequest = rule("pull_request")?.parameters ?? {}; const statusChecks = rule("required_status_checks")?.parameters ?? {};
const requiredChecks = (statusChecks.required_status_checks ?? []).map(({ context }) => context).sort();
const directPushBypass = applicable.some(({ bypass_actors }) => (bypass_actors ?? []).some(({ bypass_mode }) => bypass_mode === "always"));
const settings = {
  visibility: repo.visibility ?? "unknown",
  release_blocking_issues_closed: dependencies.every(({ state, pull_request }) => state === "closed" && !pull_request),
  ruleset: {
    ids: applicable.map(({ id }) => id).sort((left, right) => left - right), active: applicable.length > 0, default_branch: applicable.length > 0,
    prevents_deletion: Boolean(rule("deletion")), prevents_non_fast_forward: Boolean(rule("non_fast_forward")), linear_history: Boolean(rule("required_linear_history")),
    pull_request: { required_approvals: pullRequest.required_approving_review_count ?? 0, require_code_owner_review: pullRequest.require_code_owner_review === true, dismiss_stale_reviews: pullRequest.dismiss_stale_reviews_on_push === true, require_last_push_approval: pullRequest.require_last_push_approval === true, require_thread_resolution: pullRequest.required_review_thread_resolution === true, allowed_merge_methods: [...(pullRequest.allowed_merge_methods ?? [])].sort() },
    strict_status_checks: statusChecks.strict_required_status_checks_policy === true, required_checks: requiredChecks, direct_push_bypass: directPushBypass
  }
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
