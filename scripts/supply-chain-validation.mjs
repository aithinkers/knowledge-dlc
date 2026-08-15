export function exactPackageManifestFailures(actual, expected) {
  const normalize = (values) => [...new Set(values)].sort();
  const actualPaths = normalize(actual);
  const expectedPaths = normalize(expected);
  const expectedSet = new Set(expectedPaths);
  const actualSet = new Set(actualPaths);
  return [
    ...actualPaths.filter((path) => !expectedSet.has(path)).map((path) => `unexpected emitted package file: ${path}`),
    ...expectedPaths.filter((path) => !actualSet.has(path)).map((path) => `missing emitted package file: ${path}`)
  ];
}

export function installedMetadataFailures({ identity, entry, metadata, allowedLicenses }) {
  const failures = [];
  if (metadata.name !== identity.name || metadata.version !== entry.version) failures.push(`installed identity differs from lock: ${identity.name}@${entry.version}`);
  if (typeof metadata.license !== "string" || !allowedLicenses.includes(metadata.license)) failures.push(`installed license is not allowlisted: ${identity.name}@${entry.version} (${metadata.license ?? "missing"})`);
  return failures;
}
