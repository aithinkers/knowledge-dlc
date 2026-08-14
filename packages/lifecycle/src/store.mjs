import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { invalid } from "./errors.mjs";

export const sha256Token = (content) => `sha256:${createHash("sha256").update(content).digest("hex")}`;

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

  async ensureDir(relativePath) { await mkdir(this.path(relativePath), { recursive: true }); }
  async exists(relativePath) { try { await stat(this.path(relativePath)); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
  async readText(relativePath) { return readFile(this.path(relativePath), "utf8"); }
  async readJson(relativePath) { return JSON.parse(await this.readText(relativePath)); }
  async tokenOf(relativePath) { return this.exists(relativePath) ? this.token(await this.readText(relativePath)) : null; }

  async writeTextAtomic(relativePath, content) {
    const target = this.path(relativePath);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    try { await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }

  async writeJsonAtomic(relativePath, value) { await this.writeTextAtomic(relativePath, `${JSON.stringify(value, null, 2)}\n`); }
  async appendExclusive(relativePath, content) {
    const target = this.path(relativePath);
    await mkdir(dirname(target), { recursive: true });
    const handle = await open(target, "a", 0o600);
    try { await handle.write(content); await handle.sync(); } finally { await handle.close(); }
  }
  async remove(relativePath) { await rm(this.path(relativePath), { force: true }); }
  async createDirectoryExclusive(relativePath) {
    const target = this.path(relativePath);
    await mkdir(dirname(target), { recursive: true });
    await mkdir(target);
  }
  async removeDirectory(relativePath) { await rmdir(this.path(relativePath)); }
}

export function jsonEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
