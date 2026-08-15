import { createInterface } from "node:readline";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const denied = () => { throw new Error("Normalizer worker network access is disabled"); };
globalThis.fetch = denied; globalThis.WebSocket = class { constructor() { denied(); } };
for (const api of [dns, http, https, net]) for (const name of ["connect", "createConnection", "get", "lookup", "lookupService", "request", "resolve"]) if (typeof api[name] === "function") api[name] = denied;
const { normalize } = await import("../../packages/normalizers/index.mjs");

const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
for await (const line of input) {
  let id = null;
  try {
    const request = JSON.parse(line); id = request.id;
    if (request.network === true || request.execute === true) throw new Error("Worker policy forbids network and code execution");
    const result = await normalize({ ...request, bytes: Buffer.from(request.bytes_base64, "base64") });
    process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id, ok: false, error: { code: "KDLC_NORMALIZER_WORKER", message: error.message } })}\n`);
  }
}
