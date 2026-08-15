import { chmod, copyFile, lstat, mkdir, opendir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { artifactHash, byteHash } from "../../core/index.mjs";
import { federationFail } from "./errors.mjs";

const IGNORED_ROOTS = new Set([".git", ".kdlc"]);

function portable(root, path) {
  const value = relative(root, path).split(sep).join("/").normalize("NFC");
  if (!value || value === ".." || value.startsWith("../") || value.includes("\0")) {
    federationFail("KDLC_FEDERATION_PATH", "A materialized path escapes its knowledge-base root");
  }
  return value;
}

export async function describeTree(root, { maxFiles = 100_000, maxBytes = 1024 * 1024 * 1024, maxFileBytes = 64 * 1024 * 1024 } = {}) {
  const canonicalRoot = resolve(root);
  const entries = []; const identities = new Set(); let totalBytes = 0;
  async function visit(directory, depth = 0) {
    if (depth > 128) federationFail("KDLC_FEDERATION_TREE_DEPTH", "Knowledge-base tree exceeds the traversal depth limit");
    const handle = await opendir(directory);
    const children = [];
    for await (const entry of handle) children.push(entry);
    children.sort((left, right) => left.name.normalize("NFC") < right.name.normalize("NFC") ? -1 : left.name.normalize("NFC") > right.name.normalize("NFC") ? 1 : 0);
    for (const entry of children) {
      if (depth === 0 && IGNORED_ROOTS.has(entry.name)) continue;
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) federationFail("KDLC_FEDERATION_SYMLINK", `Knowledge-base snapshots reject symlinks: ${portable(canonicalRoot, path)}`);
      if (metadata.isDirectory()) await visit(path, depth + 1);
      else if (metadata.isFile()) {
        const name = portable(canonicalRoot, path);
        if (identities.has(name)) federationFail("KDLC_FEDERATION_PATH_COLLISION", `Duplicate canonical path: ${name}`);
        identities.add(name);
        if (entries.length >= maxFiles || metadata.size > maxFileBytes || totalBytes + metadata.size > maxBytes) {
          federationFail("KDLC_FEDERATION_TREE_LIMIT", "Knowledge-base snapshot exceeds its file or byte limit");
        }
        totalBytes += metadata.size;
        entries.push(Object.freeze({ path: name, mode: metadata.mode & 0o111 ? "executable" : "regular", hash: byteHash(await readFile(path)) }));
      } else federationFail("KDLC_FEDERATION_FILE_TYPE", `Unsupported file type in knowledge base: ${portable(canonicalRoot, path)}`);
    }
  }
  await visit(canonicalRoot);
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return Object.freeze({ entries: Object.freeze(entries), tree_hash: artifactHash({ version: 1, entries }) });
}

export async function copyVerifiedTree(source, destination, expected) {
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const directories = new Set([destination]);
  for (const entry of expected.entries) {
    const from = resolve(source, entry.path);
    const to = resolve(destination, entry.path);
    if (!from.startsWith(`${resolve(source)}${sep}`) || !to.startsWith(`${resolve(destination)}${sep}`)) {
      federationFail("KDLC_FEDERATION_PATH", "Snapshot copy path escaped its root");
    }
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    let parent = dirname(to);
    while (parent !== destination && parent.startsWith(`${destination}${sep}`)) { directories.add(parent); parent = dirname(parent); }
    await copyFile(from, to);
    await chmod(to, entry.mode === "executable" ? 0o555 : 0o444);
  }
  const actual = await describeTree(destination);
  if (actual.tree_hash !== expected.tree_hash) federationFail("KDLC_FEDERATION_TREE_DRIFT", "Materialized tree differs from its verified source");
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) await chmod(directory, 0o555);
  return actual;
}
