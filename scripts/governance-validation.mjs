import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";

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
  const protectedFiles = [".github/workflows/candidate-tests.yml"];
  for (const path of protectedFiles) {
    try {
      const [candidate, trusted] = await Promise.all([
        readFile(resolve(candidateRoot, path), "utf8"),
        readFile(resolve(trustedRoot, path), "utf8")
      ]);
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
    for (const script of ["test", "check:governance", "test:governance"]) {
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
      if (!entry.isFile() || entry.name === "candidate-tests.yml") continue;
      const content = await readFile(resolve(workflowDirectory, entry.name), "utf8");
      if (/^\s*name:\s*(['"]?)Candidate tests\1\s*$/m.test(content)) {
        failures.push(`reserved check name "Candidate tests" appears in another workflow: ${entry.name}`);
      }
    }
  } catch (error) {
    failures.push(`candidate workflow names cannot be inspected: ${error.message}`);
  }

  return failures;
}
