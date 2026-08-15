import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import YAML from "yaml";

export const protectedHarnessFiles = Object.freeze([
  ".github/workflows/governance.yml",
  ".github/workflows/candidate-tests.yml",
  ".github/workflows/release-matrix.yml",
  "scripts/governance-validation.mjs",
  "scripts/verify-governance.mjs",
  "scripts/release-matrix-definition.mjs",
  "scripts/run-release-matrix-cell.mjs",
  "scripts/verify-release-matrix.mjs",
  "scripts/statistical-evidence-validation.mjs",
  "scripts/verify-statistical-evidence.mjs",
  "core/schemas/common.schema.json",
  "core/schemas/release/release-matrix-result.schema.json",
  "core/schemas/release/statistical-corpus.schema.json",
  "core/schemas/release/statistical-manifest.schema.json",
  "core/schemas/release/statistical-profile.schema.json",
  "core/schemas/release/statistical-capture.schema.json",
  "core/schemas/release/statistical-report.schema.json",
  "distribution/release/statistical/corpus.json",
  "distribution/release/statistical/prompt-manifest.json",
  "distribution/release/statistical/tool-manifest.json"
]);
export const protectedHarnessScripts = Object.freeze(["test", "check:governance", "test:governance", "test:release-evaluation", "check:release-evidence", "check:statistical-evidence"]);
const reservedContexts = Object.freeze([
  Object.freeze({ name: "Candidate tests", workflow: "candidate-tests.yml" }),
  Object.freeze({ name: "Release matrix", workflow: "release-matrix.yml" })
]);

function inspectReservedContexts(content, entryName) {
  const failures = [];
  const document = YAML.parseDocument(content, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length) return [`candidate workflow cannot be parsed safely: ${entryName}: ${document.errors[0].message}`];
  const workflow = document.toJS({ maxAliasCount: 100 });
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) return [`candidate workflow is not a mapping: ${entryName}`];
  const isProtectedOwner = reservedContexts.some(({ workflow: owner }) => entryName === owner);
  if (!isProtectedOwner && workflow.jobs && typeof workflow.jobs === "object" && !Array.isArray(workflow.jobs)) for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (job && typeof job === "object" && !Array.isArray(job) && typeof job.name === "string" && job.name.includes("${{")) {
      failures.push(`dynamic job name is forbidden outside a protected workflow: ${entryName}#${jobId}`);
    }
  }
  for (const reserved of reservedContexts) {
    if (entryName === reserved.workflow) continue;
    if (workflow.name === reserved.name) failures.push(`reserved check name "${reserved.name}" appears in another workflow: ${entryName}`);
    if (!workflow.jobs || typeof workflow.jobs !== "object" || Array.isArray(workflow.jobs)) continue;
    for (const [jobId, job] of Object.entries(workflow.jobs)) {
      if (!job || typeof job !== "object" || Array.isArray(job) || typeof job.name !== "string") continue;
      if (job.name === reserved.name) failures.push(`reserved check name "${reserved.name}" appears in another workflow: ${entryName}#${jobId}`);
    }
  }
  return failures;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function validateAgainstSchema(document, schema) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  const valid = validate(document);
  return valid ? [] : (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`);
}

export async function validateJsonFile(documentPath, schemaPath) {
  const [document, schema] = await Promise.all([readJson(documentPath), readJson(schemaPath)]);
  return { document, failures: validateAgainstSchema(document, schema) };
}

export async function validateEvidencePaths(traceability, repositoryRoot = process.cwd()) {
  const failures = [];
  const canonicalRoot = await realpath(repositoryRoot);
  for (const requirement of traceability.requirements ?? []) {
    for (const kind of ["implementation", "tests"]) {
      for (const path of requirement.evidence?.[kind] ?? []) {
        const resolvedPath = resolve(repositoryRoot, path);
        const relativePath = relative(repositoryRoot, resolvedPath);
        if (isAbsolute(path) || relativePath.startsWith("..") || isAbsolute(relativePath)) {
          failures.push(`${requirement.id}: evidence.${kind} path must stay within the repository: ${path}`);
          continue;
        }
        try {
          const metadata = await lstat(resolvedPath);
          if (metadata.isSymbolicLink() || !metadata.isFile()) {
            failures.push(`${requirement.id}: evidence.${kind} path must be a regular file: ${path}`);
            continue;
          }
          const canonicalPath = await realpath(resolvedPath);
          const canonicalRelative = relative(canonicalRoot, canonicalPath);
          if (canonicalRelative.startsWith("..") || isAbsolute(canonicalRelative)) {
            failures.push(`${requirement.id}: evidence.${kind} path must stay within the repository: ${path}`);
            continue;
          }
          execFileSync("git", ["ls-files", "--error-unmatch", "--", relativePath], {
            cwd: repositoryRoot,
            stdio: "ignore"
          });
        } catch {
          failures.push(`${requirement.id}: evidence.${kind} path must be a tracked repository file: ${path}`);
        }
      }
    }
  }
  return failures;
}

export async function validateHarnessIntegrity(candidateRoot, trustedRoot) {
  if (!trustedRoot) return [];
  const failures = [];
  for (const path of protectedHarnessFiles) {
    try {
      let trusted;
      try { trusted = await readFile(resolve(trustedRoot, path), "utf8"); }
      catch (error) {
        // A newly introduced gate is reviewed in its introducing PR. Once it
        // exists in the trusted base, every later candidate must match it.
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      const candidate = await readFile(resolve(candidateRoot, path), "utf8");
      if (candidate !== trusted) failures.push(`protected harness file differs from trusted base: ${path}`);
    } catch (error) {
      failures.push(`protected harness file cannot be compared: ${path}: ${error.message}`);
    }
  }

  try {
    const [candidatePackage, trustedPackage] = await Promise.all([
      readJson(resolve(candidateRoot, "package.json")),
      readJson(resolve(trustedRoot, "package.json"))
    ]);
    for (const script of protectedHarnessScripts) {
      if (candidatePackage.scripts?.[script] !== trustedPackage.scripts?.[script]) {
        failures.push(`protected npm script differs from trusted base: ${script}`);
      }
    }
  } catch (error) {
    failures.push(`protected npm scripts cannot be compared: ${error.message}`);
  }

  try {
    const workflowDirectory = resolve(candidateRoot, ".github/workflows");
    for (const entry of await readdir(workflowDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.ya?ml$/u.test(entry.name)) continue;
      const content = await readFile(resolve(workflowDirectory, entry.name), "utf8");
      failures.push(...inspectReservedContexts(content, entry.name));
    }
  } catch (error) {
    failures.push(`candidate workflow names cannot be inspected: ${error.message}`);
  }

  return failures;
}
