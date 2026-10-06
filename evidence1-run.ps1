# Evidence1 Phase 3 orchestrator -- see docs/audits/evidence1-stabilization-plan.md
# section 7 ("Phase 3 -- broker/API consolidation", action 4: "Provide one public
# run entrypoint") and docs/audits/evidence1-phase3c-architecture-note.md for the
# design rationale behind everything below.
#
# This is ADR-S2's "one idempotent orchestrator" made real, for the non-live half
# of its own state machine only:
#
#   Uninitialized -> BrokerReady -> VmReady -> ToolchainReady -> AuthReady
#                  -> RestrictedReady -> DryRunPassed
#                  -> LiveAuthorized -> LiveRunning -> EvidenceCopied -> Closed
#
# Uninitialized through Closed are now implemented for real (Phase 3c second
# fix-forward round -- see below): inspectable before mutation, idempotent, and
# resumable from a durable per-state PASS receipt, exactly as ADR-S2 requires.
#
# LiveAuthorized/LiveRunning/EvidenceCopied/Closed are real ONLY for the
# fake-backend path. For -UseRealBackends, they remain exactly what they were
# before this round: named transitions that throw immediately if reached (see
# Invoke-E1RunNotYetImplementedState in evidence1-run-state-contract.psm1),
# checked BEFORE that state's handler is even looked up -- never a silent
# no-op, never a TODO that could be wired live by accident. There is no real
# (-hyperv/-real) implementation of ProviderRuntime or ArtifactStore this
# round, deliberately (see evidence1-provider-runtime-fake.psm1's own header):
# building one now, even unused, would be getting ahead of Phase 5's gate
# (the ADR-S6 manifest consumed for real, two consecutive full Phase 4
# rehearsal passes) before that gate exists. Nothing in this file can reach a
# real provider dispatch: with -UseRealBackends, reaching any of the four
# live-adjacent states is still a hard, unconditional stop; with fake
# backends, every capability call those four states make resolves to a fake
# module that is structurally incapable of starting a real process, opening a
# network connection, or reading credential material (see
# evidence1-provider-runtime-fake.psm1 and evidence1-artifact-store-fake.psm1's
# own headers and tests for exactly what "structurally incapable" means and
# how it is proven, not just asserted).
#
# DRAFTED, NEVER EXECUTED CODE -- same standing notice as every *-hyperv.psm1 file
# this repo already carries (see e.g. evidence1-vm-state-hyperv.psm1's header).
# This file additionally imports and calls docs/audits/evidence1-*-fake.psm1 by
# default (see -UseRealBackends below): even the FAKE path has not been run, for
# the same reason -- this round's hard boundary is "never execute any script",
# full stop, not "never execute a script that could touch Hyper-V."
#
# STALE as of the 2026-09-27 independent audit: this notice, and the "hard,
# unconditional stop" claim two paragraphs above, both describe a guard that was
# never actually wired into executable code (Invoke-E1RunNotYetImplementedState
# is referenced only in comments here, never called; $LiveAdjacentStates is
# assigned but never read). Invoke-E1RunEvidenceCopiedState's -UseRealBackends
# path is genuinely live and has executed for real campaigns -- see e.g.
# C:\kmp-eval\scratch\evidence1-run\689b7772-...\EvidenceCopied.receipt.json.
#
# Backends (ADR-S4): by default this script imports the *-fake.psm1 sibling of
# each capability module (BrokerStatus, NetworkBackend, VmState/ensure_state,
# GuestBundle), so the entire Uninitialized..DryRunPassed path is exercisable
# without touching Hyper-V OR this host's own real broker installation --
# exactly what section 7 Phase 4's "full fake Claude/Codex campaign through
# publication" rehearsal needs. Pass -UseRealBackends to import the real
# siblings instead (see the sixth addendum below for exactly which module
# each capability imports now -- it is no longer uniformly "the *-hyperv.psm1
# sibling" for every capability). That switch governs backend REALISM for the
# already-inspectable prefix only; it grants no additional permission to go
# past DryRunPassed -- see Invoke-E1RunNotYetImplementedState.
#
# Sixth addendum (broker capability queue-dispatch protocol -- closes the gap
# docs/audits/evidence1-overnight-execution-report-2026-09-18.md's final
# "PRE-BOOTSTRAP READINESS" section flagged as the single highest-priority
# piece of remaining architecture): VmState, NetworkBackend, and GuestBundle
# previously imported their *-hyperv.psm1 siblings DIRECTLY under
# -UseRealBackends -- calling real Hyper-V/PowerShell-Direct functions
# in-process, from this non-elevated script, never through the elevated
# broker's own queue. That was ADR-S1's own unresolved tension (see
# docs/audits/evidence1-phase3c-architecture-note.md section 5 and section
# 9.4 item 6, where the maintainer's own answer was recorded but not yet
# implemented). Fixed here: -UseRealBackends now imports
# evidence1-vm-state-queue-client.psm1, evidence1-network-backend-queue-client.psm1,
# evidence1-guest-bundle-queue-client.psm1, and (Task 3, this round)
# evidence1-artifact-copy-queue-client.psm1 -- each exports the SAME function
# names as its *-hyperv.psm1 sibling, so every handler body below is
# UNCHANGED; only the import line for each of these four capabilities
# changed. Under the hood, each queue-client submits a closed, typed
# capability request (evidence1-broker-capability-contract.psm1) through
# the SAME elevated queue evidence1-install.ps1's self-update already uses,
# dispatched by the ONE new allowlisted entrypoint,
# evidence1-host-broker-capability-dispatch.ps1, which is the ONLY place in
# this entire codebase still permitted to import a *-hyperv.psm1 module
# directly, in any mode -- see that dispatcher script and
# evidence1-broker-capability-contract.psm1's own headers for the full
# design. This file no longer contains the literal string "-hyperv.psm1" for
# any Import-Module call at all (broker.status stays "-real.psm1", never
# "-hyperv" to begin with -- see the import block below for why it is
# excluded from this rewiring) -- enforced by a regression test that reads
# this file's own source text, not merely asserted here.
#
# Fifth addendum (output_roots trust-root portability follow-up):
# $ResolvedOutputRootsTrustedRoot (below) is now threaded to all THREE
# call sites that need a trust root for this campaign, not only
# Read-E1RunManifest -- Invoke-E1RunEvidenceCopiedState's
# Copy-E1ArtifactsReadOnly call and Invoke-E1RunClosedState's
# Publish-E1ArtifactStoreSet call both now receive it explicitly too, via
# the new $Context.OutputRootsTrustedRoot key. evidence1-artifact-copy-fake.psm1
# and evidence1-artifact-store-fake.psm1 previously each had their own
# separate, still-hardcoded C:\kmp-eval\scratch\ confinement check (the
# fourth addendum below flagged this as a known, not-yet-fixed gap) --
# both now accept a caller-injected -TrustedRoot the same way the manifest
# contract already did, resolving their own defaults through the new shared
# evidence1-trusted-root-config.psm1 leaf module (see its header for why a
# shared module, not a cross-import of the manifest contract). This is the
# SAME resolved value for all three call sites -- resolved exactly once,
# below -- never three independent resolutions that could drift apart.
#
# Fourth addendum (schema-2 fix +
# trust-root portability): (A) evidence1-live-handoff-contract.psm1's dual
# auth host report now requires schema=2 (not 1) whenever an expected Codex
# version is supplied -- unrelated to this file directly (no call site here
# touches that contract), documented here only because it is the same
# engagement's other concurrent fix; see the architecture note. (B) this
# file's own -OutputRootsTrustedRoot parameter, above, replaces what used to
# be a hardcoded C:\kmp-eval\scratch\ constant baked into
# evidence1-run-manifest-contract.psm1 -- see $ResolvedOutputRootsTrustedRoot
# and its own comment, further down, for how it is resolved and why it is
# always explicitly passed to Read-E1RunManifest rather than left to that
# function's own default.
#
# Third addendum (root-cause fixes): three items, each
# implemented RED-tests-first against real Pester execution (see
# docs/audits/evidence1-phase3c-architecture-note.md's own addendum for full
# citations). (1) EvidenceCopied/Closed previously hardcoded
# <CampaignRoot>\private-evidence and \public-evidence, silently ignoring
# the manifest's own output_roots.private/.public (ADR-S6) -- both handlers
# now read $Context.Manifest.output_roots directly, confined and
# canonicalized by Assert-E1RunManifestOutputRootsConfined at manifest-load
# time (evidence1-run-manifest-contract.psm1), and a campaign resumed with a
# different output_roots than its first invocation is now caught loudly via
# Test-E1RunCampaignIdentityMatches (evidence1-run-state-contract.psm1)
# rather than silently switching. (2) LiveRunning's dispatch formula
# (round_order.Count * runtimes.Count sessions) was already correct per plan
# section 6.2, but max_session_count validation only checked
# round_order.Count -- Get-E1RunManifestExpectedCells
# (evidence1-run-manifest-contract.psm1) is now the single source of truth
# for cell cardinality, used by both that validation and this file's
# Invoke-E1RunLiveRunningState, so they cannot drift apart again. (3) Clock
# (ADR-S4) is now a proper contract/real/fake trio
# (evidence1-clock-{contract,real,fake}.psm1) instead of one file playing
# both roles; -UseRealBackends now imports evidence1-clock-real.psm1
# explicitly rather than importing nothing for Clock at all.
#
# Second addendum (Phase 3c, second fix-forward round): broker.status
# (evidence1-broker-status-contract.psm1) originally had no -fake sibling --
# the maintainer's architectural catch was that this made even a fully-fake
# rehearsal depend on this host's real, already-installed broker at
# BrokerReady, an inconsistency with every other capability, not an
# intentional gap. evidence1-broker-status-{real,fake}.psm1 now exist,
# matching the pattern; BrokerReady branches on -UseRealBackends exactly like
# VmReady/ToolchainReady/AuthReady/RestrictedReady already did.
#
# Addendum (Phase 3c fix-forward round): the maintainer ran this script for the
# first time (fake mode, non-live) and it failed immediately at BrokerReady --
# a real bug, found the moment untested code actually ran. Fixed, and fixed the
# same way everywhere it was live across every new Phase 2/3a/3b/3c module; see
# the architecture note's fix-forward addendum for the full account. Two
# structural changes came out of it: (1) the state graph and per-state receipt
# envelope moved into evidence1-run-state-contract.psm1, both because that is
# this codebase's own established one-concern-per-file shape and because it
# makes that logic unit-testable without ever dot-sourcing (executing) this
# script; (2) Invoke-E1RunRestrictedReadyState's fake/hyperv special-casing was
# removed once evidence1-network-backend-fake.psm1 was fixed to accept the same
# -GuestCredentialPath parameter the hyperv implementation always required.
#
# Manifest (ADR-S6): -Manifest is OPTIONAL. When supplied, its shape is fully
# validated (docs/audits/evidence1-run-manifest-contract.psm1) and its
# campaign_id/vm_name/vm_id/runtimes become defaults for the corresponding
# parameters below. When omitted, a DryRun-only invocation still works end to
# end: a fresh campaign ID is generated, a fake VM identity is synthesized, and
# ToolchainReady/AuthReady check every runtime this codebase knows about
# (see $script:E1RunCanonicalRuntimeProbes) rather than a manifest-declared
# subset. A manifest only becomes REQUIRED starting at LiveAuthorized -- with
# fake backends that IS now reachable (Phase 3c second fix-forward round), so
# a manifest-less fake run's target must stop at or before DryRunPassed; a
# manifest is mandatory for any -TargetState at or past LiveAuthorized,
# fake or real. See the architecture note for why "works end to end" is read
# as "completes with a legible PASS or FAIL receipt chain," not "always
# PASSes regardless of host state" (BrokerReady still genuinely depends on
# this host's broker actually being installed when -UseRealBackends is set).
#
# Resumability: every state from BrokerReady through DryRunPassed writes an
# atomic JSON PASS/FAIL receipt under <StateRoot>\<CampaignId>\<State>.receipt.json
# on completion. Re-running this script for the same -CampaignId resumes from the
# highest state with an unbroken chain of PASS receipts back to Uninitialized,
# and calls no backend at all for any state it skips -- see
# Get-E1RunResumeIndex. This is deliberately layered ON TOP of (not a
# replacement for) each capability's own internal idempotency (Get-E1VmState /
# Invoke-E1VmEnsureState etc. already no-op if the target is already reached);
# ADR-S2 separates "idempotent" from "resumable from its last durable PASS
# receipt" as two distinct requirements, and this file satisfies both
# separately for the same reason.

param(
  [string]$Manifest = '',
  [switch]$UseRealBackends = $true,
  [switch]$Inspect,
  [string]$TargetState = 'Closed',
  [string]$CampaignId = '',
  [string]$VMName = '',
  [string]$VMId = '',
  [string]$GuestCredentialPath = '',
  [string]$StateRoot = 'C:\kmp-eval\scratch\evidence1-run',
  [string]$ReportPath = '',
  # Explicitly injected into
  # Read-E1RunManifest/Assert-E1RunManifestShape below -- this script is the
  # "orchestrator injects a parameter" half of the portability fix (the
  # other half being evidence1-run-manifest-contract.psm1's own
  # EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT environment-variable fallback).
  # Empty by default: resolved from the module's own
  # Get-E1RunManifestDefaultTrustedRoot (env var, else the historical
  # C:\kmp-eval\scratch\) further down, so the common case on this host
  # needs no new configuration. Explicitly passing this parameter always
  # wins over the environment variable.
  [string]$OutputRootsTrustedRoot = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
  Write-Error "HARD STOP: $Message"
  exit 1
}

function Resolve-FullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

# A session's own OutputSummary does not always carry benchmark_status: both of
# Invoke-E1ProviderRuntimeSession's real-path failure branches (guest bundle call failed;
# worker failed) return `@{ worker_output_present = $false }` with no such key -- by design, a
# session that never produced worker output has nothing to report a benchmark status FOR. Under
# Set-StrictMode -Version Latest, `$_.output_summary.benchmark_status` on an object that lacks the
# key throws instead of returning $null, which crashed LiveRunning's/EvidenceCopied's own accounting
# before either could record the session as the FAIL it already is and move the state machine
# forward -- confirmed live, campaign 275517a4, 2026-09-28. Same
# dictionary-vs-PSCustomObject-property-names idiom evidence1-run-manifest-contract.psm1's own
# Get-E1RunManifestPropertyNames and evidence1-broker-status-contract.psm1's
# Get-E1BrokerStatusPropertyNames already establish, duplicated locally rather than newly exported
# from either module for one call site's sake.
function Get-E1SafeBenchmarkStatus($OutputSummary) {
  if ($null -eq $OutputSummary) { return $null }
  $names = if ($OutputSummary -is [Collections.IDictionary]) { @($OutputSummary.Keys) } else { @($OutputSummary.PSObject.Properties.Name) }
  if ('benchmark_status' -cnotin $names) { return $null }
  return [string]$OutputSummary.benchmark_status
}

# Textually near-identical to evidence1-install.ps1's own copy -- see the
# architecture note's open question on per-file small-helper duplication
# (hash helpers, atomic JSON writers, this). Not imported from
# evidence1-install.ps1 because it is a script, not a module -- dot-sourcing a
# full .ps1 to reach one four-line helper would also execute that script's
# entire top-level body, which is not something this round can do to reach a
# helper function.
function Assert-PathInside([string]$Candidate, [string]$Root, [string]$Label) {
  $candidateFull = Resolve-FullPath $Candidate
  $rootFull = (Resolve-FullPath $Root).TrimEnd('\') + '\'
  if (-not $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "$Label path is outside expected root: $candidateFull"
  }
}

# ---------------------------------------------------------------------------
# Canonical guest CLI probe targets for ToolchainReady/AuthReady, keyed by the
# runtime_id vocabulary ADR-S6's manifest.runtimes[].runtime_id is expected to
# use ('codex', 'claude' -- lowercase, exact).
#
# Evidence: the version-pinned root directories are read directly from
# evidence1-hyperv-verify-guest-codex-preflight-direct.ps1 lines 112, 118-122
# and evidence1-hyperv-verify-guest-claude-auth-direct.ps1 lines 198-201. The
# LoginStatusArgs are read directly from the same two scripts' own login-status
# probes: codex line 194 ("login status"), claude line 219 ("auth status").
#
# NOT independently confirmed this round: the exact leaf executable filename
# under each version root. Both source scripts resolve the command via
# Get-Command against a temporarily-modified $env:Path rather than a single
# literal file path, so "codex.cmd"/"claude.cmd" directly under the version
# root below is this round's best-evidenced extrapolation, not a re-confirmed
# fact -- see the architecture note's open questions. This does not affect
# fake-mode correctness (Test-E1GuestBundleCanonicalToolchainPath only checks
# the string SHAPE, and evidence1-guest-bundle-fake.psm1 never resolves it
# against a real filesystem); it matters only if -UseRealBackends is ever used
# against a live guest.
# [string[]] cast on LoginStatusArgs (Phase 3c fix-forward round): a bare
# @('login', 'status') array literal, stored as a hashtable value, is a plain
# System.Object[] -- confirmed empirically ($_.LoginStatusArgs -is [string[]]
# is $false for the untyped form, $true only after an explicit [string[]]
# cast). evidence1-guest-bundle-contract.psm1's own argument validator for
# this bundle requires -is [string[]] exactly
# ({ param($v) $v -is [string[]] -and ... }), so without the cast every
# ToolchainReady/AuthReady call -- for both runtimes, in both fake and real
# mode -- would throw guest_bundle_argument_invalid immediately. Found by
# replicating evidence1-run.ps1's exact fake-mode call sequence against the
# real modules (never executing evidence1-run.ps1 itself), not by static
# review; a real, previously-undiscovered bug, not a hypothetical one.
$script:E1RunCanonicalRuntimeProbes = [ordered]@{
  'codex-cli'  = [ordered]@{ CommandPath = 'C:\Evidence1Toolchain\codex-cli\0.154.0\bin\codex.exe'; LoginStatusArgs = [string[]]@('login', 'status') }
  'claude-code' = [ordered]@{ CommandPath = 'C:\Evidence1Toolchain\claude-code\2.1.238\claude.cmd'; LoginStatusArgs = [string[]]@('auth', 'status') }
}

# Manifest-declared runtimes if a manifest was supplied, else every runtime
# this file knows a probe for -- see the module header on why "no manifest"
# still exercises something meaningful rather than vacuously passing.
function Get-E1RunRuntimeIdsToCheck($Context) {
  if ($Context.Manifest) {
    return @($Context.Manifest.runtimes | ForEach-Object { [string]$_.runtime_id })
  }
  return @($script:E1RunCanonicalRuntimeProbes.Keys)
}

# The ONE place in this file (and, by the incident fix's own design, the
# ONE place in this entire codebase) that explicitly constructs the REAL
# queue transport -- see
# docs/audits/evidence1-incident-2026-09-19-real-queue-trigger.md and
# evidence1-broker-capability-client.psm1's own header. -QueueRoot/
# -TriggerTask are now Mandatory, real-default-free parameters on every
# queue-client function; a caller that omits them gets an immediate missing-
# parameter error rather than a silent real dispatch. Splatted at each of
# the four real-backend state handlers below, and ONLY when
# $Context.UseRealBackends is true -- fake mode's own handlers call the
# *-fake.psm1 siblings, which have no such parameters at all.
# 2026-09-29 (canary attempt 1 on 8869d9c2, Amendment A6): host-side, no broker dispatch needed
# -- this process already has ordinary read access to its own disk free space. The literal below
# is the VM root from tools/evidence1/provisioning/evidence1-windows-hyperv-e2e-v1.json
# ("vm.root": "C:\\kmp-eval\\hyperv-e2e", confirmed against the live VHD/AVHDX files directly),
# not re-derived from that profile file at runtime -- same one-literal-not-a-second-read-path
# discipline this file's other hardcoded C:\kmp-eval\... roots already use. A pure query, never a
# throw: BrokerReady/VmReady fold the result into their own existing conditional-verdict shape
# (never $ok = $true/$false with no receipt written -- see this file's own top-level state loop,
# which writes no receipt at all for a handler that throws instead of returning one).
function Get-E1RunHostDiskFreeBytes {
  $root = [System.IO.Path]::GetPathRoot('C:\kmp-eval\hyperv-e2e')
  $drive = [System.IO.DriveInfo]::new($root)
  return [int64]$drive.AvailableFreeSpace
}

# BrokerReady's own baseline read of "what commit are we running against" -- the first live state
# in the whole pipeline, so there is no earlier-verified receipt to pin against yet (contrast
# DryRunPassed's own expected-commit read above, which deliberately uses ToolchainReady's already-
# verified target_commit rather than a fresh git call, precisely because HEAD could move between
# BrokerReady and DryRunPassed; BrokerReady itself has no such earlier point to prefer).
function Get-E1RunLocalGitCommit([string]$SourceRepoDir) {
  $commit = ([string](& git.exe -C $SourceRepoDir rev-parse HEAD)).Trim()
  if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw 'broker_harness_local_commit_unavailable' }
  return $commit
}

# Single-key dual-shape-safe read -- same idiom Invoke-E1RunVmReadyState's own result-copy loop
# already inlines for its whole object (real Invoke-E1VmEnsureState/broker-capability results cross
# the queue's own JSON round trip and come back as PSCustomObject, never a Hashtable/IDictionary --
# confirmed live: the .Keys regression an earlier VmReady fix introduced). Pulled
# out as its own one-key helper here because the disk guard's formula reads several keys off two different
# object shapes (the chain inspection result itself, and each entry inside its own chain[] array),
# not one flat copy loop.
# (Found live during the first fake-mode GREEN run against the
# formula this feeds): PowerShell unrolls a ONE-element array to its bare element whenever it
# crosses a function `return` or an if/else EXPRESSION capture -- confirmed directly, the hard way
# (a 2-element chain, used by every existing test fixture, survives that round trip unchanged,
# which is exactly why this went undetected; the fake mode's own single-link chain literal is what
# first exercised the 1-element case for real). Reading into a plain if/else STATEMENT (assigning
# inside each branch, never capturing the if/else as a value-producing expression) avoids the
# collapse on the way IN; comma-wrapping the return, but only once $value is confirmed to already
# be an array, avoids it on the way OUT without disturbing a genuine scalar (which the same
# unconditional comma-wrap would otherwise incorrectly box into a 1-element array of its own).
function Get-E1RunPropertyValue($Object, [string]$Key) {
  if ($Object -is [Collections.IDictionary]) {
    $value = $Object[$Key]
  } else {
    $value = $Object.$Key
  }
  if ($value -is [array]) { return ,$value }
  return $value
}

# The principled VmReady disk guard, replacing the flat 15 GiB floor
# with the real worst-case growth bound -- Amendment A6's own confirmed formula (this
# closure's own host-disk-exhaustion canary-1 root cause), drafted mid-session then
# descoped once the user freed host space directly (see the A6 addendum: "the guard... deferred to
# a future WO, to be validated by a fresh GREEN gate run... not by this campaign's own gate" -- this
# is that WO). $ChainInspection is evidence1-hyperv-inspect-vhd-chain-direct.ps1's own report shape:
# chain[0] is the attached/leaf disk (the walk starts at the attached path and appends outward
# toward the base, never sorted), leaf virtual_size/file_size are the worst-case growth bound
# (VirtualSize - avhdx FileSize is how far the leaf CAN still grow on the host before hitting its
# own ceiling, not a base+diff sum against one virtual size -- Amendment A6's correction).
# MemoryStartup only adds to the requirement when the VM's own AutomaticStopAction is Save AND it
# isn't already Running (a Running VM's save-state reservation, if any, already exists and is
# already counted in the host's OWN currently-reported free bytes -- adding it again would double
# count exactly the case VmReady itself is about to hit, starting the VM).
# Fail-open fix: [int64]$null is 0 and [string]$null is '' -- both cast
# silently instead of failing, so a missing virtual_size made the leaf slack negative (the floor
# always "won", the check PASSED with no real chain data behind it) and a missing/garbled
# automatic_stop_action silently skipped the Save reservation instead of surfacing that the field
# was never read. Rejects a non-numeric-typed value outright (a numeric-looking STRING is a
# malformed request, not an equivalent one -- same discipline
# Assert-E1BrokerCapabilityArguments already applies elsewhere in this codebase).
function Get-E1RunRequiredPositiveInt64($Object, [string]$Key) {
  $raw = Get-E1RunPropertyValue $Object $Key
  if ($raw -isnot [int] -and $raw -isnot [int64] -and $raw -isnot [long] -and $raw -isnot [double]) {
    throw "vhd_chain_inspection_unavailable: $Key missing or not numeric"
  }
  $value = [int64]$raw
  if ($value -le 0) { throw "vhd_chain_inspection_unavailable: $Key not a positive integer" }
  return $value
}

function Get-E1RunVmReadyRequiredDiskBytes($ChainInspection) {
  # @($x) on a genuinely-$null $x is a ONE-element array containing $null, never @() -- the same
  # PowerShell array-wrapping trap this closure has already hit with @(ConvertFrom-Json '[]').
  # $chain missing entirely (Get-E1RunPropertyValue returns $null) must fail closed exactly like an
  # explicit empty array does; checking for $null before the @() wrap is what makes both cases throw
  # the same way instead of only the explicit-empty-array one.
  #
  # The ORIGINAL `$chain = if ($null -eq $chainRaw) { @() } else
  # { @($chainRaw) }` had the exact same if/else-expression-capture array collapse
  # Get-E1RunPropertyValue's own header now documents -- a genuinely single-link chain (this
  # formula's single most common real shape: no checkpoint) collapsed right back down to $chain
  # being the LEAF'S OWN FIRST KEY-VALUE (a bare Int64), not a 1-element array containing the leaf,
  # even with Get-E1RunPropertyValue's own return already fixed. Assigning inside a plain
  # if-STATEMENT, never through an if/else used as a value, avoids it here too.
  $chainRaw = Get-E1RunPropertyValue $ChainInspection 'chain'
  if ($null -eq $chainRaw) {
    $chain = @()
  } else {
    $chain = @($chainRaw)
  }
  if ($chain.Count -lt 1) { throw 'vhd_chain_inspection_unavailable' }
  $leaf = $chain[0]

  $virtualSize = Get-E1RunRequiredPositiveInt64 $leaf 'virtual_size'
  $fileSize = Get-E1RunRequiredPositiveInt64 $leaf 'file_size'
  # A real differencing disk's own allocated file size can exceed its virtual size only by its own
  # small metadata overhead -- anything past a generous 1 GiB allowance means the chain-inspection
  # data itself is inconsistent (a bug, a corrupted read, or fields from two different disks), not a
  # real disk this formula can safely reason about.
  if ($fileSize -gt ($virtualSize + [int64]1073741824)) {
    throw "vhd_chain_inspection_unavailable: file_size ($fileSize) exceeds virtual_size ($virtualSize) plus the metadata allowance"
  }

  $automaticStopAction = [string](Get-E1RunPropertyValue $ChainInspection 'automatic_stop_action')
  if ($automaticStopAction -cnotin @('Save', 'ShutDown', 'TurnOff')) {
    throw "vhd_chain_inspection_unavailable: automatic_stop_action missing or not a recognized value ('$automaticStopAction')"
  }
  $vmState = [string](Get-E1RunPropertyValue $ChainInspection 'vm_state')
  if ([string]::IsNullOrWhiteSpace($vmState)) {
    throw 'vhd_chain_inspection_unavailable: vm_state missing'
  }

  $floor = [int64]16106127360
  $leafSlack = ($virtualSize - $fileSize) + [int64]3221225472
  $required = [Math]::Max($floor, $leafSlack)
  if ($automaticStopAction -ceq 'Save' -and $vmState -cne 'Running') {
    # Only validated here, not unconditionally above: an absent/garbled memory_startup_bytes on a
    # ShutDown/TurnOff VM (the common case) must never fail a guard that never needed the field.
    $memoryStartupBytes = Get-E1RunRequiredPositiveInt64 $ChainInspection 'memory_startup_bytes'
    $required += $memoryStartupBytes
  }
  return [int64]$required
}

function Get-E1RunRealTransportArguments {
  $status = Get-E1BrokerStatus
  if (-not $status.readable -or [string]::IsNullOrWhiteSpace([string]$status.deployment_root)) {
    throw 'broker_deployment_root_unavailable'
  }
  return @{
    QueueRoot   = Get-E1BrokerCapabilityDefaultQueueRoot
    AllowedRoot = [string]$status.deployment_root
    TriggerTask = (Get-Command Invoke-E1BrokerCapabilityTriggerTask).ScriptBlock
  }
}

function Ensure-E1RunDeployedSessionBundle($Context) {
  return Ensure-E1BrokerSessionBundle -UseRealBackends ([bool]$Context.UseRealBackends) `
    -CampaignRoot $Context.CampaignRoot -InstallerPath (Join-Path $PSScriptRoot 'evidence1-install.ps1') `
    -GetBrokerStatus { Get-E1BrokerStatus }
}

function Invoke-E1RunPrepareHarness($Context) {
  if (-not $Context.UseRealBackends) { return $null }
  $status = Get-E1BrokerStatus
  $sourceRepoDir = Resolve-FullPath $PSScriptRoot
  $targetCommit = ([string](& git.exe -C $sourceRepoDir rev-parse HEAD)).Trim()
  $targetTree = ([string](& git.exe -C $sourceRepoDir rev-parse 'HEAD^{tree}')).Trim()
  if ($LASTEXITCODE -ne 0 -or $targetCommit -notmatch '^[0-9a-f]{40}$' -or $targetTree -notmatch '^[0-9a-f]{40}$') { throw 'prepare_harness_target_resolution_failed' }
  $scriptPath = Join-Path ([string]$status.deployment_root) 'evidence1-hyperv-update-harness-from-bundle.ps1'
  $transport = Get-E1RunRealTransportArguments
  $response = Submit-E1BrokerElevatedScript -ScriptPath $scriptPath -ScriptArguments @(
    '-VMName',$Context.VMName,'-GuestCredentialPath',$Context.GuestCredentialPath,
    '-SourceRepoDir',$sourceRepoDir,'-TargetCommit',$targetCommit,'-TargetTree',$targetTree,
    '-SkipFetch','-HarnessDir',[string]$Context.Manifest.harness_dir,
    '-ReportPath',(Join-Path $Context.CampaignRoot 'prepare-harness.json')
  ) @transport
  if ([int]$response.exit_code -ne 0) { throw 'prepare_harness_dispatch_failed' }
  return [ordered]@{ source_repo_dir=$sourceRepoDir; target_commit=$targetCommit; target_tree=$targetTree; response=$response }
}

function New-E1CurrentCampaignInputs($Manifest, [string]$VMId) {
  return [ordered]@{
    campaign_id = [string]$Manifest.campaign_id
    scenario_id = [string]$Manifest.scenario_id
    seed = [int64]$Manifest.seed
    execution_profile_id = [string]$Manifest.execution_profile_id
    conditions = @($Manifest.conditions)
    max_session_count = [int]$Manifest.max_session_count
    no_automatic_provider_retry = [bool]$Manifest.no_automatic_provider_retry
    vm_name = [string]$Manifest.vm_name
    vm_id = $VMId
    guest_credential_path = [string]$Manifest.guest_credential_path
    harness_dir = [string]$Manifest.harness_dir
    source_template_dir = [string]$Manifest.source_template_dir
    claude_attestation_file = [string]$Manifest.claude_attestation_file
    codex_attestation_file = [string]$Manifest.codex_attestation_file
    readiness_path = [string]$Manifest.readiness_path
    private_root = [string]$Manifest.private_root
    provider_timeout_seconds = [int]$Manifest.provider_timeout_seconds
    worker_timeout_seconds = [int]$Manifest.worker_timeout_seconds
    guest_transport_timeout_seconds = [int]$Manifest.guest_transport_timeout_seconds
    provider_mode = [string]$Manifest.provider_mode
    runtimes = @($Manifest.runtimes)
    round_order = @($Manifest.round_order)
    output_roots = $Manifest.output_roots
  }
}

# ---------------------------------------------------------------------------
# State handlers. Each takes the shared $Context ordered hashtable
# (CampaignId, CampaignRoot, VMName, VMId, GuestCredentialPath, UseRealBackends,
# Manifest) and returns one New-E1RunStateReceipt (evidence1-run-state-contract.psm1).
# Only BrokerReady through DryRunPassed exist -- there is deliberately no handler
# function for any live-adjacent state; see Invoke-E1RunNotYetImplementedState.
# ---------------------------------------------------------------------------

# READ-ONLY. "Ready" means the already-installed broker is present,
# readable and self-update capable. Hash and ACL observations remain available
# in the receipt, but mutable deployment metadata does not block a campaign.
# Get-E1BrokerStatus resolves
# to the fake or real implementation identically to how VmReady/ToolchainReady/
# AuthReady/RestrictedReady already resolve their own capability calls --
# no branching needed in this function body, since both siblings export the
# exact same parameterless signature (Phase 3c second fix-forward round; see
# the module header for why broker.status did not have this split originally).
function Invoke-E1RunBrokerReadyState(
  $Context,
  [scriptblock]$GetHostDiskFreeBytes = ${function:Get-E1RunHostDiskFreeBytes},
  [scriptblock]$GetLocalGitCommit = ${function:Get-E1RunLocalGitCommit}
) {
  $status = Get-E1BrokerStatus
  $hostFreeBytes = [int64](& $GetHostDiskFreeBytes)
  $hostDiskOk = $hostFreeBytes -ge 16106127360
  # The deployed broker's own manifest source_git_commit must equal
  # this repo's local HEAD, or every later state's "verified against HEAD" claim is unearned --
  # -UpdateBroker not having been re-run after the last commit is exactly the gap this closes.
  # Real-backend only: evidence1-broker-status-fake.psm1's own default result hardcodes
  # SourceGitCommit as ('0' * 40), by explicit, documented design ("BrokerReady must not depend on
  # this host's real, already-installed broker for a fully-fake rehearsal to reach DryRunPassed") --
  # gating fake-mode coherence against a real local HEAD would make every fake-mode run fail this
  # check unconditionally, forever, which is exactly the real-dependency the fake module exists to
  # avoid. Found live, the first time a fake-mode GREEN run was
  # attempted against this coherence check.
  $localCommit = & $GetLocalGitCommit $PSScriptRoot
  $deployedCommit = [string]$status.source_git_commit
  $coherent = (-not $Context.UseRealBackends) -or ($deployedCommit -ceq $localCommit)
  $ok = $status.task_exists -and $status.readable -and $status.self_update_capable -and $hostDiskOk -and $coherent
  $verdict = if ($ok) { 'PASS' } else { 'FAIL' }
  $reasonCode = $null
  if (-not $ok) {
    if (-not $status.task_exists) { $reasonCode = 'broker_task_not_installed' }
    elseif (-not $status.readable) { $reasonCode = 'broker_deployment_unreadable' }
    elseif (-not $status.self_update_capable) { $reasonCode = 'broker_not_self_update_capable' }
    elseif (-not $hostDiskOk) { $reasonCode = "host_disk_space_insufficient:$hostFreeBytes" }
    else { $reasonCode = 'broker_harness_incoherent' }
  }
  $detail = [ordered]@{}
  foreach ($key in $status.Keys) { $detail[$key] = $status[$key] }
  $detail['host_free_bytes'] = $hostFreeBytes
  $detail['local_git_commit'] = $localCommit
  return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'BrokerReady' -Verdict $verdict -ReasonCode $reasonCode -Detail $detail
}

# In fake mode, seeds the fake's starting power state to Off before asking
# ensure_state('Running') to hop it -- VmReady's own job is exactly that hop,
# so a pre-seeded 'Running' would make this state a no-op rather than exercise
# anything. Real mode never seeds; Invoke-E1VmEnsureState inspects the VM's
# actual current state itself.
# The principled disk guard's own inspection dispatch, isolated
# behind an injectable scriptblock the same way every other real-vs-fake VmReady dependency already
# is. Fake-backend runs (gate/dry testing, never real disk pressure) get a fixed, always-sufficient
# fake inspection -- there is no real VHD to inspect and no real host disk-space scenario being
# exercised, so a fake numeric answer here would test nothing the real formula's own dedicated
# RED/GREEN coverage (Evidence1-Run-Vhd-Chain-Disk-Guard.Tests.ps1) doesn't already cover directly.
function Get-E1RunVhdChainInspectionForContext($Context) {
  if (-not $Context.UseRealBackends) {
    return [ordered]@{
      chain = @([ordered]@{ virtual_size = 137438953472; file_size = 1073741824 })
      automatic_stop_action = 'ShutDown'
      vm_state = 'Off'
      memory_startup_bytes = 0
    }
  }
  $transportArgs = Get-E1RunRealTransportArguments
  return Get-E1VmVhdChainInspection -VMName $Context.VMName -ExpectedVMId $Context.VMId @transportArgs
}

function Invoke-E1RunVmReadyState(
  $Context,
  [scriptblock]$GetHostDiskFreeBytes = ${function:Get-E1RunHostDiskFreeBytes},
  [scriptblock]$GetVhdChainInspection = ${function:Get-E1RunVhdChainInspectionForContext}
) {
  # Checked before starting the VM at all -- fail fast rather than spend a Start-VM round trip
  # only to hit the same wall the guest-side guards (run-agentic-eval-product-smoke,
  # evidence1-dual-condition-canary-launch.ps1) would have caught moments later anyway. The
  # principled formula (Get-E1RunVmReadyRequiredDiskBytes) REPLACES the old flat 16106127360-byte
  # floor -- it already includes that same floor as its own Math.Max baseline, so this is strictly
  # at least as strict, never looser, while also catching the leaf-slack and Save-reservation cases
  # the flat floor never could (Amendment A6's own canary-1 root cause: guest disk exhaustion a flat
  # floor alone did not predict).
  $hostFreeBytes = [int64](& $GetHostDiskFreeBytes)
  try {
    $inspection = & $GetVhdChainInspection $Context
    $requiredBytes = Get-E1RunVmReadyRequiredDiskBytes $inspection
  } catch {
    return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'VmReady' -Verdict 'FAIL' `
      -ReasonCode 'vhd_chain_inspection_unavailable' -Detail ([ordered]@{ host_free_bytes = $hostFreeBytes; error = [string]$_.Exception.Message })
  }
  if ($hostFreeBytes -lt $requiredBytes) {
    return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'VmReady' -Verdict 'FAIL' `
      -ReasonCode "host_disk_space_insufficient:$hostFreeBytes" -Detail ([ordered]@{ host_free_bytes = $hostFreeBytes; required_bytes = $requiredBytes })
  }
  $transportArgs = @{}
  if (-not $Context.UseRealBackends) {
    Set-E1FakeVmInitialState -VMName $Context.VMName -VMId $Context.VMId -State 'Off' | Out-Null
  } else {
    $transportArgs = Get-E1RunRealTransportArguments
  }
  $result = Invoke-E1VmEnsureState -VMName $Context.VMName -ExpectedVMId $Context.VMId -TargetState 'Running' @transportArgs
  # $result.Keys/[$key] alone only works when $result is a real Hashtable/IDictionary, which is
  # true for the fake backend (in-process, never serialized) but not the real one: the real
  # Invoke-E1VmEnsureState (evidence1-vm-state-queue-client.psm1) crosses the broker queue's own
  # JSON round trip, so $result comes back as a PSCustomObject -- confirmed live, "property 'Keys'
  # not found" on the very first real campaign run through this state. Same dual-shape idiom
  # Get-E1RunPropertyNames already uses for NAMES (evidence1-run-state-contract.psm1), extended
  # here to also read each value dual-shape-safely.
  $detail = [ordered]@{}
  foreach ($key in (Get-E1RunPropertyNames $result)) {
    $detail[$key] = if ($result -is [Collections.IDictionary]) { $result[$key] } else { $result.$key }
  }
  $detail['host_free_bytes'] = $hostFreeBytes
  $detail['required_bytes'] = $requiredBytes
  return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'VmReady' -Verdict ([string]$result.verdict) -ReasonCode ([string]$result.reason_code) -Detail $detail
}

# Read-only per runtime: --version plus the login-status exit code, via the
# already-closed-registry get-cli-version-and-login-status bundle (Phase 3a).
# PASS iff the toolchain command resolves for every runtime being checked --
# this state does NOT look at login_status_exit_code (that is AuthReady's
# concern, immediately below), only at command_found, matching how the two
# states are separated in ADR-S2 itself (ToolchainReady before AuthReady).
function Invoke-E1RunToolchainReadyState($Context) {
  $bundleMigration = Ensure-E1RunDeployedSessionBundle $Context
  $prepare = Invoke-E1RunPrepareHarness $Context
  $runtimeIds = @(Get-E1RunRuntimeIdsToCheck $Context)
  $perRuntime = @()
  $overallOk = $true
  foreach ($runtimeId in $runtimeIds) {
    if ($runtimeId -cnotin @($script:E1RunCanonicalRuntimeProbes.Keys)) {
      throw "toolchain_ready_runtime_id_unmapped: $runtimeId"
    }
    $probe = $script:E1RunCanonicalRuntimeProbes[$runtimeId]
    $transportArgs = @{}
    if (-not $Context.UseRealBackends) {
      Set-E1FakeGuestBundleResult -VMName $Context.VMName -BundleName 'get-cli-version' `
        -Verdict 'PASS' -Output ([ordered]@{ command_found = $true; version_text = "$runtimeId-fake-version" }) | Out-Null
    } else {
      $transportArgs = Get-E1RunRealTransportArguments
    }
    $invocation = Invoke-E1GuestBundle -VMName $Context.VMName -GuestCredentialPath $Context.GuestCredentialPath `
      -BundleName 'get-cli-version' `
      -Arguments @{ CommandPath = $probe.CommandPath } @transportArgs
    $toolchainPresent = ([string]$invocation.verdict -ceq 'PASS') -and ($null -ne $invocation.output) -and [bool]$invocation.output.command_found
    if (-not $toolchainPresent) { $overallOk = $false }
    $perRuntime += [ordered]@{ runtime_id = $runtimeId; invocation = $invocation; toolchain_present = $toolchainPresent }
  }
  $verdict = if ($overallOk) { 'PASS' } else { 'FAIL' }
  $reasonCode = if ($overallOk) { $null } else { 'toolchain_missing_for_one_or_more_runtimes' }
  return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'ToolchainReady' -Verdict $verdict -ReasonCode $reasonCode -Detail ([ordered]@{ bundle_migration=$bundleMigration; prepare_harness = $prepare; runtimes = $perRuntime })
}

# READ-ONLY, and deliberately narrow -- the single most safety-sensitive
# handler in this file. It calls the SAME read-only bundle as ToolchainReady
# and looks ONLY at login_status_exit_code. It never opens, drives, prints, or
# waits for an interactive provider login, and never touches a credential or
# auth-material file's contents (the bundle itself doesn't either -- see
# evidence1-guest-bundle-contract.psm1's own registry comment).
#
# The plan's own section 7 Phase 3 text ultimately wants this process to "open
# or print the provider login, wait for completion, validate it, and resume."
# That half is intentionally NOT implemented here. It is treated the same as
# this codebase's standing UAC boundary: a human-supervised auth/security step
# that an agent does not script around, only report the need for. On FAIL this
# state's reason_code says "authenticate out of band, then resume this
# campaign" -- it does not attempt to fix itself. See the architecture note's
# open questions for who implements the interactive-driving half and when.
function Invoke-E1RunAuthReadyState($Context) {
  $runtimeIds = @(Get-E1RunRuntimeIdsToCheck $Context)
  $perRuntime = @()
  $overallOk = $true
  $transportArgs = @{}
  $networkOpen = $null
  $networkClosed = $null
  if ($Context.UseRealBackends) {
    $transportArgs = Get-E1RunRealTransportArguments
    $networkOpen = Invoke-E1NetworkEnsureMode -VMName $Context.VMName -GuestCredentialPath $Context.GuestCredentialPath `
      -TargetMode 'auth-open' @transportArgs
    if ([string]$networkOpen.verdict -cne 'PASS') {
      return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'AuthReady' -Verdict 'FAIL' `
        -ReasonCode 'auth_ready_network_open_failed' -Detail ([ordered]@{ network_open = $networkOpen; runtimes = @() })
    }
  }
  try {
    foreach ($runtimeId in $runtimeIds) {
      if ($runtimeId -cnotin @($script:E1RunCanonicalRuntimeProbes.Keys)) {
        throw "auth_ready_runtime_id_unmapped: $runtimeId"
      }
      $probe = $script:E1RunCanonicalRuntimeProbes[$runtimeId]
      if (-not $Context.UseRealBackends) {
        Set-E1FakeGuestBundleResult -VMName $Context.VMName -BundleName 'get-cli-version-and-login-status' `
          -Verdict 'PASS' -Output ([ordered]@{ command_found = $true; version_text = "$runtimeId-fake-version"; login_status_exit_code = 0 }) | Out-Null
      }
      $invocation = Invoke-E1GuestBundle -VMName $Context.VMName -GuestCredentialPath $Context.GuestCredentialPath `
        -BundleName 'get-cli-version-and-login-status' `
        -Arguments @{ CommandPath = $probe.CommandPath; LoginStatusArgs = $probe.LoginStatusArgs } @transportArgs
      $loggedIn = ([string]$invocation.verdict -ceq 'PASS') -and ($null -ne $invocation.output) -and ($null -ne $invocation.output.login_status_exit_code) -and ([int]$invocation.output.login_status_exit_code -eq 0)
      if (-not $loggedIn) { $overallOk = $false }
      $perRuntime += [ordered]@{ runtime_id = $runtimeId; invocation = $invocation; logged_in = $loggedIn }
    }
  } finally {
    if ($Context.UseRealBackends) {
      $networkClosed = Invoke-E1NetworkEnsureMode -VMName $Context.VMName -GuestCredentialPath $Context.GuestCredentialPath `
        -TargetMode 'offline' @transportArgs
      if ([string]$networkClosed.verdict -cne 'PASS') { $overallOk = $false }
    }
  }
  $verdict = if ($overallOk) { 'PASS' } else { 'FAIL' }
  $reasonCode = if ($overallOk) { $null } else { 'one_or_more_runtimes_not_authenticated_authenticate_out_of_band_then_resume' }
  $note = 'Read-only login-status check only. This state never opens, drives, prints, or waits for an interactive provider login -- see the architecture note for why that half of plan section 7 Phase 3 is intentionally out of this round''s scope, mirroring the standing UAC boundary.'
  return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'AuthReady' -Verdict $verdict -ReasonCode $reasonCode `
    -Detail ([ordered]@{ network_open = $networkOpen; runtimes = $perRuntime; network_closed = $networkClosed; note = $note })
}

# evidence1-network-backend-fake.psm1's Get-E1NetworkState/Invoke-E1NetworkEnsureMode
# now accept -GuestCredentialPath (fixed Phase 3c fix-forward round -- see the
# architecture note); this handler no longer needs to special-case which
# backend is active the way an earlier draft did.
function Invoke-E1RunRestrictedReadyState($Context) {
  $transportArgs = @{}
  if (-not $Context.UseRealBackends) {
    Set-E1FakeNetworkInitialMode -VMName $Context.VMName -VMId $Context.VMId -Mode 'offline' | Out-Null
  } else {
    $transportArgs = Get-E1RunRealTransportArguments
  }
  $result = Invoke-E1NetworkEnsureMode -VMName $Context.VMName -GuestCredentialPath $Context.GuestCredentialPath -TargetMode 'restricted' @transportArgs
  if ([string]$result.verdict -cne 'PASS' -or -not $Context.UseRealBackends) {
    return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'RestrictedReady' -Verdict ([string]$result.verdict) -ReasonCode ([string]$result.reason_code) -Detail $result
  }

  # Attestations describe the synchronized harness commit and therefore must
  # be refreshed after ToolchainReady updates that checkout, never copied from
  # a prior campaign or pinned to a commit in source. RestrictedReady is the
  # correct boundary: the network transition has just been positively
  # confirmed and no provider process has started.
  $toolchainReceipt = Read-E1RunStateReceipt $Context.CampaignRoot 'ToolchainReady'
  $harnessCommit = [string]$toolchainReceipt.detail.prepare_harness.target_commit
  if ($harnessCommit -cnotmatch '^[0-9a-f]{40}$') { throw 'restricted_ready_harness_commit_unavailable' }
  $attestations = Invoke-E1GuestBundle -VMName $Context.VMName -GuestCredentialPath $Context.GuestCredentialPath `
    -BundleName 'prepare-agentic-eval-isolation-attestations' -Arguments ([ordered]@{
      HarnessCommit = $harnessCommit
      CampaignId = [string]$Context.Manifest.campaign_id
      ClaudeAttestationFile = [string]$Context.Manifest.claude_attestation_file
      CodexAttestationFile = [string]$Context.Manifest.codex_attestation_file
    }) @transportArgs
  if ([string]$attestations.verdict -cne 'PASS' -or $null -eq $attestations.output -or
      [int]$attestations.output.inference_sessions_consumed -ne 0 -or
      [string]$attestations.output.harness_commit -cne $harnessCommit) {
    return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'RestrictedReady' -Verdict 'FAIL' `
      -ReasonCode 'restricted_ready_attestation_prepare_failed' -Detail ([ordered]@{ network = $result; attestations = $attestations })
  }
  return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'RestrictedReady' -Verdict 'PASS' -ReasonCode $null `
    -Detail ([ordered]@{ network = $result; attestations = $attestations })
}

# Re-verifies the five prerequisite receipts already durably written to this
# campaign's own directory. With real backends it additionally executes the
# exact kmp-test product command for the campaign scenario inside a disposable
# guest clone, without starting Claude or Codex. A prerequisite that is
# missing, FAIL, or stamped with a different campaign_id (e.g. a StateRoot
# reused across campaigns by mistake) fails this state loudly rather than
# silently trusting a receipt that does not actually belong to this run.
function Invoke-E1RunDryRunPassedState($Context) {
  $prerequisites = @('BrokerReady', 'VmReady', 'ToolchainReady', 'AuthReady', 'RestrictedReady')
  $summary = @()
  $toolchainReceipt = $null
  foreach ($stateName in $prerequisites) {
    $receipt = Read-E1RunStateReceipt $Context.CampaignRoot $stateName
    if ($null -eq $receipt) { throw "dry_run_passed_missing_prerequisite_receipt: $stateName" }
    Assert-E1RunStateReceiptShape $receipt
    if ([string]$receipt.verdict -cne 'PASS') { throw "dry_run_passed_prerequisite_not_pass: $stateName" }
    if ([string]$receipt.campaign_id -cne $Context.CampaignId) { throw "dry_run_passed_campaign_id_mismatch: $stateName" }
    if ($stateName -ceq 'ToolchainReady') { $toolchainReceipt = $receipt }
    $summary += [ordered]@{ state = $stateName; generated_at_utc = [string]$receipt.generated_at_utc }
  }
  $detail = [ordered]@{
    verified_prerequisite_receipts = $summary
    vm_name                        = $Context.VMName
    vm_id                           = $Context.VMId
    use_real_backends                = [bool]$Context.UseRealBackends
  }
  if ($Context.UseRealBackends) {
    if (-not $Context.Manifest) { throw 'dry_run_passed_manifest_required' }
    # The guest's harness checkout was seen live
    # reporting a stale product version despite ToolchainReady's own git-level sync
    # check already passing -- see evidence1-guest-bundle-contract.psm1's
    # run-agentic-eval-product-smoke bundle header for the full incident. These
    # "expected" values are ALWAYS derived from the ALREADY-VERIFIED ToolchainReady
    # receipt's own target_commit, never a fresh `git rev-parse HEAD` at this later
    # point -- HEAD may have moved on since ToolchainReady synced the guest, and
    # comparing against a moving target would defeat the whole check.
    if ($null -eq $toolchainReceipt) { throw 'dry_run_passed_toolchain_receipt_missing' }
    $expectedCommit = [string]$toolchainReceipt.detail.prepare_harness.target_commit
    if ($expectedCommit -notmatch '^[0-9a-f]{40}$') { throw 'dry_run_passed_expected_commit_invalid' }
    $sourceRepoDir = [string]$toolchainReceipt.detail.prepare_harness.source_repo_dir
    if ([string]::IsNullOrWhiteSpace($sourceRepoDir)) { throw 'dry_run_passed_source_repo_dir_missing' }
    $expectedVersionJson = ([string](& git.exe -C $sourceRepoDir show "${expectedCommit}:package.json")).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'dry_run_passed_expected_version_resolution_failed' }
    $expectedVersion = ([string]($expectedVersionJson | ConvertFrom-Json -ErrorAction Stop).version)
    if ($expectedVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'dry_run_passed_expected_version_shape_invalid' }
    $expectedLibTreeHash = ([string](& git.exe -C $sourceRepoDir rev-parse "${expectedCommit}:lib")).Trim()
    $expectedBinTreeHash = ([string](& git.exe -C $sourceRepoDir rev-parse "${expectedCommit}:bin")).Trim()
    $expectedSkillsTreeHash = ([string](& git.exe -C $sourceRepoDir rev-parse "${expectedCommit}:.skills")).Trim()
    if ($LASTEXITCODE -ne 0 -or $expectedLibTreeHash -notmatch '^[0-9a-f]{40}$' -or
        $expectedBinTreeHash -notmatch '^[0-9a-f]{40}$' -or $expectedSkillsTreeHash -notmatch '^[0-9a-f]{40}$') {
      throw 'dry_run_passed_expected_tree_hash_resolution_failed'
    }
    # The anchor scenario's own JSON is the single source of
    # truth for which NowInAndroid commit source_template_dir must be checked out to -- read here,
    # host-side, the same way the product identity's expected values are derived above, never a
    # second hardcoded copy of the commit drifting out of sync with the scenario file.
    $scenarioPath = Join-Path $sourceRepoDir (Join-Path 'tools\agentic-eval\corpus\scenarios' ("$([string]$Context.Manifest.scenario_id).json"))
    if (-not (Test-Path -LiteralPath $scenarioPath -PathType Leaf)) { throw 'dry_run_passed_scenario_missing' }
    $scenario = Get-Content -LiteralPath $scenarioPath -Raw | ConvertFrom-Json -ErrorAction Stop
    $expectedSourceCommit = [string]$scenario.project_commit
    if ($expectedSourceCommit -notmatch '^[0-9a-f]{40}$') { throw 'dry_run_passed_expected_source_commit_invalid' }
    # The scenario's family sizes the guest call. The coverage smoke is the 4-minute run this state has always
    # made (1200 s); a multi-module-tests smoke applies the scenario's patch and runs kmp-test over a dozen
    # modules inside the guest for up to 3300 s, so its bundle call gets 3600 s. The guest decides what a
    # scenario id means from the scenario's own files and refuses what it cannot run (smoke_scenario_unsupported).
    $isMultiModuleScenario = ([string]$scenario.family -ceq 'multi-module-tests')
    $smokeTimeoutSeconds = $(if ($isMultiModuleScenario) { 3600 } else { 1200 })
    $smokeRoot = Join-Path ([string]$Context.Manifest.private_root) (Join-Path $Context.CampaignId 'provider-free-product-smoke')
    $transportArgs = Get-E1RunRealTransportArguments
    $smoke = Invoke-E1GuestBundle -VMName $Context.VMName -GuestCredentialPath $Context.GuestCredentialPath `
      -BundleName 'run-agentic-eval-product-smoke' -Arguments ([ordered]@{
        HarnessDir = [string]$Context.Manifest.harness_dir
        SourceTemplateDir = [string]$Context.Manifest.source_template_dir
        SmokeRoot = $smokeRoot
        ExpectedProductCommit = $expectedCommit
        ExpectedProductVersion = $expectedVersion
        ExpectedLibTreeHash = $expectedLibTreeHash
        ExpectedBinTreeHash = $expectedBinTreeHash
        ExpectedSkillsTreeHash = $expectedSkillsTreeHash
        ExpectedSourceCommit = $expectedSourceCommit
        ScenarioId = [string]$Context.Manifest.scenario_id
      }) -TimeoutSeconds $smokeTimeoutSeconds @transportArgs
    $detail.provider_free_product_smoke = $smoke
    # A multi-module-tests smoke must report what it observed in the envelope (the receipt is where the operator
    # reads it); the coverage smoke has never returned these keys.
    $observedReportMissing = $false
    if ($isMultiModuleScenario -and $null -ne $smoke.output) {
      $smokeOutputKeys = @(Get-E1RunPropertyNames $smoke.output)
      $observedReportMissing = @(@('observed_failing_modules', 'observed_failed_test_classes', 'observed_failed_count') | Where-Object { $_ -cnotin $smokeOutputKeys }).Count -ne 0
    }
    if ([string]$smoke.verdict -cne 'PASS' -or $null -eq $smoke.output -or
        [string]$smoke.output.verdict -cne 'PASS' -or [int]$smoke.output.inference_sessions_consumed -ne 0 -or $observedReportMissing) {
      return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'DryRunPassed' -Verdict 'FAIL' `
        -ReasonCode 'dry_run_product_smoke_failed' -Detail $detail
    }
  }
  return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'DryRunPassed' -Verdict 'PASS' -ReasonCode $null -Detail $detail
}

# ---------------------------------------------------------------------------
# Live-adjacent state handlers (Phase 3c, second fix-forward round). Exist
# ONLY for the fake-backend path -- the main loop's live-adjacent guard
# throws Invoke-E1RunNotYetImplementedState before ever looking these up
# when $Context.UseRealBackends is true, so none of them can run against a
# real provider or a real filesystem outside C:\kmp-eval\scratch\. Every
# capability call below resolves to evidence1-provider-runtime-fake.psm1 or
# evidence1-artifact-store-fake.psm1, which have no real (-hyperv/-real)
# sibling at all this round -- see each module's own header for why not.
# ---------------------------------------------------------------------------

# A manifest becomes required starting here. Authentication was already
# confirmed by AuthReady; this gate only confirms the exact, no-retry budget
# declared by the same manifest that enumerates LiveRunning's cells.
# The ONE place that shells out to
# tools/agentic-eval/derive-round-order-cli.mjs (Node -- buildScenarioCampaignPlan has no
# PowerShell equivalent, and re-implementing the counterbalancing logic here would be exactly the
# kind of second, independently-maintained copy this project's own single-source-of-truth
# discipline exists to prevent). Indexes by the runtime's own campaign_cell_indices into the
# design's full pre-registered plan (exactly the property the guest side already
# asserts per cell, order_index == CampaignCellIndex, so any valid index subset works the same way
# a canary's [0,1] does, not just "1 rep or the full count"). Throws on any failure, including an
# index the plan doesn't contain -- the caller decides the reason code.
#
# The JSON argument crosses via stdin, never a positional CLI argument -- confirmed live: PowerShell
# mangles a JSON string's embedded double quotes on the way to a native executable's command line
# (ConvertTo-Json -Compress output passed positionally to node.exe arrived at process.argv[2] as
# undefined). Piping has no such quoting layer to cross.
function Get-E1RunPreregisteredRoundOrder([string]$DesignId, [int[]]$CampaignCellIndices, [string]$ExecutionProfileId, [string]$SourceRepoDir) {
  $cliPath = Join-Path $SourceRepoDir 'tools\agentic-eval\derive-round-order-cli.mjs'
  $argsJson = ([ordered]@{ designId = $DesignId; campaignCellIndices = @($CampaignCellIndices); executionProfiles = @($ExecutionProfileId) } | ConvertTo-Json -Compress)
  $output = ([string]($argsJson | & node.exe $cliPath 2>$null)).Trim()
  $parsed = $null
  try { $parsed = $output | ConvertFrom-Json -ErrorAction Stop } catch { throw 'run_manifest_round_order_derivation_unavailable' }
  if (-not [bool]$parsed.ok) { throw "run_manifest_round_order_derivation_failed: $([string]$parsed.reason)" }
  return @($parsed.round_order)
}

function Invoke-E1RunLiveAuthorizedState($Context, [scriptblock]$GetPreregisteredRoundOrder = ${function:Get-E1RunPreregisteredRoundOrder}) {
  if (-not $Context.Manifest) {
    return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'LiveAuthorized' -Verdict 'FAIL' -ReasonCode 'live_authorized_requires_manifest'
  }
  $expectedCells = @(Get-E1RunManifestExpectedCells $Context.Manifest)
  $budgetOk = [bool]$Context.Manifest.no_automatic_provider_retry -and ([int]$Context.Manifest.max_session_count -eq $expectedCells.Count)

  # Derived independently per runtime (never assumed shared just because every manifest observed
  # so far happens to declare one shared round_order) -- a manifest whose runtimes disagree with
  # each other, or with their own pre-registered design, fails exactly as loudly as one that
  # disagrees with a hand-invented sequence would.
  $declaredRoundOrder = @($Context.Manifest.round_order)
  $roundOrderOk = $true
  $roundOrderDetail = @()
  foreach ($runtime in @($Context.Manifest.runtimes)) {
    $cellIndices = @($runtime.campaign_cell_indices)
    $entry = [ordered]@{ runtime_id = [string]$runtime.runtime_id; campaign_design_id = [string]$runtime.campaign_design_id; campaign_cell_indices = $cellIndices }
    try {
      $preregistered = @(& $GetPreregisteredRoundOrder ([string]$runtime.campaign_design_id) $cellIndices ([string]$Context.Manifest.execution_profile_id) $PSScriptRoot)
    } catch {
      $roundOrderOk = $false
      $entry['matched'] = $false
      $entry['error'] = [string]$_.Exception.Message
      $roundOrderDetail += $entry
      continue
    }
    $matches = ($preregistered.Count -eq $declaredRoundOrder.Count)
    if ($matches) {
      for ($i = 0; $i -lt $preregistered.Count; $i++) {
        if ([string]$preregistered[$i] -cne [string]$declaredRoundOrder[$i]) { $matches = $false; break }
      }
    }
    if (-not $matches) { $roundOrderOk = $false }
    $entry['matched'] = $matches
    $entry['preregistered_round_order'] = $preregistered
    $roundOrderDetail += $entry
  }

  $ok = $budgetOk -and $roundOrderOk
  $verdict = if ($ok) { 'PASS' } else { 'FAIL' }
  $reasonCode = if ($ok) { $null }
    elseif (-not $budgetOk) { 'live_authorized_budget_or_retry_statement_invalid' }
    else { 'run_manifest_round_order_not_preregistered' }
  $detail = [ordered]@{
    max_session_count   = [int]$Context.Manifest.max_session_count
    expected_cell_count = $expectedCells.Count
    no_automatic_provider_retry = [bool]$Context.Manifest.no_automatic_provider_retry
    round_order_verification = $roundOrderDetail
  }
  return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'LiveAuthorized' -Verdict $verdict -ReasonCode $reasonCode -Detail $detail
}

# Dispatches one fake ProviderRuntime session per cell in
# Get-E1RunManifestExpectedCells (evidence1-run-manifest-contract.psm1) --
# round_order.Count * runtimes.Count sessions total, one per (round, runtime)
# pair. Resolved (previously an open question):
# re-read ADR-S6 and plan section 6.2's own product/free diagram -- 3 rounds
# of two condition-slots each is 6 round_order entries, times 2 runtimes, is
# 12, matching the plan's own "12 sessions for the Claude/Codex product-vs-free
# benchmark" and "six accepted product/free records" per runtime exactly. The
# dispatch formula itself was always correct; the bug was that
# evidence1-run-manifest-contract.psm1's max_session_count validation only
# checked round_order.Count and could pass a manifest whose declared budget
# was too low for what this handler would actually dispatch. Root-cause fix:
# Get-E1RunManifestExpectedCells is now the ONE place that computes cell
# cardinality, used by both that validation and this dispatch loop, so they
# cannot drift apart again -- this handler no longer computes round_index x
# runtime pairing itself at all. PASS iff every dispatched session is PASS.
# Nothing here can start a real provider: see
# evidence1-provider-runtime-fake.psm1's own structural-safety header and
# tests.
function Invoke-E1RunLiveRunningState($Context) {
  $cells = @(Get-E1RunManifestExpectedCells $Context.Manifest)
  $sessions = @()
  $overallOk = $true
  foreach ($cell in $cells) {
    if ($Context.UseRealBackends) {
      $transportArguments = Get-E1RunRealTransportArguments
      $session = Invoke-E1ProviderRuntimeSession -CurrentCampaignInputs $Context.CurrentCampaignInputs -Cell $cell `
        -VMName $Context.VMName -GuestCredentialPath $Context.GuestCredentialPath @transportArguments
    } else {
      # The fake remains process-free. Its deterministic identity uses semantic
      # manifest identifiers, never removed hash fields.
      $session = Invoke-E1ProviderRuntimeSession -RuntimeId ([string]$cell.runtime_id) -ModelId ([string]$cell.model_id) `
        -RoundIndex ([int]$cell.round_index) -ScenarioSha256 ([string]$Context.CurrentCampaignInputs.scenario_id) `
        -PromptSha256 ([string]$cell.campaign_design_id)
    }
    Assert-E1ProviderRuntimeSessionResult $session
    if ([string]$session.verdict -cne 'PASS') { $overallOk = $false }
    $sessions += $session
  }
  $verdict = if ($overallOk) { 'PASS' } else { 'FAIL' }
  $reasonCode = if ($overallOk) { $null } else { 'one_or_more_provider_sessions_failed' }
  $semanticRejectionCount = @($sessions | Where-Object { (Get-E1SafeBenchmarkStatus $_.output_summary) -ceq 'rejected' }).Count
  return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'LiveRunning' -Verdict $verdict -ReasonCode $reasonCode -Detail ([ordered]@{ sessions = $sessions; cell_count = $cells.Count; semantic_rejection_count = $semanticRejectionCount })
}

# Pulls evidence out of the (fake) guest via the EXISTING artifacts.copy_read_only
# capability (Phase 3b -- evidence1-artifact-copy-fake.psm1, not a new
# capability this round) into the campaign's PRIVATE staging directory --
# $Context.Manifest.output_roots.private (ADR-S6), NOT a <CampaignRoot>-relative
# hardcode as this handler previously used. A manifest is already guaranteed
# non-null this far into the state graph (the upfront -TargetState-vs-LiveAuthorized
# gate below), but this handler checks again anyway, matching
# Invoke-E1RunLiveAuthorizedState's own defensive style, and so the handler's
# logic stays self-contained and correct even when called directly (as the
# integration tests do) rather than only via the main loop.
# evidence1-run-manifest-contract.psm1's Assert-E1RunManifestOutputRootsConfined
# (called from Assert-E1RunManifestShape, itself called from Read-E1RunManifest
# above) has already confirmed output_roots.private/.public are absolute,
# canonicalized, confined under C:\kmp-eval\scratch\, and mutually
# non-overlapping by the time $Context.Manifest ever reaches this handler.
# Seeds a minimal fake "mounted VHD root" under the campaign root with the
# one file the final-codex-attestation spec requires, matching how
# VmReady/RestrictedReady seed their own fakes' starting state.
function Invoke-E1RunEvidenceCopiedState($Context) {
  if (-not $Context.Manifest) {
    return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'EvidenceCopied' -Verdict 'FAIL' -ReasonCode 'evidence_copied_requires_manifest'
  }
  if ($Context.UseRealBackends) {
    $transportArguments = Get-E1RunRealTransportArguments
    $networkResult = Invoke-E1NetworkEnsureMode -VMName $Context.VMName -GuestCredentialPath $Context.GuestCredentialPath -TargetMode 'offline' @transportArguments
    if ([string]$networkResult.verdict -cne 'PASS') {
      return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'EvidenceCopied' -Verdict 'FAIL' -ReasonCode ([string]$networkResult.reason_code) -Detail ([ordered]@{ network_result = $networkResult })
    }
    $vmResult = Invoke-E1VmEnsureState -VMName $Context.VMName -ExpectedVMId $Context.VMId -TargetState 'Off' @transportArguments
    if ([string]$vmResult.verdict -cne 'PASS') {
      return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'EvidenceCopied' -Verdict 'FAIL' -ReasonCode ([string]$vmResult.reason_code) -Detail ([ordered]@{ network_result = $networkResult; vm_result = $vmResult })
    }
    $privateEvidenceRoot = Resolve-FullPath ([string]$Context.Manifest.output_roots.private)
    New-Item -ItemType Directory -Force -Path $privateEvidenceRoot | Out-Null
    # The internal worker writes each normalized pair below the campaign
    # directory, not directly below private_root.  This must remain the exact
    # same formula as Invoke-E1DualConditionCanarySession's $runsRoot:
    # private_root\\campaign_id\\runtime-round\\{record,audit}.json.
    $guestCampaignRoot = Join-Path ([string]$Context.Manifest.private_root) ([string]$Context.Manifest.campaign_id)
    $privateRootRelative = ConvertTo-E1RunGuestRelativePath $guestCampaignRoot
    $liveReceipt = Read-E1RunStateReceipt $Context.CampaignRoot 'LiveRunning'
    $liveSessions = @($liveReceipt.detail.sessions)
    if ($liveSessions.Count -ne @(Get-E1RunManifestExpectedCells $Context.Manifest).Count) { throw 'evidence_copied_live_session_set_mismatch' }
    $copyResults = @()
    $rejectedCellKeys = @()
    foreach ($cell in @(Get-E1RunManifestExpectedCells $Context.Manifest)) {
      $cellKey = "$([string]$cell.runtime_id)-$([int]$cell.campaign_cell_index)"
      $guestCellKey = "$([string]$cell.runtime_id)-$([int]$cell.round_index)"
      $destination = Join-Path $privateEvidenceRoot $cellKey
      $matchingSessions = @($liveSessions | Where-Object { [string]$_.runtime_id -ceq [string]$cell.runtime_id -and [int]$_.round_index -eq [int]$cell.round_index })
      if ($matchingSessions.Count -ne 1) { throw 'evidence_copied_live_session_identity_mismatch' }
      $benchmarkStatus = Get-E1SafeBenchmarkStatus $matchingSessions[0].output_summary
      if ($benchmarkStatus -ceq 'accepted') {
        $resumeArguments = @{ DestinationDir=$destination; RuntimeId=[string]$cell.runtime_id; ModelId=[string]$cell.model_id; ScenarioId=[string]$Context.Manifest.scenario_id; Seed=[int64]$Context.Manifest.seed; Condition=[string]$cell.condition; CampaignCellIndex=[int]$cell.campaign_cell_index }
        $resumeAction = Resolve-E1ArtifactCopyResumeDestination @resumeArguments
        if ($resumeAction -ceq 'reuse') {
          $copy = [ordered]@{ files_copied = @('record.json','audit.json') }
        } else {
          $copy = Copy-E1ArtifactsReadOnly -VMName $Context.VMName -ExpectedVMId $Context.VMId -SpecName 'agentic-eval-session-record' -Arguments @{ PrivateRootRelative = $privateRootRelative; CellKey = $guestCellKey } -DestinationDir $destination -TrustedRoot $Context.OutputRootsTrustedRoot @transportArguments
        }
        Assert-E1ArtifactCopyResultShape 'agentic-eval-session-record' $copy
        if ((Resolve-E1ArtifactCopyResumeDestination @resumeArguments) -cne 'reuse') { throw 'evidence_copied_record_pair_validation_failed' }
        if (@($copy.files_copied).Count -ne 2) {
          return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'EvidenceCopied' -Verdict 'FAIL' -ReasonCode 'evidence_copied_record_pair_incomplete' -Detail ([ordered]@{ network_result = $networkResult; vm_result = $vmResult; copy_results = $copyResults })
        }
      } elseif ($benchmarkStatus -ceq 'rejected') {
        $rejectionId = [string]$matchingSessions[0].output_summary.rejection_id
        if ($rejectionId -cnotmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$') { throw 'evidence_copied_rejection_identity_invalid' }
        if (Test-Path -LiteralPath $destination -PathType Container) {
          $existing = @(Get-ChildItem -LiteralPath $destination -Force)
          if ($existing.Count -ne 1 -or $existing[0].Name -cne 'rejection.json') { throw 'evidence_copied_rejection_destination_conflict' }
          try { $existingRejection = Get-Content -LiteralPath $existing[0].FullName -Raw | ConvertFrom-Json -ErrorAction Stop } catch { throw 'evidence_copied_rejection_invalid' }
          if ([string]$existingRejection.rejection_id -cne $rejectionId) { throw 'evidence_copied_rejection_identity_mismatch' }
          $resumeAction = 'reuse'
          $copy = [ordered]@{ files_copied = @('rejection.json') }
        } else {
          $resumeAction = 'copy'
          $copy = Copy-E1ArtifactsReadOnly -VMName $Context.VMName -ExpectedVMId $Context.VMId -SpecName 'agentic-eval-rejection-diagnostic' -Arguments @{ PrivateRootRelative = $privateRootRelative; CellKey = $guestCellKey; RejectionId = $rejectionId } -DestinationDir $destination -TrustedRoot $Context.OutputRootsTrustedRoot @transportArguments
        }
        Assert-E1ArtifactCopyResultShape 'agentic-eval-rejection-diagnostic' $copy
        $rejectedCellKeys += $cellKey
      } else {
        throw 'evidence_copied_benchmark_status_invalid'
      }
      $copyResults += [ordered]@{ cell_key = $cellKey; benchmark_status = $benchmarkStatus; resume_action = $resumeAction; result = $copy }
    }
    # Always finalize, even with rejected cells present -- the finalizer
    # itself decides eligibility per runtime, so a rejection isolated to one runtime no longer
    # blocks a different runtime's own complete, balanced cells from promoting. RejectedCellKeys
    # is exactly what this loop already knows from output_summary.benchmark_status above; never
    # re-derived from what the evidence directory happens to contain.
    $eligibility = Invoke-E1CampaignEligibilityFinalization `
      -PrivateEvidenceRoot $privateEvidenceRoot `
      -ExpectedCells @(Get-E1RunManifestExpectedCells $Context.Manifest) `
      -ScenarioId ([string]$Context.Manifest.scenario_id) `
      -Seed ([int64]$Context.Manifest.seed) `
      -CampaignId ([string]$Context.Manifest.campaign_id) `
      -ProviderMode ([string]$Context.Manifest.provider_mode) `
      -RejectedCellKeys $rejectedCellKeys
    return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'EvidenceCopied' -Verdict 'PASS' -ReasonCode $null -Detail ([ordered]@{ network_result = $networkResult; vm_result = $vmResult; private_root = $privateEvidenceRoot; copy_results = $copyResults; eligibility = $eligibility })
  }
  $fakeMountRoot = Join-Path $Context.CampaignRoot 'fake-guest-mount'
  $attestationDir = Join-Path $fakeMountRoot 'kmp-eval\measurement-scopes'
  New-Item -ItemType Directory -Force -Path $attestationDir | Out-Null
  $attestationPath = Join-Path $attestationDir 'evidence1-claude-windows-isolation-attestation-stageb-v1.json'
  if (-not (Test-Path -LiteralPath $attestationPath -PathType Leaf)) {
    ([ordered]@{ schema = 1; fake = $true; campaign_id = $Context.CampaignId } | ConvertTo-Json) |
      Set-Content -LiteralPath $attestationPath -Encoding UTF8
  }
  Set-E1FakeArtifactCopyMountRoot -VMName $Context.VMName -MountRootPath $fakeMountRoot

  $privateEvidenceRoot = Resolve-FullPath ([string]$Context.Manifest.output_roots.private)
  if (Test-Path -LiteralPath $privateEvidenceRoot) { Remove-Item -LiteralPath $privateEvidenceRoot -Recurse -Force }
  # -TrustedRoot: $Context.OutputRootsTrustedRoot (output_roots trust-root
  # portability follow-up) -- the SAME value this run resolved once for the
  # manifest contract, passed explicitly here too rather than left to
  # evidence1-artifact-copy-fake.psm1's own default.
  $result = Copy-E1ArtifactsReadOnly -VMName $Context.VMName -ExpectedVMId $Context.VMId -SpecName 'final-codex-attestation' `
    -Arguments @{} -DestinationDir $privateEvidenceRoot -TrustedRoot $Context.OutputRootsTrustedRoot
  Assert-E1ArtifactCopyResultShape 'final-codex-attestation' $result
  $ok = @($result.files_copied).Count -gt 0
  $verdict = if ($ok) { 'PASS' } else { 'FAIL' }
  $reasonCode = if ($ok) { $null } else { 'evidence_copied_no_files' }
  return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'EvidenceCopied' -Verdict $verdict -ReasonCode $reasonCode `
    -Detail ([ordered]@{ private_root = $privateEvidenceRoot; copy_result = $result })
}

# Terminal state: VM Off, network offline, and evidence published from the
# private staging directory EvidenceCopied just populated to a public one --
# ADR-S4's ArtifactStore (evidence1-artifact-store-fake.psm1), distinct from
# artifacts.copy_read_only (see that module's own header for the
# distinction). Ensures VM/network state even though RestrictedReady already
# left the network 'restricted' and VmReady left the VM 'Running' -- Closed
# is where a campaign actually shuts down, matching this round's own reading
# of "network offline + VM/processes/mounts/queue all closed" from the
# Phase 3c architecture note's earlier open-question discussion of what
# 'Closed' composes.
function Invoke-E1RunClosedState($Context) {
  if (-not $Context.Manifest) {
    return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'Closed' -Verdict 'FAIL' -ReasonCode 'closed_requires_manifest'
  }
  $transportArguments = if ($Context.UseRealBackends) { Get-E1RunRealTransportArguments } else { @{} }
  $networkResult = Invoke-E1NetworkEnsureMode -VMName $Context.VMName -GuestCredentialPath $Context.GuestCredentialPath -TargetMode 'offline' @transportArguments
  if ([string]$networkResult.verdict -cne 'PASS') {
    return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'Closed' -Verdict 'FAIL' -ReasonCode ([string]$networkResult.reason_code) -Detail ([ordered]@{ network_result = $networkResult })
  }
  $vmResult = Invoke-E1VmEnsureState -VMName $Context.VMName -ExpectedVMId $Context.VMId -TargetState 'Off' @transportArguments
  if ([string]$vmResult.verdict -cne 'PASS') {
    return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'Closed' -Verdict 'FAIL' -ReasonCode ([string]$vmResult.reason_code) -Detail ([ordered]@{ network_result = $networkResult; vm_result = $vmResult })
  }

  # $Context.Manifest.output_roots.private/.public (ADR-S6), matching
  # EvidenceCopied's own root exactly -- NOT a <CampaignRoot>-relative
  # hardcode as this handler previously used. Both invocations read the
  # SAME manifest object, so this and EvidenceCopied always agree without
  # needing to pass the path between them; Test-E1RunCampaignIdentityMatches
  # (below, campaign.json resume check) additionally pins these two values
  # so a resume against an edited manifest cannot silently switch them.
  $privateEvidenceRoot = Resolve-FullPath ([string]$Context.Manifest.output_roots.private)
  $publicEvidenceRoot = Resolve-FullPath ([string]$Context.Manifest.output_roots.public)
  # -TrustedRoot: same $Context.OutputRootsTrustedRoot value as
  # EvidenceCopied's Copy-E1ArtifactsReadOnly call above and this run's own
  # manifest-load call -- one resolution, passed explicitly to all three.
  $publicationResult = Publish-E1ArtifactStoreSet -PrivateRoot $privateEvidenceRoot -PublicRoot $publicEvidenceRoot -TrustedRoot $Context.OutputRootsTrustedRoot
  Assert-E1ArtifactStorePublicationResult $publicationResult

  $verdict = [string]$publicationResult.verdict
  $reasonCode = [string]$publicationResult.reason_code
  return New-E1RunStateReceipt -CampaignId $Context.CampaignId -StateName 'Closed' -Verdict $verdict -ReasonCode $reasonCode `
    -Detail ([ordered]@{ vm_result = $vmResult; network_result = $networkResult; publication_result = $publicationResult })
}

# Best-effort cleanup attempted by the main loop's catch block (below) when
# the state walk fails with the VM possibly still on and the network possibly
# still live -- i.e. once VmReady has been attempted, not only once it has
# PASSED, since a real VM ensure-state call can leave the VM partially
# brought up even on its own FAIL path.
#
# 2026-09-28 incident (campaign 275517a4) is the motivating case, but only
# part of it is actually confirmed: the broker instance claimed the live
# request and hung; after the client's own 120-minute wait elapsed, the
# failure path itself crashed (benchmark_status under StrictMode, fixed
# separately in ade3528), so no closure was ever attempted. What the VM and
# network were actually left in from there is UNKNOWN -- nobody queried the
# VM's live state (Get-VM requires elevation this session did not have), so
# "it stayed on" is exactly the kind of plausible-but-unverified claim not
# to assert as fact. Also worth being explicit about the limit this fix
# does NOT cover: in that specific incident the broker itself was hung, so
# this attempt would not have reached a result either -- it would have
# bounded-timed-out same as everything else that round. This closes the gap
# for failures with a HEALTHY broker (a rejected session, a validation
# failure, anything downstream of VmReady that isn't the broker itself);
# against a hung broker it records bounded failures, it does not recover
# the VM.
#
# Never throws: every real capability call here is individually try/caught,
# and the whole thing is ALSO wrapped by its one caller (defense in depth,
# not redundant -- Get-E1RunRealTransportArguments itself can throw before
# either inner try is even reached). A failure here must never replace or
# mask $Report.reason, which the caller has already captured by the time it
# calls this. Real-backend only: fake mode has no real VM to leave running,
# and every fake campaign starts from fresh fake state regardless.
#
# Deliberately does NOT write an $AllStates-shaped 'Closed' receipt --
# Get-E1RunResumeIndex only ever reads receipts named after real states, and
# a best-effort attempt (which may itself have failed) must never be
# mistaken for a genuine, verified Closed PASS. Its outcome is informational
# only, folded into $Report.failure_safe_closure by the caller. Existing
# practice, restated here because it is easy to miss: never resume a
# campaign after a failure-safe closure ran against it (successfully or
# not) -- its earlier PASS receipts (VmReady, RestrictedReady, ...) no
# longer describe the VM's real state once this has run. Start a new
# campaign_id instead.
#
# -TimeoutMinutes 10 on both calls below, not each function's own 120-minute
# default: this is a BEST-EFFORT attempt running inside an already-failed
# campaign's catch block, not a fresh dispatch -- letting either one wait
# its full default would risk up to 240 minutes (120 + 120) before the
# failure report is ever written, which defeats the point of a fail-safe.
# 10 minutes is still generous: network.ensure_mode observed <=~13s in the
# 2026-09-28 trace, VM Off is bounded by evidence1-vm-state-hyperv.psm1's
# own StopTimeoutSeconds (180s). NOT a bound against the specific 2026-09-28
# orphan scenario itself: with a stale outer request already sitting in
# requests/ or in-progress/, Submit-E1BrokerCapabilityOperation's own
# queue_busy check rejects a NEW teardown request immediately, before this
# wait is ever reached. This bound guards a different, still-real stall
# shape: a teardown request that IS accepted into the queue but then itself
# hangs, same as the original request did.
function Invoke-E1RunFailureSafeClosureAttempt($Context) {
  $attempt = [ordered]@{
    attempted_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    network_result   = $null
    vm_result        = $null
    evidence_copy    = $null
    error            = $null
  }
  if (-not $Context.UseRealBackends) { $attempt.error = 'skipped_fake_backend'; return $attempt }
  try {
    $transportArguments = Get-E1RunRealTransportArguments
    try {
      $attempt.network_result = Invoke-E1NetworkEnsureMode -VMName $Context.VMName -GuestCredentialPath $Context.GuestCredentialPath -TargetMode 'offline' -TimeoutMinutes 10 @transportArguments
    } catch {
      $attempt.network_result = [ordered]@{ verdict = 'FAIL'; reason_code = 'failure_safe_network_attempt_threw'; error = [string]$_.Exception.Message }
    }
    try {
      $attempt.vm_result = Invoke-E1VmEnsureState -VMName $Context.VMName -ExpectedVMId $Context.VMId -TargetState 'Off' -TimeoutMinutes 10 @transportArguments
    } catch {
      $attempt.vm_result = [ordered]@{ verdict = 'FAIL'; reason_code = 'failure_safe_vm_attempt_threw'; error = [string]$_.Exception.Message }
    }
    # Best-effort read-only evidence recovery, now that the VM's
    # power state is settled -- see Invoke-E1RunFailureSafeEvidenceCopyAttempt's own header for why
    # this needs two tiers and what it deliberately does NOT attempt to recover.
    try {
      $attempt.evidence_copy = Invoke-E1RunFailureSafeEvidenceCopyAttempt $Context $attempt.vm_result $transportArguments
    } catch {
      $attempt.evidence_copy = [ordered]@{ attempted = $false; error = [string]$_.Exception.Message }
    }
  } catch {
    $attempt.error = [string]$_.Exception.Message
  }
  return $attempt
}

# Publication hardening: "evidence from a failed LiveRunning reaches the
# host automatically." Before this, a campaign that failed anywhere from VmReady onward powered
# the VM off (the closure attempt above) and stopped there -- whatever the guest had already
# written for any cell that DID finish was simply stranded, since this campaign_id must never be
# resumed afterward (Get-E1RunResumeIndex/EvidenceCopied both assume a monotonic, never-replayed
# walk) and EvidenceCopied itself refuses to run at all against an incomplete LiveRunning session
# set (evidence_copied_live_session_set_mismatch, by design -- it must never silently promote a
# partial campaign as though it were whole).
#
# Two tiers, in order of how much can honestly be recovered without a new capability:
#  1. LiveRunning itself actually completed (wrote a receipt with exactly one session per expected
#     cell -- its OWN verdict may still be FAIL, e.g. one_or_more_provider_sessions_failed, if some
#     individual session was rejected; that is in fact the single most common real trigger for this
#     whole function, since the main loop throws on ANY non-PASS receipt, including LiveRunning's
#     own). When this holds, every cell's accepted/rejected status is already knowable exactly like
#     Invoke-E1RunEvidenceCopiedState itself determines it, so this copies the SAME spec per cell
#     EvidenceCopied would have -- full parity, nothing lost.
#  2. LiveRunning did not complete (missing receipt, or a session count that does not match the
#     manifest's expected cells -- LiveRunning crashed/hung partway through its own per-cell loop
#     rather than returning a FAIL receipt for a completed set). There is no way to know which
#     cells finished without asking the guest, so this falls back to one best-effort
#     agentic-eval-session-record attempt per expected cell: a cell already recorded before the
#     failure comes back with its record/audit pair (record.json/audit.json are both a required
#     source for this spec -- confirmed against evidence1-artifact-copy-fake.psm1's own
#     artifact_copy_required_source_missing throw); a cell that had not yet been recorded throws
#     the same way and is captured per-cell below as a legitimate miss, never as a fatal error.
#     Recovering the specific in-flight cell's own raw, not-yet-recorded journal needs a capability
#     this closure does not have (a guest directory listing to discover its JournalId) --
#     intentionally left for separate work rather than folded in here.
#
# Never throws (same discipline as its caller): every per-cell attempt is its own try/catch, and
# the whole function is wrapped again by its one caller besides -- one cell's copy failure must
# never stop the rest, and this function's own failure must never mask $Report.reason.
function Invoke-E1RunFailureSafeEvidenceCopyAttempt($Context, $VmResult, $TransportArguments) {
  $copy = [ordered]@{
    attempted               = $false
    skipped_reason          = $null
    tier                    = $null
    live_running_available  = $false
    results                 = @()
    error                   = $null
  }
  if (-not $Context.Manifest) { $copy.skipped_reason = 'no_manifest'; return $copy }
  if ([string]$VmResult.verdict -cne 'PASS') { $copy.skipped_reason = 'vm_not_confirmed_off'; return $copy }
  try {
    $expectedCells = @(Get-E1RunManifestExpectedCells $Context.Manifest)
    if ($expectedCells.Count -eq 0) { $copy.skipped_reason = 'no_expected_cells'; return $copy }
    $guestCampaignRoot = Join-Path ([string]$Context.Manifest.private_root) ([string]$Context.Manifest.campaign_id)
    $privateRootRelative = ConvertTo-E1RunGuestRelativePath $guestCampaignRoot
    $destinationRoot = Join-Path $Context.CampaignRoot 'failure-safe-evidence'
    New-Item -ItemType Directory -Force -Path $destinationRoot | Out-Null

    # If/else used as a value-producing expression collapses a
    # ONE-element array to its bare element on capture, same as a function return -- see
    # Get-E1RunPropertyValue's own header for the full finding. A campaign with exactly one
    # expected cell would otherwise turn $liveSessions into a bare session object instead of a
    # 1-element array, breaking the Count comparison just below. Plain if-statement instead.
    $liveReceipt = Read-E1RunStateReceipt $Context.CampaignRoot 'LiveRunning'
    if ($liveReceipt) {
      $liveSessions = @($liveReceipt.detail.sessions)
    } else {
      $liveSessions = @()
    }
    $copy.live_running_available = ($liveSessions.Count -eq $expectedCells.Count)
    $copy.tier = if ($copy.live_running_available) { 'live_running_session_status' } else { 'best_effort_session_record_only' }
    $copy.attempted = $true

    foreach ($cell in $expectedCells) {
      $cellKey = "$([string]$cell.runtime_id)-$([int]$cell.campaign_cell_index)"
      $guestCellKey = "$([string]$cell.runtime_id)-$([int]$cell.round_index)"
      $destination = Join-Path $destinationRoot $cellKey
      try {
        if ($copy.live_running_available) {
          $matchingSessions = @($liveSessions | Where-Object { [string]$_.runtime_id -ceq [string]$cell.runtime_id -and [int]$_.round_index -eq [int]$cell.round_index })
          if ($matchingSessions.Count -ne 1) { throw 'failure_safe_evidence_copy_session_identity_mismatch' }
          $benchmarkStatus = Get-E1SafeBenchmarkStatus $matchingSessions[0].output_summary
          if ($benchmarkStatus -ceq 'rejected') {
            $rejectionId = [string]$matchingSessions[0].output_summary.rejection_id
            if ($rejectionId -cnotmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$') { throw 'failure_safe_evidence_copy_rejection_identity_invalid' }
            $result = Copy-E1ArtifactsReadOnly -VMName $Context.VMName -ExpectedVMId $Context.VMId -SpecName 'agentic-eval-rejection-diagnostic' `
              -Arguments @{ PrivateRootRelative = $privateRootRelative; CellKey = $guestCellKey; RejectionId = $rejectionId } -DestinationDir $destination `
              -TrustedRoot $Context.OutputRootsTrustedRoot -TimeoutMinutes 10 @TransportArguments
            Assert-E1ArtifactCopyResultShape 'agentic-eval-rejection-diagnostic' $result
            $copy.results += [ordered]@{ cell_key = $cellKey; spec_name = 'agentic-eval-rejection-diagnostic'; benchmark_status = $benchmarkStatus; verdict = 'PASS'; files_copied = @($result.files_copied) }
          } elseif ($benchmarkStatus -ceq 'accepted') {
            $result = Copy-E1ArtifactsReadOnly -VMName $Context.VMName -ExpectedVMId $Context.VMId -SpecName 'agentic-eval-session-record' `
              -Arguments @{ PrivateRootRelative = $privateRootRelative; CellKey = $guestCellKey } -DestinationDir $destination `
              -TrustedRoot $Context.OutputRootsTrustedRoot -TimeoutMinutes 10 @TransportArguments
            Assert-E1ArtifactCopyResultShape 'agentic-eval-session-record' $result
            $copy.results += [ordered]@{ cell_key = $cellKey; spec_name = 'agentic-eval-session-record'; benchmark_status = $benchmarkStatus; verdict = 'PASS'; files_copied = @($result.files_copied) }
          } else {
            throw 'failure_safe_evidence_copy_benchmark_status_invalid'
          }
        } else {
          $result = Copy-E1ArtifactsReadOnly -VMName $Context.VMName -ExpectedVMId $Context.VMId -SpecName 'agentic-eval-session-record' `
            -Arguments @{ PrivateRootRelative = $privateRootRelative; CellKey = $guestCellKey } -DestinationDir $destination `
            -TrustedRoot $Context.OutputRootsTrustedRoot -TimeoutMinutes 10 @TransportArguments
          Assert-E1ArtifactCopyResultShape 'agentic-eval-session-record' $result
          $copy.results += [ordered]@{ cell_key = $cellKey; spec_name = 'agentic-eval-session-record'; benchmark_status = $null; verdict = 'PASS'; files_copied = @($result.files_copied) }
        }
      } catch {
        $copy.results += [ordered]@{ cell_key = $cellKey; verdict = 'FAIL'; error = [string]$_.Exception.Message }
      }
    }
  } catch {
    $copy.error = [string]$_.Exception.Message
  }
  return $copy
}

# Run-level recovery, attempted from the main loop's catch block (below) BEFORE the failure-safe
# closure, and ONLY when $Report.reason matches the two fast-fail codes
# evidence1-broker-capability-client.psm1's own pickup check can throw (broker_request_stalled /
# broker_request_not_picked_up) -- i.e. only when the failure itself was the broker never
# starting the dispatch, not some other reason a real campaign can fail for. 2026-09-28 incident:
# a hung runner instance also swallows every later /Run (MultipleInstances=IgnoreNew), including
# the failure-safe closure's own teardown requests, which would otherwise queue_busy-reject
# immediately and never actually turn the VM/network off. This clears that queue first so the
# failure-safe closure that runs right after it has a real chance to reach the broker at all.
#
# (a) /End the task through the one new injectable seam (mirrors -TriggerTask elsewhere in
# evidence1-broker-capability-client.psm1, and lives in that same file, not here -- keeping every
# schtasks.exe reference in this codebase inside that one module's own two seams). (b) a bounded
# (<=30s) wait for it to stop, done INSIDE that seam, not as a second loop here. (c) sweep
# requests/ and in-progress/ for any outer request with no matching logs/<id>.log -- a request
# the runner never finished claiming cannot possibly still be doing real work -- and move each
# into stale/, never delete: 'withdrawn-not-picked-up' for one still in requests/,
# 'stalled-before-log' for one that had reached in-progress/, matching the exact naming
# convention every prior stale/ entry already uses
# (<yyyyMMdd-HHmm>.<source-dir>.<request-id>.<cause>.request.json). A request WITH a log is left
# alone: something claimed it and may still be legitimately working, and this recovery's whole
# premise is that ending the one hung/unresponsive task instance is enough -- it must never
# delete or move evidence of work that might still be real.
#
# Never throws, same discipline as Invoke-E1RunFailureSafeClosureAttempt: every step is its own
# try/catch, the whole thing is also wrapped by its one caller, and nothing here may ever replace
# $Report.reason, which the caller has already captured. No retry of the failed dispatch itself --
# this only clears the queue and records what it found; the campaign's own FAIL stands, and (S1,
# same as the failure-safe closure) this campaign_id must not be resumed afterward either.
#
# TRIGGER IS STATE-BASED, not message-based -- deliberately, after a real bug found in review:
# $Reason alone cannot be trusted to carry these fast-fail codes through to this catch block.
# evidence1-provider-runtime-real.psm1's own Invoke-E1ProviderRuntimeSession wraps the ENTIRE
# guest-bundle call (which is what actually reaches Submit-E1BrokerCapabilityOperation on the
# live dispatch path) in its own try/catch that converts ANY exception -- including
# broker_request_stalled/broker_request_not_picked_up -- into a generic FAIL session result
# (reason_code provider_runtime_real_guest_bundle_call_failed) with no trace of the original
# message anywhere. LiveRunning then folds that into the still-more-generic
# one_or_more_provider_sessions_failed. A $Reason regex match against
# ^broker_request_(stalled|not_picked_up) would therefore NEVER fire on exactly the live path
# this recovery exists for -- confirmed by reading the actual catch block, not assumed. Instead,
# this looks at the queue's own current state directly: is there an outer request in requests/ or
# in-progress/ with no matching logs/<id>.log, right now. This is robust to any wrapping at any
# layer (live dispatch, dry-run, teardown), and safe to check unconditionally here: this
# orchestrator is the only client of this queue (the mutex plus Submit-E1BrokerCapabilityOperation's
# own busy-check guarantee that), the whole script is synchronous, and by the time this catch
# block runs, nothing of this run's own is still in flight that could be mistaken for a stall.
# $Reason is still accepted and recorded (reason_at_attempt) for a human reading the report later,
# but it no longer gates anything.
function Invoke-E1RunBrokerStallRecoveryAttempt($Context, [string]$Reason, [scriptblock]$EndTask = $null) {
  $recovery = [ordered]@{
    attempted_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    reason_at_attempt = $Reason
    triggered        = $false
    end_task_result  = $null
    moved            = @()
    error            = $null
  }
  if (-not $Context.UseRealBackends) { $recovery.error = 'skipped_fake_backend'; return $recovery }
  try {
    $queueRoot = Get-E1BrokerCapabilityDefaultQueueRoot
    $logsDir = Join-Path $queueRoot 'logs'
    $sweepTargets = @(
      [ordered]@{ dir = (Join-Path $queueRoot 'requests');    cause = 'withdrawn-not-picked-up' }
      [ordered]@{ dir = (Join-Path $queueRoot 'in-progress'); cause = 'stalled-before-log' }
    )
    $staleCandidates = @()
    foreach ($target in $sweepTargets) {
      if (-not (Test-Path -LiteralPath $target.dir -PathType Container)) { continue }
      $sourceLeaf = Split-Path -Leaf $target.dir
      $files = @(Get-ChildItem -LiteralPath $target.dir -Filter '*.request.json' -File -ErrorAction SilentlyContinue)
      foreach ($file in $files) {
        $requestId = $file.BaseName -replace '\.request$', ''
        $logPath = Join-Path $logsDir "$requestId.log"
        if (Test-Path -LiteralPath $logPath -PathType Leaf) { continue }
        $staleCandidates += [ordered]@{ file = $file; source_leaf = $sourceLeaf; cause = $target.cause }
      }
    }
    if ($staleCandidates.Count -eq 0) { return $recovery }
    $recovery.triggered = $true

    if ($null -eq $EndTask) { $EndTask = (Get-Command Invoke-E1BrokerCapabilityEndTask).ScriptBlock }
    $taskName = Get-E1BrokerCapabilityDefaultTaskName
    try {
      $recovery.end_task_result = & $EndTask $taskName
    } catch {
      $recovery.end_task_result = [ordered]@{ error = [string]$_.Exception.Message }
    }

    $staleDir = Join-Path $queueRoot 'stale'
    New-Item -ItemType Directory -Force -Path $staleDir | Out-Null
    foreach ($candidate in $staleCandidates) {
      $file = $candidate.file
      try {
        $requestId = $file.BaseName -replace '\.request$', ''
        $stamp = (Get-Date).ToString('yyyyMMdd-HHmm')
        $destName = "$stamp.$($candidate.source_leaf).$requestId.$($candidate.cause).request.json"
        $destPath = Join-Path $staleDir $destName
        Move-Item -LiteralPath $file.FullName -Destination $destPath -ErrorAction Stop
        $recovery.moved += [ordered]@{ from = $file.FullName; to = $destPath; cause = $candidate.cause }
      } catch {
        $recovery.moved += [ordered]@{ from = $file.FullName; error = [string]$_.Exception.Message }
      }
    }
  } catch {
    $recovery.error = [string]$_.Exception.Message
  }
  return $recovery
}

$StateHandlers = @{
  'BrokerReady'     = ${function:Invoke-E1RunBrokerReadyState}
  'VmReady'         = ${function:Invoke-E1RunVmReadyState}
  'ToolchainReady'  = ${function:Invoke-E1RunToolchainReadyState}
  'AuthReady'       = ${function:Invoke-E1RunAuthReadyState}
  'RestrictedReady' = ${function:Invoke-E1RunRestrictedReadyState}
  'DryRunPassed'    = ${function:Invoke-E1RunDryRunPassedState}
  'LiveAuthorized'  = ${function:Invoke-E1RunLiveAuthorizedState}
  'LiveRunning'     = ${function:Invoke-E1RunLiveRunningState}
  'EvidenceCopied'  = ${function:Invoke-E1RunEvidenceCopiedState}
  'Closed'          = ${function:Invoke-E1RunClosedState}
}

# Highest index i such that every state $AllStates[1..i] has an unbroken chain
# of PASS receipts back to Uninitialized. A missing or FAIL receipt anywhere
# in the chain stops the walk there, even if a later state somehow has an old
# receipt on disk (should not happen by construction, since the main loop
# below only ever writes states in order -- treated defensively anyway).
#
# $UseRealBackends parameter (Phase 3c second fix-forward round): the
# live-adjacent states are only a hard stop for the REAL-backend path now --
# in fake mode they have real handlers and real receipts, so resumability
# must be able to walk through them too. Real mode keeps the original
# behavior exactly (stops at the first live-adjacent name, since
# Invoke-E1RunNotYetImplementedState guarantees no real-mode receipt for any
# of them can ever exist to resume from).
function Get-E1RunResumeIndex([string]$CampaignRoot, [string]$ExpectedCampaignId, [bool]$UseRealBackends) {
  $index = 0
  for ($i = 1; $i -lt $AllStates.Count; $i++) {
    $stateName = $AllStates[$i]
    $receipt = Read-E1RunStateReceipt $CampaignRoot $stateName
    if ($null -eq $receipt -or [string]$receipt.verdict -cne 'PASS' -or [string]$receipt.campaign_id -cne $ExpectedCampaignId) { break }
    $index = $i
  }
  return $index
}

# ---------------------------------------------------------------------------
# Path setup and module imports.
#
# Only evidence1-run-manifest-contract.psm1 and evidence1-run-state-contract.psm1
# are imported directly: this script calls their functions itself.
# evidence1-broker-status-contract.psm1, evidence1-vm-state-contract.psm1,
# evidence1-network-backend-contract.psm1, and evidence1-guest-bundle-contract.psm1
# are NOT imported directly here -- this script never calls anything from them
# itself; each is already imported transitively by whichever -fake.psm1 or
# -real.psm1/-hyperv.psm1 sibling is selected below. BrokerReady now branches
# on -UseRealBackends exactly like the other four states (Phase 3c second
# fix-forward round: evidence1-broker-status-fake.psm1 previously did not
# exist -- see the module header).
# ---------------------------------------------------------------------------
$RepoRoot = Resolve-FullPath $PSScriptRoot
$AuditsRoot = Resolve-FullPath (Join-Path $RepoRoot 'docs\audits')

Import-Module (Join-Path $AuditsRoot 'evidence1-run-manifest-contract.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $AuditsRoot 'evidence1-run-state-contract.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $AuditsRoot 'evidence1-campaign-eligibility.psm1') -Force -DisableNameChecking
# (Found live during the first-ever full fake-mode run reaching
# ToolchainReady): Ensure-E1RunDeployedSessionBundle calls Ensure-E1BrokerSessionBundle
# unconditionally, in both modes -- that function's own body immediately no-ops for fake mode
# (`if (-not $UseRealBackends) { return ... }`, evidence1-broker-capability-client.psm1:231), so it
# has always been safe to call here regardless of mode. Only its MODULE was real-backend-only
# (transitively pulled in by the *-queue-client.psm1 imports below); unconditional here instead, so
# a fake-mode run can reach it at all.
Import-Module (Join-Path $AuditsRoot 'evidence1-broker-capability-client.psm1') -Force -DisableNameChecking

$AllStates = Get-E1RunStateNames
$LiveAdjacentStates = Get-E1RunLiveAdjacentStateNames

if ($UseRealBackends) {
  Write-Host '[evidence1-run] -UseRealBackends: importing broker capability queue-client modules (drafted, never executed code paths -- see those modules'' own headers). This still cannot pass DryRunPassed further than the fake path does.'
  # broker.status stays a direct, non-elevated, in-process import --
  # deliberately NOT rewired to a queue-client this round. Unlike the four
  # capabilities below, evidence1-broker-status-real.psm1 never touches
  # Hyper-V, a VM, an adapter, or PowerShell Direct at all (see that
  # module's own header): it only reads THIS host's own Scheduled Task,
  # filesystem, and ACLs, all of which are already readable by a
  # Hyper-V-Administrators-class principal without elevation -- the same
  # reason it was never named "-hyperv.psm1". Routing it through the queue
  # too would add a real round trip for zero additional safety.
  Import-Module (Join-Path $AuditsRoot 'evidence1-broker-status-real.psm1') -Force -DisableNameChecking
  # The four real-capable capabilities that DO need Hyper-V-Administrators-class
  # or PowerShell-Direct-into-the-guest privilege now import their
  # QUEUE-CLIENT siblings instead of the *-hyperv.psm1 modules directly --
  # this is this round's core fix (see
  # docs/audits/evidence1-broker-capability-contract.psm1's own header and
  # docs/audits/evidence1-phase3c-architecture-note.md section 9.4 item 6,
  # the maintainer's own prior answer that these MUST dispatch through the
  # elevated broker's queue for the real path). Each queue-client module
  # exports the SAME function names, with the SAME parameter shapes, as its
  # *-hyperv.psm1 sibling -- this file's own handler bodies below need zero
  # changes beyond this import swap. evidence1-vm-state-hyperv.psm1,
  # evidence1-network-backend-hyperv.psm1, evidence1-guest-bundle-hyperv.psm1,
  # and evidence1-artifact-copy-hyperv.psm1 are no longer imported by this
  # file in ANY mode -- they are only ever loadable from inside the elevated
  # broker's own dispatched context now
  # (evidence1-host-broker-capability-dispatch.ps1).
  Import-Module (Join-Path $AuditsRoot 'evidence1-vm-state-queue-client.psm1') -Force -DisableNameChecking
  Import-Module (Join-Path $AuditsRoot 'evidence1-network-backend-queue-client.psm1') -Force -DisableNameChecking
  Import-Module (Join-Path $AuditsRoot 'evidence1-guest-bundle-queue-client.psm1') -Force -DisableNameChecking
  # ArtifactCopy (this round's Task 3): imported for parity with the other
  # three real-capable capabilities.
  # STALE (2026-09-27 audit): the paragraph below described EvidenceCopied as
  # hard-blocked by Invoke-E1RunNotYetImplementedState for -UseRealBackends --
  # that guard was never actually called anywhere in this file, and
  # Invoke-E1RunEvidenceCopiedState's real-backend path genuinely DOES call
  # ArtifactCopy and Invoke-E1CampaignEligibilityFinalization today (confirmed
  # via real campaign receipts, e.g. 689b7772's EvidenceCopied.receipt.json).
  # This import makes the real artifacts.copy_read_only dispatch path
  # genuinely REACHABLE (module loads, exports the right function, routes
  # through the broker queue correctly -- see this round's Pester coverage).
  Import-Module (Join-Path $AuditsRoot 'evidence1-artifact-copy-queue-client.psm1') -Force -DisableNameChecking
  # Clock's real half DOES get imported here,
  # unlike ProviderRuntime/ArtifactStore just below: a real Clock is just
  # [DateTime]::UtcNow with nothing to build ahead of any gate, so importing
  # it costs nothing and is the semantically correct choice on the off
  # chance a future change ever lets real-backend code reach a
  # Get-E1CurrentUtc call site -- it should see real time, never the fake
  # clock, even though nothing in this round's live-adjacent guard actually
  # allows that to happen today.
  Import-Module (Join-Path $AuditsRoot 'evidence1-clock-real.psm1') -Force -DisableNameChecking
  Import-Module (Join-Path $AuditsRoot 'evidence1-provider-runtime-real.psm1') -Force -DisableNameChecking
  Import-Module (Join-Path $AuditsRoot 'evidence1-artifact-store-real.psm1') -Force -DisableNameChecking
  # Deliberately NOT importing anything for ProviderRuntime/ArtifactStore here:
  # no real implementation of either exists this round (see
  # evidence1-provider-runtime-fake.psm1's header for why not, even unused).
  # If -UseRealBackends ever reaches LiveAuthorized, the live-adjacent guard
  # below throws Invoke-E1RunNotYetImplementedState before any handler that
  # would need either capability is ever looked up.
} else {
  Import-Module (Join-Path $AuditsRoot 'evidence1-broker-status-fake.psm1') -Force -DisableNameChecking
  Import-Module (Join-Path $AuditsRoot 'evidence1-vm-state-fake.psm1') -Force -DisableNameChecking
  Import-Module (Join-Path $AuditsRoot 'evidence1-network-backend-fake.psm1') -Force -DisableNameChecking
  Import-Module (Join-Path $AuditsRoot 'evidence1-guest-bundle-fake.psm1') -Force -DisableNameChecking
  Import-Module (Join-Path $AuditsRoot 'evidence1-artifact-copy-fake.psm1') -Force -DisableNameChecking
  Import-Module (Join-Path $AuditsRoot 'evidence1-clock-fake.psm1') -Force -DisableNameChecking
  Import-Module (Join-Path $AuditsRoot 'evidence1-provider-runtime-fake.psm1') -Force -DisableNameChecking
  Import-Module (Join-Path $AuditsRoot 'evidence1-artifact-store-fake.psm1') -Force -DisableNameChecking
}

# ---------------------------------------------------------------------------
# Manifest (optional -- see module header).
# ---------------------------------------------------------------------------
# Resolved once, here: explicit -OutputRootsTrustedRoot wins; otherwise the
# module's own Get-E1RunManifestDefaultTrustedRoot (EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT
# env var, else the historical C:\kmp-eval\scratch\) applies. This value is
# ALWAYS explicitly passed to Read-E1RunManifest below -- never left to that
# function's own default -- so this script's own resolution is the one
# actually in effect and auditable from this file alone, matching "a
# parameter the orchestrator injects explicitly into the validation call"
# (the requirement behind -OutputRootsTrustedRoot).
$ResolvedOutputRootsTrustedRoot = if ([string]::IsNullOrWhiteSpace($OutputRootsTrustedRoot)) { Get-E1RunManifestDefaultTrustedRoot } else { $OutputRootsTrustedRoot }
$LoadedManifest = $null
if (-not [string]::IsNullOrWhiteSpace($Manifest)) {
  Assert-PathInside $Manifest 'C:\kmp-eval\' 'manifest'
  $LoadedManifest = Read-E1RunManifest $Manifest -TrustedRoot $ResolvedOutputRootsTrustedRoot
}

# ---------------------------------------------------------------------------
# Parameter resolution: -Manifest fields are defaults, explicit parameters
# override, and fake mode synthesizes whatever is still missing. Real mode
# requires VM identity and a guest credential path outright -- fail fast,
# before any state work begins, rather than partway through a campaign.
# ---------------------------------------------------------------------------
if ($TargetState -cnotin $AllStates) { Fail "target_state_invalid: $TargetState" }

$ResolvedCampaignId = $CampaignId
if ([string]::IsNullOrWhiteSpace($ResolvedCampaignId)) {
  if ($LoadedManifest) { $ResolvedCampaignId = [string]$LoadedManifest.campaign_id }
  else { $ResolvedCampaignId = [guid]::NewGuid().ToString() }
}
if ($ResolvedCampaignId -cnotmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$') { Fail "campaign_id_invalid: $ResolvedCampaignId" }

$ResolvedVMName = $VMName
if ([string]::IsNullOrWhiteSpace($ResolvedVMName) -and $LoadedManifest) { $ResolvedVMName = [string]$LoadedManifest.vm_name }
$ResolvedVMId = $VMId
if ([string]::IsNullOrWhiteSpace($ResolvedVMId) -and $LoadedManifest -and $LoadedManifest.PSObject.Properties['vm_id']) {
  $ResolvedVMId = [string]$LoadedManifest.vm_id
}

if ($UseRealBackends) {
  if ([string]::IsNullOrWhiteSpace($ResolvedVMName)) {
    Fail 'vm_identity_required_for_real_backends: supply -Manifest'
  }
  if ([string]::IsNullOrWhiteSpace($ResolvedVMId)) {
    $transportArgs = Get-E1RunRealTransportArguments
    $vmInspection = Get-E1VmState -VMName $ResolvedVMName -ExpectedVMId '' @transportArgs
    $ResolvedVMId = [string]$vmInspection.vm_id
    if ([string]::IsNullOrWhiteSpace($ResolvedVMId)) { Fail 'vm_identity_unavailable_from_inspection' }
  }
  if ([string]::IsNullOrWhiteSpace($GuestCredentialPath) -and $LoadedManifest) {
    $GuestCredentialPath = [string]$LoadedManifest.guest_credential_path
  }
} else {
  if ([string]::IsNullOrWhiteSpace($ResolvedVMName)) { $ResolvedVMName = 'Evidence1FakeVM' }
  if ([string]::IsNullOrWhiteSpace($ResolvedVMId)) { $ResolvedVMId = [guid]::NewGuid().ToString() }
}

# A manifest is mandatory once the target reaches LiveAuthorized or beyond
# (fake or real) -- failed fast here, before any state work begins, rather
# than letting the walk reach LiveAuthorized's own handler first. Checked
# against $TargetState specifically, not -UseRealBackends: a fake run asking
# for -TargetState Closed needs this exactly as much as a real one would.
if (-not $LoadedManifest) {
  $targetRequiresManifestIndex = [array]::IndexOf($AllStates, 'LiveAuthorized')
  $requestedTargetIndexForManifestCheck = [array]::IndexOf($AllStates, $TargetState)
  if ($requestedTargetIndexForManifestCheck -ge $targetRequiresManifestIndex) {
    Fail "manifest_required_for_target_state: -TargetState $TargetState requires -Manifest"
  }
}

# ---------------------------------------------------------------------------
# Campaign root: <StateRoot>\<CampaignId>\. A campaign.json descriptor is
# written once and checked (not overwritten) on every later resume, so a
# caller who accidentally resumes the right CampaignId against a different
# VM/backend combination is stopped loudly rather than silently proceeding
# with mismatched identity -- the same "observed state contradicts the phase
# input receipt" class of stop the plan's section 8 names generically.
# ---------------------------------------------------------------------------
$CampaignRoot = Join-Path (Resolve-FullPath $StateRoot) $ResolvedCampaignId
Assert-PathInside $CampaignRoot $StateRoot 'campaign root'
New-Item -ItemType Directory -Force -Path $CampaignRoot | Out-Null

# Precomputed once, used both to build $CampaignDescriptor below and (via
# Test-E1RunCampaignIdentityMatches) to compare against whatever a PRIOR
# invocation already wrote -- so a campaign resumed (same -CampaignId)
# against a manifest with different output_roots than the first invocation
# is caught loudly here, at descriptor-check time, rather than silently
# publishing evidence to wherever the SECOND invocation's manifest happened
# to say (the requirement: "resume must honor the SAME
# output_roots from the first invocation").
$ResolvedOutputRootsPrivate = if ($LoadedManifest) { Resolve-FullPath ([string]$LoadedManifest.output_roots.private) } else { $null }
$ResolvedOutputRootsPublic  = if ($LoadedManifest) { Resolve-FullPath ([string]$LoadedManifest.output_roots.public) } else { $null }

$CampaignDescriptorPath = Join-Path $CampaignRoot 'campaign.json'
$CampaignDescriptor = [ordered]@{
  schema               = 1
  campaign_id          = $ResolvedCampaignId
  vm_name              = $ResolvedVMName
  vm_id                = $ResolvedVMId
  use_real_backends    = [bool]$UseRealBackends
  manifest_path        = if ($LoadedManifest) { Resolve-FullPath $Manifest } else { $null }
  output_roots_private = $ResolvedOutputRootsPrivate
  output_roots_public  = $ResolvedOutputRootsPublic
  created_at_utc       = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}
if (Test-Path -LiteralPath $CampaignDescriptorPath -PathType Leaf) {
  $existingDescriptor = Get-Content -LiteralPath $CampaignDescriptorPath -Raw | ConvertFrom-Json -ErrorAction Stop
  if (-not (Test-E1RunCampaignIdentityMatches $existingDescriptor $CampaignDescriptor)) {
    Fail "campaign_identity_mismatch_on_resume: $ResolvedCampaignId was previously started with a different vm_name/vm_id/use_real_backends/output_roots combination"
  }
} else {
  Write-E1RunJsonAtomically $CampaignDescriptorPath $CampaignDescriptor
}

if ([string]::IsNullOrWhiteSpace($ReportPath)) {
  $ReportPath = Join-Path $CampaignRoot ('run-' + (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmssfff') + '.json')
} else {
  Assert-PathInside $ReportPath 'C:\kmp-eval\scratch\' 'report'
}

$Context = [ordered]@{
  CampaignId             = $ResolvedCampaignId
  CampaignRoot           = $CampaignRoot
  VMName                 = $ResolvedVMName
  VMId                   = $ResolvedVMId
  GuestCredentialPath    = $GuestCredentialPath
  UseRealBackends        = [bool]$UseRealBackends
  Manifest               = $LoadedManifest
  # Output_roots trust-root portability follow-up: the SAME resolved value
  # (see $ResolvedOutputRootsTrustedRoot above) threaded to every handler
  # that needs it (EvidenceCopied's Copy-E1ArtifactsReadOnly,
  # Closed's Publish-E1ArtifactStoreSet) via $Context, matching how every
  # other per-campaign value already flows through $Context rather than an
  # implicitly-captured script-scope variable.
  OutputRootsTrustedRoot = $ResolvedOutputRootsTrustedRoot
  CurrentCampaignInputs = $(if ($LoadedManifest) { New-E1CurrentCampaignInputs $LoadedManifest $ResolvedVMId } else { $null })
}

# ---------------------------------------------------------------------------
# -Inspect: read-only reporting mode, mirroring evidence1-install.ps1's own
# -DryRun. Never calls an Ensure/Invoke mutator. Reports every state's receipt
# status (or "not_yet_implemented" for the live-adjacent four) without
# attempting or requiring any of them, and never throws for a missing or FAIL
# receipt -- that is exactly the information this mode exists to surface.
# ---------------------------------------------------------------------------
if ($Inspect) {
  $inspectStates = @()
  foreach ($stateName in $AllStates) {
    if ($stateName -ceq 'Uninitialized') { continue }
    $receipt = Read-E1RunStateReceipt $CampaignRoot $stateName
    if ($receipt) {
      $inspectStates += [ordered]@{ state = $stateName; receipt_verdict = [string]$receipt.verdict; generated_at_utc = [string]$receipt.generated_at_utc }
    } else {
      $inspectStates += [ordered]@{ state = $stateName; receipt_verdict = $null }
    }
  }

  $liveVmState = $null
  $liveVmStateError = $null
  if ($UseRealBackends) {
    try {
      $inspectTransportArgs = Get-E1RunRealTransportArguments
      $liveVmState = Get-E1VmState -VMName $ResolvedVMName -ExpectedVMId $ResolvedVMId @inspectTransportArgs
    }
    catch { $liveVmStateError = [string]$_.Exception.Message }
  }

  $inspectReport = [ordered]@{
    schema              = 1
    verdict              = 'PASS'
    mode                  = 'Inspect'
    campaign_id            = $ResolvedCampaignId
    use_real_backends       = [bool]$UseRealBackends
    states                   = $inspectStates
    live_vm_state              = $liveVmState
    live_vm_state_error         = $liveVmStateError
    generated_at_utc             = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  }
  Write-E1RunJsonAtomically $ReportPath $inspectReport

  $summaryParts = @()
  foreach ($entry in $inspectStates) {
    if ('not_yet_implemented' -cin @($entry.Keys)) { $summaryParts += "$($entry.state)=NOT_YET_IMPLEMENTED" }
    else { $summaryParts += "$($entry.state)=$($entry.receipt_verdict)" }
  }
  Write-Host "[evidence1-run] Inspect ($ResolvedCampaignId): $($summaryParts -join ', ')"
  Write-Host "[evidence1-run] report: $ReportPath"
  exit 0
}

# ---------------------------------------------------------------------------
# Main state walk: resume point through -TargetState (default DryRunPassed).
# If -TargetState is already durably behind the resume point, this is a no-op
# success -- idempotent by construction, not a special case.
# STALE (2026-09-27 audit): the sentence below claimed a state in
# $LiveAdjacentStates throws via Invoke-E1RunNotYetImplementedState before any
# handler lookup -- that guard is never actually called anywhere in this file,
# and $LiveAdjacentStates (assigned above) is never read. A live-adjacent
# state's own handler runs directly via $StateHandlers, same as any other.
# ---------------------------------------------------------------------------
$targetIndex = [array]::IndexOf($AllStates, $TargetState)
$resumeIndex = Get-E1RunResumeIndex $CampaignRoot $ResolvedCampaignId ([bool]$UseRealBackends)

$Report = [ordered]@{
  schema             = 1
  verdict             = 'RUNNING'
  campaign_id          = $ResolvedCampaignId
  target_state          = $TargetState
  use_real_backends       = [bool]$UseRealBackends
  vm_name                  = $ResolvedVMName
  vm_id                     = $ResolvedVMId
  generated_at_utc           = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  states_run                  = @()
}

$lastAttemptedIndex = $resumeIndex
try {
  if ($targetIndex -le $resumeIndex) {
    Write-Host "[evidence1-run] $TargetState already durably PASS for campaign $ResolvedCampaignId -- nothing to do."
  } else {
    for ($i = $resumeIndex + 1; $i -le $targetIndex; $i++) {
      $stateName = $AllStates[$i]
      $lastAttemptedIndex = $i
      Write-Host "[evidence1-run] -> $stateName"
      $handler = $StateHandlers[$stateName]
      $receipt = & $handler $Context
      Assert-E1RunStateReceiptShape $receipt
      Write-E1RunStateReceiptAtomically $CampaignRoot $receipt
      $Report.states_run += [ordered]@{ state = $stateName; verdict = [string]$receipt.verdict }
      if ([string]$receipt.verdict -cne 'PASS') { throw "state_failed: $stateName ($([string]$receipt.reason_code))" }
    }
  }
  $Report.verdict = 'PASS'
} catch {
  $Report.verdict = 'FAIL'
  $Report.reason = [string]$_.Exception.Message
  try { $Report.broker_stall_recovery = Invoke-E1RunBrokerStallRecoveryAttempt $Context $Report.reason }
  catch { $Report.broker_stall_recovery = [ordered]@{ error = [string]$_.Exception.Message } }
  $vmReadyIndex = [array]::IndexOf($AllStates, 'VmReady')
  if ($vmReadyIndex -ge 0 -and $lastAttemptedIndex -ge $vmReadyIndex) {
    try { $Report.failure_safe_closure = Invoke-E1RunFailureSafeClosureAttempt $Context }
    catch { $Report.failure_safe_closure = [ordered]@{ error = [string]$_.Exception.Message } }
  }
} finally {
  $Report.generated_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  try { Write-E1RunJsonAtomically $ReportPath $Report } catch { }
}

if ([string]$Report.verdict -cne 'PASS') {
  Write-Error "HARD STOP: $([string]$Report.reason) (campaign: $ResolvedCampaignId, report: $ReportPath)"
  exit 1
}
Write-Host "[evidence1-run] PASS: reached $TargetState for campaign $ResolvedCampaignId ($ReportPath)"
