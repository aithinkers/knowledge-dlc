import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { artifactHash, byteHash, canonicalJson, parseMarkdownConcept } from "../../core/index.mjs";
import { createContractValidator, parseAndValidateContract, validateProjectSemantics } from "../../contracts/index.mjs";
import { NodeFileStore } from "../../lifecycle/src/index.mjs";
import { federationFail } from "./errors.mjs";
import { copyVerifiedTree, describeTree } from "./tree.mjs";

const execFile = promisify(execFileCallback);
const clock = { now: () => new Date().toISOString(), millis: () => Date.now() };
const gitEnvironment = Object.freeze(Object.fromEntries([
  "PATH", "HOME", "SSH_AUTH_SOCK", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"
].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])));

function inside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function readManifest(root) {
  let bytes;
  try { bytes = await readFile(join(root, "knowledge-base.yaml")); }
  catch (error) { federationFail("KDLC_FEDERATION_MANIFEST", "Mounted base lacks knowledge-base.yaml", { cause: error.code }); }
  let checked;
  try { checked = await parseAndValidateContract("knowledgeBase", bytes.toString("utf8")); }
  catch { federationFail("KDLC_FEDERATION_MANIFEST", "Mounted knowledge-base manifest is invalid YAML"); }
  if (!checked.valid) federationFail("KDLC_FEDERATION_MANIFEST", "Mounted knowledge-base manifest violates its contract");
  const manifest = checked.value;
  const id = manifest?.metadata?.id;
  if (manifest?.kind !== "KnowledgeBase" || typeof id !== "string" || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(id)) {
    federationFail("KDLC_FEDERATION_MANIFEST", "Mounted knowledge-base manifest has no valid stable ID");
  }
  return { manifest, manifest_hash: byteHash(bytes) };
}

async function readRetrievalCatalog(root) {
  let bytes; let value;
  try { bytes = await readFile(join(root, "retrieval-catalog.json")); value = JSON.parse(bytes.toString("utf8")); }
  catch (error) { federationFail("KDLC_RETRIEVAL_CATALOG", "Mounted base lacks a valid retrieval catalog", { cause: error?.code }); }
  if (value?.version !== "kdlc-retrieval-catalog-1" || !Array.isArray(value.concepts)) federationFail("KDLC_RETRIEVAL_CATALOG", "Mounted retrieval catalog has an invalid shape");
  const ids = new Set(); const paths = new Set();
  const concepts = value.concepts.map((entry) => {
    const safePath = typeof entry?.path === "string" && entry.path.endsWith(".md") && !entry.path.startsWith("/") && !entry.path.includes("\\")
      && entry.path.split("/").every((part) => part && part !== "." && part !== "..");
    const expectedId = safePath ? entry.path.slice(0, -3) : null;
    const access = entry?.access;
    const validAccess = access && typeof access === "object" && !Array.isArray(access) && typeof access.classification === "string"
      && (access.compartments === undefined || (Array.isArray(access.compartments) && access.compartments.every((item) => typeof item === "string")))
      && (access.policy_ref === undefined || (typeof access.policy_ref === "string" && access.policy_ref.length > 0));
    if (!safePath || entry?.id !== expectedId || !/^sha256:[0-9a-f]{64}$/.test(entry?.byte_hash ?? "") || !validAccess || ids.has(entry.id) || paths.has(entry.path)) {
      federationFail("KDLC_RETRIEVAL_CATALOG", "Mounted retrieval catalog contains an invalid or duplicate concept entry");
    }
    ids.add(entry.id); paths.add(entry.path);
    return Object.freeze({ id: entry.id, path: entry.path, byte_hash: entry.byte_hash,
      access: Object.freeze({ classification: access.classification, ...(access.compartments ? { compartments: Object.freeze([...access.compartments]) } : {}),
        ...(access.policy_ref ? { policy_ref: access.policy_ref } : {}) }) });
  });
  for (const concept of concepts) {
    let conceptBytes; let parsed;
    try { conceptBytes = await readFile(join(root, concept.path)); parsed = parseMarkdownConcept(conceptBytes); }
    catch { federationFail("KDLC_RETRIEVAL_CATALOG", "Mounted retrieval catalog references invalid concept content"); }
    if (byteHash(conceptBytes) !== concept.byte_hash || canonicalJson(parsed.frontmatter.access ?? null) !== canonicalJson(concept.access)) {
      federationFail("KDLC_RETRIEVAL_CATALOG", "Mounted retrieval catalog does not bind concept bytes and access metadata");
    }
  }
  return { catalog_hash: byteHash(bytes), retrieval_catalog: Object.freeze(concepts) };
}

async function runGit(args, cwd) {
  try {
    return (await execFile("git", args, {
      cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      env: { ...gitEnvironment, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" }
    })).stdout.trim();
  } catch (error) {
    federationFail("KDLC_GIT_RESOLUTION", "Git mount resolution failed", { exit_code: error.code });
  }
}

async function runGitBytes(args, cwd) {
  try {
    return (await execFile("git", args, { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024,
      env: { ...gitEnvironment, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" } })).stdout;
  } catch (error) { federationFail("KDLC_GIT_RESOLUTION", "Git mount resolution failed", { exit_code: error.code }); }
}

function gitUrl(uri) {
  if (!uri.startsWith("git+")) federationFail("KDLC_MOUNT_SCHEME", `Unsupported mount URI scheme: ${uri.split(":", 1)[0]}`);
  const value = uri.slice(4);
  if (!/^(?:file|https|ssh):\/\//.test(value)) federationFail("KDLC_MOUNT_SCHEME", "Git mounts require git+file, git+https, or git+ssh");
  let parsed; try { parsed = new URL(value); } catch { federationFail("KDLC_MOUNT_SCHEME", "Git mount URI is invalid"); }
  if (parsed.password || parsed.search || parsed.hash || (parsed.protocol === "https:" && parsed.username)) federationFail("KDLC_GIT_CREDENTIAL", "Git mount URIs must not embed credentials, query parameters, or fragments");
  return value;
}

async function materializeGit(uri, requestedRef, temporaryRoot) {
  if (typeof requestedRef !== "string" || !requestedRef || requestedRef.startsWith("-") || requestedRef.length > 1024 || /[\0-\x20\x7f]/.test(requestedRef)) federationFail("KDLC_GIT_REF_REQUIRED", "Git mounts require a safe explicit ref");
  const repository = join(temporaryRoot, "repository.git");
  await runGit(["-c", "core.hooksPath=/dev/null", "init", "--bare", repository], temporaryRoot);
  await runGit(["remote", "add", "origin", gitUrl(uri)], repository);
  await runGit(["-c", "core.hooksPath=/dev/null", "fetch", "--depth=1", "--filter=blob:none", "--no-tags", "origin", requestedRef], repository);
  const resolvedRef = await runGit(["rev-parse", "--verify", "--end-of-options", "FETCH_HEAD^{commit}"], repository);
  if (!/^[0-9a-f]{40,64}$/.test(resolvedRef)) federationFail("KDLC_GIT_REVISION", "Git did not resolve an immutable commit ID");
  const listing = await runGitBytes(["ls-tree", "-r", "-z", "--full-tree", resolvedRef], repository);
  const snapshot = join(temporaryRoot, "snapshot"); await mkdir(snapshot);
  const records = []; let offset = 0; const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let index = 0; index < listing.length; index += 1) if (listing[index] === 0) {
    try { records.push(decoder.decode(listing.subarray(offset, index))); }
    catch { federationFail("KDLC_GIT_ENTRY", "Git mount paths must be valid UTF-8"); }
    offset = index + 1;
  }
  if (offset !== listing.length) federationFail("KDLC_GIT_ENTRY", "Git tree listing was not NUL terminated");
  const identities = new Set();
  for (const encoded of records.filter(Boolean)) {
    const match = /^(\d{6}) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(encoded);
    if (!match || match[2] !== "blob" || !["100644", "100755"].includes(match[1])) federationFail("KDLC_GIT_ENTRY", "Git mount contains a symlink, submodule, or unsupported entry");
    const path = match[4];
    const identity = path.normalize("NFC");
    if (identities.has(identity)) federationFail("KDLC_GIT_ENTRY", "Git mount paths collide after canonical Unicode normalization");
    identities.add(identity);
    const target = resolve(snapshot, path);
    if (!inside(snapshot, target) || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..")) federationFail("KDLC_GIT_ENTRY", "Git mount contains an unsafe path");
    await mkdir(dirname(target), { recursive: true });
    const bytes = await runGitBytes(["cat-file", "blob", match[3]], repository);
    await writeFile(target, bytes, { flag: "wx", mode: match[1] === "100755" ? 0o700 : 0o600 });
  }
  return { sourceRoot: snapshot, resolvedRef };
}

async function quarantine(path) {
  const target = `${path}.quarantine-${process.pid}-${Date.now()}`;
  try { await rename(path, target); return target; }
  catch (error) { if (error?.code === "ENOENT") return null; federationFail("KDLC_CACHE_QUARANTINE", "Cache drift could not be quarantined"); }
}

export class FederationResolver {
  constructor({ projectRoot, cacheRoot = ".kdlc/mounts", now = () => new Date().toISOString(), coordination = {} }) {
    this.projectRoot = resolve(projectRoot);
    this.cacheRoot = isAbsolute(cacheRoot) ? resolve(cacheRoot) : resolve(this.projectRoot, cacheRoot);
    this.now = now;
    this.coordination = coordination;
    this.store = new NodeFileStore(this.projectRoot);
    this.cacheStore = new NodeFileStore(this.cacheRoot);
  }

  async resolveMount(mount) {
    if (typeof mount?.name !== "string" || typeof mount?.uri !== "string" || !["read-only", "propose", "draft", "maintain", "publish"].includes(mount?.mode)) federationFail("KDLC_MOUNT_INVALID", "Mount name, URI, and a valid mode are required");
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(mount.name) || mount.uri.includes("\0")) federationFail("KDLC_MOUNT_INVALID", "Mount identity or URI is invalid");
    await mkdir(this.cacheRoot, { recursive: true });
    const temporary = await mkdtemp(join(this.cacheRoot, ".incoming-"));
    try {
      let sourceRoot; let resolvedRef;
      if (mount.uri.startsWith("git+")) ({ sourceRoot, resolvedRef } = await materializeGit(mount.uri, mount.ref, temporary));
      else {
        const candidate = resolve(this.projectRoot, mount.uri);
        try { sourceRoot = await realpath(candidate); } catch { federationFail("KDLC_LOCAL_MOUNT", "Local mount does not resolve"); }
        resolvedRef = "pending-tree-hash";
      }
      const sourceTree = await describeTree(sourceRoot);
      if (resolvedRef === "pending-tree-hash") resolvedRef = sourceTree.tree_hash;
      const { manifest, manifest_hash } = await readManifest(sourceRoot);
      const { catalog_hash, retrieval_catalog } = await readRetrievalCatalog(sourceRoot);
      const cacheKey = artifactHash({ id: manifest.metadata.id, resolved_ref: resolvedRef, tree_hash: sourceTree.tree_hash }).slice(7);
      const root = join(this.cacheRoot, cacheKey);
      return await this.cacheStore.withMutex(`.coordination/federation-${cacheKey}`, {
        owner: `federation:${mount.name}:${process.pid}`, clock, ...this.coordination
      }, async () => {
        let cachePresent = true;
        try {
          const existing = await describeTree(root);
          const existingManifest = await readManifest(root);
          if (existing.tree_hash !== sourceTree.tree_hash || existingManifest.manifest_hash !== manifest_hash || existingManifest.manifest.metadata.id !== manifest.metadata.id) {
            await quarantine(root);
            federationFail("KDLC_CACHE_DRIFT", "Cached mount identity or tree hash drifted");
          }
        } catch (error) {
          if (error?.code !== "ENOENT") { await quarantine(root); throw error; }
          cachePresent = false;
        }
        if (!cachePresent) {
          const staged = join(this.cacheRoot, `.staged-${cacheKey}-${process.pid}-${Date.now()}`);
          try {
            await copyVerifiedTree(sourceRoot, staged, sourceTree);
            await rename(staged, root);
          } finally { await rm(staged, { recursive: true, force: true }).catch(() => {}); }
        }
        const verified = await describeTree(root);
        if (verified.tree_hash !== sourceTree.tree_hash) { await quarantine(root); federationFail("KDLC_CACHE_DRIFT", "Cached mount failed final tree verification"); }
        const cachedCatalog = await readRetrievalCatalog(root);
        if (cachedCatalog.catalog_hash !== catalog_hash) { await quarantine(root); federationFail("KDLC_CACHE_DRIFT", "Cached retrieval catalog drifted"); }
        return Object.freeze({ alias: mount.name, id: manifest.metadata.id, version: manifest.metadata.version, uri: mount.uri,
          ...(mount.ref ? { requested_ref: mount.ref } : {}), resolved_ref: resolvedRef, manifest_hash, tree_hash: verified.tree_hash,
          catalog_hash, retrieval_catalog, mode: mount.mode, role: mount.role ?? "dependency", priority: mount.priority ?? 0, access: manifest.access, root });
      });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  async resolveProject(project) {
    await mkdir(this.cacheRoot, { recursive: true });
    const contracts = await createContractValidator(); const contract = contracts.validate("project", project); const semantic = validateProjectSemantics(project);
    if (!contract.valid || semantic.length) federationFail("KDLC_PROJECT_INVALID", "Project manifest is invalid", { contract: contract.errors, semantic });
    return this.store.withMutex(".kdlc/coordination/knowledge-lock", { owner: `knowledge-lock:${process.pid}`, clock, ...this.coordination }, async () => {
      const resolved = [];
      for (const mount of project.knowledge_bases ?? []) resolved.push(await this.resolveMount(mount));
      const ids = new Map();
      for (const mount of resolved) {
        if (ids.has(mount.id)) federationFail("KDLC_DUPLICATE_KB_ID", `Duplicate stable knowledge-base ID: ${mount.id}`);
        ids.set(mount.id, mount.alias);
      }
      const knowledge_bases = Object.fromEntries([...resolved].sort((a, b) => a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0).map((mount) => [mount.alias, {
        id: mount.id, version: mount.version, uri: mount.uri, ...(mount.requested_ref ? { requested_ref: mount.requested_ref } : {}),
        resolved_ref: mount.resolved_ref, manifest_hash: mount.manifest_hash, tree_hash: mount.tree_hash
      }]));
      const lock = { api_version: "kdlc.dev/v1alpha1", project: project.metadata.name, resolved_at: this.now(), knowledge_bases };
      await this.store.writeJsonAtomic("knowledge.lock", lock);
      return Object.freeze({ lock, mounts: Object.freeze(resolved) });
    });
  }

  async verify(mount) {
    try {
      const tree = await describeTree(mount.root); const manifest = await readManifest(mount.root);
      const catalog = await readRetrievalCatalog(mount.root);
      if (tree.tree_hash !== mount.tree_hash || manifest.manifest_hash !== mount.manifest_hash || catalog.catalog_hash !== mount.catalog_hash || manifest.manifest.metadata.id !== mount.id) throw new Error("identity mismatch");
      return true;
    } catch { federationFail("KDLC_CACHE_DRIFT", "Locked mount no longer matches its verified identity"); }
  }
}
