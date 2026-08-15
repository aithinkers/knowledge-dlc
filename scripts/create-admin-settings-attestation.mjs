#!/usr/bin/env node
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { issueAdminSettingsAttestation } from "./release-state-derivation.mjs";

const [repositoryFlag, repository, actorFlag, actor, inputFlag, input, outputFlag, output] = process.argv.slice(2);
if (repositoryFlag !== "--repository" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "") || actorFlag !== "--actor" || !actor
  || inputFlag !== "--input" || !input || outputFlag !== "--output" || !output) throw new Error("usage: node scripts/create-admin-settings-attestation.mjs --repository <owner/repo> --actor <owner-identity> --input <admin-api.json> --output <attestation.json>");
const source = JSON.parse(await readFile(resolve(input), "utf8"));
if (JSON.stringify(Object.keys(source).sort()) !== JSON.stringify(["can_approve_pull_request_reviews", "default_workflow_permissions"].sort())
  || !["read", "write"].includes(source.default_workflow_permissions) || typeof source.can_approve_pull_request_reviews !== "boolean") throw new Error("admin API input has an unexpected shape");
const capturedAt = new Date().toISOString();
const record = issueAdminSettingsAttestation({ repository, capturedAt, confirmedAt: capturedAt, actor, settings: source });
const handle = await open(resolve(output), "wx", 0o600); try { await handle.writeFile(`${JSON.stringify(record)}\n`); } finally { await handle.close(); }
console.log("Created owner admin-settings attestation from supplied live API bytes; manually cross-check the settings UI before publishing the repository variable.");
