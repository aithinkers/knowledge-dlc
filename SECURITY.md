# Security policy

## Supported versions

K-DLC has not released a supported public version. Security fixes currently
target the public `main` branch. This statement does not make pre-release code
production-ready or supported.

## Reporting a vulnerability

Do not open a public issue containing vulnerability details, credentials,
private evidence, or exploit fixtures.

GitHub private vulnerability reporting is enabled. Use
[`https://github.com/aithinkers/knowledge-dlc/security/advisories/new`](https://github.com/aithinkers/knowledge-dlc/security/advisories/new),
or email
[connect@aithinkers.com](mailto:connect@aithinkers.com?subject=K-DLC%20confidential%20security%20report)
with the subject `K-DLC confidential security report`. In the first message,
send only your contact information, the affected revision, and a non-sensitive
impact category. Ask for an encrypted or otherwise mutually agreed channel
before sending reproduction details, logs, source material, or exploit code.

We aim to acknowledge a report within 3 business days, establish a protected
channel before requesting sensitive detail, and provide a status update within
10 business days. These are response targets, not a disclosure deadline or a
promise that a pre-release version will receive a patch.

Reports should include affected revision, impact, reproduction conditions, and
suggested mitigation when known. Never include live credentials or restricted
source content.

The repository's confidential advisory route and the low-disclosure email
handshake are both tracked in [release readiness](docs/release-readiness.md).

## Security development rules

Security changes require a GitHub issue or private advisory, negative tests,
independent review, and a traceability entry. Publication, access-control,
rights, retention, parser isolation, and prompt-injection controls fail closed.
