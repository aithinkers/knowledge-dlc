#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { releaseMatrixCells, releaseMatrixCommandIds, releaseMatrixDifferences } from "./release-matrix-definition.mjs";
import { validateReleaseEvidence } from "./release-evidence-validation.mjs";
import { validateCandidatePreregistration } from "./statistical-evidence-validation.mjs";

const [directory] = process.argv.slice(2); if (!directory || process.argv.length !== 3) throw new Error("usage: node scripts/verify-release-matrix.mjs <download-directory>");
const candidateRoot = process.env.KDLC_CANDIDATE_ROOT ? resolve(process.env.KDLC_CANDIDATE_ROOT) : process.cwd();
await validateCandidatePreregistration(process.cwd(), candidateRoot);
const root = resolve(directory); const schema = JSON.parse(await readFile(resolve(process.cwd(), "core/schemas/release/release-matrix-result.schema.json"), "utf8")); const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const visit = async (path) => { const found = []; for (const entry of await readdir(path, { withFileTypes: true })) entry.isDirectory() ? found.push(...await visit(resolve(path, entry.name))) : entry.name === "result.json" && found.push(resolve(path, entry.name)); return found; };
const files = await visit(root); const results = await Promise.all(files.map(async (path) => JSON.parse(await readFile(path, "utf8"))));
if (results.length !== releaseMatrixCells.length) throw new Error(`expected exactly six release matrix results, received ${results.length}`);
for (const expected of releaseMatrixCells) {
  const matches = results.filter(({ cell }) => cell === expected.cell); if (matches.length !== 1) throw new Error(`${expected.cell}: missing or duplicate result`); const result = matches[0];
  if (!validate(result)) throw new Error(`${expected.cell}: ${new Ajv2020().errorsText(validate.errors)}`);
  if (result.runtime.node !== expected.node || result.runtime.npm !== "11.5.1" || result.platform.os !== expected.os || JSON.stringify(result.commands.map(({ id }) => id)) !== JSON.stringify(releaseMatrixCommandIds)) throw new Error(`${expected.cell}: runtime or command coverage was substituted`);
  if (JSON.stringify(result.differences) !== JSON.stringify(releaseMatrixDifferences(expected.os))) throw new Error(`${expected.cell}: platform differences were missing, duplicated, extra, or substituted`);
}
if (!process.env.KDLC_TRUSTED_ARTIFACT_EVIDENCE) throw new Error("trusted derived artifact evidence is unavailable");
const derivedArtifacts = JSON.parse(await readFile(process.env.KDLC_TRUSTED_ARTIFACT_EVIDENCE, "utf8"));
if (derivedArtifacts.head_sha !== process.env.KDLC_HEAD_SHA || results.some(({ observed_evidence }) => JSON.stringify(observed_evidence) !== JSON.stringify({ package: derivedArtifacts.package, supply_chain: derivedArtifacts.supply_chain, smoke: derivedArtifacts.smoke }))) throw new Error("cell evidence differs from trusted isolated package/supply-chain/smoke derivation");
const releaseFailures = await validateReleaseEvidence(candidateRoot, { headSha: process.env.KDLC_HEAD_SHA, matrixResults: results, trustedRepositorySnapshot: process.env.KDLC_TRUSTED_REPOSITORY_SNAPSHOT, trustedReviewRecord: process.env.KDLC_TRUSTED_REVIEW_RECORD }); if (releaseFailures.length) throw new Error(releaseFailures.join("; "));
console.log("Release matrix verified: exact six cells and nine required checks per cell passed; platform differences and derived package/supply-chain/smoke evidence recorded.");
