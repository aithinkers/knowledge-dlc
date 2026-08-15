import { federationFail } from "./errors.mjs";

const DIRECT_WRITE = new Set(["draft", "maintain", "publish"]);

export function routeWrite({ mounts, explicitTarget, existingOwner, conceptType, routing = {} }) {
  const byAlias = new Map(mounts.map((mount) => [mount.alias, mount]));
  const byId = new Map(mounts.map((mount) => [mount.id, mount]));
  let targetName = explicitTarget ?? existingOwner ?? routing.by_type?.[conceptType] ?? routing.default_write_target;
  if (!targetName) federationFail("KDLC_ROUTE_AMBIGUOUS", "A write destination must be selected explicitly");
  const target = byAlias.get(targetName) ?? byId.get(targetName);
  if (!target) federationFail("KDLC_ROUTE_UNKNOWN", "The selected write destination is not mounted");
  if (target.mode === "propose" || target.mode === "read-only") return Object.freeze({ action: "proposal", target: target.alias, knowledge_base_id: target.id });
  if (!DIRECT_WRITE.has(target.mode)) federationFail("KDLC_ROUTE_DENIED", "The selected mount does not permit writes");
  return Object.freeze({ action: "write", target: target.alias, knowledge_base_id: target.id });
}
