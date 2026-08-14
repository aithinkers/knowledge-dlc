# K-DLC

K-DLC (Knowledge Development Lifecycle) is a harness-neutral lifecycle and
governance framework for building, querying, and maintaining agent-authored
knowledge bases.

The repository is in private MVP development against specification version
0.2.0. The implementation will declare conformance module-by-module; no module
or document-format capability is considered implemented until its linked issue,
tests, and review evidence are complete.

## Development status

- [MVP milestone](https://github.com/aithinkers/knowledge-dlc/milestone/1)
- [Requirement and feature backlog](https://github.com/aithinkers/knowledge-dlc/issues)
- [Specification baseline](docs/specification-baseline.md)
- [Traceability index](docs/traceability.json)
- [Agent development contract](AGENTS.md)
- [Development harness](development/README.md)
- [Contributing guide](CONTRIBUTING.md)

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
```

## License

[MIT](LICENSE)
