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
  // The Claude Code palette carries the human tier only (FEAT-036) with
  // plugin-namespace-friendly names; other operations remain runner-invocable
  // and are exercised through the kiro surfaces below.
  assert.ok((await readFile(join(root, "distribution/claude-code/commands/start.md"), "utf8")).includes("pick up where we left off"));
  for (const command of ["init", "ingest", "query", "publish", "revisit", "status", "doctor"]) {
    const claude = await readFile(join(root, "distribution/claude-code/commands", `${command}.md`), "utf8");
    assert.ok(!claude.startsWith("---\ndescription: Run the governed"), `${command}: description is plain language`);
    for (const marker of ["**When to use:**", "**What you give it:**", "**What you get back:**", "**Usually next:**"]) {
      assert.ok(claude.includes(marker), `${command}: ${marker}`);
    }
    assert.ok(claude.includes(`"distribution/claude-code/run.mjs", "${command}", "--output", "json"`), `${command}: binding intact`);
  }
  for (const command of distributionDefinition.cli_commands.filter((name) => name !== "setup")) {
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

test("FEAT-040: the Kiro IDE surface carries the protective parity tier — hooks, front door, hardened manifests", async () => {
  // Native hooks: orientation and the pre-write guard, wired as .kiro.hook.
  for (const hook of ["kdlc-orient", "kdlc-guard"]) {
    const manifest = JSON.parse(await readFile(join(root, `distribution/kiro-ide/.kiro/hooks/${hook}.kiro.hook`), "utf8"));
    assert.equal(manifest.enabled, true);
    assert.equal(manifest.then.command, `node .kiro/hooks/${hook}.mjs`);
  }
  assert.equal(JSON.parse(await readFile(join(root, "distribution/kiro-ide/.kiro/hooks/kdlc-guard.kiro.hook"), "utf8")).when.type, "preToolUse");
  // IDE 1.x silently ignores .kiro.hook — the v2 .json registration is the
  // live one there, so both hooks must be dual-registered (review CRITICAL).
  const guardV2 = JSON.parse(await readFile(join(root, "distribution/kiro-ide/.kiro/hooks/kdlc-guard.json"), "utf8"));
  assert.equal(guardV2.version, "v1");
  assert.equal(guardV2.hooks[0].trigger, "PreToolUse");
  assert.equal(guardV2.hooks[0].action.command, "node .kiro/hooks/kdlc-guard.mjs");
  const orientV2 = JSON.parse(await readFile(join(root, "distribution/kiro-ide/.kiro/hooks/kdlc-orient.json"), "utf8"));
  assert.equal(orientV2.hooks[0].trigger, "UserPromptSubmit");
  // The guard blocks governed paths and fails open on unknown payloads.
  const { execFileSync } = await import("node:child_process");
  const guard = join(root, "distribution/kiro-ide/.kiro/hooks/kdlc-guard.mjs");
  const run = (payload) => {
    try {
      execFileSync("node", [guard], { input: payload, stdio: ["pipe", "pipe", "pipe"] });
      return { code: 0, stderr: "" };
    } catch (error) {
      return { code: error.status, stderr: String(error.stderr) };
    }
  };
  const blocked = run(JSON.stringify({ tool_name: "fs_write", tool_input: { path: "knowledge-bases/x/concepts/y.md" } }));
  assert.equal(blocked.code, 2);
  assert.match(blocked.stderr, /bypass review/);
  assert.equal(run("not json").code, 0, "unknown payloads fail open");
  assert.equal(run(JSON.stringify({ tool_name: "fs_write", tool_input: { path: "notes/todo.md" } })).code, 0, "ungoverned paths pass");
  // 0.12 channel: payload rides USER_PROMPT (camelCase toolArgs), stdin never
  // closes — the guard must still block without hanging (review CRITICAL).
  const legacy = (() => {
    try {
      execFileSync("node", [guard], {
        input: "", stdio: ["pipe", "pipe", "pipe"], timeout: 10_000,
        env: { ...process.env, USER_PROMPT: JSON.stringify({ toolName: "fs_write", toolArgs: { path: "knowledge-bases/x/y.md" } }) }
      });
      return { code: 0, stderr: "" };
    } catch (error) {
      return { code: error.status, stderr: String(error.stderr) };
    }
  })();
  assert.equal(legacy.code, 2, "legacy USER_PROMPT channel still blocks");
  assert.match(legacy.stderr, /bypass review/);
  // Front-door agent routes to the start routine with confined tools.
  const door = JSON.parse(await readFile(join(root, "distribution/kiro-ide/.kiro/agents/kdlc.json"), "utf8"));
  assert.equal(door.name, "kdlc");
  assert.deepEqual(door.toolsSettings.fs_write.allowedPaths, [".kdlc/**", "workspace/**"]);
  // The front door's regexes must be byte-identical to the role agents'
  // (an over-escaped copy once shipped broken patterns — review round 2).
  const conductorManifest = JSON.parse(await readFile(join(root, "distribution/kiro-ide/.kiro/agents/conductor.json"), "utf8"));
  assert.deepEqual(door.toolsSettings.execute_bash, conductorManifest.toolsSettings.execute_bash);
  assert.ok(door.toolsSettings.execute_bash.deniedCommands.some((rule) => new RegExp(`^(?:${rule})$`).test("rm subdir --recursive")), "long-form recursive delete is denied");
  // Every role manifest declares resources and the hardened settings.
  for (const definition of AGENT_DEFINITIONS) {
    const manifest = JSON.parse(await readFile(join(root, `distribution/kiro-ide/.kiro/agents/${definition.role}.json`), "utf8"));
    assert.deepEqual(manifest.resources, [`file://.kiro/agents/${definition.role}.md`, "file://AGENTS.md", "file://guides/*.md"], definition.role);
    if (manifest.toolsSettings) {
      assert.ok(manifest.toolsSettings.execute_bash.deniedCommands.some((rule) => rule.includes("push")), `${definition.role} denies git push`);
      assert.deepEqual(manifest.toolsSettings.fs_write.allowedPaths, [".kdlc/**", "workspace/**"], `${definition.role} confines writes`);
    }
  }
});
