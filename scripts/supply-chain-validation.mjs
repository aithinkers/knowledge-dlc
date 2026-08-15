import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function parentIdentity(root, target) {
  const values = []; let current = dirname(target);
  while (inside(root, current)) {
    const metadata = await lstat(current); const canonical = await realpath(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || !inside(root, canonical)) throw new Error("trusted file parent ancestry is invalid");
    const canonicalMetadata = await lstat(canonical);
    if (!canonicalMetadata.isDirectory() || canonicalMetadata.dev !== metadata.dev || canonicalMetadata.ino !== metadata.ino) throw new Error("trusted file parent identity changed");
    values.push([current, metadata.dev, metadata.ino, canonical]);
    if (current === root) break;
    current = dirname(current);
  }
  if (values.at(-1)?.[0] !== root) throw new Error("trusted file parent escapes its root");
  return values;
}

export async function readTrustedFile(root, relativePath, { afterOpen } = {}) {
  if (typeof relativePath !== "string" || !relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/u).some((part) => !part || part === "." || part === "..")) throw new Error("trusted file path is invalid");
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error("this platform cannot enforce no-follow package reads");
  const canonicalRoot = await realpath(root); const target = resolve(canonicalRoot, relativePath);
  if (!inside(canonicalRoot, target)) throw new Error("trusted file path escapes its root");
  const beforeParents = await parentIdentity(canonicalRoot, target);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("trusted file is not regular");
    if (afterOpen) await afterOpen({ target, fd: handle.fd });
    const content = await handle.readFile();
    const current = await lstat(target); const afterParents = await parentIdentity(canonicalRoot, target);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino || JSON.stringify(afterParents) !== JSON.stringify(beforeParents)) throw new Error("trusted file identity changed while open");
    return content;
  } finally {
    await handle?.close();
  }
}

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
