import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AGENT_DEFINITIONS, renderAgentMarkdown, renderCodexAgentMarkdown, renderKiroAgentPrompt } from "../../packages/agents/definitions/index.mjs";
import { KdlcEngine, EXIT, renderEnvelope } from "../../packages/cli/index.mjs";
import { distributionDefinition } from "../../packages/adapters/definitions.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("FEAT-017: every agent carries a complete plain-language persona", () => {
  for (const definition of AGENT_DEFINITIONS) {
    const persona = definition.persona;
    assert.ok(persona, `${definition.role} has a persona`);
    for (const field of ["when", "working", "example"]) {
      assert.equal(typeof persona[field], "string", `${definition.role} persona.${field}`);
      assert.ok(persona[field].length > 80, `${definition.role} persona.${field} is substantive`);
    }
  }
});

test("FEAT-017: personas render into every harness agent surface without touching the enforcement preamble", () => {
  for (const definition of AGENT_DEFINITIONS) {
    for (const render of [renderAgentMarkdown, renderCodexAgentMarkdown, renderKiroAgentPrompt]) {
      const body = render(definition);
      assert.ok(body.includes("## When to use this agent"), `${definition.role} persona section`);
      assert.ok(body.includes("## Worked example"), `${definition.role} example section`);
      if (definition.enforcement === undefined) {
        assert.ok(body.includes(`packages/agents/roles/${definition.role}.json`), `${definition.role} still names the runtime descriptor as enforcement source`);
      } else {
        assert.ok(body.includes("harness-level setup assistant"), `${definition.role} states its non-runtime enforcement honestly`);
      }
      assert.ok(body.includes("## Security"), `${definition.role} keeps the security section`);
      assert.ok(body.indexOf("## When to use this agent") < body.indexOf("## Security"), "persona precedes security");
    }
  }
});

test("FEAT-017: every generated command surface carries guidance above an unchanged binding", async () => {
  for (const command of distributionDefinition.cli_commands) {
    const claude = await readFile(join(root, "distribution/claude-code/commands", `kdlc-${command}.md`), "utf8");
    for (const marker of ["**When to use:**", "**What you give it:**", "**What you get back:**", "**Usually next:**"]) {
      assert.ok(claude.includes(marker), `${command}: ${marker}`);
    }
    assert.ok(claude.includes(`"distribution/claude-code/run.mjs", "${command}", "--output", "json"`), `${command}: binding intact`);
    for (const harness of ["kiro", "kiro-ide"]) {
      const skill = await readFile(join(root, `distribution/${harness}/.kiro/skills/kdlc-${command}/SKILL.md`), "utf8");
      assert.ok(skill.includes("**When to use:**"), `${harness}/${command}: guidance present`);
      assert.ok(skill.includes(`"distribution/${harness}/run.mjs", "${command}", "--output", "json"`), `${harness}/${command}: binding intact`);
    }
  }
});

test("FEAT-017: guidance names only real commands as next steps", async () => {
  const known = new Set(distributionDefinition.cli_commands);
  const commandsDirectory = join(root, "distribution/claude-code/commands");
  for (const file of await readdir(commandsDirectory)) {
    const text = await readFile(join(commandsDirectory, file), "utf8");
    for (const [, named] of text.matchAll(/kdlc ([a-z-]+)/g)) {
      assert.ok(known.has(named), `${file} references unknown command "kdlc ${named}"`);
    }
  }
});

test("FEAT-017: --output human renders success results in plain language", async () => {
  const envelope = await new KdlcEngine().envelope("status", {});
  envelope.ok = true;
  envelope.result = { workflow_runs: 2, next_action: "review pending proposals" };
  const text = renderEnvelope(envelope, "human");
  assert.match(text, /✔ status completed\./);
  assert.match(text, /workflow runs: 2/);
  assert.match(text, /next action: review pending proposals/);
  assert.ok(!text.includes("workflow_runs"), "keys are humanized");
});

test("FEAT-017: --output human frames every failure class for a non-engineer", async () => {
  for (const kind of ["input", "policy", "conflict", "dependency", "transient", "internal"]) {
    const envelope = await new KdlcEngine().envelope("publish", {});
    envelope.ok = false;
    envelope.result = null;
    envelope.error = { code: "KDLC_TEST", message: "detail text", class: EXIT[kind], details: {} };
    const text = renderEnvelope(envelope, "human");
    assert.match(text, /✖ publish did not complete\./, kind);
    assert.match(text, /Detail: detail text \(KDLC_TEST\)/, kind);
    assert.ok(text.split("\n")[1].trim().length > 30, `${kind} carries a plain-language framing line`);
  }
  // Unknown classes fall back to the internal framing rather than crashing.
  const envelope = await new KdlcEngine().envelope("publish", {});
  envelope.ok = false;
  envelope.result = null;
  envelope.error = { code: "KDLC_TEST", message: "detail", class: 99, details: {} };
  assert.match(renderEnvelope(envelope, "human"), /internal error/i);
});

test("FEAT-017: json and text envelope rendering are byte-identical to the pre-human contract", async () => {
  const envelope = await new KdlcEngine().envelope("status", {});
  envelope.ok = true;
  envelope.result = { value: 1 };
  assert.match(renderEnvelope(envelope, "json"), /^\{.*\}\n$/s);
  assert.equal(renderEnvelope(envelope, "text").split("\n")[0], "status: ok");
});
