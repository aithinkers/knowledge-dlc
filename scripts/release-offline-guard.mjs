import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const observations = { external_network_calls: 0, live_model_calls: 0, blocked_process_calls: 0 };
const denyNetwork = () => { observations.external_network_calls += 1; throw Object.assign(new Error("REL-001 offline boundary denied network access"), { code: "KDLC_RELEASE_NETWORK_DENIED" }); };
const blocked = () => { observations.blocked_process_calls += 1; observations.live_model_calls += 1; throw Object.assign(new Error("REL-001 recorded boundary denied executable model/process access"), { code: "KDLC_RELEASE_PROCESS_DENIED" }); };

globalThis.fetch = denyNetwork;
if (globalThis.WebSocket) globalThis.WebSocket = class { constructor() { denyNetwork(); } };
for (const target of [http, https]) { target.request = denyNetwork; target.get = denyNetwork; }
http2.connect = denyNetwork;
net.connect = denyNetwork; net.createConnection = denyNetwork; net.Socket.prototype.connect = denyNetwork;
dgram.createSocket = denyNetwork;
for (const name of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"]) if (typeof dns[name] === "function") dns[name] = denyNetwork;

const originalExecFile = childProcess.execFile.bind(childProcess);
const originalSpawn = childProcess.spawn.bind(childProcess);
function localGit(command, args = []) {
  return command === "git" && Array.isArray(args) && !args.some((arg) => typeof arg !== "string" || /^(?:https?|ssh|git):/i.test(arg));
}
childProcess.execFile = (command, args, ...rest) => localGit(command, args) ? originalExecFile(command, args, ...rest) : blocked();
function restrictedNormalizer(command, args = [], options = {}) {
  return command === process.execPath && Array.isArray(args) && args.includes("--permission") && args.includes("--allow-worker")
    && args.some((arg) => typeof arg === "string" && arg.endsWith("/workers/normalizer/worker.mjs"))
    && options?.shell === false && options?.env?.KDLC_RESTRICTED_WORKER === "1" && Object.keys(options.env).length === 1;
}
childProcess.spawn = (command, args, options) => restrictedNormalizer(command, args, options) ? originalSpawn(command, args, options) : blocked();
childProcess.exec = blocked; childProcess.fork = blocked;
syncBuiltinESMExports();

process.once("exit", () => {
  const path = process.env.KDLC_RELEASE_BOUNDARY_REPORT;
  if (path) writeFileSync(path, `${JSON.stringify(observations)}\n`, { flag: "wx", mode: 0o600 });
});
