#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const OKF_REFERENCE = Object.freeze({
  version: "0.2",
  revision: "3fcbb9f828c2f23d109c855ee403c3a4c81f3a96",
  source: "https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/3fcbb9f828c2f23d109c855ee403c3a4c81f3a96/okf/SPEC.md",
  sha256: "5a3311d270bebb16d558010e75064f5b75323f284992641732b1c8097511f948"
});

export async function verifyOkfReference(root = process.cwd()) {
  const directory = resolve(root, "core/schemas/okf-0.2");
  const [bytes, metadataText] = await Promise.all([
    readFile(resolve(directory, "SPEC.md")),
    readFile(resolve(directory, "reference.json"), "utf8")
  ]);
  const metadata = JSON.parse(metadataText);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const failures = [];
  for (const field of ["version", "revision", "source", "sha256"]) {
    if (metadata[field] !== OKF_REFERENCE[field]) failures.push(`OKF metadata ${field} does not match the specification pin`);
  }
  if (digest !== OKF_REFERENCE.sha256) failures.push(`OKF reference hash mismatch: expected ${OKF_REFERENCE.sha256}, received ${digest}`);
  return { valid: failures.length === 0, digest, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await verifyOkfReference();
  if (!result.valid) {
    console.error(result.failures.map((failure) => `ERROR: ${failure}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`OKF ${OKF_REFERENCE.version} reference verified at ${OKF_REFERENCE.revision} (${result.digest}).`);
  }
}
