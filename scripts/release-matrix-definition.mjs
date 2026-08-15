export const releaseMatrixCells = Object.freeze([
  Object.freeze({ cell: "ubuntu-node22", runner: "ubuntu-latest", os: "linux", node: "22.23.2" }),
  Object.freeze({ cell: "ubuntu-node24", runner: "ubuntu-latest", os: "linux", node: "24.5.0" }),
  Object.freeze({ cell: "windows-node22", runner: "windows-latest", os: "win32", node: "22.23.2" }),
  Object.freeze({ cell: "windows-node24", runner: "windows-latest", os: "win32", node: "24.5.0" }),
  Object.freeze({ cell: "macos-node22", runner: "macos-latest", os: "darwin", node: "22.23.2" }),
  Object.freeze({ cell: "macos-node24", runner: "macos-latest", os: "darwin", node: "24.5.0" }),
]);
export const releaseMatrixCommandIds = Object.freeze(["full", "offline", "release", "statistical", "clean-rebuild", "pack", "cli", "import"]);
export function releaseMatrixDifferences(os) {
  if (!["linux", "win32", "darwin"].includes(os)) throw new Error(`unsupported release matrix OS: ${os}`);
  return Object.freeze([
    Object.freeze({ key: "path_separator", value: os === "win32" ? "backslash" : "slash" }),
    Object.freeze({ key: "line_ending", value: "lf-generated-evidence" }),
    Object.freeze({ key: "executable_shim", value: os === "win32" ? "cmd" : "posix" })
  ]);
}
