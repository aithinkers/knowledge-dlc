import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CoreValidationError,
  artifactHash,
  byteHash,
  canonicalClaimSidecar,
  canonicalJson,
  canonicalMarkdownProjection,
  canonicalText,
  createMountTable,
  generateHierarchicalIndexes,
  markdownArtifactHash,
  materializeScaffold,
  parseKbReference,
  resolveContainedPath,
  resolveKbReference,
  reviewHash,
  scaffoldProject,
  validatePublishedProvenance
} from "../../packages/core/index.mjs";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/core/runtime");
const hashFixture = JSON.parse(await readFile(join(fixtureRoot, "hashes.json"), "utf8"));

function expectCode(code) {
  return (error) => error instanceof CoreValidationError && error.code === code;
}

test("FEAT-001 kdlc-c14n-1 canonical JSON and text are byte deterministic", () => {
  const document = { z: [3, -0, true, null], a: "e\u0301", nested: { b: 2, a: 1 } };
  assert.equal(canonicalJson(document), hashFixture.canonical_json);
  assert.equal(canonicalText(hashFixture.byte_input), hashFixture.canonical_text);
  assert.equal(canonicalText("alpha\nbeta\n\n"), hashFixture.canonical_text);
  assert.equal(canonicalMarkdownProjection({ frontmatter: { title: "e\u0301", type: "Policy" }, body: "line\r\n" }),
    '{"body":"line\\n","frontmatter":{"title":"é","type":"Policy"}}');
});

test("FEAT-001 byte, artifact, Markdown, and review hashes match stable fixtures", () => {
  const document = { z: [3, -0, true, null], a: "e\u0301", nested: { b: 2, a: 1 } };
  const concept = {
    frontmatter: { type: "Policy", title: "Authentication", status: "stable", generated: { at: "ignored" } },
    body: "# Authentication\r\n"
  };
  assert.equal(byteHash(hashFixture.byte_input), hashFixture.byte_hash);
  assert.equal(artifactHash(document), hashFixture.artifact_hash);
  assert.equal(reviewHash(concept), hashFixture.review_hash);
  assert.equal(markdownArtifactHash({ frontmatter: concept.frontmatter, body: concept.body }), markdownArtifactHash({
    frontmatter: { generated: { at: "ignored" }, status: "stable", title: "Authentication", type: "Policy" },
    body: "# Authentication\n\n"
  }));
});

test("FEAT-001 canonicalization rejects ambiguous or unsupported values", () => {
  assert.throws(() => canonicalJson({ value: Number.NaN }), expectCode("KDLC_CANONICAL_INVALID"));
  assert.throws(() => canonicalJson({ value: undefined }), expectCode("KDLC_CANONICAL_INVALID"));
  assert.throws(() => canonicalJson([, 1]), expectCode("KDLC_CANONICAL_INVALID"));
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), expectCode("KDLC_CANONICAL_INVALID"));
  assert.throws(() => canonicalJson({ "é": 1, "e\u0301": 2 }), expectCode("KDLC_CANONICAL_COLLISION"));
  assert.throws(() => canonicalJson({ value: "\ud800" }), expectCode("KDLC_CANONICAL_INVALID"));
  assert.throws(() => canonicalText("\udc00"), expectCode("KDLC_CANONICAL_INVALID"));
});

test("FEAT-001 mount tables and kb references resolve stable identities", async () => {
  const root = join(fixtureRoot, "mount-a");
  const table = await createMountTable([{ id: "acme.security", name: "security", root, version: "2.4.0" }]);
  assert.equal(table.getByName("security").id, "acme.security");
  assert.deepEqual(parseKbReference("kb://acme.security@2.4.0/policies/authentication"), {
    id: "acme.security", version: "2.4.0", conceptId: "policies/authentication"
  });
  const resolved = await resolveKbReference("kb://acme.security@2.4.0/policies/authentication", table);
  assert.equal(resolved.path, join(root, "policies/authentication.md"));
  assert.deepEqual(resolved.aliasChain, ["kb://acme.security/policies/authentication"]);
});

test("FEAT-001 mount and kb resolution reject duplicate IDs, traversal, symlink escape, and version drift", async () => {
  const root = join(fixtureRoot, "mount-a");
  await assert.rejects(createMountTable([
    { id: "acme.security", name: "one", root },
    { id: "acme.security", name: "two", root }
  ]), expectCode("KDLC_DUPLICATE_KB_ID"));
  await assert.rejects(createMountTable([{ id: "ACME.Security", name: "security", root }]), expectCode("KDLC_MOUNT_INVALID"));
  const table = await createMountTable([{ id: "acme.security", name: "security", root, version: "2.4.0" }]);
  await assert.rejects(resolveKbReference("kb://acme.security/policies/%2e%2e/outside", table), expectCode("KDLC_REFERENCE_TRAVERSAL"));
  await assert.rejects(resolveKbReference("kb://acme.security@9.0.0/policies/authentication", table), expectCode("KDLC_KB_VERSION_MISMATCH"));

  const temporary = await mkdtemp(join(tmpdir(), "kdlc-resolver-"));
  try {
    const mount = join(temporary, "mount");
    await mkdir(mount);
    await symlink(join(fixtureRoot, "outside.md"), join(mount, "escape.md"));
    await assert.rejects(resolveContainedPath(mount, "escape.md"), expectCode("KDLC_REFERENCE_TRAVERSAL"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("FEAT-001 alias resolution follows bounded chains and rejects cycles", async () => {
  const root = join(fixtureRoot, "mount-a");
  const table = await createMountTable([{ id: "acme.security", name: "security", root }]);
  const aliases = new Map([
    ["kb://acme.security/policies/old", "policies/older"],
    ["kb://acme.security/policies/older", "policies/replacement"]
  ]);
  const resolved = await resolveKbReference("kb://acme.security/policies/old", table, { aliases });
  assert.equal(resolved.conceptId, "policies/replacement");
  assert.equal(resolved.aliasChain.length, 3);
  aliases.set("kb://acme.security/policies/replacement", "policies/old");
  await assert.rejects(resolveKbReference("kb://acme.security/policies/old", table, { aliases }), expectCode("KDLC_ALIAS_CYCLE"));
});

test("FEAT-001 project and base scaffolds are deterministic and materialize without overwriting", async () => {
  const first = scaffoldProject({ name: "payments", title: "Payments", knowledgeBaseId: "acme.payments" });
  const second = scaffoldProject({ name: "payments", title: "Payments", knowledgeBaseId: "acme.payments" });
  assert.deepEqual([...first], [...second]);
  assert.deepEqual([...first.keys()], [
    "knowledge-project.yaml",
    "knowledge/primary/index.md",
    "knowledge/primary/knowledge-base.yaml",
    "purpose.md"
  ]);
  const temporary = await mkdtemp(join(tmpdir(), "kdlc-scaffold-"));
  try {
    await materializeScaffold(temporary, first);
    assert.equal(await readFile(join(temporary, "knowledge/primary/index.md"), "utf8"), first.get("knowledge/primary/index.md"));
    await assert.rejects(materializeScaffold(temporary, first), (error) => error.code === "EEXIST");
    await assert.rejects(materializeScaffold(temporary, new Map([["../escape", "bad"]])), expectCode("KDLC_SCAFFOLD_PATH"));
    const outside = await mkdtemp(join(tmpdir(), "kdlc-scaffold-outside-"));
    try {
      await symlink(outside, join(temporary, "linked"));
      await assert.rejects(materializeScaffold(temporary, new Map([["linked/escape", "bad"]])), expectCode("KDLC_SCAFFOLD_PATH"));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  assert.throws(() => scaffoldProject({ name: "../unsafe" }), expectCode("KDLC_PROJECT_NAME_INVALID"));
});

test("FEAT-001 hierarchical OKF indexes are reproducible, relative, escaped, and sorted", async () => {
  const concepts = [
    { path: "concepts/zulu.md", title: "Zulu", description: "Last." },
    { path: "overview.md", title: "Overview", description: "Root overview." },
    { path: "concepts/alpha.md", title: "A [safe] title", description: "First.\nStill first." },
    { path: "concepts/nested/item.md", title: "Nested Item" }
  ];
  const indexes = generateHierarchicalIndexes(concepts);
  assert.equal(indexes.get("index.md"), await readFile(join(fixtureRoot, "expected-root-index.md"), "utf8"));
  assert.match(indexes.get("concepts/index.md"), /\* \[A \\[safe\\\] title\]\(alpha\.md\) - First\. Still first\.[\s\S]*\* \[Nested\]\(nested\/\)[\s\S]*\* \[Zulu\]\(zulu\.md\)/);
  assert.equal(indexes.get("concepts/nested/index.md").endsWith("\n"), true);
  assert.deepEqual([...generateHierarchicalIndexes([...concepts].reverse())], [...indexes]);
  assert.throws(() => generateHierarchicalIndexes([{ path: "../escape.md", title: "bad" }]), expectCode("KDLC_INDEX_PATH_INVALID"));
  assert.throws(() => generateHierarchicalIndexes([{ path: "index.md", title: "bad" }]), expectCode("KDLC_INDEX_PATH_INVALID"));
  assert.throws(() => generateHierarchicalIndexes([concepts[0], concepts[0]]), expectCode("KDLC_DUPLICATE_CONCEPT"));
});

function validProvenance() {
  const sourceHash = byteHash("reviewed source bytes");
  const claims = [{
    id: "clm-1",
    assertion_key: "policies/authentication#token-lifetime",
    assertion: "Tokens are short-lived.",
    source_entry_id: "auth-standard",
    source_record_id: "src-auth",
    source_hash: sourceHash,
    locator: { heading: "Lifetime" },
    extraction: "explicit",
    disposition: "accepted"
  }];
  const concept = {
    id: "policies/authentication",
    frontmatter: {
      type: "Policy",
      status: "stable",
      sources: [{
        id: "auth-standard",
        resource: "/references/sources/src-auth.md",
        source_record_id: "src-auth",
        source_hash: sourceHash
      }],
      claim_provenance: {
        resource: "/references/claims/policies/authentication.jsonl",
        artifact_hash: artifactHash(canonicalClaimSidecar(claims))
      }
    },
    body: "Tokens are short-lived.[^auth-standard]\n\n[^auth-standard]: Authentication Standard\n"
  };
  return { concept, claims, sourceHash, sourceRecords: new Map([["src-auth", sourceHash]]) };
}

test("FEAT-001 published citations and governed claim sidecars validate exact provenance", () => {
  assert.equal(validatePublishedProvenance(validProvenance()), true);
  const fixture = validProvenance();
  fixture.claims.push({ ...fixture.claims[0], id: "clm-2", assertion_key: "policies/authentication#another" });
  fixture.concept.frontmatter.claim_provenance.artifact_hash = artifactHash(canonicalClaimSidecar(fixture.claims));
  assert.equal(validatePublishedProvenance(fixture), true);
  const codeExample = validProvenance();
  codeExample.concept.body += "\n```markdown\nnot attribution[^unknown]\n```\n`also[^unknown]`\n";
  assert.equal(validatePublishedProvenance(codeExample), true);
});

test("FEAT-001 provenance validation fails closed on citations, resources, hashes, and sidecars", () => {
  const missingCitation = validProvenance();
  missingCitation.concept.body += "Unknown.[^missing]\n";
  assert.throws(() => validatePublishedProvenance(missingCitation), expectCode("KDLC_CITATION_INVALID"));

  const localSource = validProvenance();
  localSource.concept.frontmatter.sources[0].resource = "sources/records/src-auth.yaml";
  assert.throws(() => validatePublishedProvenance(localSource), expectCode("KDLC_PROVENANCE_NOT_DURABLE"));
  const rootLocalSource = validProvenance();
  rootLocalSource.concept.frontmatter.sources[0].resource = "/sources/records/src-auth.yaml";
  assert.throws(() => validatePublishedProvenance(rootLocalSource), expectCode("KDLC_PROVENANCE_NOT_DURABLE"));
  const traversal = validProvenance();
  traversal.concept.frontmatter.sources[0].resource = "../../secret.md";
  assert.throws(() => validatePublishedProvenance(traversal), expectCode("KDLC_PROVENANCE_NOT_DURABLE"));

  const sourceDrift = validProvenance();
  sourceDrift.sourceRecords.set("src-auth", byteHash("changed"));
  assert.throws(() => validatePublishedProvenance(sourceDrift), expectCode("KDLC_SOURCE_HASH_MISMATCH"));
  const missingRecord = validProvenance();
  missingRecord.sourceRecords.clear();
  assert.throws(() => validatePublishedProvenance(missingRecord), expectCode("KDLC_SOURCE_RECORD_MISSING"));

  const sidecarDrift = validProvenance();
  sidecarDrift.claims[0].assertion = "Changed after hashing.";
  assert.throws(() => validatePublishedProvenance(sidecarDrift), expectCode("KDLC_CLAIM_SIDECAR_HASH"));
  const badClaim = validProvenance();
  badClaim.claims[0].assertion_key = "position-1";
  badClaim.concept.frontmatter.claim_provenance.artifact_hash = artifactHash(canonicalClaimSidecar(badClaim.claims));
  assert.throws(() => validatePublishedProvenance(badClaim), expectCode("KDLC_CLAIM_SIDECAR_INVALID"));

  const noSidecar = validProvenance();
  delete noSidecar.concept.frontmatter.claim_provenance;
  assert.throws(() => validatePublishedProvenance(noSidecar), expectCode("KDLC_CLAIM_SIDECAR_MISSING"));
  assert.equal(validatePublishedProvenance({ ...noSidecar, profile: "personal" }), true);

  const emptySidecar = validProvenance();
  emptySidecar.claims = [];
  emptySidecar.concept.frontmatter.claim_provenance.artifact_hash = artifactHash([]);
  assert.throws(() => validatePublishedProvenance(emptySidecar), expectCode("KDLC_CLAIM_SIDECAR_INVALID"));
  const badExtraction = validProvenance();
  badExtraction.claims[0].extraction = "model-guessed";
  badExtraction.concept.frontmatter.claim_provenance.artifact_hash = artifactHash(canonicalClaimSidecar(badExtraction.claims));
  assert.throws(() => validatePublishedProvenance(badExtraction), expectCode("KDLC_CLAIM_SIDECAR_INVALID"));
});
