// Shared connector transport contract (FEAT-023, #97). Connectors never talk
// to the network themselves: an injected transport performs the request and
// owns authentication end-to-end. These helpers fail closed on anything but
// a clean success and keep provider error bodies out of thrown messages so
// foreign content never rides into logs or artifacts.

export class ConnectorError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = "ConnectorError";
    this.status = status;
  }
}

export function instant() {
  return new Date().toISOString();
}

function guard(response, what) {
  if (!response || typeof response.status !== "number") throw new ConnectorError(`${what}: transport returned no status`);
  if (response.status === 401 || response.status === 403) throw new ConnectorError(`${what}: access denied — the credential lacks read access or has expired`, { status: response.status });
  if (response.status === 404) throw new ConnectorError(`${what}: not found — the item may be deleted or moved`, { status: 404 });
  if (response.status === 429) throw new ConnectorError(`${what}: rate limited by the provider — retry later`, { status: 429 });
  if (response.status < 200 || response.status >= 300) throw new ConnectorError(`${what}: provider returned status ${response.status}`, { status: response.status });
}

export function expectJson(response, what) {
  guard(response, what);
  if (typeof response.json !== "function") throw new ConnectorError(`${what}: transport response carries no JSON body`);
  const value = response.json();
  if (value === null || typeof value !== "object") throw new ConnectorError(`${what}: provider returned a non-object body`);
  return value;
}

export function expectBytes(response, what) {
  guard(response, what);
  if (typeof response.bytes !== "function") throw new ConnectorError(`${what}: transport response carries no byte body`);
  const value = response.bytes();
  if (!(value instanceof Uint8Array)) throw new ConnectorError(`${what}: transport bytes must be a Uint8Array`);
  return value;
}

/**
 * Judge stored receipts against live probes and turn the answers into
 * refresh work (maintainer semantics): stale → refresh proposal, unreachable
 * → investigate proposal, current → nothing. Deterministic; the caller
 * supplies probes.
 */
export async function assessReceipts(receipts, probeFor) {
  const { receiptStaleness } = await import("../sources/index.mjs");
  const proposals = [];
  for (const receipt of receipts) {
    const probe = probeFor(receipt);
    const live = probe ? await probe : null;
    const verdict = receiptStaleness(receipt, live);
    if (verdict.state === "current") continue;
    proposals.push({
      kind: verdict.state === "stale" ? "refresh" : "investigate-source",
      source_id: receipt.source_id,
      provider: receipt.provider,
      remote_id: receipt.remote_id,
      reason: verdict.reason,
      ...(receipt.display_name ? { display_name: receipt.display_name } : {}),
    });
  }
  return proposals;
}
