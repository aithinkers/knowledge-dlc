import { runRestrictedNormalizer } from "./src/worker-client.mjs";

export { descriptors, defaultLimits, portableArtifacts } from "./src/normalize.mjs";
export { runRestrictedNormalizer } from "./src/worker-client.mjs";

export async function normalize({ bytes, ...request }) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return runRestrictedNormalizer({ id: "normalize", ...request, bytes_base64: Buffer.from(input).toString("base64") });
}
