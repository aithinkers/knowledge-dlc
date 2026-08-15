# Extension SDK

K-DLC extensions are data-first plugin manifests. A manifest may contribute
versioned templates, profiles, scopes, sensors, and normalizers. Executable
entry points are declared separately with their isolation mode, path, resource
limits, and complete filesystem, network, credential, subprocess, and macro
permissions.

Installation is a gated sequence:

1. Validate the strict `v1alpha1` schemas and canonical semantic versions.
2. Scan the actual package root without executing it. The bounded scanner
   rejects symlinks, parses every executable's transitive imports, detects
   undeclared sensitive capabilities and credentials, hashes every file, and
   signs its report with runtime-held key material. Because static JavaScript
   analysis cannot prove the absence of ambient behavior, every executable is
   also classified as capable of dynamic filesystem, network, credential,
   subprocess, and macro access; controlled hosts must enforce those denials.
3. Verify the trusted framework identity and exact OKF version, revision, and
   hash against the dependency lock. Every plugin in the installed graph and
   every direct or transitive edge binds version, manifest hash, and package
   hash.
4. Preview a runtime-signed permission report for every executable in the
   installed graph. In controlled mode the host's trusted sandbox attestation
   must demonstrate effective enforcement and sufficient scopes and ceilings
   for filesystem, network, credential, subprocess, macro, memory, CPU, and
   output boundaries.
5. Obtain explicit trust from an authenticated `plugin-trust` principal for any
   executable plugin.
6. If controlled-mode sandbox evidence is absent or insufficient, reject the
   executable unless an authenticated governance reviewer grants a live waiver
   scoped to the exact signed report and fully-qualified executable IDs.

Authorization reports explicitly state `execution_status: not-executed`; the
SDK does not execute plugin code. Normalizer and sensor contributions bind
to declared executable IDs so the existing bounded normalizer worker and
governed sensor runtime remain the execution boundary.

Migrations are declarative. `previewMigration` operates on an explicit in-memory
snapshot and returns changed-path hashes plus human-readable semantic effects.
Those effects and downgrade flags are derived from the actual structured diff;
the descriptor's self-reported category is not trusted. Applying a
security-weakening preview requires a separate live waiver from an authenticated
governance reviewer.
`applyMigrationPreview` accepts only the original issued preview object and its
exact confirmation hash; it returns proposed output bytes and performs no
filesystem writes. Callers retain responsibility for their normal transactional
and review gates.
