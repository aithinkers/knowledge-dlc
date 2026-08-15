#!/usr/bin/env node
import { execFile } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { createAdminSettingsCapture, issueAdminSettingsAttestation } from "./release-state-derivation.mjs";

const execute = promisify(execFile);
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const expectedSettings = (value) => value && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["can_approve_pull_request_reviews", "default_workflow_permissions"].sort())
  && ["read", "write"].includes(value.default_workflow_permissions) && typeof value.can_approve_pull_request_reviews === "boolean";
const writeExclusive = async (path, value) => { const handle = await open(resolve(path), "wx", 0o600); try { await handle.writeFile(`${JSON.stringify(value)}\n`); } finally { await handle.close(); } };
const ghActor = async () => (await execute("gh", ["api", "--hostname", "github.com", "user", "--jq", ".login"], { encoding: "utf8", maxBuffer: 1024 * 1024 })).stdout.trim();

if (process.env.GITHUB_ACTIONS === "true") throw new Error("admin settings capture and confirmation are prohibited in GitHub Actions");
const [command, repositoryFlag, repository, outputFlag, output, confirmationFlag] = process.argv.slice(2);
if (!repositoryPattern.test(repository ?? "") || repositoryFlag !== "--repository" || outputFlag !== "--output" || !output) {
  throw new Error("usage: ... capture --repository <owner/repo> --output <pending.json> | confirm --repository <owner/repo> --output <attestation.json> --manual-confirmed <pending.json>");
}
const actor = await ghActor();
if (command === "capture" && confirmationFlag === undefined) {
  const { stdout } = await execute("gh", ["api", "--hostname", "github.com", `repos/${repository}/actions/permissions/workflow`], { encoding: "buffer", maxBuffer: 1024 * 1024 });
  const bytes = Buffer.from(stdout); const settings = JSON.parse(bytes.toString("utf8"));
  if (!expectedSettings(settings)) throw new Error("live admin API response has an unexpected shape");
  await writeExclusive(output, createAdminSettingsCapture({ repository, capturedAt: new Date().toISOString(), actor, responseBytes: bytes }));
  console.log("Captured live admin API bytes. Manually compare them with the repository Actions settings UI, then run the separate confirm command.");
} else if (command === "confirm" && confirmationFlag === "--manual-confirmed") {
  const pendingPath = process.argv.at(-1); const capture = JSON.parse(await readFile(resolve(pendingPath), "utf8"));
  if (capture.repository !== repository) throw new Error("capture repository does not match confirmation repository");
  await writeExclusive(output, issueAdminSettingsAttestation({ capture, confirmedAt: new Date().toISOString(), actor }));
  console.log("Confirmed the owner-observed settings against the bound live capture. Publish only this attestation file as the repository variable.");
} else throw new Error("capture and confirm are separate operations; confirmation requires --manual-confirmed <pending.json>");
