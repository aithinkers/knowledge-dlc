# Extension SDK

K-DLC extensions are data-first plugin manifests. A manifest may contribute
versioned templates, profiles, scopes, sensors, and normalizers. Executable
entry points are declared separately with their isolation mode, path, resource
limits, and complete filesystem, network, credential, subprocess, and macro
permissions.

Installation is a gated sequence:

1. Validate the strict `v1alpha1` schemas and canonical semantic versions.
2. Verify framework and OKF compatibility against the exact dependency lock,
   manifest hash, package hash, and transitive plugin identities.
3. Compare the manifest to a trusted package inventory and preview the complete
   permission report and host enforcement limitations.
4. Obtain explicit trust from an authenticated `plugin-trust` principal for any
   executable plugin.
5. In controlled mode, reject every unsandboxed executable unless an
   authenticated governance reviewer grants a live waiver scoped to the exact
   report, manifest, and executable IDs.

The SDK does not execute plugin code. Normalizer and sensor contributions bind
to declared executable IDs so the existing bounded normalizer worker and
governed sensor runtime remain the execution boundary.

Migrations are declarative. `previewMigration` operates on an explicit in-memory
snapshot and returns changed-path hashes plus human-readable semantic effects.
`applyMigrationPreview` accepts only the original issued preview object and its
exact confirmation hash; it returns proposed output bytes and performs no
filesystem writes. Callers retain responsibility for their normal transactional
and review gates.
