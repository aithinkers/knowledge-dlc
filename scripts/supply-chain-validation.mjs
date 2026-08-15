import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { gunzipSync } from "node:zlib";

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
  const noFollow = Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : 0;
  const canonicalRoot = await realpath(root); const target = resolve(canonicalRoot, relativePath);
  if (!inside(canonicalRoot, target)) throw new Error("trusted file path escapes its root");
  const beforeParents = await parentIdentity(canonicalRoot, target);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | noFollow);
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

export function normalizeNpmPackPath(path) {
  if (typeof path !== "string" || !path) throw new Error("npm pack path is invalid");
  return path.replaceAll("\\", "/");
}

export function npmCommandInvocation({ platform = process.platform, environment = process.env, node = process.execPath } = {}) {
  if (platform !== "win32") return { command: "npm", prefix: [] };
  const cli = environment.KDLC_NPM_CLI ?? environment.npm_execpath;
  if (typeof cli !== "string" || !win32.isAbsolute(cli) || !/[\\/]npm-cli\.js$/iu.test(cli)) throw new Error("trusted Windows npm CLI path is unavailable");
  return { command: node, prefix: [cli] };
}

export async function inspectPackageArchive(archive) {
  const bytes = gunzipSync(await readFile(archive), { maxOutputLength: 128 * 1024 * 1024 }); const entries = []; const identities = new Set(); let offset = 0; let ended = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512); if (header.every((value) => value === 0)) { ended = true; break; }
    if (entries.length >= 512) throw new Error("package archive entry count exceeds the trusted ceiling");
    const storedChecksum = Number.parseInt(header.subarray(148, 156).toString("ascii").replace(/\0.*$/u, "").trim(), 8); let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (!Number.isSafeInteger(storedChecksum) || storedChecksum !== checksum) throw new Error("package archive header checksum is invalid");
    const field = (start, end) => header.subarray(start, end).toString("utf8").replace(/\0.*$/u, ""); const name = `${field(345, 500) ? `${field(345, 500)}/` : ""}${field(0, 100)}`; const size = Number.parseInt(field(124, 136).trim() || "0", 8); const type = header[156];
    if (type !== 0 && type !== 48) throw new Error("package archive links, devices, directories, and extended headers are forbidden");
    if (!Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024) throw new Error("package archive entry size exceeds the trusted ceiling");
    if (!name.startsWith("package/") || name.includes("\\") || name.startsWith("/") || name.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("package archive path is outside the exact package namespace");
    const path = name.slice("package/".length); const identity = path.normalize("NFC").toLocaleLowerCase("en-US"); if (identities.has(identity)) throw new Error("package archive contains a duplicate or aliased path"); identities.add(identity);
    const start = offset + 512; const end = start + size; if (end > bytes.length) throw new Error("package archive entry is truncated"); const content = bytes.subarray(start, end);
    entries.push({ path, size, sha256: createHash("sha256").update(content).digest("hex") }); offset = start + Math.ceil(size / 512) * 512;
  }
  if (!ended || entries.length === 0) throw new Error("package archive is missing a bounded end marker or content"); entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return { content_sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"), file_count: entries.length };
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
