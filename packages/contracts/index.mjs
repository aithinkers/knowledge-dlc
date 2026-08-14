import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const CONTRACT_SCHEMA_PATHS = Object.freeze({
  common: "core/schemas/common.schema.json",
  project: "core/schemas/manifests/project.schema.json",
  knowledgeBase: "core/schemas/manifests/knowledge-base.schema.json",
  knowledgeLock: "core/schemas/manifests/knowledge-lock.schema.json",
  sourceRecord: "core/schemas/manifests/source-record.schema.json",
  conceptExtensions: "core/schemas/artifacts/concept-extensions.schema.json",
  claim: "core/schemas/artifacts/claim.schema.json",
  claimSidecarEntry: "core/schemas/artifacts/claim-sidecar-entry.schema.json",
  reviewPacket: "core/schemas/artifacts/review-packet.schema.json",
  reviewReceipt: "core/schemas/artifacts/review-receipt.schema.json"
});

export async function loadContractSchemas(root = moduleRoot) {
  return Promise.all(Object.entries(CONTRACT_SCHEMA_PATHS).map(async ([name, relativePath]) => {
    const schema = JSON.parse(await readFile(resolve(root, relativePath), "utf8"));
    return { name, relativePath, schema };
  }));
}

export async function createContractValidator(root = moduleRoot) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
  const schemas = await loadContractSchemas(root);
  for (const { schema } of schemas) ajv.addSchema(schema);

  const validators = Object.fromEntries(schemas
    .filter(({ name }) => name !== "common")
    .map(({ name, schema }) => [name, ajv.getSchema(schema.$id)]));

  return {
    schemas,
    validate(name, value) {
      const validate = validators[name];
      if (!validate) throw new TypeError(`unknown K-DLC contract: ${name}`);
      const valid = validate(value);
      return {
        valid,
        errors: valid ? [] : (validate.errors ?? []).map(({ instancePath, keyword, message, params }) => ({
          instancePath,
          keyword,
          message,
          params
        }))
      };
    }
  };
}

export function validateProjectSemantics(project) {
  const failures = [];
  const mounts = Array.isArray(project?.knowledge_bases) ? project.knowledge_bases : [];
  const byName = new Map();
  for (const mount of mounts) {
    if (byName.has(mount.name)) failures.push(`duplicate mount name: ${mount.name}`);
    byName.set(mount.name, mount);
  }

  const durableModes = new Set(["draft", "maintain", "publish"]);
  const durableWrites = mounts.some(({ mode }) => durableModes.has(mode));
  const primary = mounts.filter(({ role }) => role === "primary");
  if (durableWrites && primary.length !== 1) {
    failures.push("a write-enabled project must declare exactly one primary mount");
  }
  if (!durableWrites && primary.length > 1) {
    failures.push("a project may declare no more than one primary mount");
  }

  const defaultTarget = project?.routing?.default_write_target;
  if (defaultTarget) {
    const target = byName.get(defaultTarget);
    if (!target) failures.push(`default write target does not name a mount: ${defaultTarget}`);
    else if (target.role !== "primary") failures.push("default write target must identify the primary mount");
  }
  for (const [type, targetName] of Object.entries(project?.routing?.by_type ?? {})) {
    if (!byName.has(targetName)) failures.push(`routing target for ${type} does not name a mount: ${targetName}`);
  }
  if (project?.workflow?.approval_policy === "risk-based" && Object.keys(project?.policies ?? {}).length === 0) {
    failures.push("risk-based approval requires an explicitly resolved policy");
  }
  return failures;
}

export function validateResolvedMountIds(mounts) {
  const failures = [];
  const ids = new Map();
  for (const { alias, id } of mounts) {
    if (ids.has(id)) failures.push(`duplicate knowledge-base id ${id}: ${ids.get(id)} and ${alias}`);
    else ids.set(id, alias);
  }
  return failures;
}
