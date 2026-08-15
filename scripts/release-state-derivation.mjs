import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import { isRfc3339Instant } from "../packages/core/src/temporal.mjs";

function globPattern(pattern) {
  if (/[\[\]]/u.test(pattern)) throw new Error("unsupported ruleset character-set pattern");
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") { source += ".*"; index += 1; }
    else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }
  return new RegExp(`^${source}$`, "u");
}

export function matchesRulesetRef(pattern, { baseRef, defaultBranch }) {
  if (pattern === "~ALL") return true;
  if (pattern === "~DEFAULT_BRANCH") return baseRef === defaultBranch;
  return globPattern(pattern).test(`refs/heads/${baseRef}`);
}

export function deriveRulesetState(rulesets, { baseRef, defaultBranch }) {
  const applicable = rulesets.filter(({ target, enforcement, conditions }) => {
    if (target !== "branch" || enforcement !== "active") return false;
    try {
      if (!(conditions?.ref_name?.include ?? []).some((pattern) => matchesRulesetRef(pattern, { baseRef, defaultBranch }))) return false;
      return !(conditions?.ref_name?.exclude ?? []).some((pattern) => matchesRulesetRef(pattern, { baseRef, defaultBranch }));
    } catch { return false; }
  });
  const rules = applicable.flatMap(({ rules: values }) => values ?? []); const byType = (type) => rules.filter((rule) => rule.type === type);
  const pullRequests = byType("pull_request").map(({ parameters }) => parameters ?? {}); const statuses = byType("required_status_checks").map(({ parameters }) => parameters ?? {});
  const allowedSets = pullRequests.map(({ allowed_merge_methods }) => new Set(allowed_merge_methods ?? [])); const allowed = allowedSets.length ? [...allowedSets[0]].filter((method) => allowedSets.every((set) => set.has(method))).sort() : [];
  return {
    ids: applicable.map(({ id }) => id).sort((left, right) => left - right), active: applicable.length > 0, default_branch: applicable.length > 0,
    prevents_deletion: byType("deletion").length > 0, prevents_non_fast_forward: byType("non_fast_forward").length > 0, linear_history: byType("required_linear_history").length > 0,
    pull_request: { required_approvals: Math.max(0, ...pullRequests.map(({ required_approving_review_count }) => required_approving_review_count ?? 0)), require_code_owner_review: pullRequests.some(({ require_code_owner_review }) => require_code_owner_review === true), dismiss_stale_reviews: pullRequests.some(({ dismiss_stale_reviews_on_push }) => dismiss_stale_reviews_on_push === true), require_last_push_approval: pullRequests.some(({ require_last_push_approval }) => require_last_push_approval === true), require_thread_resolution: pullRequests.some(({ required_review_thread_resolution }) => required_review_thread_resolution === true), allowed_merge_methods: allowed },
    strict_status_checks: statuses.some(({ strict_required_status_checks_policy }) => strict_required_status_checks_policy === true), required_checks: [...new Set(statuses.flatMap(({ required_status_checks }) => (required_status_checks ?? []).map(({ context }) => context)))].sort(),
    direct_push_bypass: applicable.some(({ bypass_actors }) => (bypass_actors ?? []).some(({ bypass_mode }) => bypass_mode === "always"))
  };
}
const ADMIN_ATTESTATION_VERSION = "kdlc.dev/admin-settings-attestation/v1alpha1";
const ADMIN_CAPTURE_VERSION = "kdlc.dev/admin-settings-capture/v1alpha1";
const ADMIN_CAPTURE_METHOD = "owner-live-admin-api-and-manual-ui";
const ADMIN_API_METHOD = "authenticated-gh-admin-api";
const ADMIN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ADMIN_MAX_CONFIRM_DELAY_MS = 60 * 60 * 1000;
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const digest = (value) => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;

export function createAdminSettingsCapture({ repository, capturedAt, actor, responseBytes }) {
  const endpoint = `/repos/${repository}/actions/permissions/workflow`;
  const bytes = Buffer.isBuffer(responseBytes) ? responseBytes : Buffer.from(responseBytes);
  const settings = JSON.parse(bytes.toString("utf8"));
  const payload = { api_version: ADMIN_CAPTURE_VERSION, repository, captured_at: capturedAt, actor,
    capture: { method: ADMIN_API_METHOD, endpoint, response_sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` },
    response_base64: bytes.toString("base64"), settings: structuredClone(settings) };
  return Object.freeze({ ...payload, canonical_sha256: digest(payload) });
}

export function issueAdminSettingsAttestation({ capture, confirmedAt, actor }) {
  const bytes = Buffer.from(capture.response_base64 ?? "", "base64");
  const capturePayload = { api_version: capture.api_version, repository: capture.repository, captured_at: capture.captured_at,
    actor: capture.actor, capture: capture.capture, response_base64: capture.response_base64, settings: capture.settings };
  if (!exactKeys(capture, [...Object.keys(capturePayload), "canonical_sha256"]) || capture.api_version !== ADMIN_CAPTURE_VERSION
    || capture.canonical_sha256 !== digest(capturePayload) || capture.capture?.method !== ADMIN_API_METHOD
    || capture.capture?.endpoint !== `/repos/${capture.repository}/actions/permissions/workflow`
    || capture.capture?.response_sha256 !== `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    || JSON.stringify(JSON.parse(bytes.toString("utf8"))) !== JSON.stringify(capture.settings) || actor !== capture.actor) throw new Error("invalid or unauthorized admin settings capture");
  const payload = { api_version: ADMIN_ATTESTATION_VERSION, repository: capture.repository, captured_at: capture.captured_at,
    capture: { ...structuredClone(capture.capture), actor: capture.actor, record_sha256: capture.canonical_sha256 }, settings: structuredClone(capture.settings),
    manual_cross_check: { confirmed: true, confirmed_at: confirmedAt, method: ADMIN_CAPTURE_METHOD, actor } };
  return Object.freeze({ ...payload, canonical_sha256: digest(payload) });
}

export function evaluateAdminSettingsAttestation(serialized, { repository, now = new Date().toISOString(), maxAgeMs = ADMIN_MAX_AGE_MS } = {}) {
  if (typeof serialized !== "string" || serialized.trim() === "") return { status: "unavailable", attestation: null };
  let value; try { value = JSON.parse(serialized); } catch { return { status: "invalid", attestation: null }; }
  const manual = value?.manual_cross_check; const settings = value?.settings;
  const validShape = exactKeys(value, ["api_version", "repository", "captured_at", "capture", "settings", "manual_cross_check", "canonical_sha256"])
    && exactKeys(settings, ["default_workflow_permissions", "can_approve_pull_request_reviews"])
    && exactKeys(manual, ["confirmed", "confirmed_at", "method", "actor"])
    && exactKeys(value?.capture, ["method", "endpoint", "response_sha256", "record_sha256", "actor"]);
  const payload = validShape ? { api_version: value.api_version, repository: value.repository, captured_at: value.captured_at,
    capture: value.capture, settings: value.settings, manual_cross_check: value.manual_cross_check } : null;
  const captured = Date.parse(value?.captured_at), confirmed = Date.parse(manual?.confirmed_at), current = Date.parse(now);
  const authentic = validShape && value.api_version === ADMIN_ATTESTATION_VERSION && value.repository === repository
    && isRfc3339Instant(value.captured_at) && isRfc3339Instant(manual.confirmed_at) && isRfc3339Instant(now)
    && manual.confirmed === true && manual.method === ADMIN_CAPTURE_METHOD && typeof manual.actor === "string" && manual.actor.length > 0
    && value.capture.method === ADMIN_API_METHOD && value.capture.endpoint === `/repos/${repository}/actions/permissions/workflow`
    && /^sha256:[0-9a-f]{64}$/u.test(value.capture.response_sha256) && /^sha256:[0-9a-f]{64}$/u.test(value.capture.record_sha256)
    && value.capture.actor === manual.actor
    && Number.isFinite(captured) && Number.isFinite(confirmed) && Number.isFinite(current)
    && confirmed > captured && confirmed <= current && confirmed - captured <= ADMIN_MAX_CONFIRM_DELAY_MS
    && value.canonical_sha256 === digest(payload);
  if (!authentic) return { status: "invalid", attestation: null };
  if (captured > current || current - captured > maxAgeMs) return { status: "stale", attestation: structuredClone(value) };
  const policyReady = settings.default_workflow_permissions === "read" && settings.can_approve_pull_request_reviews === false;
  return { status: policyReady ? "current" : "weakened", attestation: structuredClone(value) };
}
