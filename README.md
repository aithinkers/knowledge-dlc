# K-DLC

K-DLC (Knowledge Development Lifecycle) is a harness-neutral lifecycle and
governance framework for building, querying, and maintaining agent-authored
knowledge bases.

The public repository is in pre-release MVP development against specification
version 0.2.0. It is not a supported release. Conformance is declared
module-by-module; no module or document-format capability is considered
implemented until its linked issue, tests, and independent review evidence are
complete.

## Development status

- [MVP milestone](https://github.com/aithinkers/knowledge-dlc/milestone/1)
- [Requirement and feature backlog](https://github.com/aithinkers/knowledge-dlc/issues)
- [Specification baseline](docs/specification-baseline.md)
- [Traceability index](docs/traceability.json)
- [Agent development contract](AGENTS.md)
- [Development harness](development/README.md)
- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Support policy](SUPPORT.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Release-readiness gates](docs/release-readiness.md)
- [Machine-readable pre-release conformance](distribution/release/conformance-statement.json)
- [Recorded pre-release evaluation](distribution/release/evaluation-report.json)

## Required delivery flow

```text
requirement -> GitHub issue -> reviewed plan -> implementation -> tests
            -> independent review -> pull request -> release evidence
```

Every change must begin with an issue and preserve that relationship through
the branch, commits, pull request, tests, and traceability index. CI enforces
the machine-checkable parts of this contract.

## Local governance checks

```bash
node scripts/verify-governance.mjs
node --test tests/governance/*.test.mjs
npm run check:supply-chain
```

## License

[MIT](LICENSE)
