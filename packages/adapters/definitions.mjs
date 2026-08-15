import { CLI_COMMANDS } from "../cli/index.mjs";
import { MCP_PROTOCOL, MCP_TOOLS } from "../mcp/index.mjs";

export const distributionDefinition = Object.freeze({
  version: 1,
  specification: "0.2.0",
  canonicalization: "kdlc-c14n-1",
  cli_commands: CLI_COMMANDS,
  mcp_protocol: MCP_PROTOCOL,
  mcp_tools: MCP_TOOLS.filter(({ name }) =>
    [
      "project_init",
      "project_get",
      "project_list_mounts",
      "kb_search",
      "kb_fetch",
      "kb_trace",
      "kb_conflicts",
      "kb_gaps",
      "ingest_start",
      "job_status",
      "job_cancel",
    ].includes(name),
  ).map(({ name }) => name),
  conformance_modules: ["Core", "Lifecycle", "Federated", "Served"],
  transports: ["stdio", "streamable-http"],
  format_profiles: [],
});
