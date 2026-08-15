import { tmpdir } from "node:os";

export function scrubbedReleaseEnvironment(reportPath) {
  return Object.freeze({
    PATH: process.env.PATH,
    LANG: "C",
    LC_ALL: "C",
    TMPDIR: tmpdir(),
    KDLC_RELEASE_EVALUATION_MODE: "recorded-offline",
    KDLC_RELEASE_BOUNDARY_REPORT: reportPath,
  });
}
