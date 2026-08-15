#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [output] = process.argv.slice(2); if (!output || process.argv.length !== 3) throw new Error("usage: node scripts/collect-release-state.mjs <output-directory>");
const [owner, repository] = (process.env.GITHUB_REPOSITORY ?? "").split("/"); const token = process.env.GH_TOKEN; const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
if (!owner || !repository || !token || !event.pull_request) throw new Error("trusted GitHub release-state inputs are unavailable");
const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
const api = async (path) => { const response = await fetch(`https://api.github.com/repos/${owner}/${repository}${path}`, { headers }); if (!response.ok) throw new Error(`${path}: ${response.status}`); return response.json(); };
let repo = {}; let protection = {}; let reviews = []; let dependenciesClosed = false;
try { repo = await api(""); } catch {}
try { protection = await api(`/branches/${encodeURIComponent(event.pull_request.base.ref)}/protection`); } catch {}
try { reviews = await api(`/pulls/${event.pull_request.number}/reviews?per_page=100`); } catch {}
try { dependenciesClosed = (await Promise.all(Array.from({ length: 8 }, (_, index) => api(`/issues/${index + 2}`)))).every(({ state, pull_request }) => state === "closed" && !pull_request); } catch {}
const checks = [...(protection.required_status_checks?.contexts ?? []), ...(protection.required_status_checks?.checks ?? []).map(({ context }) => context)].filter((value, index, all) => all.indexOf(value) === index).sort();
const approved = reviews.find(({ state, commit_id, user }) => state === "APPROVED" && commit_id === event.pull_request.head.sha && user?.login !== event.pull_request.user?.login);
const settings = { visibility: repo.visibility ?? "unknown", branch_protection: Boolean(protection.required_status_checks), release_blocking_issues_closed: dependenciesClosed, required_checks: checks };
const review = { head_sha: event.pull_request.head.sha, decision: approved ? "approved" : "unapproved", independent: Boolean(approved), reviewer: approved?.user?.login ?? null };
await mkdir(resolve(output), { recursive: true }); await writeFile(resolve(output, "repository-settings.json"), `${JSON.stringify(settings, null, 2)}\n`); await writeFile(resolve(output, "independent-review.json"), `${JSON.stringify(review, null, 2)}\n`);
