import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { resolveContainedPath } from "../../core/index.mjs";
import { retrievalFail } from "./errors.mjs";

function links(markdown) {
  const values = [];
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/[?#].*$/, "");
    if (target && !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("#")) values.push(target);
  }
  return values;
}

export async function traverseHierarchicalIndex(root, { maxIndexes = 10_000, maxConcepts = 100_000 } = {}) {
  root = await realpath(root);
  const pending = ["index.md"]; const indexes = new Set(); const concepts = new Set();
  while (pending.length) {
    const index = pending.shift();
    if (indexes.has(index)) continue;
    if (indexes.size >= maxIndexes) retrievalFail("KDLC_RETRIEVAL_LIMIT", "Hierarchical index traversal exceeded its index limit");
    let indexPath;
    try { indexPath = await resolveContainedPath(root, index); }
    catch (error) { retrievalFail("KDLC_INDEX_INVALID", `Required hierarchical index cannot be resolved: ${index}`, { cause: error.code }); }
    indexes.add(index);
    const markdown = await readFile(indexPath, "utf8");
    for (const target of links(markdown)) {
      const from = dirname(index);
      let path;
      try { path = await resolveContainedPath(root, target, { from: index, requireFile: false }); }
      catch (error) { retrievalFail("KDLC_INDEX_INVALID", "Hierarchical index contains an unsafe or broken target", { cause: error.code }); }
      const metadata = await lstat(path);
      const portable = relative(root, path).split(sep).join("/");
      if (portable.includes("\\") || portable.split("/").some((part) => !part || part === "." || part === "..")) retrievalFail("KDLC_INDEX_INVALID", "Hierarchical index resolved an unsafe concept identity");
      if (metadata.isDirectory()) pending.push(`${portable}/index.md`);
      else if (metadata.isFile() && portable.endsWith(".md") && !portable.endsWith("/index.md") && portable !== "index.md") {
        concepts.add(portable);
        if (concepts.size > maxConcepts) retrievalFail("KDLC_RETRIEVAL_LIMIT", "Hierarchical index traversal exceeded its concept limit");
      } else retrievalFail("KDLC_INDEX_INVALID", "Hierarchical index target must be a Markdown concept or directory");
    }
  }
  return Object.freeze([...concepts].sort());
}
