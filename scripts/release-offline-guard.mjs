import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { realpathSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { relative, resolve, sep } from "node:path";

import { invocationHash, normalizerInvocation } from "./release-evaluation-boundary.mjs";

const observations = { external_network_calls: 0, live_model_calls: 0, blocked_process_calls: 0 };
const denyNetwork = () => { observations.external_network_calls += 1; throw Object.assign(new Error("REL-001 offline boundary denied network access"), { code: "KDLC_RELEASE_NETWORK_DENIED" }); };
const denyProcess = () => { observations.blocked_process_calls += 1; observations.live_model_calls += 1; throw Object.assign(new Error("REL-001 recorded boundary denied executable model/process access"), { code: "KDLC_RELEASE_PROCESS_DENIED" }); };

globalThis.fetch = denyNetwork;
if (globalThis.WebSocket) globalThis.WebSocket = class { constructor() { denyNetwork(); } };
if (globalThis.EventSource) globalThis.EventSource = class { constructor() { denyNetwork(); } };
for (const target of [http, https]) {
  target.request = denyNetwork; target.get = denyNetwork; target.createServer = denyNetwork;
  if (target.Agent?.prototype) target.Agent.prototype.createConnection = denyNetwork;
}
http2.connect = denyNetwork; http2.createServer = denyNetwork; http2.createSecureServer = denyNetwork;
net.connect = denyNetwork; net.createConnection = denyNetwork; net.createServer = denyNetwork; net.Socket.prototype.connect = denyNetwork;
tls.connect = denyNetwork; tls.createServer = denyNetwork; if (tls.TLSSocket?.prototype) tls.TLSSocket.prototype.connect = denyNetwork;
dgram.createSocket = denyNetwork;
const dnsMethods = ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"];
for (const target of [dns, dns.promises, dnsPromises]) for (const name of dnsMethods) if (typeof target?.[name] === "function") target[name] = denyNetwork;
for (const Resolver of [dns.Resolver, dns.promises?.Resolver, dnsPromises.Resolver]) for (const name of dnsMethods) if (typeof Resolver?.prototype?.[name] === "function") Resolver.prototype[name] = denyNetwork;

const originalBinding = process.binding.bind(process);
process.binding = (name) => ["cares_wrap", "tcp_wrap", "udp_wrap"].includes(name) ? denyNetwork() : originalBinding(name);
if (typeof process._linkedBinding === "function") {
  const originalLinkedBinding = process._linkedBinding.bind(process);
  process._linkedBinding = (name) => ["cares_wrap", "tcp_wrap", "udp_wrap"].includes(name) ? denyNetwork() : originalLinkedBinding(name);
}

const originalSpawn = childProcess.spawn.bind(childProcess);
const releaseRoot = process.env.KDLC_RELEASE_ROOT ? resolve(process.env.KDLC_RELEASE_ROOT) : null;
const expectedInvocation = releaseRoot ? normalizerInvocation(releaseRoot) : null;
const expectedHash = expectedInvocation ? invocationHash(expectedInvocation) : null;
const temporaryRoot = realpathSync(process.env.TMPDIR ?? "/tmp");
function inside(root, path) { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`)); }
function exactNormalizer(command, args, options) {
  if (!expectedInvocation || process.env.KDLC_RELEASE_ALLOWED_INVOCATION_HASH !== expectedHash) return false;
  if (command !== expectedInvocation.command || JSON.stringify(args) !== JSON.stringify(expectedInvocation.args)) return false;
  if (!options || JSON.stringify(Object.keys(options).sort()) !== JSON.stringify(["cwd", "env", "shell", "stdio"])) return false;
  if (options.shell !== false || JSON.stringify(options.env) !== JSON.stringify({ KDLC_RESTRICTED_WORKER: "1" }) || JSON.stringify(options.stdio) !== JSON.stringify(["pipe", "pipe", "pipe"])) return false;
  let cwd; try { cwd = realpathSync(options.cwd); } catch { return false; }
  return inside(temporaryRoot, cwd) && /^kdlc-normalizer-[A-Za-z0-9]+$/.test(cwd.slice(cwd.lastIndexOf(sep) + 1));
}
childProcess.spawn = (command, args, options) => exactNormalizer(command, args, options) ? originalSpawn(command, args, options) : denyProcess();
for (const name of ["exec", "execFile", "execSync", "execFileSync", "fork", "spawnSync"]) childProcess[name] = denyProcess;
syncBuiltinESMExports();

process.once("exit", () => {
  const path = process.env.KDLC_RELEASE_BOUNDARY_REPORT;
  if (path) writeFileSync(path, `${JSON.stringify(observations)}\n`, { flag: "wx", mode: 0o600 });
});
