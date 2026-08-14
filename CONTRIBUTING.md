# Contributing to K-DLC

K-DLC uses issue-first, review-gated development. Read [AGENTS.md](AGENTS.md)
before making a change; it applies to both people and automated agents.

## Start with a requirement

1. Select or create a GitHub issue using the requirement, feature, decision, or
   security form.
2. Make acceptance criteria observable and testable.
3. Link the relevant K-DLC specification sections.
4. Add dependencies, risks, access concerns, and rights concerns.
5. Obtain plan review when the issue changes architecture, policy, public API,
   durable formats, or publication behavior.

## Develop

Create a branch named `<type>/<issue>-<slug>`. Keep the change within issue
scope. Update `docs/traceability.json` as status or evidence changes. Use commits
whose subjects contain both the GitHub issue number and requirement identifier.

## Verify

Run:

```bash
node scripts/verify-governance.mjs
node --test tests/governance/*.test.mjs
```

Then run all tests relevant to the changed packages. Security-sensitive changes
must include negative tests proving that prohibited behavior stays blocked.

## Pull requests

Use the pull request template. `Closes #<issue>` is required, as are the stable
traceability IDs, specification sections, verification evidence, and rollback
notes. A substantive change requires approval by a reviewer other than its
author and all protected checks must pass.

Contributors must follow the [Code of Conduct](CODE_OF_CONDUCT.md) and report
security vulnerabilities according to [SECURITY.md](SECURITY.md).
