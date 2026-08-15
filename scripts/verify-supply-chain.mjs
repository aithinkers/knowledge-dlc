import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const writing = process.argv.slice(2).includes("--write");
if (process.argv.slice(2).some((argument) => argument !== "--write")) throw new Error("usage: node scripts/verify-supply-chain.mjs [--write]");

const bytes = async (path) => readFile(resolve(root, path));
const json = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const packageName = (path) => path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
const spdxId = (name, version) => `SPDXRef-Package-${digest(`${name}@${version}`).slice(0, 20)}`;

const packageDocument = await json("package.json");
const lockBytes = await bytes("package-lock.json");
const lock = JSON.parse(lockBytes);
const policy = await json("security/supply-chain-policy.json");
const failures = [];

if (policy.version !== 1 || !Array.isArray(policy.allowed_licenses) || !policy.allowed_licenses.length) failures.push("supply-chain policy is invalid");
if (packageDocument.private !== true || !String(packageDocument.version).endsWith("-private")) failures.push("pre-release package must remain private and non-final");
if (packageDocument.license !== "MIT") failures.push("root package license must agree with LICENSE");
if (JSON.stringify(packageDocument.files) !== JSON.stringify(policy.package_files)) failures.push("package files allowlist drifted from supply-chain policy");
if (lock.name !== packageDocument.name || lock.version !== packageDocument.version || lock.packages?.[""]?.version !== packageDocument.version) failures.push("package-lock root identity drift");

const lockedLocations = Object.entries(lock.packages ?? {}).filter(([path]) => path.includes("node_modules/")).map(([path, entry]) => ({
  name: packageName(path), version: entry.version, license: entry.license, integrity: entry.integrity, resolved: entry.resolved
})).sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));

const byIdentity = new Map();
for (const item of lockedLocations) {
  const identity = `${item.name}@${item.version}`;
  const existing = byIdentity.get(identity);
  if (existing && (existing.license !== item.license || existing.integrity !== item.integrity || existing.resolved !== item.resolved)) failures.push(`conflicting locked package identity: ${identity}`);
  else if (!existing) byIdentity.set(identity, item);
  if (!item.version || !item.license || !item.integrity || !item.resolved) failures.push(`incomplete locked package metadata: ${identity}`);
  if (!policy.allowed_licenses.includes(item.license)) failures.push(`license is not allowlisted: ${identity} (${item.license ?? "missing"})`);
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(item.integrity ?? "")) failures.push(`package integrity is not pinned with sha512: ${identity}`);
  if (!/^https:\/\/registry\.npmjs\.org\//.test(item.resolved ?? "")) failures.push(`package is not resolved from the approved npm registry: ${identity}`);
}
const inventory = [...byIdentity.values()];

const inventoryHash = `sha256:${digest(JSON.stringify(inventory))}`;
const notices = `# Third-party notices\n\nThis inventory is generated from \`package-lock.json\`. K-DLC is licensed under MIT; dependencies remain under their respective licenses. Review the referenced package distributions for full license text and attribution terms.\n\nInventory hash: \`${inventoryHash}\`\n\n| Package | Version | License | Locked source |\n| --- | --- | --- | --- |\n${inventory.map(({ name, version, license, resolved }) => `| \`${name}\` | \`${version}\` | \`${license}\` | [npm tarball](${resolved}) |`).join("\n")}\n`;

const packages = [{
  SPDXID: "SPDXRef-Root", name: packageDocument.name, versionInfo: packageDocument.version,
  downloadLocation: "NOASSERTION", filesAnalyzed: false, licenseConcluded: "MIT", licenseDeclared: "MIT",
  copyrightText: "Copyright (c) 2026 AIThinkers"
}, ...inventory.map((item) => ({
  SPDXID: spdxId(item.name, item.version), name: item.name, versionInfo: item.version,
  downloadLocation: item.resolved, filesAnalyzed: false, licenseConcluded: "NOASSERTION", licenseDeclared: item.license,
  checksums: [{ algorithm: "SHA512", checksumValue: Buffer.from(item.integrity.slice("sha512-".length), "base64").toString("hex") }],
  copyrightText: "NOASSERTION"
}))];
const directNames = new Set([...Object.keys(packageDocument.dependencies ?? {}), ...Object.keys(packageDocument.devDependencies ?? {})]);
const relationships = inventory.filter(({ name }) => directNames.has(name)).map((item) => ({
  spdxElementId: "SPDXRef-Root", relationshipType: "DEPENDS_ON", relatedSpdxElement: spdxId(item.name, item.version)
}));
const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `${packageDocument.name}-${packageDocument.version}`,
  documentNamespace: `https://github.com/aithinkers/knowledge-dlc/sbom/${digest(lockBytes)}`,
  creationInfo: { created: "1970-01-01T00:00:00Z", creators: ["Tool: scripts/verify-supply-chain.mjs"] },
  documentDescribes: ["SPDXRef-Root"],
  packages,
  relationships
};
const sbomText = `${JSON.stringify(sbom, null, 2)}\n`;

if (failures.length) {
  for (const failure of failures) console.error(`ERROR: ${failure}`);
  process.exitCode = 1;
} else if (writing) {
  await writeFile(resolve(root, policy.notices), notices);
  await writeFile(resolve(root, policy.sbom), sbomText);
  console.log(`Wrote ${inventory.length} dependency notices and SPDX inventory ${inventoryHash}.`);
} else {
  const expected = [[policy.notices, notices], [policy.sbom, sbomText]];
  for (const [path, generated] of expected) {
    let committed;
    try { committed = await readFile(resolve(root, path), "utf8"); } catch { failures.push(`missing generated supply-chain evidence: ${path}`); continue; }
    if (committed !== generated) failures.push(`generated supply-chain evidence drift: ${path}`);
  }
  if (failures.length) {
    for (const failure of failures) console.error(`ERROR: ${failure}`);
    process.exitCode = 1;
  } else console.log(`Supply chain verified: ${inventory.length} locked dependencies, allowlisted licenses, notices, and SPDX SBOM (${inventoryHash}).`);
}
