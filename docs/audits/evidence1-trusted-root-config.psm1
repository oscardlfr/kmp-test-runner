# evidence1-trusted-root-config.psm1
#
# Single shared "local/installation configuration" layer (the maintainer's own
# phrase, first used when evidence1-run-manifest-contract.psm1 grew its own
# Get-E1RunManifestDefaultTrustedRoot) for the ONE trust root every
# output-artifact-confinement check in this codebase resolves against when a
# caller does not explicitly inject one: EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT if
# a deployment has set it, else the historical C:\kmp-eval\scratch\.
#
# Why this file exists (output_roots trust-root portability, follow-up round):
# evidence1-run-manifest-contract.psm1's own Assert-E1RunManifestOutputRootsConfined
# was fixed first (see that module's header) to take a caller-injected
# -TrustedRoot parameter instead of a hardcoded module constant, with
# Get-E1RunManifestDefaultTrustedRoot as its own default-resolution function.
# evidence1-artifact-copy-fake.psm1 and evidence1-artifact-store-fake.psm1 each
# had the identical hardcoded-constant gap in their own, separate scratch-
# confinement checks (Assert-E1FakeArtifactCopyDestination /
# Assert-E1ArtifactStoreScratchScoped). Importing evidence1-run-manifest-contract.psm1
# into either of those two capability-level fakes just to reuse one function
# would invert this codebase's own layering: the manifest contract is
# ADR-S6/orchestrator-level (evidence1-run.ps1's own concern, consumed by it
# directly), while ArtifactCopy and ArtifactStore are ADR-S1/ADR-S4
# capability-level modules that evidence1-run.ps1 itself depends on -- a
# capability fake reaching "upward" into the orchestrator's manifest schema
# module would be backwards, and would make two unrelated capability fakes'
# tests incidentally coupled to manifest-shape-validation code (required
# keys, per-runtime entry shape, credential fingerprints, ...) they have
# nothing to do with.
#
# This module is the fix: a small, dependency-free LEAF module (no
# Import-Module of anything else in this repo) that all THREE call sites --
# manifest-contract, artifact-copy-fake, artifact-store-fake -- now resolve
# through, so the env-var-else-historical-default LOGIC lives in exactly one
# place rather than three independent copies that could drift apart. Each of
# the three call sites keeps its own existing (or, for the two fakes, newly
# added) exported function name
# (Get-E1RunManifestDefaultTrustedRoot / Get-E1ArtifactCopyDefaultTrustedRoot /
# Get-E1ArtifactStoreDefaultTrustedRoot) for its own module's public API and
# backward compatibility with already-passing tests and callers -- each is a
# thin delegator to Get-E1DefaultTrustedRoot below, not a second
# implementation of the same env-var-or-literal decision.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The ONE place the literal 'C:\kmp-eval\scratch\' is written in this module.
# Both functions below resolve through this rather than each hardcoding the
# literal a second time -- Get-E1DefaultTrustedRoot (env-var-overridable, for
# the fake/test paths that have no real privilege boundary to protect) and
# Get-E1HistoricalScratchRootLiteral's OWN direct callers elsewhere (the real,
# sealed-configuration paths -- see evidence1-artifact-copy-hyperv.psm1's
# Get-E1ArtifactCopyRealTrustedRoot -- that must NEVER read $env: at all,
# because an unprivileged process/environment variable must not be able to
# widen or redirect where a real backend writes evidence on this host).
function Get-E1HistoricalScratchRootLiteral {
  return 'C:\kmp-eval\scratch\'
}

function Get-E1DefaultTrustedRoot {
  if (-not [string]::IsNullOrWhiteSpace($env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT)) {
    return $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT
  }
  return Get-E1HistoricalScratchRootLiteral
}

Export-ModuleMember -Function Get-E1DefaultTrustedRoot, Get-E1HistoricalScratchRootLiteral
