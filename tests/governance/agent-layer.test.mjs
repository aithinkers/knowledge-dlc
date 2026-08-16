import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

import { loadRoleDescriptors } from "../../packages/agents/index.mjs";
import { AGENT_DEFINITIONS, renderAgentMarkdown, renderCodexAgentMarkdown, renderCodexAgentToml } from "../../packages/agents/definitions/index.mjs";

const execute = promisify(execFile);
const SPEC_ROLES = [
  "conductor",
  "curator",
  "source-analyst",
  "integrator",
  "librarian",
  "trust-reviewer",
  "retrieval-agent",
  "maintainer",
  "governance-reviewer",
];

test("FEAT-010 registry loads all nine specification §22 roles", async () => {
  const roles = await loadRoleDescriptors();
  assert.deepEqual([...roles.keys()].sort(), [...SPEC_ROLES].sort());
  for (const role of SPEC_ROLES) assert.equal(roles.get(role).actor, `kdlc-${role}/0.2.0`);
});

test("FEAT-010 write capabilities respect the §22 upper bounds", async () => {
  const roles = await loadRoleDescriptors();
  for (const reviewer of ["trust-reviewer", "governance-reviewer"]) {
    assert.equal(roles.get(reviewer).review_only, true);
    assert.deepEqual(roles.get(reviewer).permissions.write, []);
  }
  assert.deepEqual(roles.get("retrieval-agent").permissions.write, []);
  assert.deepEqual(roles.get("curator").permissions.write, ["workflow/runs/**/proposals/**"]);
  for (const drafting of ["maintainer", "integrator"]) {
    assert.deepEqual(roles.get(drafting).permissions.write, ["workflow/runs/**/proposals/**", "workflow/runs/**/drafts/**"]);
  }
});

test("FEAT-010 every role has one authored harness agent definition", () => {
  // The nine §22 workflow roles each have exactly one definition; harness-
  // level assistants (which declare their own `enforcement` text instead of a
  // runtime descriptor) may exist alongside them.
  const workflowDefinitions = AGENT_DEFINITIONS.filter(({ enforcement }) => enforcement === undefined);
  assert.deepEqual(workflowDefinitions.map(({ role }) => role), SPEC_ROLES);
  for (const assistant of AGENT_DEFINITIONS.filter(({ enforcement }) => enforcement !== undefined)) {
    assert.ok(!SPEC_ROLES.includes(assistant.role), `${assistant.role} must not shadow a workflow role`);
  }
  for (const definition of AGENT_DEFINITIONS) {
    const markdown = renderAgentMarkdown(definition);
    assert.ok(markdown.startsWith(`---\nname: ${definition.role}\n`));
    assert.ok(markdown.includes("untrusted data"), "must delimit source content per §27.1");
    assert.ok(markdown.includes("prompt text never"), "must state runtime permission enforcement");
    if (definition.role.endsWith("-reviewer")) {
      assert.ok(markdown.includes("review-only"), "reviewer prompts must state review-only constraint");
    }
  }
});

test("FEAT-012 generated Codex agents match a fresh build and keep §27.1 guidance", async () => {
  await execute(process.execPath, ["packages/adapters/generate.mjs", "--check"]);
  for (const definition of AGENT_DEFINITIONS) {
    const markdown = await readFile(`distribution/codex/.codex/agents/${definition.role}.md`, "utf8");
    const toml = await readFile(`distribution/codex/.codex/agents/${definition.role}.toml`, "utf8");
    assert.equal(markdown, renderCodexAgentMarkdown(definition));
    assert.equal(toml, renderCodexAgentToml(definition));
    for (const rendered of [markdown, toml]) {
      assert.ok(rendered.includes("untrusted data"), "must delimit source content per §27.1");
      assert.ok(rendered.includes("prompt text never"), "must state runtime permission enforcement");
      if (definition.role.endsWith("-reviewer")) assert.ok(rendered.includes("review-only"));
    }
    assert.ok(!toml.split('developer_instructions = """')[1].includes('"""\n#'), "TOML body must not terminate early");
  }
});

test("FEAT-010 generated Claude Code agents match a fresh build", async () => {
  await execute(process.execPath, ["packages/adapters/generate.mjs", "--check"]);
  const plugin = JSON.parse(await readFile("distribution/claude-code/.claude-plugin/plugin.json", "utf8"));
  // Current Claude Code auto-discovers root agents/ and commands/; the
  // manifest must not name them as slash-less directory strings (FEAT-028).
  assert.equal(plugin.agents, undefined);
  assert.equal(plugin.name, "kdlc");
  for (const { role } of AGENT_DEFINITIONS) {
    const generatedAgent = await readFile(`distribution/claude-code/agents/${role}.md`, "utf8");
    assert.equal(generatedAgent, renderAgentMarkdown(AGENT_DEFINITIONS.find((definition) => definition.role === role)));
  }
});
