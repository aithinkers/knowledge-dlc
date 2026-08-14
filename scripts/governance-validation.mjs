import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
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
