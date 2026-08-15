#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { releaseMatrixCells, releaseMatrixCommandIds, releaseMatrixDifferences } from "./release-matrix-definition.mjs";

const [directory] = process.argv.slice(2); if (!directory || process.argv.length !== 3) throw new Error("usage: node scripts/verify-release-matrix.mjs <download-directory>");
const root = resolve(directory); const schema = JSON.parse(await readFile(resolve(process.cwd(), "core/schemas/release/release-matrix-result.schema.json"), "utf8")); const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const visit = async (path) => { const found = []; for (const entry of await readdir(path, { withFileTypes: true })) entry.isDirectory() ? found.push(...await visit(resolve(path, entry.name))) : entry.name === "result.json" && found.push(resolve(path, entry.name)); return found; };
const files = await visit(root); const results = await Promise.all(files.map(async (path) => JSON.parse(await readFile(path, "utf8"))));
if (results.length !== releaseMatrixCells.length) throw new Error(`expected exactly six release matrix results, received ${results.length}`);
for (const expected of releaseMatrixCells) {
  const matches = results.filter(({ cell }) => cell === expected.cell); if (matches.length !== 1) throw new Error(`${expected.cell}: missing or duplicate result`); const result = matches[0];
  if (!validate(result)) throw new Error(`${expected.cell}: ${new Ajv2020().errorsText(validate.errors)}`);
  if (result.runtime.node !== expected.node || result.runtime.npm !== "11.5.1" || result.platform.os !== expected.os || JSON.stringify(result.commands.map(({ id }) => id)) !== JSON.stringify(releaseMatrixCommandIds)) throw new Error(`${expected.cell}: runtime or command coverage was substituted`);
  if (JSON.stringify(result.differences) !== JSON.stringify(releaseMatrixDifferences(expected.os))) throw new Error(`${expected.cell}: platform differences were missing, duplicated, extra, or substituted`);
}
console.log("Release matrix verified: exact six cells and eight required checks per cell passed; platform differences recorded.");
