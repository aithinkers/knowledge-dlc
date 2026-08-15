import { CLI_COMMANDS } from "../cli/index.mjs";
import { MCP_PROTOCOL, MCP_TOOLS } from "../mcp/index.mjs";

export const distributionDefinition = Object.freeze({
  version: 1,
  specification: "0.2.0",
  canonicalization: "kdlc-c14n-1",
  cli_commands: CLI_COMMANDS,
  mcp_protocol: MCP_PROTOCOL,
  mcp_tools: MCP_TOOLS.map(({ name }) => name),
  conformance_modules: ["Core","Lifecycle","Governed","Federated","Served"],
  transports: ["stdio","streamable-http"],
  format_profiles: ["markdown","text","csv","pdf","docx","xlsx","pptx","drawio","gif","vsdx"]
});
