import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, posix, relative, resolve, sep } from "node:path";

import { parse } from "acorn";

import { artifactHash, byteHash, canonicalJson } from "../../core/index.mjs";
import { validatePluginManifest } from "./compatibility.mjs";
import { extensionFail } from "./errors.mjs";

const PROOF_DOMAIN = "kdlc.extension.package-scan/v1";
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "").split("/")[0]));
const builtinPermission = Object.freeze({
  fs: "filesystem", http: "network", https: "network", net: "network", tls: "network", dns: "network", dgram: "network",
  child_process: "subprocess", cluster: "subprocess", worker_threads: "subprocess", vm: "macros"
});
const safeBuiltins = new Set(["assert", "buffer", "crypto", "events", "path", "querystring", "stream", "string_decoder", "url", "util", "zlib"]);
const pathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[A-Za-z0-9._/-]+$/;
const AMBIENT_CAPABILITIES = Object.freeze(["credentials", "filesystem", "macros", "network", "subprocess"]);

function unsigned(report) { const { scanner_proof: ignored, ...payload } = report; return payload; }
function same(left, right) { return canonicalJson(left) === canonicalJson(right); }
function requested(entry, permission) {
  if (permission === "filesystem") return entry.permissions.filesystem.length > 0;
  if (permission === "network") return entry.permissions.network.length > 0;
  if (permission === "subprocess" || permission === "macros") return entry.permissions[permission] === true;
  return false;
}

function inspectModule(source, path) {
  let tree;
  try { tree = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true }); }
  catch { extensionFail("KDLC_EXTENSION_SOURCE_INVALID", `Executable module is not valid JavaScript: ${path}`); }
  const imports = new Set(); const credentials = new Set();
  const visit = (node, parent = null) => {
    if (!node || typeof node !== "object") return;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source) imports.add(node.source.value);
    if (node.type === "ImportExpression") {
      if (node.source?.type !== "Literal" || typeof node.source.value !== "string") extensionFail("KDLC_EXTENSION_DYNAMIC_IMPORT_DENIED", `Dynamic import cannot be statically authorized: ${path}`);
      imports.add(node.source.value);
    }
    if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "require") {
      if (node.arguments.length !== 1 || node.arguments[0]?.type !== "Literal" || typeof node.arguments[0].value !== "string") extensionFail("KDLC_EXTENSION_DYNAMIC_IMPORT_DENIED", `Dynamic require cannot be statically authorized: ${path}`);
      imports.add(node.arguments[0].value);
    }
    if ((node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "fetch")
      || (node.type === "NewExpression" && node.callee?.type === "Identifier" && node.callee.name === "WebSocket")
      || (node.type === "MemberExpression" && node.object?.type === "Identifier" && node.object.name === "globalThis" && ["fetch", "WebSocket"].includes(node.property?.name))) imports.add("node:https");
    if ((node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "eval")
      || (node.type === "NewExpression" && node.callee?.type === "Identifier" && node.callee.name === "Function")) imports.add("node:vm");
    if (node.type === "MemberExpression" && node.object?.type === "MemberExpression" && node.object.object?.type === "Identifier" && node.object.object.name === "process"
      && ((!node.object.computed && node.object.property?.name === "env") || (node.object.computed && node.object.property?.value === "env"))) {
      const name = node.computed ? node.property?.value : node.property?.name;
      if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(name)) extensionFail("KDLC_EXTENSION_DYNAMIC_CREDENTIAL_DENIED", `Dynamic environment access cannot be statically authorized: ${path}`);
      credentials.add(name);
    }
    if (node.type === "MemberExpression" && node.object?.type === "Identifier" && node.object.name === "process"
      && ((!node.computed && node.property?.name === "env") || (node.computed && node.property?.value === "env"))
      && !(parent?.type === "MemberExpression" && parent.object === node)) extensionFail("KDLC_EXTENSION_DYNAMIC_CREDENTIAL_DENIED", `Unscoped environment access cannot be statically authorized: ${path}`);
    if (node.type === "MemberExpression" && node.object?.type === "Identifier" && node.object.name === "process"
      && !((!node.computed && node.property?.name === "env") || (node.computed && node.property?.value === "env"))) extensionFail("KDLC_EXTENSION_IMPORT_DENIED", `Ambient process capability cannot be statically authorized: ${path}`);
    if (node.type === "MemberExpression" && node.object?.type === "Identifier" && node.object.name === "globalThis"
      && !["fetch", "WebSocket"].includes(node.property?.name)) extensionFail("KDLC_EXTENSION_IMPORT_DENIED", `Ambient global capability cannot be statically authorized: ${path}`);
    for (const [key, value] of Object.entries(node)) {
      if (["start", "end", "loc"].includes(key)) continue;
      if (Array.isArray(value)) for (const child of value) visit(child, node);
      else if (value && typeof value === "object") visit(value, node);
    }
  };
  visit(tree);
  return { imports: [...imports].sort(), credentials: [...credentials].sort() };
}

function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino && left.isDirectory() === right.isDirectory(); }
async function ancestry(root, file) {
  const result = []; let current = dirname(file);
  while (true) {
    const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) extensionFail("KDLC_EXTENSION_PACKAGE_SYMLINK_DENIED", "Package ancestry changed during scan");
    const resolved = await realpath(current);
    if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) extensionFail("KDLC_EXTENSION_PACKAGE_SYMLINK_DENIED", "Package ancestry escaped its root");
    result.push({ path: current, stat }); if (current === root) return result;
    const parent = dirname(current); if (parent === current) extensionFail("KDLC_EXTENSION_PACKAGE_SYMLINK_DENIED", "Package ancestry does not reach its root"); current = parent;
  }
}

async function readPackageFiles(packageRoot, { maxFiles, maxBytes, afterOpen }) {
  const root = await realpath(packageRoot); const files = new Map(); let total = 0;
  const descend = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = resolve(directory, entry.name); const rel = relative(root, absolute).split(sep).join("/");
      if (!pathPattern.test(rel)) extensionFail("KDLC_EXTENSION_PACKAGE_PATH_INVALID", `Package contains an unsafe path: ${rel}`);
      if (entry.isSymbolicLink()) extensionFail("KDLC_EXTENSION_PACKAGE_SYMLINK_DENIED", `Package symlinks are not trusted: ${rel}`);
      if (entry.isDirectory()) { await descend(absolute); continue; }
      if (!entry.isFile()) extensionFail("KDLC_EXTENSION_PACKAGE_ENTRY_DENIED", `Package contains a non-file entry: ${rel}`);
      if (files.size >= maxFiles) extensionFail("KDLC_EXTENSION_PACKAGE_LIMIT", "Package exceeds the trusted file-count limit");
      const parents = await ancestry(root, absolute); let handle;
      const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
      try { handle = await open(absolute, constants.O_RDONLY | noFollow); }
      catch { extensionFail("KDLC_EXTENSION_PACKAGE_RACE", `Package entry could not be opened without following links: ${rel}`); }
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) extensionFail("KDLC_EXTENSION_PACKAGE_ENTRY_DENIED", `Package entry changed type during scan: ${rel}`);
        if (afterOpen) await afterOpen({ relativePath: rel, absolutePath: absolute });
        const pathStat = await lstat(absolute);
        if (pathStat.isSymbolicLink() || !sameIdentity(stat, pathStat)) extensionFail("KDLC_EXTENSION_PACKAGE_RACE", `Package entry changed after its descriptor was opened: ${rel}`);
        for (const parent of parents) if (!sameIdentity(parent.stat, await lstat(parent.path))) extensionFail("KDLC_EXTENSION_PACKAGE_RACE", `Package ancestry changed during scan: ${rel}`);
        const resolved = await realpath(absolute);
        if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) extensionFail("KDLC_EXTENSION_PACKAGE_SYMLINK_DENIED", `Package entry escaped its root: ${rel}`);
        const bytes = await handle.readFile(); total += bytes.byteLength;
        if (total > maxBytes) extensionFail("KDLC_EXTENSION_PACKAGE_LIMIT", "Package exceeds the trusted byte limit");
        files.set(rel, bytes);
      } finally { await handle.close(); }
    }
  };
  await descend(root);
  return files;
}

function analyzeExecutables(manifest, files) {
  return manifest.executables.map((entry) => {
    const pending = [entry.entrypoint]; const visited = new Set(); const imports = new Set(); const credentials = new Set(); const required = new Set();
    while (pending.length) {
      const modulePath = pending.pop();
      if (visited.has(modulePath)) continue;
      const bytes = files.get(modulePath);
      if (!bytes) extensionFail("KDLC_EXTENSION_ENTRYPOINT_MISSING", `Executable module is absent from package bytes: ${modulePath}`);
      let source; try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { extensionFail("KDLC_EXTENSION_SOURCE_INVALID", `Executable module is not strict UTF-8: ${modulePath}`); }
      const inspected = inspectModule(source, modulePath); visited.add(modulePath);
      for (const credential of inspected.credentials) credentials.add(credential);
      for (const specifier of inspected.imports) {
        imports.add(specifier);
        if (specifier.startsWith(".") || specifier.startsWith("/")) {
          if (specifier.startsWith("/")) extensionFail("KDLC_EXTENSION_IMPORT_DENIED", `Absolute import is outside the package: ${specifier}`);
          const target = posix.normalize(posix.join(posix.dirname(modulePath), specifier));
          if (!pathPattern.test(target) || !target.endsWith(".mjs")) extensionFail("KDLC_EXTENSION_IMPORT_DENIED", `Relative import is unsafe or ambiguous: ${specifier}`);
          pending.push(target); continue;
        }
        const normalized = specifier.replace(/^node:/, ""); const base = normalized.split("/")[0];
        if (specifier.startsWith("node:") || builtins.has(base)) {
          const permission = builtinPermission[base];
          if (permission) required.add(permission);
          else if (!safeBuiltins.has(base)) extensionFail("KDLC_EXTENSION_IMPORT_DENIED", `Builtin import has no governed capability mapping: ${specifier}`);
        } else extensionFail("KDLC_EXTENSION_IMPORT_DENIED", `Executable dependency imports must use a mediated host capability: ${specifier}`);
      }
    }
    for (const permission of required) if (!requested(entry, permission)) extensionFail("KDLC_EXTENSION_PERMISSION_UNDERREPORTED", `Executable ${entry.id} imports ${permission} capability without declaring it`);
    for (const credential of credentials) if (!entry.permissions.credentials.includes(credential)) extensionFail("KDLC_EXTENSION_PERMISSION_UNDERREPORTED", `Executable ${entry.id} reads undeclared credential ${credential}`);
    return { id: entry.id, modules: [...visited].sort(), imports: [...imports].sort(), detected_permissions: [...required].sort(),
      required_capabilities: [...AMBIENT_CAPABILITIES], ambient_dynamic_code: true, credentials: [...credentials].sort() };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export class ExtensionPackageScanner {
  #key;
  #keyId;
  #validator;
  #limits;

  constructor({ validator, key = randomBytes(32), keyId = "extension-scanner-v1", maxFiles = 4096, maxBytes = 64 * 1024 * 1024, afterOpen } = {}) {
    if (!validator || !(key instanceof Uint8Array) || key.byteLength < 32 || typeof keyId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(keyId)
      || !Number.isSafeInteger(maxFiles) || maxFiles < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("Extension package scanner requires a validator, signing key, and positive bounds");
    if (afterOpen !== undefined && typeof afterOpen !== "function") throw new TypeError("Extension scanner afterOpen hook must be callable");
    this.#validator = validator; this.#key = Buffer.from(key); this.#keyId = keyId; this.#limits = { maxFiles, maxBytes, afterOpen };
  }

  #mac(payload) { return createHmac("sha256", this.#key).update(`${PROOF_DOMAIN}\0${canonicalJson(payload)}`).digest(); }

  async scan(packageRoot) {
    const files = await readPackageFiles(packageRoot, this.#limits);
    const manifestBytes = files.get(".kdlc-plugin/plugin.json");
    if (!manifestBytes) extensionFail("KDLC_EXTENSION_MANIFEST_MISSING", "Package does not contain .kdlc-plugin/plugin.json");
    let manifest; try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)); } catch { extensionFail("KDLC_EXTENSION_MANIFEST_INVALID", "Plugin manifest is not strict UTF-8 JSON"); }
    validatePluginManifest(manifest, this.#validator);
    const inventory = [...files].map(([path, bytes]) => ({ path, size: bytes.byteLength, byte_hash: byteHash(bytes) })).sort((a, b) => a.path.localeCompare(b.path));
    const payload = { api_version: "kdlc.dev/package-scan/v1alpha1", plugin: manifest.metadata.name, version: manifest.metadata.version,
      manifest: structuredClone(manifest), manifest_hash: artifactHash(manifest), package_hash: artifactHash({ files: inventory }), files: inventory,
      import_analysis: analyzeExecutables(manifest, files) };
    const proof = { algorithm: "hmac-sha256", key_id: this.#keyId, domain: PROOF_DOMAIN, mac: `sha256:${this.#mac(payload).toString("hex")}` };
    return Object.freeze({ ...payload, scanner_proof: Object.freeze(proof) });
  }

  verifyReport(report) {
    try {
      const proof = report?.scanner_proof; if (!proof || proof.algorithm !== "hmac-sha256" || proof.key_id !== this.#keyId || proof.domain !== PROOF_DOMAIN || !/^sha256:[a-f0-9]{64}$/.test(proof.mac)) return false;
      const actual = Buffer.from(proof.mac.slice(7), "hex"); const expected = this.#mac(unsigned(report));
      return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected) && same(report.manifest_hash, artifactHash(report.manifest));
    } catch { return false; }
  }
}
