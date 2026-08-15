#!/usr/bin/env node
import { createLocalProjectEngine } from "../cli/index.mjs";
import { McpProjectServer, serveStdio } from "./index.mjs";
await serveStdio(
  new McpProjectServer({
    root: process.cwd(),
    projectId: process.env.KDLC_PROJECT_ID ?? "local",
    engineFactory: createLocalProjectEngine,
  }),
);
