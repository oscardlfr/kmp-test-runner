// SPDX-License-Identifier: MIT
// Named runtime contracts exposed by `kmp-test --version --json` and every
// canonical JSON envelope. Named contracts let consumers reject an old global
// installation before running Gradle, without guessing from an already-used
// package version.

export const RUNNER_CONTRACTS = Object.freeze({
  // Numeric coverage fields come only from real contributing XML. An explicit
  // parallel/changed coverage-tool request fails closed when no selected
  // module contributes, while mixed real/no-XML inputs retain only real totals.
  coverage_evidence: 1,
});

export function runnerContracts() {
  return { ...RUNNER_CONTRACTS };
}

export function buildRunnerIdentity({ version, schemaVersion }) {
  return {
    tool: 'kmp-test',
    version,
    schema_version: schemaVersion,
    contracts: runnerContracts(),
  };
}

export function supportsRunnerContract(identity, name, minimumVersion = 1) {
  if (!identity || identity.tool !== 'kmp-test') return false;
  if (!Number.isInteger(minimumVersion) || minimumVersion < 1) return false;
  const actual = identity.contracts?.[name];
  return Number.isInteger(actual) && actual >= minimumVersion;
}
