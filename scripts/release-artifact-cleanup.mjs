import { chmod, lstat, opendir, rm } from "node:fs/promises";
import { resolve } from "node:path";

async function makeRemovable(path) {
  let metadata; try { metadata = await lstat(path); } catch { return; }
  if (metadata.isDirectory()) { await chmod(path, 0o700); const directory = await opendir(path); for await (const entry of directory) await makeRemovable(resolve(path, entry.name)); }
  else if (!metadata.isSymbolicLink()) await chmod(path, 0o600);
}

export async function removeReleaseTemporary(path) { await makeRemovable(path); await rm(path, { recursive: true, force: true }); }
export async function withReleaseCleanup(action, cleanup) {
  let primary;
  try { return await action(); } catch (error) { primary = error; throw error; }
  finally { try { await cleanup(); } catch (error) { if (!primary) throw error; } }
}

export function validateInstalledCliSmoke(initialized, diagnosed) {
  if (initialized?.ok !== true) throw new Error("installed CLI init did not establish a governed project");
  if (diagnosed?.ok !== true || diagnosed.result?.healthy !== true || !diagnosed.result.diagnostics?.some(({ id, status }) => id === "project.manifest" && status === "pass")) throw new Error("installed CLI doctor did not verify the initialized governed project");
}
