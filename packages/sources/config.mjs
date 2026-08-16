// Remote-source connector configuration (FEAT-025, #105). The file at
// .kdlc/connectors.json names WHERE knowledge comes from and WHICH
// environment variables carry the credentials — never the credential values
// themselves. Validation fails closed, and anything that looks like a secret
// inline is rejected so a config file can always be committed or shared.

import { REMOTE_PROVIDERS } from "./index.mjs";

export const CONNECTORS_API_VERSION = "kdlc.dev/source-connectors/v1";
export const CONNECTORS_PATH = ".kdlc/connectors.json";

/** Environment variable names each provider's transport expects. */
export const PROVIDER_ENV = Object.freeze({
  "google-drive": ["KDLC_GDRIVE_CREDENTIALS"],
  onedrive: ["KDLC_GRAPH_TENANT_ID", "KDLC_GRAPH_CLIENT_ID", "KDLC_GRAPH_CLIENT_SECRET"],
  sharepoint: ["KDLC_GRAPH_TENANT_ID", "KDLC_GRAPH_CLIENT_ID", "KDLC_GRAPH_CLIENT_SECRET"],
  confluence: ["KDLC_CONFLUENCE_EMAIL", "KDLC_CONFLUENCE_API_TOKEN"],
});

const envName = /^[A-Z][A-Z0-9_]{2,63}$/;
// Heuristics for values that are credentials rather than env-var names:
// long mixed tokens, JWT/PEM markers, url-embedded userinfo.
const secretLooking = (value) => typeof value === "string" && (
  /BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{10,}\.|:\/\/[^/\s]+:[^@\s]+@/.test(value) ||
  (value.length >= 24 && !/\s/.test(value) && /[a-z]/.test(value) && /[A-Z0-9]/.test(value) && !envName.test(value) && !/^https:\/\//.test(value))
);

/**
 * Validate a parsed connectors document. Returns plain-language failures;
 * empty means usable.
 */
export function validateConnectorsConfig(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return ["connectors config must be an object"];
  const failures = [];
  if (config.api_version !== CONNECTORS_API_VERSION) failures.push(`api_version must be ${CONNECTORS_API_VERSION}`);
  if (!Array.isArray(config.connectors) || config.connectors.length === 0) {
    failures.push("connectors must be a non-empty array");
    return failures;
  }
  const seen = new Set();
  for (const [index, connector] of config.connectors.entries()) {
    const where = `connector ${index}`;
    if (connector === null || typeof connector !== "object" || Array.isArray(connector)) { failures.push(`${where} must be an object`); continue; }
    if (typeof connector.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(connector.id)) failures.push(`${where}: id must be a short lowercase slug`);
    else if (seen.has(connector.id)) failures.push(`${where}: duplicate id "${connector.id}"`);
    else seen.add(connector.id);
    if (!REMOTE_PROVIDERS.includes(connector.provider)) {
      failures.push(`${where}: provider must be one of ${REMOTE_PROVIDERS.join(", ")}`);
      continue;
    }
    const required = PROVIDER_ENV[connector.provider];
    const env = connector.auth_env;
    if (env === null || typeof env !== "object" || Array.isArray(env)) {
      failures.push(`${where}: auth_env must map each required credential (${required.join(", ")}) to the NAME of an environment variable`);
    } else {
      for (const key of required) {
        const name = env[key];
        if (typeof name !== "string" || !envName.test(name)) {
          failures.push(`${where}: auth_env.${key} must be an environment variable NAME (letters, digits, underscores)`);
        } else if (secretLooking(name)) {
          failures.push(`${where}: auth_env.${key} looks like a credential value — put the secret in the environment and name the variable here`);
        }
      }
      // EVERY auth_env value — required or not — must be an env-var NAME:
      // non-string values (arrays, objects) are how secrets sneak past a
      // string-only sweep (review round finding 2).
      for (const [key, value] of Object.entries(env)) {
        if (typeof value !== "string" || !envName.test(value)) {
          failures.push(`${where}: auth_env.${key} must be an environment variable NAME (letters, digits, underscores)`);
        } else if (secretLooking(value)) {
          failures.push(`${where}: auth_env.${key} looks like a credential value — credentials never belong in this file`);
        }
      }
    }
    if (connector.provider === "confluence") {
      if (typeof connector.base_url !== "string" || !/^https:\/\/[^\s/]+/.test(connector.base_url)) {
        failures.push(`${where}: confluence requires base_url (https://<site>.atlassian.net/wiki)`);
      }
    }
    // A URL can smuggle credentials as userinfo (https://user:token@host) —
    // reject it whatever the provider (review round finding 1).
    if (typeof connector.base_url === "string" && (/:\/\/[^/\s]*@/.test(connector.base_url) || secretLooking(connector.base_url))) {
      failures.push(`${where}: base_url must not embed credentials — put the secret in an environment variable`);
    }
    for (const [key, value] of Object.entries(connector)) {
      if (["id", "provider", "auth_env", "base_url", "notes"].includes(key)) {
        if (key === "notes") {
          if (typeof value !== "string") failures.push(`${where}: notes must be a string`);
          else if (secretLooking(value)) failures.push(`${where}: notes looks like it contains a credential — remove it`);
        }
        continue;
      }
      failures.push(`${where}: unknown field "${key}" (allowed: id, provider, auth_env, base_url, notes)`);
    }
  }
  return failures;
}

/**
 * Summarize configured connectors for `kdlc sources`: which env variables
 * are present (booleans only — values never surface anywhere).
 */
export function connectorReadiness(config, env = process.env) {
  const failures = validateConnectorsConfig(config);
  if (failures.length > 0) return { valid: false, failures, connectors: [] };
  return {
    valid: true,
    failures: [],
    connectors: config.connectors.map((connector) => {
      const names = Object.values(connector.auth_env);
      const missing = names.filter((name) => !env[name] || env[name].length === 0);
      return {
        id: connector.id,
        provider: connector.provider,
        ...(connector.base_url ? { base_url: connector.base_url } : {}),
        env: Object.fromEntries(names.map((name) => [name, Boolean(env[name] && env[name].length > 0)])),
        ready: missing.length === 0,
        ...(missing.length > 0 ? { hint: `set ${missing.join(", ")} in the environment to activate this connector` } : {}),
      };
    }),
  };
}
