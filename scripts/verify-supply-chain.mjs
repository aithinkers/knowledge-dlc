import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { exactPackageManifestFailures, installedMetadataFailures, installedTreeHash } from "./supply-chain-validation.mjs";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const writing = process.argv.slice(2).includes("--write");
if (process.argv.slice(2).some((argument) => argument !== "--write")) throw new Error("usage: node scripts/verify-supply-chain.mjs [--write]");

const bytes = async (path) => readFile(resolve(root, path));
const json = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const spdxId = (name, version) => `SPDXRef-Package-${digest(`${name}@${version}`).slice(0, 20)}`;
const exists = async (path) => { try { await access(resolve(root, path)); return true; } catch { return false; } };
const packageName = (path) => path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
function safeInstalledPath(path) {
  const absolute = resolve(root, path); const rel = relative(root, absolute).split(sep).join("/");
  return path.startsWith("node_modules/") && rel === path && !path.split("/").some((part) => !part || part === "." || part === "..");
}

async function installedTreeEvidence(path) {
  const base = resolve(root, path); const entries = [];
  const visit = async (directory) => {
    for (const name of (await readdir(directory)).sort()) {
      if (name === "node_modules") continue;
      const absolute = resolve(directory, name); const rel = relative(base, absolute).split(sep).join("/");
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) throw new Error(`unsupported installed entry: ${rel}`);
      if (metadata.isDirectory()) await visit(absolute);
      else { const content = await readFile(absolute); entries.push({ path: rel, size: content.byteLength, sha256: digest(content) }); }
    }
  };
  await visit(base);
  return { file_count: entries.length, tree_sha256: installedTreeHash(entries) };
}

function dependencyPath(packages, parentPath, name) {
  let parent = parentPath;
  while (true) {
    const candidate = `${parent ? `${parent}/` : ""}node_modules/${name}`;
    if (packages[candidate]) return candidate;
    const marker = parent.lastIndexOf("/node_modules/");
    if (marker >= 0) parent = parent.slice(0, marker);
    else if (parent.startsWith("node_modules/")) parent = "";
    else return null;
  }
}

const packageDocument = await json("package.json");
const lockBytes = await bytes("package-lock.json");
const lock = JSON.parse(lockBytes);
const policy = await json("security/supply-chain-policy.json");
const failures = [];

if (policy.version !== 1 || !Array.isArray(policy.allowed_licenses) || !policy.allowed_licenses.length || typeof policy.package_manifest !== "string") failures.push("supply-chain policy is invalid");
if (packageDocument.private !== true || !String(packageDocument.version).endsWith("-private")) failures.push("pre-release package must remain private and non-final");
if (packageDocument.license !== "MIT") failures.push("root package license must agree with LICENSE");
if (JSON.stringify(packageDocument.files) !== JSON.stringify(policy.package_files)) failures.push("package files allowlist drifted from supply-chain policy");
if (lock.name !== packageDocument.name || lock.version !== packageDocument.version || lock.packages?.[""]?.version !== packageDocument.version) failures.push("package-lock root identity drift");

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
let emittedFiles = [];
try {
  const { stdout } = await execute(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0].files)) throw new Error("unexpected npm pack result");
  emittedFiles = result[0].files.map(({ path }) => path).sort();
} catch (error) { failures.push(`npm pack manifest unavailable: ${error.message}`); }

const lockPackages = lock.packages ?? {};
const installedPaths = [];
for (const path of Object.keys(lockPackages).filter((path) => path.includes("node_modules/") && lockPackages[path].optional !== true)) {
  if (!safeInstalledPath(path)) { failures.push(`unsafe installed package path in lock: ${path}`); continue; }
  if (await exists(path)) installedPaths.push(path);
}
installedPaths.sort();
const installed = new Set(installedPaths);
const inventory = [];
for (const path of installedPaths) {
  const entry = lockPackages[path];
  const identity = `${packageName(path)}@${entry.version}`;
  if (!entry.version || !entry.integrity || !entry.resolved) failures.push(`incomplete locked package metadata: ${identity}`);
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? "")) failures.push(`package integrity is not pinned with sha512: ${identity}`);
  if (!/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved ?? "")) failures.push(`package is not resolved from the approved npm registry: ${identity}`);
  const metadataPath = `${path}/package.json`;
  let metadataBytes, metadata, licenseFiles = [], tree;
  try {
    const stat = await lstat(resolve(root, path));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("package directory is not a regular installed directory");
    metadataBytes = await bytes(metadataPath); metadata = JSON.parse(metadataBytes);
    const metadataFailures = installedMetadataFailures({ identity: { name: packageName(path) }, entry, metadata, allowedLicenses: policy.allowed_licenses });
    if (metadataFailures.length) throw new Error(metadataFailures.join("; "));
    const names = (await readdir(resolve(root, path))).filter((name) => /^(?:licen[cs]e|copying|notice)(?:\.|$)/iu.test(name)).sort();
    for (const name of names) licenseFiles.push({ path: name, sha256: digest(await bytes(`${path}/${name}`)) });
    tree = await installedTreeEvidence(path);
  } catch (error) { failures.push(`installed package bytes invalid: ${identity} (${error.message})`); continue; }
  const license = metadata.license;
  inventory.push({ name: metadata.name, version: metadata.version, license, integrity: entry.integrity, resolved: entry.resolved, path, manifest_sha256: digest(metadataBytes), installed_tree_sha256: tree.tree_sha256, installed_file_count: tree.file_count, license_evidence: licenseFiles.length ? "installed-license-files" : "installed-package-metadata", license_files: licenseFiles });
}

const runtimeReachable = new Set();
const visitRuntime = (path) => {
  if (!path || runtimeReachable.has(path) || !installed.has(path)) return;
  runtimeReachable.add(path);
  const entry = lockPackages[path];
  for (const name of [...Object.keys(entry.dependencies ?? {}), ...Object.keys(entry.optionalDependencies ?? {}), ...Object.keys(entry.peerDependencies ?? {})]) visitRuntime(dependencyPath(lockPackages, path, name));
};
for (const name of Object.keys(packageDocument.dependencies ?? {})) visitRuntime(dependencyPath(lockPackages, "", name));
for (const item of inventory) item.scope = runtimeReachable.has(item.path) ? "runtime" : "development";

const inventoryHash = `sha256:${digest(JSON.stringify(inventory))}`;
const notices = `# Third-party notices\n\nThis inventory is generated after a clean integrity-checked \`npm ci --ignore-scripts\` from the required installed dependency graph. Platform-specific optional packages are excluded from this portable SBOM and remain pinned and audited through \`package-lock.json\`. K-DLC is licensed under MIT; dependencies remain under their respective licenses. Installed tree, manifest, and license-file hashes bind the listed evidence to the verified bytes. Where a package ships no license or notice file, the declared license is explicitly sourced from its installed \`package.json\` metadata.\n\nInventory hash: \`${inventoryHash}\`\n\n| Package | Version | Scope | License | Installed tree | Installed manifest | Locked source |\n| --- | --- | --- | --- | --- | --- | --- |\n${inventory.map(({ name, version, scope, license, installed_tree_sha256, manifest_sha256, resolved }) => `| \`${name}\` | \`${version}\` | \`${scope}\` | \`${license}\` | \`sha256:${installed_tree_sha256}\` | \`sha256:${manifest_sha256}\` | [npm tarball](${resolved}) |`).join("\n")}\n`;

const packages = [{
  SPDXID: "SPDXRef-Root", name: packageDocument.name, versionInfo: packageDocument.version,
  downloadLocation: "NOASSERTION", filesAnalyzed: false, licenseConcluded: "MIT", licenseDeclared: "MIT", copyrightText: "Copyright (c) 2026 AIThinkers"
}, ...inventory.map((item) => ({
  SPDXID: spdxId(item.name, item.version), name: item.name, versionInfo: item.version, downloadLocation: item.resolved,
  filesAnalyzed: false, licenseConcluded: "NOASSERTION", licenseDeclared: item.license,
  checksums: [{ algorithm: "SHA512", checksumValue: Buffer.from(item.integrity.slice("sha512-".length), "base64").toString("hex") }],
  primaryPackagePurpose: item.scope === "runtime" ? "LIBRARY" : "BUILD_TOOL", copyrightText: "NOASSERTION",
  externalRefs: [
    { referenceCategory: "OTHER", referenceType: "kdlc:installed-manifest-sha256", referenceLocator: `sha256:${item.manifest_sha256}` },
    { referenceCategory: "OTHER", referenceType: "kdlc:installed-tree-sha256", referenceLocator: `sha256:${item.installed_tree_sha256}` },
    { referenceCategory: "OTHER", referenceType: "kdlc:dependency-scope", referenceLocator: item.scope }
  ]
}))];
const relationships = [];
for (const name of Object.keys(packageDocument.dependencies ?? {})) {
  const path = dependencyPath(lockPackages, "", name); const item = inventory.find((candidate) => candidate.path === path);
  if (item) relationships.push({ spdxElementId: "SPDXRef-Root", relationshipType: "DEPENDS_ON", relatedSpdxElement: spdxId(item.name, item.version) });
}
for (const name of Object.keys(packageDocument.devDependencies ?? {})) {
  const path = dependencyPath(lockPackages, "", name); const item = inventory.find((candidate) => candidate.path === path);
  if (item) relationships.push({ spdxElementId: spdxId(item.name, item.version), relationshipType: "DEV_DEPENDENCY_OF", relatedSpdxElement: "SPDXRef-Root" });
}
for (const parent of inventory) for (const name of [...Object.keys(lockPackages[parent.path].dependencies ?? {}), ...Object.keys(lockPackages[parent.path].optionalDependencies ?? {}), ...Object.keys(lockPackages[parent.path].peerDependencies ?? {})]) {
  const childPath = dependencyPath(lockPackages, parent.path, name); const child = inventory.find((candidate) => candidate.path === childPath);
  if (child) relationships.push({ spdxElementId: spdxId(parent.name, parent.version), relationshipType: "DEPENDS_ON", relatedSpdxElement: spdxId(child.name, child.version) });
}
const uniqueRelationships = [...new Map(relationships.map((item) => [JSON.stringify(item), item])).values()];
const sbom = {
  spdxVersion: "SPDX-2.3", dataLicense: "CC0-1.0", SPDXID: "SPDXRef-DOCUMENT", name: `${packageDocument.name}-${packageDocument.version}`,
  documentNamespace: `https://github.com/aithinkers/knowledge-dlc/sbom/${digest(lockBytes)}`, creationInfo: { created: "1970-01-01T00:00:00Z", creators: ["Tool: scripts/verify-supply-chain.mjs"] },
  documentDescribes: ["SPDXRef-Root"], packages, relationships: uniqueRelationships
};
const sbomText = `${JSON.stringify(sbom, null, 2)}\n`;
const packageManifest = { version: 1, files: emittedFiles };

if (!writing) {
  try {
    const committedManifest = await json(policy.package_manifest);
    if (committedManifest.version !== 1 || !Array.isArray(committedManifest.files)) failures.push("committed npm package manifest is invalid");
    else failures.push(...exactPackageManifestFailures(emittedFiles, committedManifest.files));
  } catch { failures.push(`missing generated supply-chain evidence: ${policy.package_manifest}`); }
}

if (failures.length) {
  for (const failure of failures) console.error(`ERROR: ${failure}`);
  process.exitCode = 1;
} else if (writing) {
  await writeFile(resolve(root, policy.notices), notices);
  await writeFile(resolve(root, policy.sbom), sbomText);
  await writeFile(resolve(root, policy.package_manifest), `${JSON.stringify(packageManifest, null, 2)}\n`);
  console.log(`Wrote ${inventory.length} installed dependency notices, ${uniqueRelationships.length} graph relationships, and ${emittedFiles.length} exact package paths.`);
} else {
  for (const [path, generated] of [[policy.notices, notices], [policy.sbom, sbomText]]) {
    let committed;
    try { committed = await readFile(resolve(root, path), "utf8"); } catch { failures.push(`missing generated supply-chain evidence: ${path}`); continue; }
    if (committed !== generated) failures.push(`generated supply-chain evidence drift: ${path}`);
  }
  if (failures.length) {
    for (const failure of failures) console.error(`ERROR: ${failure}`);
    process.exitCode = 1;
  } else console.log(`Supply chain verified: ${inventory.length} installed dependencies, ${uniqueRelationships.length} graph relationships, and ${emittedFiles.length} exact package paths (${inventoryHash}).`);
}
