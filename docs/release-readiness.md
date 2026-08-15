# REL-001 release readiness

This document records pre-release gates. It is not a conformance statement,
release announcement, or evidence that REL-001 is complete.

## First tranche

The first tranche covers public documentation, confidential reporting routes,
dependency and secret scanning, license/notices/SBOM verification, and package
metadata. Publishing, version finalization, tags, release artifacts,
conformance claims, deterministic/statistical release reports, and work that
depends on issues #8, #23, or #24 remain outside this tranche.

## Repository settings still required

These settings require repository-owner administration after the corresponding
workflows have merged. They are not changed or claimed by this document.

- Enable GitHub private vulnerability reporting, then test the private advisory
  link in `SECURITY.md` with a non-sensitive draft report.
- Enable GitHub secret scanning, non-provider patterns, validity checks, and
  push protection. Resolve any findings before enabling bypass-restricted push
  protection.
- Add the successful `Secret history scan`, `CodeQL`, `Dependency review`, and
  `Supply-chain verification` contexts to the active `K-DLC main protection`
  ruleset. Retain the existing governance and candidate-test requirements.
- Confirm Dependabot alerts and security updates are enabled for npm and GitHub
  Actions, and limit dismissal/bypass authority to maintainers.
- Confirm the dependency graph is enabled so dependency review has a complete
  base/head comparison before making its status required.
- Review Actions permissions at the repository level: read-only by default,
  selected actions only if organizational policy supports it, and no broad
  workflow write token.
- Establish a dedicated confidential security/conduct intake or encrypted form;
  until then, the low-disclosure `connect@aithinkers.com` handshake in the
  policies is the actionable fallback.

## Final REL-001 blockers

Issue #10 remains open until every dependency is closed through reviewed pull
requests; conformance and evaluation evidence is accurate and published;
version, changelog, packages, SBOM, notices, and artifacts agree; current public
visibility and post-release verification are recorded; and an independent
release verifier confirms the evidence.
