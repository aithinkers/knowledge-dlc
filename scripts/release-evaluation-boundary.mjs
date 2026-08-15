import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";

export function normalizerInvocation(root) {
  const absoluteRoot = resolve(root);
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze(["--permission", "--allow-worker", "--allow-addons", `--allow-fs-read=${absoluteRoot}${sep}`, "--max-old-space-size=512", "--disable-proto=throw", resolve(absoluteRoot, "workers/normalizer/worker.mjs")]),
  });
}

export function invocationHash(invocation) {
  return `sha256:${createHash("sha256").update(JSON.stringify(invocation)).digest("hex")}`;
}

export function scrubbedReleaseEnvironment(reportPath, { root, allowNormalizer = false } = {}) {
  const invocation = allowNormalizer ? normalizerInvocation(root) : null;
  const windowsRuntime = process.platform === "win32" ? Object.fromEntries([
    ["SystemRoot", process.env.SystemRoot], ["WINDIR", process.env.WINDIR], ["ComSpec", process.env.ComSpec], ["PATHEXT", process.env.PATHEXT],
    ["TEMP", tmpdir()], ["TMP", tmpdir()],
  ].filter(([, value]) => typeof value === "string" && value.length > 0)) : {};
  return Object.freeze({
    PATH: process.env.PATH,
    LANG: "C",
    LC_ALL: "C",
    TMPDIR: tmpdir(),
    ...windowsRuntime,
    KDLC_RELEASE_EVALUATION_MODE: "recorded-offline",
    KDLC_RELEASE_BOUNDARY_REPORT: reportPath,
    ...(invocation ? { KDLC_RELEASE_ROOT: resolve(root), KDLC_RELEASE_ALLOWED_INVOCATION_HASH: invocationHash(invocation) } : {}),
  });
}
