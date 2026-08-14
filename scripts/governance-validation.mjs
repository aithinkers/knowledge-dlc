import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";

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

export async function validateEvidencePaths(traceability) {
  const failures = [];
  for (const requirement of traceability.requirements ?? []) {
    for (const kind of ["implementation", "tests"]) {
      for (const path of requirement.evidence?.[kind] ?? []) {
        try {
          await access(path, constants.R_OK);
        } catch {
          failures.push(`${requirement.id}: evidence.${kind} path does not exist: ${path}`);
        }
      }
    }
  }
  return failures;
}
