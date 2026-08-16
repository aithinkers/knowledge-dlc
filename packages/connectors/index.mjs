// Deterministic remote source connectors (FEAT-023, #97) over injected
// transports. See graph.mjs (OneDrive/SharePoint) and confluence.mjs;
// transport.mjs carries the shared contract and the receipt-assessment
// helper that feeds maintainer refresh proposals.

export { GraphConnector, GRAPH_CAPABILITIES } from "./graph.mjs";
export { ConfluenceConnector, CONFLUENCE_CAPABILITIES } from "./confluence.mjs";
export { ConnectorError, assessReceipts, expectBytes, expectJson, instant } from "./transport.mjs";
