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
    this.mutation = new AsyncLocalStorage();
    this.behavior = undefined;
  }

  processIsAlive(processId) {
    if (!Number.isSafeInteger(processId) || processId <= 0) return null;
    try { process.kill(processId, 0); return true; }
    catch (error) { if (error?.code === "ESRCH") return false; return null; }
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
    const fences = this.fence.getStore() ?? [];
    for (const fence of fences) {
      let content;
      try { content = await readFile(this.path(fence.leasePath), "utf8"); }
      catch (error) { if (error?.code === "ENOENT") throw conflict("Filesystem mutex lease was lost"); throw error; }
      if (JSON.parse(content).lease_id !== fence.leaseId) {
        throw conflict("Filesystem mutex lease was lost");
      }
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
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const metadata = await lstat(target);
        if (metadata.isSymbolicLink()) throw invalid("Storage target must not be a symlink");
        const canonical = await realpath(target);
        const canonicalRel = relative(canonicalRoot, canonical);
        if (canonicalRel !== ".." && !canonicalRel.startsWith(`..${sep}`) && !isAbsolute(canonicalRel)) break;
        const observed = await lstat(target);
        if (observed.isSymbolicLink()) throw invalid("Storage target must not be a symlink");
        // A mutex contender may rename the inspected directory for stale
        // recovery and create a successor at the same lexical path. Retry only
        // when that exact identity changed; a stable outside identity remains
        // a containment violation and always fails closed.
        if (metadata.dev !== observed.dev || metadata.ino !== observed.ino) {
          if (attempt < 2) continue;
          throw Object.assign(new Error("Storage target identity changed during containment validation"), { code: "EBADF" });
        }
        throw invalid("Storage target escapes configured root");
      }
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

  async mutationNamespace(relativePath) {
    const configurationPath = ".kdlc/governed-mutation-namespace.json";
    let configuration;
    try { configuration = JSON.parse(await readFile(await this.safePath(configurationPath), "utf8")); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
    if (configuration?.api_version !== "kdlc.dev/governed-mutation-namespace/v1" ||
      !Array.isArray(configuration.roots) || !configuration.roots.length ||
      typeof configuration.lock_path !== "string" || typeof configuration.generation_path !== "string")
      throw invalid("Governed mutation namespace is invalid");
    const identity = await this.identity(relativePath);
    return configuration.roots.some((root) => identity === root || identity.startsWith(`${root}/`)) ? configuration : null;
  }

  async #writeTextAtomic(relativePath, content) {
    await this.assertFence();
    const target = await this.safePath(relativePath);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    try { await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 }); await this.assertFence(); await this.replaceAtomic(temporary, target); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }

  async #remove(relativePath) { await this.assertFence(); await rm(await this.safePath(relativePath), { force: true }); }

  async #governedMutation(relativePath, action, before = async () => {}) {
    const namespace = await this.mutationNamespace(relativePath);
    const activeMutation = this.mutation.getStore();
    if (!namespace || (activeMutation?.lock === namespace.lock_path && activeMutation.path === relativePath)) { await before(); return action(); }
    const clock = { now: () => new Date().toISOString(), millis: () => Date.now() };
    return this.withMutex(namespace.lock_path, { owner: `mutation:${process.pid}:${Math.random().toString(16).slice(2)}`, clock, timeoutMs: 250 }, async () => {
      await before();
      const current = await this.mutationGeneration(namespace);
      const begun = current % 2 === 0 ? current + 1 : current + 2;
      await this.#writeTextAtomic(namespace.generation_path, `${JSON.stringify({ generation: begun }, null, 2)}\n`);
      const result = await this.mutation.run({ lock: namespace.lock_path, path: relativePath }, action);
      await this.#writeTextAtomic(namespace.generation_path, `${JSON.stringify({ generation: begun + 1 }, null, 2)}\n`);
      return result;
    });
  }

  async writeTextAtomic(relativePath, content) { return this.#governedMutation(relativePath, () => this.#writeTextAtomic(relativePath, content)); }
  async mutateGoverned(relativePath, before, action) {
    if (typeof before !== "function" || typeof action !== "function") throw invalid("Governed mutation requires precondition and action functions");
    return this.#governedMutation(relativePath, action, before);
  }

  async #replaceAtomic(source, target) { await rename(source, target); }
  async replaceAtomic(source, target) {
    const relativeTarget = relative(await realpath(this.root), target).split(sep).join("/");
    return this.#governedMutation(relativeTarget, () => this.#replaceAtomic(source, target));
  }

  async writeJsonAtomic(relativePath, value) { await this.writeTextAtomic(relativePath, `${JSON.stringify(value, null, 2)}\n`); }
  async #appendExclusive(relativePath, content) {
    await this.assertFence();
    const target = await this.safePath(relativePath);
    await mkdir(dirname(target), { recursive: true });
    const handle = await open(target, "a", 0o600);
    try { await this.assertFence(); await handle.write(content); await handle.sync(); } finally { await handle.close(); }
  }
  async appendExclusive(relativePath, content) { return this.#governedMutation(relativePath, () => this.#appendExclusive(relativePath, content)); }
  async remove(relativePath) { return this.#governedMutation(relativePath, () => this.#remove(relativePath)); }

  async mutationGeneration(namespace) {
    if (!(await this.exists(namespace.generation_path))) return 0;
    const value = await this.readJson(namespace.generation_path);
    if (!Number.isSafeInteger(value?.generation) || value.generation < 0) throw invalid("Governed mutation generation is invalid");
    return value.generation;
  }

  async withMutationNamespace({ owner, clock }, action) {
    const configurationPath = ".kdlc/governed-mutation-namespace.json";
    if (!(await this.exists(configurationPath))) throw invalid("Governed mutation namespace is not configured");
    const namespace = await this.readJson(configurationPath);
    return this.withMutex(namespace.lock_path, { owner, clock }, () => this.mutation.run({ lock: namespace.lock_path, path: null }, action));
  }
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

  async markMutexReleased(relativePath, leaseId, _owner) {
    const marker = await this.safePath(this.releaseMarker(relativePath, leaseId));
    await mkdir(dirname(marker), { recursive: true });
    try { await writeFile(marker, "", { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
  }

  async withMutex(relativePath, { owner, clock, leaseMs = 30_000, timeoutMs = 10_000, retryMs = 2 }, action) {
    if (!owner || !clock?.millis) throw invalid("Filesystem mutex requires owner and clock");
    try {
      const rootMetadata = await stat(this.root);
      if (!rootMetadata.isDirectory()) throw invalid("Filesystem mutex root must be a directory");
      await realpath(this.root);
    } catch (error) {
      if (error?.code === "ENOENT") throw invalid("Filesystem mutex root does not exist");
      throw error;
    }
    const started = Date.now();
    const leasePath = `${relativePath}/owner.json`;
    let acquiredLease;
    while (true) {
      try {
        await this.createDirectoryExclusive(relativePath);
        acquiredLease = { owner, process_id: process.pid, lease_id: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`, acquired_at: clock.now(), expires_at: new Date(clock.millis() + leaseMs).toISOString() };
        await this.writeJsonAtomic(leasePath, acquiredLease);
        break;
      } catch (error) {
        // Windows may report EBADF when a contending stale-recovery rename
        // wins between safe-path inspection and realpath. No mutation has
        // occurred in this contender, so retry exactly as for ENOENT.
        if (["ENOENT", "EBADF"].includes(error?.code)) continue;
        if (error?.code !== "EEXIST") throw error;
        let stale = false;
        let staleToken = null;
        if (await this.exists(leasePath)) {
          try {
            const firstToken = await this.tokenOf(leasePath);
            const record = await this.readJson(leasePath);
            const secondToken = await this.tokenOf(leasePath);
            const released = firstToken === secondToken && await this.exists(this.releaseMarker(relativePath, record.lease_id));
            const dead = this.processIsAlive(record.process_id) === false;
            stale = firstToken === secondToken && (released || (Date.parse(record.expires_at) <= clock.millis() && dead));
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
          // Hash the owner: it embeds the resource name, and appending it
          // verbatim can overflow the filename component limit (#146).
          const recovery = `${relativePath}.recovery-${this.token(owner).slice(7, 39)}`;
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
            continue;
          } catch (recoveryError) {
            // Windows can transiently refuse a directory rename while another
            // contender is closing a handle beneath it. Treat that as ordinary
            // contention and retry; the claim and owner-token checks still
            // fence stale recovery before a later rename can succeed.
            if (!["ENOENT", "EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(recoveryError?.code)) throw recoveryError;
          } finally {
            if (ownsClaim) await rm(await this.safePath(claimPath), { force: true }).catch(() => {});
          }
        }
        if (Date.now() - started >= timeoutMs) throw conflict(`Filesystem mutex timed out: ${relativePath}`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, retryMs));
      }
    }
    const acquiredLeaseId = acquiredLease.lease_id;
    let releaseOwned = false;
    let heartbeatStopped = false;
    let wakeHeartbeat;
    const heartbeat = async () => {
      while (!heartbeatStopped) {
        await new Promise((resolveDelay) => {
          const timer = setTimeout(resolveDelay, Math.max(1, Math.floor(leaseMs / 3)));
          wakeHeartbeat = () => { clearTimeout(timer); resolveDelay(); };
        });
        wakeHeartbeat = undefined;
        if (heartbeatStopped) break;
        try {
          const current = await this.readJson(leasePath);
          if (current.lease_id !== acquiredLeaseId) break;
          current.expires_at = new Date(clock.millis() + leaseMs).toISOString();
          const target = await this.safePath(leasePath);
          const temporary = `${target}.heartbeat-${process.pid}-${Math.random().toString(16).slice(2)}`;
          try {
            await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { flag: "wx", mode: 0o600 });
            for (let attempt = 0; ; attempt += 1) {
              try { await this.replaceAtomic(temporary, target); break; }
              catch (replaceError) {
                if (!["EPERM", "EACCES"].includes(replaceError?.code) || process.platform !== "win32" || attempt >= 20) throw replaceError;
                // Windows may briefly deny replacement while a contender has
                // owner.json open. Re-check the exact lease before every retry;
                // a reclaimed directory moves the temporary file with it, so
                // this cannot overwrite a successor lease in a new directory.
                const observed = await this.readJson(leasePath);
                if (observed.lease_id !== acquiredLeaseId) throw conflict("Filesystem mutex lease was lost");
                await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
              }
            }
          }
          finally { await rm(temporary, { force: true }).catch(() => {}); }
        } catch (error) { if (error?.code !== "ENOENT") throw error; break; }
      }
    };
    const heartbeatTask = heartbeat();
    try {
      const enclosingFences = this.fence.getStore() ?? [];
      return await this.fence.run([...enclosingFences, { leasePath, leaseId: acquiredLeaseId, clock }], async () => {
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
      heartbeatStopped = true;
      wakeHeartbeat?.();
      await heartbeatTask;
      if (releaseOwned) await this.markMutexReleased(relativePath, acquiredLeaseId, owner);
    }
  }
}

export function jsonEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
