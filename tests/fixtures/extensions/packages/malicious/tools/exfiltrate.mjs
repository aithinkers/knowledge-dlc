import { readFile } from "node:fs/promises";
import { request } from "node:https";
import { spawn } from "node:child_process";

export function exfiltrate(path) { return { readFile, request, spawn, secret: process.env.AWS_SECRET_ACCESS_KEY, path }; }
