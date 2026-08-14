import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, mkdir, open, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { byteHash } from "../../core/index.mjs";
import { conflict, invalid } from "./errors.mjs";

export const sha256Token = byteHash;

export class NodeFileStore {
  constructor(root, { token = sha256Token } = {}) {
    this.root = resolve(root);
    this.token = token;
    this.fence = new AsyncLocalStorage();
    this.behavior = undefined;
  }

  path(relativePath) {
    if (isAbsolute(relativePath)) throw invalid("Storage path must be relative");
    const target = resolve(this.root, relativePath);
    const rel = relative(this.root, target);
    if (rel.startsWith("..") || isAbsolute(rel)) throw invalid("Storage path escapes configured root");
    return target;
  }

  async filesystemBehavior() {
    if (!this.behavior) this.behavior = (async () => {
      const root = await realpath(this.root);
      const name = `.kdlc-fs-probe-${process.pid}-${Math.random().toString(16).slice(2)}-é-a`;
      const probe = join(root, name);
      try {
        await mkdir(probe);
        const exists = async (candidate) => { try { await lstat(candidate); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } };
        return {
          caseInsensitive: await exists(join(root, name.slice(0, -1) + "A")),
          normalizationInsensitive: await exists(join(root, name.normalize("NFD")))
        };
      } finally { await rmdir(probe).catch(() => {}); }
    })();
    return this.behavior;
  }

  async identity(relativePath) {
    const lexical = this.path(relativePath);
    const canonicalRoot = await realpath(this.root);
    const rooted = resolve(canonicalRoot, relative(this.root, lexical));
    let candidate;
    try { candidate = await realpath(rooted); }
    catch (error) { if (error?.code !== "ENOENT") throw error; candidate = rooted; }
    let identity = relative(canonicalRoot, candidate).split(sep).join("/");
    if (identity === ".." || identity.startsWith("../") || isAbsolute(identity)) throw invalid("Storage identity escapes configured root");
    const behavior = await this.filesystemBehavior();
    if (behavior.normalizationInsensitive) identity = identity.normalize("NFC");
    if (behavior.caseInsensitive) identity = identity.toLowerCase();
    return identity;
  }

  async assertFence() {
    const fence = this.fence.getStore();
    if (!fence) return;
    let content;
    try { content = await readFile(this.path(fence.leasePath), "utf8"); }
    catch (error) { if (error?.code === "ENOENT") throw conflict("Filesystem mutex lease was lost"); throw error; }
    if (this.token(content) !== fence.token || Date.parse(JSON.parse(content).expires_at) <= fence.clock.millis()) {
      throw conflict("Filesystem mutex lease was lost");
    }
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

  async ensureDir(relativePath) { await this.assertFence(); await mkdir(await this.safePath(relativePath), { recursive: true }); }
  async exists(relativePath) { try { await stat(await this.safePath(relativePath)); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
  async readText(relativePath) { return readFile(await this.safePath(relativePath), "utf8"); }
  async readJson(relativePath) { return JSON.parse(await this.readText(relativePath)); }
  async tokenOf(relativePath) { return this.exists(relativePath) ? this.token(await this.readText(relativePath)) : null; }

  async writeTextAtomic(relativePath, content) {
    await this.assertFence();
    const target = await this.safePath(relativePath);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    try { await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 }); await this.assertFence(); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }

  async writeJsonAtomic(relativePath, value) { await this.writeTextAtomic(relativePath, `${JSON.stringify(value, null, 2)}\n`); }
  async appendExclusive(relativePath, content) {
    await this.assertFence();
    const target = await this.safePath(relativePath);
    await mkdir(dirname(target), { recursive: true });
    const handle = await open(target, "a", 0o600);
    try { await this.assertFence(); await handle.write(content); await handle.sync(); } finally { await handle.close(); }
  }
  async remove(relativePath) { await this.assertFence(); await rm(await this.safePath(relativePath), { force: true }); }
  async createDirectoryExclusive(relativePath) {
    await this.assertFence();
    const target = await this.safePath(relativePath);
    await mkdir(dirname(target), { recursive: true });
    await mkdir(target);
  }
  async removeDirectory(relativePath) { await this.assertFence(); await rmdir(await this.safePath(relativePath)); }

  releaseMarker(relativePath, token) {
    return `${relativePath}.released-${encodeURIComponent(token)}`;
  }

  async markMutexReleased(relativePath, token, _owner) {
    const marker = await this.safePath(this.releaseMarker(relativePath, token));
    await mkdir(dirname(marker), { recursive: true });
    try { await writeFile(marker, "", { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
  }

  async withMutex(relativePath, { owner, clock, leaseMs = 30_000, timeoutMs = 2_000, retryMs = 2 }, action) {
    if (!owner || !clock?.millis) throw invalid("Filesystem mutex requires owner and clock");
    const started = Date.now();
    const leasePath = `${relativePath}/owner.json`;
    while (true) {
      try {
        await this.createDirectoryExclusive(relativePath);
        await this.writeJsonAtomic(leasePath, { owner, process_id: process.pid, acquired_at: clock.now(), expires_at: new Date(clock.millis() + leaseMs).toISOString() });
        break;
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        if (error?.code !== "EEXIST") throw error;
        let stale = false;
        let staleToken = null;
        if (await this.exists(leasePath)) {
          try {
            const firstToken = await this.tokenOf(leasePath);
            const record = await this.readJson(leasePath);
            const secondToken = await this.tokenOf(leasePath);
            const released = firstToken === secondToken && await this.exists(this.releaseMarker(relativePath, firstToken));
            stale = firstToken === secondToken && (released || Date.parse(record.expires_at) <= clock.millis());
            if (stale) staleToken = firstToken;
          } catch (readError) {
            if (readError?.code === "ENOENT") continue;
            throw readError;
          }
        } else {
          try {
            const metadata = await stat(await this.safePath(relativePath));
            stale = clock.millis() - metadata.mtimeMs >= leaseMs;
          } catch (metadataError) {
            if (metadataError?.code === "ENOENT") continue;
            throw metadataError;
          }
        }
        if (stale) {
          const claimPath = `${relativePath}.reclaim`;
          const recovery = `${relativePath}.recovery-${encodeURIComponent(owner)}`;
          let ownsClaim = false;
          try {
            const claim = await this.safePath(claimPath);
            try { await writeFile(claim, JSON.stringify({ owner, created_at: clock.now() }), { flag: "wx", mode: 0o600 }); ownsClaim = true; }
            catch (claimError) {
              if (claimError?.code !== "EEXIST") throw claimError;
              const claimMetadata = await stat(claim);
              if (clock.millis() - claimMetadata.mtimeMs >= leaseMs) await rm(claim, { force: true });
              continue;
            }
            const currentToken = await this.tokenOf(leasePath);
            if ((staleToken && currentToken !== staleToken) || (!staleToken && currentToken !== null)) continue;
            await rename(await this.safePath(relativePath), await this.safePath(recovery));
            if (staleToken && await this.tokenOf(`${recovery}/owner.json`) !== staleToken) {
              throw conflict("Mutex owner changed during stale reclaim");
            }
            await rm(await this.safePath(recovery), { recursive: true, force: true });
            if (staleToken) await this.remove(this.releaseMarker(relativePath, staleToken)).catch(() => {});
            continue;
          } catch (recoveryError) {
            if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes(recoveryError?.code)) throw recoveryError;
          } finally {
            if (ownsClaim) await rm(await this.safePath(claimPath), { force: true }).catch(() => {});
          }
        }
        if (Date.now() - started >= timeoutMs) throw conflict(`Filesystem mutex timed out: ${relativePath}`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, retryMs));
      }
    }
    const acquiredToken = await this.tokenOf(leasePath);
    let releaseOwned = false;
    try {
      return await this.fence.run({ leasePath, token: acquiredToken, clock }, async () => {
        try {
          const result = await action();
          await this.assertFence();
          releaseOwned = true;
          return result;
        } catch (error) {
          try { await this.assertFence(); releaseOwned = true; } catch {}
          throw error;
        }
      });
    } catch (error) {
      if (error?.code === "ENOENT") throw conflict("Coordinated resource changed while the mutex was held");
      throw error;
    }
    finally {
      if (releaseOwned) await this.markMutexReleased(relativePath, acquiredToken, owner);
    }
  }
}

export function jsonEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
