#!/usr/bin/env node
// REL-002 (#57): produce the 30 preregistered provider capture trials.
// This producer sits OUTSIDE the trusted import path: it calls the provider,
// assembles capture documents, and hands each one to
// scripts/capture-statistical-evaluation.mjs, which re-validates everything
// against the frozen preregistration before writing an immutable trial file.
// Requires ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in the environment.
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { loadPreregistration, providerRequestBytes, sha256 } from "./statistical-evidence-validation.mjs";

const execute = promisify(execFile);
const root = process.cwd();
const capturesDirectory = resolve(root, "distribution/release/statistical/captures");
const apiKey = process.env.ANTHROPIC_API_KEY;
const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
if (!apiKey && !authToken) throw new Error("Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN before capturing");

const state = await loadPreregistration(root);
if (state.documents.model.status !== "frozen") throw new Error("model manifest must be frozen before capture");
const { provider, revision, temperature } = state.documents.model.configuration;
if (provider !== "anthropic") throw new Error(`unsupported provider: ${provider}`);

// Structured outputs reject oneOf; the frozen response contract uses it for
// locators. The HTTP request uses an anyOf projection purely to constrain
// decoding — the recorded canonical request bytes come from
// providerRequestBytes() and are unaffected.
const UNSUPPORTED_CONSTRAINTS = new Set(["minimum", "maximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems"]);
function anyOfProjection(node) {
  if (Array.isArray(node)) return node.map(anyOfProjection);
  if (node && typeof node === "object") {
    const output = {};
    for (const [key, value] of Object.entries(node)) {
      if (UNSUPPORTED_CONSTRAINTS.has(key)) continue;
      output[key === "oneOf" ? "anyOf" : key] = anyOfProjection(value);
    }
    return output;
  }
  return node;
}
const responseFormat = anyOfProjection(state.documents.prompt.configuration.response_schema);

async function callProvider(publicCase) {
  // Claude 5-series models reject sampling parameters; the frozen manifest's
  // temperature remains preregistration metadata in the recorded request bytes.
  const sendTemperature = !/claude-(?:sonnet|opus|fable|mythos)-5/u.test(revision);
  const body = {
    model: revision,
    max_tokens: 2048,
    ...(sendTemperature ? { temperature } : {}),
    system: state.documents.prompt.configuration.template,
    output_config: { format: { type: "json_schema", schema: responseFormat } },
    messages: [{ role: "user", content: JSON.stringify({ input: publicCase.input, context: publicCase.context }) }],
  };
  const headers = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    ...(apiKey ? { "x-api-key": apiKey } : { authorization: `Bearer ${authToken}`, "anthropic-beta": "oauth-2025-04-20" }),
  };
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(body) });
    if (response.status === 429 || response.status >= 500) {
      const wait = Number(response.headers.get("retry-after")) || attempt * 15;
      await new Promise((tick) => setTimeout(tick, wait * 1000));
      continue;
    }
    if (!response.ok) throw new Error(`provider error ${response.status}: ${(await response.text()).slice(0, 400)}`);
    const message = await response.json();
    const text = (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
    return { providerRequestId: message.id, rawOutput: text };
  }
  throw new Error("provider retries exhausted");
}

await mkdir(capturesDirectory, { recursive: true });
for (let trial = 1; trial <= 30; trial += 1) {
  const trialId = `trial-${String(trial).padStart(3, "0")}`;
  const outputPath = resolve(capturesDirectory, `${trialId}.json`);
  try { await readFile(outputPath); console.log(`${trialId}: already captured, skipping`); continue; } catch {}
  const results = [];
  for (let index = 0; index < state.documents.corpus.cases.length; index += 1) {
    const publicCase = state.documents.corpus.cases[index];
    const request = providerRequestBytes(state, { input: publicCase.input, context: publicCase.context });
    const { providerRequestId, rawOutput } = await callProvider(publicCase);
    let parsed;
    try { parsed = JSON.parse(rawOutput); } catch { throw new Error(`${trialId}/${publicCase.case_key}: provider returned non-JSON output`); }
    results.push({
      case_key: publicCase.case_key,
      provider_request_id: providerRequestId,
      request,
      request_hash: sha256(request),
      raw_output: rawOutput,
      raw_output_hash: sha256(rawOutput),
      response: parsed,
    });
    process.stdout.write(`${trialId} ${publicCase.case_key} ok\n`);
  }
  const capture = {
    api_version: "kdlc.dev/statistical-capture/v1alpha1",
    trial_id: trialId,
    captured_at: new Date().toISOString(),
    corpus_hash: state.hashes.corpus,
    evaluator_gold_hash: state.hashes.gold,
    profile_hash: state.hashes.profile,
    manifest_hashes: state.documents.profile.manifest_hashes,
    results,
    exclusions: [],
  };
  const pending = resolve(capturesDirectory, `.pending-${trialId}.json`);
  await writeFile(pending, `${JSON.stringify(capture)}\n`);
  await execute(process.execPath, ["scripts/capture-statistical-evaluation.mjs", "--input", pending, "--output", outputPath], { cwd: root });
  await rm(pending);
  console.log(`${trialId}: imported via trusted capture path`);
}
console.log("All 30 trials captured.");
