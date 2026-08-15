import { createHash } from "node:crypto";

export function exactPackageManifestFailures(actual, expected) {
  const normalize = (values) => [...new Set(values)].sort();
  const actualPaths = normalize(actual);
  const expectedPaths = normalize(expected);
  const expectedSet = new Set(expectedPaths);
  const actualSet = new Set(actualPaths);
  return [
    ...actualPaths.filter((path) => !expectedSet.has(path)).map((path) => `unexpected emitted package file: ${path}`),
    ...expectedPaths.filter((path) => !actualSet.has(path)).map((path) => `missing emitted package file: ${path}`)
  ];
}

export function installedMetadataFailures({ identity, entry, metadata, allowedLicenses }) {
  const failures = [];
  if (metadata.name !== identity.name || metadata.version !== entry.version) failures.push(`installed identity differs from lock: ${identity.name}@${entry.version}`);
  if (typeof metadata.license !== "string" || !allowedLicenses.includes(metadata.license)) failures.push(`installed license is not allowlisted: ${identity.name}@${entry.version} (${metadata.license ?? "missing"})`);
  return failures;
}

export function installedTreeHash(entries) {
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry?.path !== "string" || !entry.path || entry.path.startsWith("/") || entry.path.split("/").includes("..")
    || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? "") || !Number.isSafeInteger(entry.size) || entry.size < 0)) throw new Error("installed package tree entries are invalid");
  const normalized = [...entries].sort((left, right) => left.path.localeCompare(right.path, "en"));
  if (new Set(normalized.map(({ path }) => path)).size !== normalized.length) throw new Error("installed package tree paths are not unique");
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
