import { lstat, mkdir, open, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { byteHash } from "../../core/index.mjs";
import { invalid } from "./errors.mjs";

export const sha256Token = byteHash;

export class NodeFileStore {
  constructor(root, { token = sha256Token } = {}) {
    this.root = resolve(root);
    this.token = token;
  }

  path(relativePath) {
    if (isAbsolute(relativePath)) throw invalid("Storage path must be relative");
    const target = resolve(this.root, relativePath);
    const rel = relative(this.root, target);
    if (rel.startsWith("..") || isAbsolute(rel)) throw invalid("Storage path escapes configured root");
    return target;
  }

  async safePath(relativePath) {
    this.path(relativePath);
    const canonicalRoot = await realpath(this.root);
    const target = resolve(canonicalRoot, relativePath);
    const rel = relative(canonicalRoot, target);
    let current = canonicalRoot;
    for (const segment of rel.split(sep).slice(0, -1).filter(Boolean)) {
      current = resolve(current, segment);
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw invalid("Storage path crosses an unsafe parent");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    try {
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink()) throw invalid("Storage target must not be a symlink");
      const canonical = await realpath(target);
      const canonicalRel = relative(canonicalRoot, canonical);
      if (canonicalRel === ".." || canonicalRel.startsWith(`..${sep}`) || isAbsolute(canonicalRel)) throw invalid("Storage target escapes configured root");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return target;
  }

  async ensureDir(relativePath) { await mkdir(await this.safePath(relativePath), { recursive: true }); }
  async exists(relativePath) { try { await stat(await this.safePath(relativePath)); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
  async readText(relativePath) { return readFile(await this.safePath(relativePath), "utf8"); }
  async readJson(relativePath) { return JSON.parse(await this.readText(relativePath)); }
  async tokenOf(relativePath) { return this.exists(relativePath) ? this.token(await this.readText(relativePath)) : null; }

  async writeTextAtomic(relativePath, content) {
    const target = await this.safePath(relativePath);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    try { await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }

  async writeJsonAtomic(relativePath, value) { await this.writeTextAtomic(relativePath, `${JSON.stringify(value, null, 2)}\n`); }
  async appendExclusive(relativePath, content) {
    const target = await this.safePath(relativePath);
    await mkdir(dirname(target), { recursive: true });
    const handle = await open(target, "a", 0o600);
    try { await handle.write(content); await handle.sync(); } finally { await handle.close(); }
  }
  async remove(relativePath) { await rm(await this.safePath(relativePath), { force: true }); }
  async createDirectoryExclusive(relativePath) {
    const target = await this.safePath(relativePath);
    await mkdir(dirname(target), { recursive: true });
    await mkdir(target);
  }
  async removeDirectory(relativePath) { await rmdir(await this.safePath(relativePath)); }
}

export function jsonEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
