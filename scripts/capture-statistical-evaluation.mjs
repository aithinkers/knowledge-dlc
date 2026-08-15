#!/usr/bin/env node
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadPreregistration, validateCapture } from "./statistical-evidence-validation.mjs";

const [inputFlag, input, outputFlag, output] = process.argv.slice(2);
if (inputFlag !== "--input" || !input || outputFlag !== "--output" || !output) throw new Error("usage: node scripts/capture-statistical-evaluation.mjs --input <provider-capture.json> --output <trial-NNN.json>");
const root = process.cwd(); const state = await loadPreregistration(root);
if (state.documents.model.status !== "frozen") throw new Error("capture blocked: exact provider, model, and revision inputs are not frozen; no provider call was made");
const capture = JSON.parse(await readFile(resolve(input), "utf8")); await validateCapture(root, capture);
if (!resolve(output).endsWith(`${capture.trial_id}.json`)) throw new Error("output filename must equal the bound trial ID");
const handle = await open(resolve(output), "wx", 0o600);
try { await handle.writeFile(`${JSON.stringify(capture, null, 2)}\n`); } finally { await handle.close(); }
console.log(`Imported immutable provider capture ${capture.trial_id}; this script made no network or model call.`);
