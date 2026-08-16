import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const guard = join(root, "distribution/claude-code/hooks/guard.mjs");
const orient = join(root, "distribution/claude-code/hooks/orient.mjs");

function runGuard(payload, cwd = root) {
  try {
    execFileSync("node", [guard], { input: JSON.stringify(payload), cwd });
    return { blocked: false };
  } catch (error) {
    return { blocked: true, status: error.status, stderr: String(error.stderr) };
  }
}

test("FEAT-018: guard blocks direct edits to governed paths, including normalization tricks", () => {
  for (const path of [
    "knowledge-bases/main/concepts/c.json",
    "knowledge-bases\\published\\c.md",
    "knowledge-bases//x.json",
    "./knowledge-bases/x",
    "docs/../knowledge-bases/x",
    "KNOWLEDGE-BASES/x.json",
    "Knowledge-Bases/main/c.json",
    "workflow/runs/r1/receipts/a.json",
    "Workflow/runs/r1.json",
  ]) {
    const result = runGuard({ tool_name: "Edit", tool_input: { file_path: path } });
    assert.equal(result.blocked, true, path);
    assert.equal(result.status, 2, path);
    assert.match(result.stderr, /kdlc reconcile-edits/, "reason names the recovery command");
    assert.doesNotMatch(result.stderr, /KDLC_[A-Z]/, "reason carries no rule codes");
  }
});

test("FEAT-018: guard allows ordinary work and non-edit tools", () => {
  assert.equal(runGuard({ tool_name: "Edit", tool_input: { file_path: "src/app.js" } }).blocked, false);
  assert.equal(runGuard({ tool_name: "Edit", tool_input: { file_path: "../elsewhere/knowledge-bases/x" } }).blocked, false, "paths outside the project are not this project's state");
  assert.equal(runGuard({ tool_name: "Read", tool_input: { file_path: "knowledge-bases/x" } }).blocked, false, "reading governed state is fine");
  assert.equal(runGuard({ tool_name: "Edit", tool_input: {} }).blocked, false, "missing path fails open");
});

test("FEAT-018: guard fails open on malformed input rather than breaking the session", () => {
  try {
    execFileSync("node", [guard], { input: "not json", cwd: root });
  } catch {
    assert.fail("malformed stdin must not block");
  }
});

test("FEAT-018: orient prints a plain-language bearing and never fails", () => {
  const out = execFileSync("node", [orient], { cwd: root }).toString();
  assert.ok(out.length > 0, "orientation printed");
  assert.doesNotMatch(out, /KDLC_[A-Z]/, "no rule codes at the surface");
});

test("FEAT-018: hooks manifest wires both hooks via the plugin root", async () => {
  const manifest = JSON.parse(await readFile(join(root, "distribution/claude-code/hooks/hooks.json"), "utf8"));
  const commands = JSON.stringify(manifest);
  assert.match(commands, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/orient\.mjs/);
  assert.match(commands, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/guard\.mjs/);
  assert.equal(manifest.hooks.PreToolUse[0].matcher, "Write|Edit|MultiEdit|NotebookEdit");
});

test("FEAT-018: workflow guides are generated into every harness tree and name only real commands", async () => {
  const { distributionDefinition } = await import("../../packages/adapters/definitions.mjs");
  const known = new Set(distributionDefinition.cli_commands);
  const slugs = ["bringing-knowledge-in", "review-and-publish", "asking-questions", "keeping-it-healthy", "when-something-is-wrong"];
  for (const harness of ["claude-code", "codex", "kiro", "kiro-ide"]) {
    for (const slug of slugs) {
      const text = await readFile(join(root, `distribution/${harness}/guides/${slug}.md`), "utf8");
      assert.ok(text.startsWith("<!-- generated:"), `${harness}/${slug} marked generated`);
      for (const [, named] of text.matchAll(/\*\*kdlc ([a-z-]+)\*\*/g)) {
        assert.ok(known.has(named), `${harness}/${slug} references unknown command "kdlc ${named}"`);
      }
    }
  }
});

test("FEAT-018: every new emitted file is declared in the supply-chain manifest", async () => {
  const manifest = JSON.parse(await readFile(join(root, "security/npm-package-files.json"), "utf8"));
  const declared = new Set(Array.isArray(manifest) ? manifest : manifest.files);
  const expected = ["distribution/claude-code/hooks/hooks.json", "distribution/claude-code/hooks/orient.mjs", "distribution/claude-code/hooks/guard.mjs"];
  for (const harness of ["claude-code", "codex", "kiro", "kiro-ide"])
    for (const slug of ["bringing-knowledge-in", "review-and-publish", "asking-questions", "keeping-it-healthy", "when-something-is-wrong"])
      expected.push(`distribution/${harness}/guides/${slug}.md`);
  for (const path of expected) assert.ok(declared.has(path), path);
});
