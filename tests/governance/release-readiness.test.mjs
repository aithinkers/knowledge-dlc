import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { parseYamlArtifact } from "../../packages/contracts/index.mjs";
import { exactPackageManifestFailures, inspectPackageArchive, installedMetadataFailures, installedTreeHash, normalizeNpmPackPath, npmCommandInvocation, readTrustedFile } from "../../scripts/supply-chain-validation.mjs";

const root = resolve(import.meta.dirname, "../..");
const text = (path) => readFile(resolve(root, path), "utf8");
const json = async (path) => JSON.parse(await text(path));
function tarArchive(entries) {
  const blocks = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "x"); const size = entry.size ?? content.byteLength; const header = Buffer.alloc(512); const octal = (value, width) => `${value.toString(8).padStart(width - 1, "0")}\0`;
    header.write(entry.name); header.write(octal(0o644, 8), 100); header.write(octal(0, 8), 108); header.write(octal(0, 8), 116); header.write(octal(size, 12), 124); header.write(octal(0, 12), 136); header.fill(32, 148, 156); header[156] = (entry.type ?? "0").charCodeAt(0); header.write("ustar\0", 257); header.write("00", 263);
    const sum = header.reduce((total, value) => total + value, 0); header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148); blocks.push(header); if (size <= content.byteLength) { blocks.push(content.subarray(0, size)); blocks.push(Buffer.alloc((512 - (size % 512)) % 512)); }
  }
  blocks.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(blocks));
}

test("REL-001 public policies provide actionable low-disclosure security and conduct channels", async () => {
  const [readme, security, conduct, support, config] = await Promise.all([
    text("README.md"), text("SECURITY.md"), text("CODE_OF_CONDUCT.md"), text("SUPPORT.md"), text(".github/ISSUE_TEMPLATE/config.yml")
  ]);
  assert.doesNotMatch(`${readme}\n${security}\n${support}`, /private (?:MVP|`main` branch)/i);
  assert.match(security, /mailto:connect@aithinkers\.com\?subject=K-DLC%20confidential%20security%20report/);
  assert.match(conduct, /mailto:connect@aithinkers\.com\?subject=K-DLC%20confidential%20conduct%20report/);
  assert.match(security, /before sending reproduction details/i);
  assert.match(conduct, /Do not\s+file a public issue/i);
  const parsed = parseYamlArtifact(config);
  assert.equal(parsed.blank_issues_enabled, false);
  assert.deepEqual(parsed.contact_links.map(({ name }) => name), ["Security vulnerability", "Confidential conduct report"]);
  assert.equal(parsed.contact_links.every(({ url }) => url.startsWith("https://")), true);
});

test("REL-001 security workflows pin executable actions and scan complete Git history", async () => {
  const workflows = ["secret-history.yml", "codeql.yml", "dependency-review.yml", "supply-chain.yml"];
  for (const name of workflows) {
    const source = await text(`.github/workflows/${name}`);
    parseYamlArtifact(source);
    for (const reference of source.matchAll(/uses:\s*([^\s#]+)/g)) assert.match(reference[1], /^[^@\s]+@[0-9a-f]{40}$/, `${name}: ${reference[1]}`);
    assert.doesNotMatch(source, /pull_request_target/);
  }
  const secret = await text(".github/workflows/secret-history.yml");
  assert.match(secret, /fetch-depth: 0/);
  assert.match(secret, /--log-opts="--all"/);
  assert.match(secret, /a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb/);
  const config = await text(".gitleaks.toml");
  assert.match(config, /useDefault = true/);
  assert.doesNotMatch(config, /allowlist|allowlists|regexes|paths/);
});

test("REL-001 npm updates, installed licenses, dependency graph, and exact package contents are bounded", async () => {
  const [manifest, dependabot, policy, notices, sbom, packageFiles] = await Promise.all([
    json("package.json"), text(".github/dependabot.yml"), json("security/supply-chain-policy.json"), text("THIRD_PARTY_NOTICES.md"), json("docs/supply-chain/sbom.spdx.json"), json("security/npm-package-files.json")
  ]);
  assert.equal(manifest.private, true);
  assert.equal(manifest.version, "0.0.0-private");
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.files, policy.package_files);
  assert.ok(manifest.files.includes("distribution/"));
  assert.equal(parseYamlArtifact(dependabot).updates.some((entry) => entry["package-ecosystem"] === "npm"), true);
  assert.deepEqual(policy.allowed_licenses, ["Apache-2.0", "BSD-3-Clause", "ISC", "MIT"]);
  assert.match(notices, /Inventory hash: `sha256:[0-9a-f]{64}`/);
  assert.match(notices, /installed dependency graph/i);
  assert.equal(sbom.spdxVersion, "SPDX-2.3");
  assert.equal(sbom.dataLicense, "CC0-1.0");
  assert.ok(sbom.packages.length > 1);
  assert.deepEqual(sbom.documentDescribes, ["SPDXRef-Root"]);
  assert.ok(packageFiles.files.includes("package.json"));
  assert.ok(packageFiles.files.includes("packages/retrieval/src/retriever.mjs"));
  assert.deepEqual(exactPackageManifestFailures([...packageFiles.files, "packages/core/src/unexpected-secret.txt"], packageFiles.files), ["unexpected emitted package file: packages/core/src/unexpected-secret.txt"]);
  assert.deepEqual(exactPackageManifestFailures(packageFiles.files.filter((path) => path !== "package.json"), packageFiles.files), ["missing emitted package file: package.json"]);
  assert.equal(normalizeNpmPackPath("distribution\\release\\evaluation-report.json"), "distribution/release/evaluation-report.json");
  assert.deepEqual(npmCommandInvocation({ platform: "win32", environment: { npm_execpath: "C:\\hostedtoolcache\\node\\node_modules\\npm\\bin\\npm-cli.js" }, node: "C:\\node.exe" }), { command: "C:\\node.exe", prefix: ["C:\\hostedtoolcache\\node\\node_modules\\npm\\bin\\npm-cli.js"] });
  assert.deepEqual(npmCommandInvocation({ platform: "win32", environment: { KDLC_NPM_CLI: "C:\\npm\\prefix\\node_modules\\npm\\bin\\npm-cli.js" }, node: "C:\\hostedtoolcache\\node\\node.exe" }), { command: "C:\\hostedtoolcache\\node\\node.exe", prefix: ["C:\\npm\\prefix\\node_modules\\npm\\bin\\npm-cli.js"] });
  assert.throws(() => npmCommandInvocation({ platform: "win32", environment: {}, node: "C:\\hostedtoolcache\\node\\node.exe" }), /trusted Windows npm CLI/);
  assert.throws(() => npmCommandInvocation({ platform: "win32", environment: { npm_execpath: "npm.cmd" } }), /trusted Windows npm CLI/);
  assert.deepEqual(installedMetadataFailures({ identity: { name: "example" }, entry: { version: "1.0.0" }, metadata: { name: "example", version: "1.0.1", license: "GPL-3.0" }, allowedLicenses: policy.allowed_licenses }), [
    "installed identity differs from lock: example@1.0.0", "installed license is not allowlisted: example@1.0.0 (GPL-3.0)"
  ]);
  const byName = Object.fromEntries(sbom.packages.map((item) => [item.name, item.SPDXID]));
  assert.ok(sbom.relationships.some((item) => item.spdxElementId === byName.ajv && item.relationshipType === "DEPENDS_ON" && item.relatedSpdxElement === byName["fast-deep-equal"]));
  assert.ok(sbom.relationships.some((item) => item.spdxElementId === byName.ajv && item.relationshipType === "DEV_DEPENDENCY_OF" && item.relatedSpdxElement === "SPDXRef-Root"));
  assert.ok(sbom.packages.filter(({ SPDXID }) => SPDXID !== "SPDXRef-Root").every((item) => item.externalRefs?.some(({ referenceType }) => referenceType === "kdlc:installed-manifest-sha256")));
  assert.ok(sbom.packages.filter(({ SPDXID }) => SPDXID !== "SPDXRef-Root").every((item) => item.externalRefs?.some(({ referenceType }) => referenceType === "kdlc:installed-tree-sha256")));
  const installedBytes = [{ path: "package.json", size: 2, sha256: "a".repeat(64) }];
  assert.notEqual(installedTreeHash(installedBytes), installedTreeHash([{ ...installedBytes[0], sha256: "b".repeat(64) }]));
  assert.throws(() => installedTreeHash([{ path: "../escape", size: 1, sha256: "a".repeat(64) }]), /invalid/);
});

test("REL-001 readiness record keeps final release gates explicitly open", async () => {
  const readiness = await text("docs/release-readiness.md");
  assert.match(readiness, /not a conformance statement,\s+release announcement, or evidence that REL-001 is complete/i);
  assert.match(readiness, /private vulnerability reporting/i);
  assert.match(readiness, /secret scanning, push protection, and\s+Dependabot security updates are enabled/i);
  assert.match(readiness, /non-provider secret patterns and validity checks are unavailable/i);
  assert.match(readiness, /allowed_actions` remains `all`/);
  assert.match(readiness, /Final REL-001 blockers/);
});

test("REL-001 package evidence reads are descriptor-pinned, no-follow, ancestry-bound, and leak-free", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "kdlc-supply-read-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(resolve(directory, "package"));
  await writeFile(resolve(directory, "package/metadata.json"), "trusted");
  assert.equal((await readTrustedFile(directory, "package/metadata.json")).toString(), "trusted");
  await symlink(resolve(directory, "package/metadata.json"), resolve(directory, "link.json"));
  await assert.rejects(readTrustedFile(directory, "link.json"));

  await assert.rejects(readTrustedFile(directory, "package/metadata.json", { afterOpen: async ({ target }) => {
    await rename(target, `${target}.old`);
    await symlink(resolve(directory, "link.json"), target);
  } }), /identity changed|ELOOP/);
  await rm(resolve(directory, "package/metadata.json"), { force: true });
  await rename(resolve(directory, "package/metadata.json.old"), resolve(directory, "package/metadata.json"));

  await assert.rejects(readTrustedFile(directory, "package/metadata.json", { afterOpen: async () => {
    await rename(resolve(directory, "package"), resolve(directory, "package.old"));
    await mkdir(resolve(directory, "package"));
    await writeFile(resolve(directory, "package/metadata.json"), "substituted");
  } }), process.platform === "win32" ? /EPERM|EACCES/ : /identity changed|parent identity changed/);
  if (await lstat(resolve(directory, "package.old")).then(() => true, () => false)) {
    await rm(resolve(directory, "package"), { recursive: true, force: true });
    await rename(resolve(directory, "package.old"), resolve(directory, "package"));
  }

  if (process.platform === "win32") {
    for (let attempt = 0; attempt < 20; attempt += 1) await assert.rejects(readTrustedFile(directory, "package/metadata.json", { afterOpen: async () => { throw new Error("controlled failure"); } }), /controlled failure/);
    await rename(resolve(directory, "package/metadata.json"), resolve(directory, "package/metadata.closed"));
    await rename(resolve(directory, "package/metadata.closed"), resolve(directory, "package/metadata.json"));
  } else {
    const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
    const before = (await readdir(descriptorDirectory)).length;
    for (let attempt = 0; attempt < 20; attempt += 1) await assert.rejects(readTrustedFile(directory, "package/metadata.json", { afterOpen: async () => { throw new Error("controlled failure"); } }), /controlled failure/);
    const after = (await readdir(descriptorDirectory)).length;
    assert.ok(after <= before + 1, `file descriptors leaked: before=${before}, after=${after}`);
  }
});

test("REL-001 package archive inspection rejects aliases, links, traversal, and resource abuse before extraction", async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), "kdlc-hostile-tar-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const check = async (name, entries, pattern) => { const path = resolve(directory, `${name}.tgz`); await writeFile(path, tarArchive(entries)); if (pattern) await assert.rejects(inspectPackageArchive(path), pattern); else assert.equal((await inspectPackageArchive(path)).file_count, entries.length); };
  await check("valid", [{ name: "package/index.mjs", content: "export {};\n" }]);
  await check("duplicate", [{ name: "package/a.txt" }, { name: "package/a.txt" }], /duplicate|aliased/);
  await check("case-alias", [{ name: "package/A.txt" }, { name: "package/a.txt" }], /duplicate|aliased/);
  await check("unicode-alias", [{ name: "package/Caf\u00e9.txt" }, { name: "package/Cafe\u0301.txt" }], /duplicate|aliased/);
  await check("traversal", [{ name: "package/../escape" }], /namespace/);
  await check("backslash", [{ name: "package\\escape" }], /namespace/);
  await check("symlink", [{ name: "package/link", type: "2" }], /links/);
  await check("hardlink", [{ name: "package/link", type: "1" }], /links/);
  await check("oversize", [{ name: "package/large", size: 16 * 1024 * 1024 + 1 }], /size/);
});
