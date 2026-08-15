# REL-001 release readiness

This document records pre-release gates. It is not a conformance statement,
release announcement, or evidence that REL-001 is complete.

## First tranche

The first tranche covers public documentation, confidential reporting routes,
dependency and secret scanning, license/notices/SBOM verification, and package
metadata. Publishing, version finalization, tags, release artifacts,
conformance claims, deterministic/statistical release reports, and work that
depends on issues #8, #23, or #24 remain outside this tranche.

## Second tranche

The second tranche adds strict machine-readable pre-release conformance and
deterministic evaluation evidence under `distribution/release/`. The structural
record binds nine offline cases to exact committed fixture and executable-evidence bytes and reports
zero live model or external network calls. The versioned multi-trial statistical
suite has since completed: thirty complete preregistered provider trials against
the frozen anthropic/claude-sonnet-5 manifest produced a qualified statistical report
(all Wilson lower bounds and per-case floors passed, security fail-closed exact at
210/210), hash-bound in the capture status.

The conformance statement declares the implemented surface without erasing
known gaps. `Core`, `Lifecycle`, `Governed`, `Federated`, and `Served` are
implemented. The Governed declaration is bound to merged FEAT-009 tests for
revocation impact, legal hold, durable erasure, propagation, and retrieval
nondisclosure.
The statement now records package version `1.0.0`, `private: false`, and a
machine-readable `release-candidate` status; final publication (tag, package,
independent release verification) remains a separately governed action.

## Known conformance gaps disclosed before release

- Specification §26 sensor coverage: the sensor runtime (determinism checks,
  severity, auditable waivers), the seven governance-gate sensors
  (§27.4–§27.7), and sixteen core lint sensor definitions (FEAT-015, issue
  #75 — OKF conformance, profile frontmatter, source/citation resolvability,
  claim-sidecar consistency, link/alias/duplicate/relationship/orphan checks,
  index completeness and reproducibility, stale verification, lifecycle
  transitions, review binding, lock drift, workflow lock/job integrity) are
  implemented and run by `kdlc lint` with info/warning/error findings.
  Generated-distribution drift remains enforced by `check:distribution` in CI
  rather than as a lint sensor, and the remaining §26 categories are enforced
  outside lint: manifest schema validity by the contract validator in
  `kdlc lint`, duplicate mounted knowledge-base IDs and tree-hash mismatches
  at mount resolution (`packages/core/src/resolution.mjs`,
  `packages/federation`), and normalizer coverage/locator/limit/probabilistic
  labels by quarantine-on-violation in `packages/normalizers`.
- Codex and Kiro harness surfaces run from this repository checkout; a
  self-contained packaged runner is future work (see issue #73 notes).

## Repository settings requiring final evidence or action

These items require repository-owner evidence or administration before release.
Already-enabled controls are recorded separately below.

- Test the enabled private vulnerability advisory route in `SECURITY.md` with a
  non-sensitive draft report.
- Record the enabled secret-scanning and push-protection state. GitHub
  non-provider patterns and validity checks remain unavailable under the
  repository's current eligibility.
- Add the successful `Secret history scan`, `CodeQL`, `Dependency review`, and
  `Supply-chain verification` contexts to the active `K-DLC main protection`
  ruleset. Retain the existing governance and candidate-test requirements.
- Record the enabled Dependabot security-update state for npm and GitHub
  Actions, and limit dismissal/bypass authority to maintainers.
- Confirm the dependency graph is enabled so dependency review has a complete
  base/head comparison before making its status required.
- Retain the verified read-only default Actions permissions and no broad
  workflow write token. Resolve the selected-actions decision recorded below.
- Establish a dedicated confidential security/conduct intake or encrypted form;
  until then, the low-disclosure `connect@aithinkers.com` handshake in the
  policies is the actionable fallback.

## Final prepublication tranche

The statistical evaluation is preregistered under
`distribution/release/statistical/`: a provider-visible public corpus, a
separate evaluator-only gold record, prompts, no-tool boundary, model selection
fields, thirty complete-trial rule, exact hashes, metrics, Wilson 95%
lower-bound thresholds, and prohibition on exclusions were fixed before
capture. The owner approved and froze provider anthropic, model
claude-sonnet-5; thirty complete trials were captured through the trusted
import path and scored offline into a qualified statistical report. Two
earlier capture attempts (claude-haiku-4-5-20251001, and claude-sonnet-5
before the decision-rubric template amendments) failed the gate and are
recorded in issue #57; the template amendments preceded any qualified claim.
The capture utility only imports complete provider-produced records; scoring
and verification are offline.

The profile freezes the raw-byte hashes of both public corpus and evaluator
gold plus the exact offline scorer source/version/hash. Provider requests are a
strict projection containing only input, explicit factual context, and the
prompt/tool/model configurations; case keys, categories, expected decisions,
security labels, trial IDs, scorer data, and thresholds never enter those
bytes. Every captured result binds its globally unique provider request ID and
the exact projected request bytes. Security cases pass only with the expected
fail-closed decision and empty answer/assertions/citations; a single disclosure
fails the exact-rate security gate.

“No hidden gold” does not mean withholding facts the governed model must use.
Provider-visible context deliberately includes operational access labels,
classification, rights, freshness, source authority, revocation state, and
policy booleans because those are inputs to the requested decision, not labels
for its expected outcome. All corpus identities, source text, classifications,
and access labels are synthetic test data. When a provider/model is later
approved and frozen, this synthetic corpus is explicitly approved for that
external statistical route; no production secret, credential, customer data,
or private repository content may be substituted into capture requests.
The current temperature `0` and fixed seed `421` target repeatability, not
independent population sampling. Wilson bounds are explicitly repeated-provider-
call operational reliability on this frozen corpus, not evidence of content
generalization. Each case also has a preregistered reliability floor, preventing
an aggregate from hiding a systematic case failure. Grounded facts and locators
require the correct decision, exact structured assertions/citations, and exact
equality to an evaluator-only accepted answer after only Unicode NFKC and
whitespace normalization. No substring or sentiment heuristic receives credit;
negated, quoted, contradictory, paraphrased, and visually confusable answers
fail closed.

The `Release matrix` workflow defines the six required Ubuntu, Windows, and
macOS cells across Node 22.23.2 and 24.5.0 with npm 11.5.1. Every cell runs the
full, offline replay, release evidence, statistical preregistration, clean
rebuild, supply-chain, reproducible double-package, installed CLI, and installed
export checks. Each protected cell records the exact candidate head plus
observed package, manifest, SBOM, notices, and smoke evidence. The stable
`Release matrix` aggregator runs trusted-base code and dependencies to reject
missing or substituted cells and cross-platform path/content/size drift. Each
cell must reproduce its archive twice; Windows archive mode metadata is an
explicit platform difference, while the trusted Ubuntu Node 24 derivation is
the designated candidate artifact and all platforms must install equivalent
content. A separate
read-token job executes only the trusted-base live-state collector and never
checks out or executes candidate code. Passing workflow evidence is still
required before release.

The read-only Actions token cannot read the administration-only default
workflow-permission endpoint. A repository owner must therefore capture that
endpoint outside Actions, manually cross-check the same values in repository
settings, and publish the resulting compact JSON as the owner-controlled
repository variable `KDLC_ADMIN_SETTINGS_ATTESTATION`:

```sh
node scripts/create-admin-settings-attestation.mjs \
  capture --repository aithinkers/knowledge-dlc --output admin-settings-pending.json
# Now manually compare the pending record's settings with the live Actions UI.
node scripts/create-admin-settings-attestation.mjs \
  confirm --repository aithinkers/knowledge-dlc --output admin-attestation.json \
  --manual-confirmed admin-settings-pending.json
gh variable set KDLC_ADMIN_SETTINGS_ATTESTATION --body "$(tr -d '\n' < admin-attestation.json)"
```

The local files contain live administrative evidence and must not be committed.
The capture command obtains fresh bytes directly from the authenticated GitHub
API; it accepts no cached input and cannot run in Actions. It produces only a
pending record and never asserts a manual confirmation. The separate confirm
command re-authenticates the same owner, verifies the pending byte and canonical
hashes, and records a later confirmation time. The attestation binds the
repository, exact settings, `https://api.github.com` origin, API endpoint,
response hash, capture and manual-check
times, actor, capture method, and canonical hash. Missing or stale evidence does
not make an ordinary private prerelease PR inoperable, but a release candidate
fails closed unless the record is authentic, policy-preserving, manually
cross-checked, and no more than 24 hours old. Public visibility, rulesets,
issues, checks, and review facts continue to come directly from GitHub's API in
the trusted-base token job.

## Live repository settings (verified 2026-08-15)

- Private vulnerability reporting, secret scanning, push protection, and
  Dependabot security updates are enabled.
- GitHub non-provider secret patterns and validity checks are unavailable for
  the current repository eligibility and therefore remain explicit blockers.
- Actions default workflow permissions are read-only, pull-request approval is
  not granted to workflows, and full-SHA action pinning is required.
- `allowed_actions` remains `all` for current workflow compatibility. A final
  release decision must either move to an enforced selected-action allowlist or
  record independent acceptance of that residual risk.
- Required status checks must include the stable `Release matrix` aggregator
  after it has produced successful evidence on the release candidate.

## Final REL-001 blockers

Issue #10 remains open until the separate statistical evaluation report with
repeated trials, confidence intervals, and profile thresholds passes;
conformance and evaluation evidence is independently reviewed and published;
version, changelog, packages, SBOM, notices, and artifacts agree; current public
visibility and post-release verification are recorded; and an independent
release verifier confirms the evidence.
