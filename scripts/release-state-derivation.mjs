function globPattern(pattern) {
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
  const applicable = rulesets.filter(({ target, enforcement, conditions }) => target === "branch" && enforcement === "active" &&
    (conditions?.ref_name?.include ?? []).some((pattern) => matchesRulesetRef(pattern, { baseRef, defaultBranch })) &&
    !(conditions?.ref_name?.exclude ?? []).some((pattern) => matchesRulesetRef(pattern, { baseRef, defaultBranch })));
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
