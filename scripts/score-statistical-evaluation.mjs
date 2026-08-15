#!/usr/bin/env node
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { loadCaptures, scoreCaptures } from "./statistical-evidence-validation.mjs";

const [capturesFlag, directory, outputFlag, output] = process.argv.slice(2);
if (capturesFlag !== "--captures" || !directory || outputFlag !== "--output" || !output) throw new Error("usage: node scripts/score-statistical-evaluation.mjs --captures <directory> --output <report.json>");
const report = await scoreCaptures(process.cwd(), await loadCaptures(resolve(directory)));
const handle = await open(resolve(output), "wx", 0o600); try { await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`); } finally { await handle.close(); }
console.log(`Scored 30 complete preregistered trials offline: ${report.gate}.`);
