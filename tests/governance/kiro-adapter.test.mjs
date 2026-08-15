import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

import { AGENT_DEFINITIONS, renderKiroAgentManifest, renderKiroAgentPrompt } from "../../packages/agents/definitions/index.mjs";
import { CLI_COMMANDS } from "../../packages/cli/index.mjs";

const execute = promisify(execFile);
const HARNESSES = ["kiro", "kiro-ide"];

test("FEAT-013 generated Kiro trees match a fresh build", async () => {
  await execute(process.execPath, ["packages/adapters/generate.mjs", "--check"]);
});

test("FEAT-013 every CLI operation has a Kiro skill bound to the governed runner", async () => {
  for (const harness of HARNESSES) {
    for (const command of CLI_COMMANDS) {
      const skill = await readFile(`distribution/${harness}/.kiro/skills/kdlc-${command}/SKILL.md`, "utf8");
      assert.ok(skill.startsWith(`---\nname: kdlc-${command}\n`));
      assert.ok(skill.includes(`"distribution/${harness}/run.mjs", "${command}"`), "skill must invoke the governed runner");
      assert.ok(skill.includes("do not infer success"), "skill must preserve the envelope contract");
    }
    const runner = await readFile(`distribution/${harness}/run.mjs`, "utf8");
    assert.ok(runner.includes("packages/cli/bin.mjs"), "runner must delegate to the governed CLI");
  }
});

test("FEAT-013 Kiro agent manifests keep §22 capability posture and §27.1 guidance", async () => {
  for (const harness of HARNESSES) {
    for (const definition of AGENT_DEFINITIONS) {
      const manifest = JSON.parse(await readFile(`distribution/${harness}/.kiro/agents/${definition.role}.json`, "utf8"));
      const expected = renderKiroAgentManifest(definition, { harness });
      assert.deepEqual(manifest, JSON.parse(JSON.stringify(expected)));
      const readOnly = definition.role.endsWith("-reviewer") || definition.role === "retrieval-agent";
      if (readOnly) {
        assert.ok(!manifest.tools.includes("fs_write") && !manifest.tools.includes("execute_bash"), `${definition.role} must not carry write or shell tools`);
      } else {
        assert.match(manifest.toolsSettings.execute_bash.allowedCommands[0], /run\\\.mjs/u, "shell access is limited to the governed runner");
      }
      assert.deepEqual(manifest.allowedTools, ["fs_read", "thinking"], "auto-approved tools stay read-only");
      const prompt = await readFile(`distribution/${harness}/.kiro/agents/${definition.role}.md`, "utf8");
      assert.equal(prompt, renderKiroAgentPrompt(definition));
      assert.ok(prompt.includes("untrusted data"), "must delimit source content per §27.1");
    }
  }
});
