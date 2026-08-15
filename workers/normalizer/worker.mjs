import { createInterface } from "node:readline";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import childProcess from "node:child_process";
import cluster from "node:cluster";
import dgram from "node:dgram";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const denied = () => { throw new Error("Normalizer worker network access is disabled"); };
globalThis.fetch = denied; globalThis.WebSocket = class { constructor() { denied(); } };
if (process.env.KDLC_RESTRICTED_WORKER !== "1" || !/^v(?:22|23|24)\./.test(process.version) || !process.permission || process.permission.has("child") || process.permission.has("fs.write", "/")) throw new Error("Restricted normalizer requires the supported Node 22-24 permission boundary");
for (const api of [dns, dnsPromises, http, http2, https, net, tls, dgram]) for (const name of ["connect", "createConnection", "createSocket", "get", "lookup", "lookupService", "request", "resolve"]) if (typeof api[name] === "function") api[name] = denied;
for (const name of ["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"]) if (typeof childProcess[name] === "function") childProcess[name] = denied;
if (typeof cluster.fork === "function") cluster.fork = denied;
const { normalizeInRestrictedWorker } = await import("../../packages/normalizers/src/normalize.mjs");

const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
for await (const line of input) {
  let id = null;
  try {
    const request = JSON.parse(line); id = request.id;
    const allowed = new Set(["id", "bytes_base64", "filename", "mediaType", "sourceId", "normalizedAt", "sourceHash", "settings", "limits", "probabilisticUnits", "network", "execute"]);
    if (!request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).some((key) => !allowed.has(key)) || typeof request.id !== "string" || request.id.length < 1 || request.id.length > 128 || typeof request.bytes_base64 !== "string" || request.bytes_base64.length > 34_000_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.bytes_base64)) throw new Error("Worker request violates the restricted protocol");
    if (request.network === true || request.execute === true) throw new Error("Worker policy forbids network and code execution");
    const result = await normalizeInRestrictedWorker({ ...request, bytes: Buffer.from(request.bytes_base64, "base64") });
    process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id, ok: false, error: { code: "KDLC_NORMALIZER_WORKER", message: error.message } })}\n`);
  }
}
