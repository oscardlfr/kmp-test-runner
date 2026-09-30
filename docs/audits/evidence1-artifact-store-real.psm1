# evidence1-artifact-store-real.psm1
#
# DRAFTED, NEVER EXECUTED CODE, WITH ONE EXPLICIT CARVE-OUT -- same standing
# notice as evidence1-artifact-store-fake.psm1's own: this module has not
# been imported, dot-sourced, or run outside a real, non-privileged Pester
# test against a $TestDrive/scratch-scoped fixture (see
# tests/pester/Evidence1-Artifact-Store-Real.Tests.ps1). It never touches
# Hyper-V, a VM, the guest, or the broker -- every path it touches is
# caller-supplied and scoped under C:\kmp-eval\scratch\ (or an injected
# -TrustedRoot), the exact same carve-out evidence1-artifact-store-fake.psm1
# already has, because -- like that module -- this one is genuinely a local
# filesystem operation, not a privileged one.
#
# ============================================================================
# What "real" means here -- this is NOT the usual fake/hyperv split
# ============================================================================
# Every other capability's -fake/-real(-hyperv) split in this repo divides
# along a PRIVILEGE boundary: the fake has zero I/O, the real touches
# Hyper-V/a VM/an elevated broker. ArtifactStore is different on purpose:
# evidence1-artifact-store-fake.psm1's own header already says it plainly --
# "despite its name, it already does REAL, non-privileged local filesystem
# I/O." Both this module and its fake sibling do the identical kind of I/O.
# What THIS module adds, extending (not replacing) the fake's already-proven
# staging/transaction/ready/crash-recovery protocol (see that module's header
# for the six-step protocol this module is behavior-preserving with), is two
# genuinely new pieces of evidence-integrity hardening the fake deliberately
# does not have: (1) a SHA-256 hash/byte-count custody manifest per published
# file, and (2) a fail-closed sensitive-content scan before anything is
# staged. evidence1-artifact-store-fake.psm1 is left completely unmodified --
# other callers/tests depend on the fast, simple version, per this round's
# explicit instruction.
#
# ============================================================================
# Hash / custody format decision
# ============================================================================
# SHA-256 of every file's STAGED (post-copy) bytes -- not the source file --
# using this codebase's already-established stream-hashing idiom (see
# evidence1-broker-status-real.psm1's Get-E1BrokerFileSha256 and
# evidence1-dual-condition-canary-contract.psm1's Get-E1FileSha256: open
# FileMode.Open/FileAccess.Read/FileShare.Read, SHA256.ComputeHash($stream),
# lowercase hex, dispose both in nested finally blocks -- duplicated here as
# its own small helper, not imported, matching this codebase's own
# established per-file-small-helper convention for this exact idiom).
# Hashing the STAGED copy rather than the source additionally proves the
# bytes that actually reached the (soon-to-be-public) side of the operation,
# not merely what the source looked like before Copy-Item ran.
#
# The manifest ({relative_path, sha256, byte_count} per file) is recorded in
# the .publication.transaction.json AND .publication.ready.json SIDECAR FILES
# on disk -- deliberately NOT added as a new key on
# New-E1ArtifactStorePublicationResult's return value.
# Assert-E1ArtifactStorePublicationResult (evidence1-artifact-store-contract.psm1,
# shared, unmodified) does an EXACT key-set comparison and would reject any
# extra key outright -- confirmed by reading that assert directly, not
# assumed. Extending the shared contract's required-key list would also
# change what evidence1-artifact-store-fake.psm1's own already-passing tests
# must produce, which is out of this round's scope (the fake stays
# unmodified). The sidecar files are the correct place for this anyway: they
# are what a LATER reader of the public tier actually opens to verify custody
# "after the fact" (this round's own explicit requirement), independent of
# whatever any particular caller received back as a return value at
# publish-time.
#
# ============================================================================
# Sensitive-content redaction design -- fail-closed, closed pattern set
# ============================================================================
# Before ANY file is staged, every file under -PrivateRoot is scanned (in a
# separate verify-then-act pass, the same two-pass shape
# evidence1-artifact-copy-hyperv.psm1's Copy-E1ArtifactsReadOnly already
# uses for its own closed source-set verification: "verify the complete
# closed set before copying anything") against a SMALL, closed set of
# high-confidence secret SHAPES -- never a vague "looks sensitive" heuristic:
#   - a PEM private-key header (RSA/OPENSSH/EC)
#   - an AWS-style access key id (AKIA + 16 upper/digit chars)
#   - a GitHub-style personal access token (ghp_ + 36 alnum chars)
#   - a general email-address shape (not only the one literal address this
#     engagement already found and fixed committed in test fixtures --
#     `git log --oneline -i --grep=email` finds commit 0282419,
#     "fix(evidence1): remove real personal email from committed test
#     fixtures," which replaced the maintainer's real personal email address
#     with @evidence1.example placeholders across two test files -- the
#     literal address itself is deliberately NOT reproduced here, even
#     though it already appears once in that commit's own history; a
#     redaction module's own source is not the place to add a second copy of
#     it. That was a single literal string; this scan generalizes to the
#     SHAPE so a DIFFERENT real address landing in evidence data would still
#     be caught)
# If ANY file matches ANY pattern, the WHOLE publication throws closed --
# same "throw with a stable identifier, dynamic detail after the colon"
# convention this function's every other error path already uses (matching
# this module's own inherited-from-the-fake artifact_store_private_root_missing/
# artifact_store_*_outside_scratch style) -- naming the offending relative
# path(s) and which pattern(s) matched, WITHOUT ever including the matched
# text itself in the thrown message (same reason-code-not-raw-detail
# discipline as evidence1-broker-capability-contract.psm1's own
# Get-E1BrokerCapabilityReasonCodePrefix convention, applied here to file
# content instead of a request field). Nothing is staged, nothing is
# published, no partial state -- the scan runs BEFORE crash-state recovery
# too (see "scan-before-recover" below), so a rejected publish leaves the
# filesystem completely untouched, not merely "no new staging directory."
#
# Why fail-closed with a SMALL pattern set rather than a broader heuristic:
# matches this codebase's established discipline of a validator that cannot
# cleanly classify something rejecting it rather than guessing (compare
# evidence1-live-handoff-contract.psm1's own dual-auth shape asserts, which
# throw on any structural doubt rather than accepting a best-effort parse).
# False positives here are a real but acceptable cost for a benchmark-
# evidence pipeline -- a human can inspect the flagged file and re-run;
# silent leakage of a real credential or a real personal email address into
# published, potentially-shared evidence is not an acceptable cost at any
# rate. A broader heuristic (entropy scoring, generic "key=value"-shaped
# lines, etc.) was deliberately NOT attempted: it would trade a bounded,
# auditable pattern list for a fuzzier one with its own unbounded false-
# positive/false-negative profile, and this round's task was scoped to "a
# SMALL, closed set of high-confidence secret SHAPES (not a vague
# heuristic)" specifically.
#
# Scan-before-recover: the sensitive-content scan runs BEFORE the leftover-
# .staging/orphaned-transaction crash-recovery step, not after. Recovery only
# ever touches debris from a DIFFERENT, already-dead prior attempt (a leftover
# .staging directory or an orphaned transaction record at the PUBLIC path) --
# it has nothing to do with whether THIS call's -PrivateRoot content is
# clean. Running the scan first means a rejected publish is a strictly
# read-only operation end to end: no recovery deletion, no staging directory,
# nothing written or removed, anywhere. This is a deliberate ordering choice,
# not the only defensible one -- flagged as such in this round's architecture
# note addendum.
#
# ============================================================================
# -TrustedRoot stays optional / env-var-aware, unlike evidence1-artifact-copy-hyperv.psm1
# ============================================================================
# evidence1-artifact-copy-hyperv.psm1 made -TrustedRoot Mandatory with NO
# env-var-or-literal default, specifically because it pulls data OUT OF a
# live guest VM via VHD mount -- an unprivileged environment variable must
# never be able to widen or redirect where real Hyper-V guest evidence lands
# (see that module's own header). This module has no guest/VM access
# whatsoever -- it is a host-local, already-resident-file, private-to-public
# republish. Per this round's own explicit spec ("[-TrustedRoot]" as
# optional, "Get-E1ArtifactStoreDefaultTrustedRoot... companion," "a drop-in
# import-swap for the fake"), -TrustedRoot here stays optional and
# env-var-aware, byte-for-byte the same resolution
# evidence1-artifact-store-fake.psm1 already uses (both delegate to the one
# shared evidence1-trusted-root-config.psm1). This is a real, deliberate
# difference from ArtifactCopy-real's stricter sealed design, not an
# oversight -- flagged explicitly as an open question in this round's
# architecture note addendum for the maintainer: once this module is ever
# actually wired into a live campaign's Closed state, should its trust root
# be sealed the same way ArtifactCopy-real's is, given it would by then be
# publishing real (not fake) campaign evidence? Not resolved here.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-artifact-store-contract.psm1') -Force -DisableNameChecking -Global
Import-Module (Join-Path $PSScriptRoot 'evidence1-trusted-root-config.psm1') -Force -DisableNameChecking -Global

function Resolve-E1ArtifactStoreFullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

# Identical delegation to evidence1-artifact-store-fake.psm1's own function of
# the same name -- see evidence1-trusted-root-config.psm1's header for why a
# shared leaf module, not a cross-import of one fake from the other.
function Get-E1ArtifactStoreDefaultTrustedRoot {
  return Get-E1DefaultTrustedRoot
}

# Identical logic to evidence1-artifact-store-fake.psm1's own
# Assert-E1ArtifactStoreScratchScoped -- duplicated, not imported (the fake
# is explicitly left unmodified this round, and importing a *-fake.psm1 from
# a *-real.psm1 sibling would be backwards layering regardless).
function Assert-E1ArtifactStoreScratchScoped([string]$Path, [string]$Label, [string]$TrustedRoot = (Get-E1ArtifactStoreDefaultTrustedRoot)) {
  $full = Resolve-E1ArtifactStoreFullPath $Path
  $rootFull = (Resolve-E1ArtifactStoreFullPath $TrustedRoot).TrimEnd('\') + '\'
  if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "artifact_store_$($Label)_outside_scratch"
  }
  return $full
}

# PUBLIC. See this file's own header, "Sensitive-content redaction design".
# The closed pattern set -- exported so a test (or a future reader) can
# enumerate exactly what is and is not covered without reverse-engineering it
# from Find-E1ArtifactStoreSensitiveContentMatches's own body.
function Get-E1ArtifactStoreSensitiveContentPatterns {
  return @(
    [ordered]@{ pattern_id = 'private_key_header'; regex = '-----BEGIN (RSA|OPENSSH|EC) PRIVATE KEY-----' }
    [ordered]@{ pattern_id = 'aws_access_key_id'; regex = 'AKIA[0-9A-Z]{16}' }
    [ordered]@{ pattern_id = 'github_personal_access_token'; regex = 'ghp_[A-Za-z0-9]{36}' }
    [ordered]@{ pattern_id = 'email_address'; regex = '[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}' }
  )
}

# PUBLIC, standalone (callable without a full publish) so this property can
# be tested in isolation -- same "public standalone confinement/validation
# helper" shape evidence1-run-manifest-contract.psm1's own
# Assert-E1RunManifestOutputRootsConfined already established. Reads every
# file under $PrivateRootFull as raw bytes -> UTF-8 text (permissive decode,
# never throws on invalid bytes -- a genuinely binary file simply will not
# match any of these text-shaped patterns; no separate binary-file branch is
# needed). Returns one entry per (file, pattern) match -- never the matched
# substring itself, only the relative path and the pattern's stable id.
function Find-E1ArtifactStoreSensitiveContentMatches([string]$PrivateRootFull) {
  $patterns = Get-E1ArtifactStoreSensitiveContentPatterns
  $files = @(Get-ChildItem -LiteralPath $PrivateRootFull -Recurse -File)
  $matches = @()
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($PrivateRootFull.TrimEnd('\').Length + 1)
    $bytes = [IO.File]::ReadAllBytes($file.FullName)
    $text = [Text.Encoding]::UTF8.GetString($bytes)
    foreach ($pattern in $patterns) {
      if ($text -match $pattern.regex) {
        $matches += [ordered]@{ relative_path = $relative; pattern_id = [string]$pattern.pattern_id }
      }
    }
  }
  return $matches
}

# Private. Same stream-hashing idiom as evidence1-broker-status-real.psm1's
# Get-E1BrokerFileSha256 / evidence1-dual-condition-canary-contract.psm1's
# Get-E1FileSha256 -- see this file's own header, "Hash / custody format
# decision".
function Get-E1ArtifactStoreRealFileSha256([string]$Path) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
  } finally { $stream.Dispose() }
}

# PUBLIC. Same six-step protocol as evidence1-artifact-store-fake.psm1
# (idempotent already-committed short-circuit -> crash-state recovery ->
# stage -> transaction record -> atomic rename -> ready marker), with two
# insertions: a sensitive-content pre-flight scan immediately after the
# idempotent short-circuit (see "Scan-before-recover" above), and a
# hash/byte-count manifest computed while staging, written into both sidecar
# files. Returns the exact same New-E1ArtifactStorePublicationResult 8-key
# shape the fake returns -- drop-in import-swap for it.
function Publish-E1ArtifactStoreSet {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$PrivateRoot,
    [Parameter(Mandatory)][string]$PublicRoot,
    [string]$TrustedRoot = (Get-E1ArtifactStoreDefaultTrustedRoot)
  )
  $privateFull = Assert-E1ArtifactStoreScratchScoped $PrivateRoot 'private_root' -TrustedRoot $TrustedRoot
  $publicFull = Assert-E1ArtifactStoreScratchScoped $PublicRoot 'public_root' -TrustedRoot $TrustedRoot
  if (-not (Test-Path -LiteralPath $privateFull -PathType Container)) { throw 'artifact_store_private_root_missing' }

  $stagingPath = "$publicFull.staging"
  $transactionPath = "$publicFull.publication.transaction.json"
  $readyPath = "$publicFull.publication.ready.json"

  # Idempotent short-circuit -- MUST fire before anything else below,
  # including the sensitive-content scan: a genuinely completed publication
  # (ready marker present AND the public root itself present) is NEVER
  # re-inspected, re-scanned, or re-touched again, even when this function is
  # called again with a DIFFERENT -PrivateRoot for the SAME -PublicRoot. See
  # this module's own regression test ("no-overwrite regression") for the
  # explicit proof of exactly this property, and
  # evidence1-artifact-store-fake.psm1's own identical short-circuit, which
  # this is behavior-preserving with.
  if ((Test-Path -LiteralPath $readyPath -PathType Leaf) -and (Test-Path -LiteralPath $publicFull -PathType Container)) {
    $artifactCount = @(Get-ChildItem -LiteralPath $publicFull -Recurse -File).Count
    return New-E1ArtifactStorePublicationResult -PrivateRoot $privateFull -PublicRoot $publicFull `
      -State 'already-committed' -ArtifactCount $artifactCount -RecoveredTornState $false -Verdict 'PASS'
  }

  # Sensitive-content pre-flight scan -- see this file's own header,
  # "Scan-before-recover". Runs before ANY mutation; a rejection here leaves
  # the filesystem completely untouched.
  $sensitiveMatches = @(Find-E1ArtifactStoreSensitiveContentMatches $privateFull)
  if ($sensitiveMatches.Count -gt 0) {
    $matchSummary = ($sensitiveMatches | ForEach-Object { "$($_.relative_path) [$($_.pattern_id)]" }) -join '; '
    throw "artifact_store_sensitive_content_detected: $matchSummary"
  }

  $recoveredTornState = $false
  if (Test-Path -LiteralPath $stagingPath) {
    Remove-Item -LiteralPath $stagingPath -Recurse -Force
    $recoveredTornState = $true
  }
  if ((Test-Path -LiteralPath $transactionPath -PathType Leaf) -and -not (Test-Path -LiteralPath $readyPath -PathType Leaf)) {
    Remove-Item -LiteralPath $transactionPath -Force
    $recoveredTornState = $true
  }

  $sourceFiles = @(Get-ChildItem -LiteralPath $privateFull -Recurse -File)
  New-Item -ItemType Directory -Path $stagingPath -Force | Out-Null
  $manifestEntries = @()
  foreach ($file in $sourceFiles) {
    $relative = $file.FullName.Substring($privateFull.TrimEnd('\').Length + 1)
    $destination = Join-Path $stagingPath $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
    $destinationItem = Get-Item -LiteralPath $destination
    # Hash the STAGED copy, not the source -- see this file's own header.
    $manifestEntries += [ordered]@{
      relative_path = $relative
      sha256        = Get-E1ArtifactStoreRealFileSha256 $destination
      byte_count    = [int64]$destinationItem.Length
    }
  }

  $transaction = [ordered]@{
    schema         = 1
    artifact_count = $sourceFiles.Count
    manifest       = $manifestEntries
    created_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  }
  ($transaction | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $transactionPath -Encoding UTF8

  if (Test-Path -LiteralPath $publicFull) { Remove-Item -LiteralPath $publicFull -Recurse -Force }
  [IO.Directory]::Move($stagingPath, $publicFull)

  $ready = [ordered]@{
    schema           = 1
    committed_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    artifact_count   = $sourceFiles.Count
    manifest         = $manifestEntries
  }
  ($ready | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $readyPath -Encoding UTF8

  return New-E1ArtifactStorePublicationResult -PrivateRoot $privateFull -PublicRoot $publicFull `
    -State 'committed' -ArtifactCount $sourceFiles.Count -RecoveredTornState $recoveredTornState -Verdict 'PASS'
}

Export-ModuleMember -Function `
  Get-E1ArtifactStoreDefaultTrustedRoot, `
  Assert-E1ArtifactStoreScratchScoped, `
  Get-E1ArtifactStoreSensitiveContentPatterns, `
  Find-E1ArtifactStoreSensitiveContentMatches, `
  Publish-E1ArtifactStoreSet
