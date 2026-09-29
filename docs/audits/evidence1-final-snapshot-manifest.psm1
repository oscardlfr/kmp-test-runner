# evidence1-final-snapshot-manifest.psm1
#
# Round C, Task 7: a complete, GENERATED-FRESH-EVERY-CALL description of what
# the eventual (still-not-yet-run) evidence1-host-elevated-runner-install.ps1
# bootstrap would deploy, reflecting the CURRENT, TRUE state of this repo.
# Read-only, non-privileged, zero writes anywhere: every fact below comes
# from reading already-on-disk file text/bytes (Get-Content/[IO.File],
# real SHA-256 hashing, AST parsing) or from importing the two pure,
# dependency-free contract modules already established as safe to import
# (evidence1-broker-capability-contract.psm1). This module NEVER imports,
# dot-sources, or executes evidence1-host-elevated-runner.ps1,
# evidence1-host-elevated-runner-install.ps1, or evidence1-install.ps1 --
# every fact about them below comes from reading their SOURCE TEXT only, the
# same AST-based static-read technique
# Evidence1-Run-Broker-Capability-Wiring.Tests.ps1's own
# Get-E1LiteralArrayAssignment already established, and the SAME technique
# evidence1-host-elevated-runner-install.ps1 itself already uses internally
# (Read-E1InstallLiteralStringArray) to derive its own manifest without ever
# executing the runner it is about to deploy.
#
# ============================================================================
# .json vs .psm1 -- why this is a module exposing a constructor function,
# not a static committed JSON file
# ============================================================================
# A static, committed JSON file would need to be hand-regenerated every time
# a future round adds a capability, an allowlisted script, or a trusted
# support file -- exactly the kind of silent-staleness risk this round's own
# task explicitly warns against ("a regression test that would fail if a
# future round added a capability/trusted file without updating anything
# this snapshot depends on"). A .psm1 exposing New-E1FinalSnapshotManifest
# instead computes every fact FRESH, on every call, directly from the live
# repo state -- there is nothing to "forget to update": the next round's own
# test run of Evidence1-Final-Snapshot-Manifest.Tests.ps1 will pick up
# whatever changed automatically, and this module's own generator body never
# embeds a copy of $AllowedScripts/$TrustedSupportFiles/$TrustedNodeFiles as
# a literal anywhere (see this module's own structural regression test for a
# direct proof of that, not just a claim).
#
# ============================================================================
# Scope: broader than the two arrays explicitly named, deliberately
# ============================================================================
# This round's own task text names $AllowedScripts and $TrustedSupportFiles
# specifically. This module ALSO includes $TrustedNodeFiles, the runner
# script itself, and the process module (evidence1-validation-ops.psm1) --
# the REAL install manifest evidence1-host-elevated-runner-install.ps1
# itself produces (schema 2, evidence1-host-elevated-runner-manifest.json)
# already covers exactly this superset (scripts/support_files/node_files
# plus runner_sha256/process_module_sha256), and a snapshot that only covered
# two of those five would not actually be "a complete description of what
# the eventual bootstrap install would deploy" -- it would silently omit
# three fifths of what the install script's own manifest schema already
# requires. PS-parse-validity (this round's own explicit ask) is computed
# for every .ps1/.psm1 entry; $TrustedNodeFiles legitimately contains
# non-PowerShell files (.mjs, .json) this module honestly marks
# not-applicable rather than silently skipping or guessing.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-broker-capability-contract.psm1') -Force -DisableNameChecking -Global

function Get-E1FinalSnapshotRepoRoot { return (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
function Get-E1FinalSnapshotAuditsRoot { return (Join-Path (Get-E1FinalSnapshotRepoRoot) 'docs\audits') }
function Get-E1FinalSnapshotRunnerScriptName { return 'evidence1-host-elevated-runner.ps1' }
function Get-E1FinalSnapshotProcessModuleName { return 'evidence1-validation-ops.psm1' }

# Duplicated, not imported -- this module's own established per-file
# stream-hashing idiom (evidence1-broker-status-real.psm1's own
# Get-E1BrokerFileSha256, evidence1-dual-condition-canary-contract.psm1's
# own Get-E1FileSha256, evidence1-artifact-store-real.psm1's own
# Get-E1ArtifactStoreRealFileSha256 -- this module's own copy is the fourth
# independent instance of the identical idiom, matching this codebase's
# established convention of NOT consolidating this specific piece of
# duplication, see the Phase 3c architecture note's own open question 5).
function Get-E1FinalSnapshotFileSha256([string]$Path) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
  } finally { $stream.Dispose() }
}

# Same AST-only, never-execute technique
# evidence1-host-elevated-runner-install.ps1's own
# Read-E1InstallLiteralStringArray and
# Evidence1-Run-Broker-Capability-Wiring.Tests.ps1's own
# Get-E1LiteralArrayAssignment already established, independently
# re-implemented here (not imported from either -- the install script is a
# never-executed .ps1 this module must not dot-source even for its helper
# functions, and the test file is test code, not production code, this
# module should not depend on). Reads ONLY a literal `$VariableName = @(...)`
# array-of-single-quoted-strings assignment; throws on anything else
# (a non-literal expression, string interpolation, a computed value) so a
# future edit that makes $AllowedScripts/etc. anything other than a plain
# literal array is a loud failure here, not a silent misread.
function Get-E1FinalSnapshotLiteralArrayAssignment($Ast, [string]$VariableName) {
  $assignments = @($Ast.FindAll({
    param($node)
    $node -is [Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and
    $node.Left.VariablePath.UserPath -ceq $VariableName
  }, $true))
  if ($assignments.Count -ne 1) { throw "final_snapshot_assignment_missing_or_ambiguous: $VariableName" }
  $right = $assignments[0].Right
  if ($right -isnot [Management.Automation.Language.CommandExpressionAst] -or
      $right.Expression -isnot [Management.Automation.Language.ArrayExpressionAst]) {
    throw "final_snapshot_assignment_not_literal_array: $VariableName"
  }
  $statements = @($right.Expression.SubExpression.Statements)
  if ($statements.Count -ne 1 -or $statements[0] -isnot [Management.Automation.Language.PipelineAst] -or
      @($statements[0].PipelineElements).Count -ne 1) {
    throw "final_snapshot_assignment_not_literal_array: $VariableName"
  }
  $command = $statements[0].PipelineElements[0]
  if ($command -isnot [Management.Automation.Language.CommandExpressionAst] -or
      $command.Expression -isnot [Management.Automation.Language.ArrayLiteralAst]) {
    throw "final_snapshot_assignment_not_literal_array: $VariableName"
  }
  $values = [Collections.Generic.List[string]]::new()
  foreach ($element in @($command.Expression.Elements)) {
    if ($element -isnot [Management.Automation.Language.StringConstantExpressionAst] -or
        $element.StringConstantType -ne [Management.Automation.Language.StringConstantType]::SingleQuoted) {
      throw "final_snapshot_assignment_contains_non_literal_element: $VariableName"
    }
    $values.Add([string]$element.Value)
  }
  return @($values)
}

# Private. Blanks every STRING/COMMENT token's own character span to spaces
# (newlines preserved) in a COPY of $Text, using the REAL token stream the
# AST parser itself already produced -- not a per-line '#'-to-end-of-line
# heuristic. This is a deliberate improvement over this codebase's own
# established "Remove-E1PowerShellLineComments" convention (used verbatim by
# Evidence1-Host-Broker-Capability-Dispatch-Static.Tests.ps1,
# Evidence1-Run-Broker-Capability-Wiring.Tests.ps1, and others), found
# necessary by this module's own first real execution: that per-line '#'
# heuristic only ever strips COMMENTS, never STRING LITERAL content, so a
# file that legitimately contains the two-character sequence "??" (or
# "?."/"&&"/"||") as DATA inside a quoted string -- confirmed live, a real
# example: evidence1-hyperv-update-harness-from-bundle.ps1 contains the
# string literal '?? tools/runs/agentic-eval-journal/' -- is a false
# positive for "contains PS6+-only syntax" under that narrower technique.
# Blanking every STRING/HereString/Comment token's own text (by exact
# Extent offset, from the SAME token stream ParseInput already returned,
# never a second, separate tokenize pass) removes exactly that class of
# false positive while preserving the CHARACTER ADJACENCY of genuine code
# tokens (so a real `&&`/`??` appearing as actual PS6+ operator syntax, not
# inside any string, is still detected correctly) -- confirmed directly:
# this fixed evidence1-hyperv-update-harness-from-bundle.ps1 and five
# similar cases this module's own first real run surfaced, all string-
# literal-data false positives under the older per-line technique, none of
# them genuine PS6+ syntax. This module's own existing files
# (Rounds A/B, out of scope to edit) were not changed to use this improved
# technique -- only this new module's own check.
function Get-E1FinalSnapshotCodeOnlyText([string]$Text, $Tokens) {
  $chars = $Text.ToCharArray()
  $excludedKinds = @(
    [Management.Automation.Language.TokenKind]::StringLiteral,
    [Management.Automation.Language.TokenKind]::StringExpandable,
    [Management.Automation.Language.TokenKind]::HereStringLiteral,
    [Management.Automation.Language.TokenKind]::HereStringExpandable,
    [Management.Automation.Language.TokenKind]::Comment
  )
  foreach ($token in $Tokens) {
    if ($token.Kind -notin $excludedKinds) { continue }
    $start = $token.Extent.StartOffset
    $end = [Math]::Min($token.Extent.EndOffset, $chars.Length)
    for ($i = $start; $i -lt $end; $i++) {
      if ($chars[$i] -ne "`n" -and $chars[$i] -ne "`r") { $chars[$i] = ' ' }
    }
  }
  return -join $chars
}

# PUBLIC. Parses $Path's own text as PowerShell (never executes/dot-sources
# it) and reports whether it is valid PS 5.1 syntax: zero AST parse errors,
# AND none of the PS6+-only tokens (??, ?., &&, ||) appear as LIVE CODE --
# see Get-E1FinalSnapshotCodeOnlyText's own header for why this module blanks
# string/comment token spans via the real token stream rather than a per-line
# '#'-to-end-of-line heuristic.
function Test-E1FinalSnapshotValidPowerShell51Syntax([string]$Path) {
  $text = Get-Content -LiteralPath $Path -Raw
  $tokens = $null
  $parseErrors = $null
  [Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$parseErrors) | Out-Null
  if ($parseErrors.Count -ne 0) { return $false }
  $codeOnly = Get-E1FinalSnapshotCodeOnlyText $text $tokens
  foreach ($forbiddenToken in @('??', '?.', '&&', '||')) {
    if ($codeOnly.Contains($forbiddenToken)) { return $false }
  }
  return $true
}

# Builds one file-entry record: name, real SHA-256 of the current on-disk
# bytes, and (for .ps1/.psm1 only) PS-5.1-parse-validity. For a non-
# PowerShell file (.mjs/.json/etc, only ever reached via $TrustedNodeFiles),
# parses_as_valid_ps51 is explicitly $null -- "not applicable", never a
# guessed or silently-skipped $true/$false -- matching this engagement's own
# "no plausible inference for unknown fields" discipline.
function New-E1FinalSnapshotFileEntry([string]$Root, [string]$Name) {
  $full = Join-Path $Root $Name
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "final_snapshot_listed_file_missing: $Name" }
  $isPowerShellFile = $Name -match '\.(ps1|psm1)$'
  return [ordered]@{
    name                 = $Name
    sha256               = Get-E1FinalSnapshotFileSha256 $full
    parses_as_valid_ps51 = if ($isPowerShellFile) { Test-E1FinalSnapshotValidPowerShell51Syntax $full } else { $null }
  }
}

# PUBLIC. Same rule evidence1-host-elevated-runner.ps1's own
# Convert-E1RunnerNodeRelativePath / evidence1-host-elevated-runner-install.ps1's
# own Convert-E1InstallNodeRelativePath already enforce for a $TrustedNodeFiles
# entry (forward-slash-relative, no drive letter, no .. traversal, no leading
# slash) -- independently re-implemented here as a pure validity CHECK (never
# used to resolve a path outside this module's own read-only hashing), so a
# node-file entry that would not actually be safely joinable is caught
# explicitly rather than silently mis-hashed or skipped.
function Test-E1FinalSnapshotNodeRelativePathValid([string]$RelativePath) {
  if ([string]::IsNullOrWhiteSpace($RelativePath)) { return $false }
  if ($RelativePath.Contains('\')) { return $false }
  if ($RelativePath.StartsWith('/')) { return $false }
  if ($RelativePath -cmatch '(^|/)(\.|\.\.)(/|$)') { return $false }
  if ($RelativePath -cmatch ':') { return $false }
  return $true
}

# PUBLIC. Reads evidence1-host-elevated-runner-install.ps1's own source text
# (never executed) and confirms, structurally, that the non-elevated
# principal's own granted FileSystemRights (Set-E1InstallProtectedAcl's own
# hardcoded literal) is exactly ReadAndExecute -- then independently computes
# (pure .NET enum math, zero I/O, zero privilege) that ReadAndExecute has NO
# overlap with any write-capable FileSystemRights flag. This is READING and
# VALIDATING the install script's own ALREADY-DECIDED ACL design (see that
# script's own Set-E1InstallProtectedAcl / Assert-E1InstallProtectedAcl,
# and evidence1-host-elevated-runner.ps1's own identical
# Assert-E1RunnerProtectedAcl re-verification), never inventing new ACL logic
# of this module's own.
function Test-E1FinalSnapshotNonElevatedGrantExcludesWriteRights {
  $installScriptPath = Join-Path (Get-E1FinalSnapshotAuditsRoot) 'evidence1-host-elevated-runner-install.ps1'
  $installSource = Get-Content -LiteralPath $installScriptPath -Raw
  # The exact literal this module's own claim depends on -- confirmed
  # present in the real source text, not assumed from memory of having read
  # it once. Set-E1InstallProtectedAcl's own three FileSystemAccessRule
  # constructions are unambiguous about which principal gets which right;
  # this is the SYSTEM/Administrators=FullControl, $principal=ReadAndExecute
  # literal that function passes to the third rule.
  $grantLinePresent = $installSource -match [regex]::Escape('[Security.AccessControl.FileSystemRights]::ReadAndExecute,$inherit')
  if (-not $grantLinePresent) { throw 'final_snapshot_acl_grant_literal_not_found_where_expected' }
  # Independently confirm the INVERSE never appears either -- i.e. this
  # module is not merely finding A ReadAndExecute grant somewhere
  # unconnected to the principal's own rule; the principal variable name is
  # $principal (constructed from $PrincipalSid two lines above), and it is
  # the THIRD and only the third FileSystemAccessRule built in that
  # function -- confirmed structurally, not merely by the single-line
  # substring match above, by requiring $principal to appear as a
  # constructor argument together with ReadAndExecute in the same function
  # body span.
  $functionStart = $installSource.IndexOf('function Set-E1InstallProtectedAcl')
  $functionEnd = $installSource.IndexOf("`n}", $functionStart)
  if ($functionStart -lt 0 -or $functionEnd -lt 0) { throw 'final_snapshot_acl_function_not_found' }
  $functionBody = $installSource.Substring($functionStart, $functionEnd - $functionStart)
  if ($functionBody -notmatch [regex]::Escape('FileSystemAccessRule]::new($principal,[Security.AccessControl.FileSystemRights]::ReadAndExecute')) {
    throw 'final_snapshot_acl_principal_grant_shape_unexpected'
  }
  # Also confirm the VERIFICATION side's own literal -- both
  # evidence1-host-elevated-runner-install.ps1's own Assert-E1InstallProtectedAcl
  # and evidence1-host-elevated-runner.ps1's own Assert-E1RunnerProtectedAcl
  # independently re-read the ACL after Windows has applied/normalized it and
  # compare against ReadAndExecute -bor Synchronize, not bare ReadAndExecute
  # -- confirmed by direct, live inspection: a real Set-Acl'd principal grant
  # reads back with the Synchronize bit ALSO set (0x1200A9, not the bare
  # constructor's 0x200A9), a well-documented Windows ACL normalization
  # behavior, not a bug in either script. This module's own computed
  # $grantedMask below matches the VERIFICATION literal exactly, for the
  # same reason: it is the value that is actually, verifiably granted after
  # Set-Acl runs, not merely the value the constructor call names.
  if ($installSource -notmatch [regex]::Escape('[Security.AccessControl.FileSystemRights]::ReadAndExecute-bor[Security.AccessControl.FileSystemRights]::Synchronize')) {
    throw 'final_snapshot_acl_verification_literal_not_found_where_expected'
  }

  # A closed, canonical list of every ATOMIC write-capable FileSystemRights
  # flag (.NET's own enum -- pure, in-memory, zero I/O, zero privilege
  # requirement to read). Deliberately EXCLUDES the COMPOSITE flags Modify
  # and FullControl: both are UNIONS that also include read/execute bits
  # (confirmed directly: ReadAndExecute -band Modify and ReadAndExecute -band
  # FullControl are BOTH non-zero, equal to ReadAndExecute itself, simply
  # because Modify/FullControl are supersets of ReadAndExecute, not because
  # ReadAndExecute grants any write capability) -- a bitwise-overlap check
  # against a composite that already contains read bits would incorrectly
  # report "overlap" for ANY non-empty read grant, a real bug this module's
  # own first live execution caught and is disclosed here, not silently
  # corrected: an earlier draft of this exact function included Modify/
  # FullControl in this list and always returned $false as a result,
  # regardless of what was actually granted. Only genuinely atomic,
  # write-specific bits belong in this list.
  $writeCapableRights = @(
    [Security.AccessControl.FileSystemRights]::WriteData,
    [Security.AccessControl.FileSystemRights]::AppendData,
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes,
    [Security.AccessControl.FileSystemRights]::WriteAttributes,
    [Security.AccessControl.FileSystemRights]::Delete,
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,
    [Security.AccessControl.FileSystemRights]::ChangePermissions,
    [Security.AccessControl.FileSystemRights]::TakeOwnership
  )
  $grantedMask = [int]([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)
  foreach ($right in $writeCapableRights) {
    if (($grantedMask -band [int]$right) -ne 0) { return $false }
  }
  return $true
}

# PUBLIC. The main constructor -- computes every fact fresh from the live
# repo. See this module's own header for the full account of scope and the
# "generated, never hand-maintained" design.
function New-E1FinalSnapshotManifest {
  [CmdletBinding()]
  param()

  $auditsRoot = Get-E1FinalSnapshotAuditsRoot
  $runnerScriptName = Get-E1FinalSnapshotRunnerScriptName
  $processModuleName = Get-E1FinalSnapshotProcessModuleName
  $runnerScriptPath = Join-Path $auditsRoot $runnerScriptName
  if (-not (Test-Path -LiteralPath $runnerScriptPath -PathType Leaf)) { throw 'final_snapshot_runner_script_missing' }

  $runnerSourceText = Get-Content -LiteralPath $runnerScriptPath -Raw
  $tokens = $null
  $parseErrors = $null
  $runnerAst = [Management.Automation.Language.Parser]::ParseInput($runnerSourceText, [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count -ne 0) { throw 'final_snapshot_runner_script_does_not_parse' }

  $allowedScripts = @(Get-E1FinalSnapshotLiteralArrayAssignment $runnerAst 'AllowedScripts')
  $trustedSupportFiles = @(Get-E1FinalSnapshotLiteralArrayAssignment $runnerAst 'TrustedSupportFiles')
  $trustedNodeFiles = @(Get-E1FinalSnapshotLiteralArrayAssignment $runnerAst 'TrustedNodeFiles')

  $allowedScriptEntries = @($allowedScripts | ForEach-Object { New-E1FinalSnapshotFileEntry $auditsRoot $_ })
  $trustedSupportFileEntries = @($trustedSupportFiles | ForEach-Object { New-E1FinalSnapshotFileEntry $auditsRoot $_ })

  $repoRoot = Get-E1FinalSnapshotRepoRoot
  $trustedNodeFileEntries = @($trustedNodeFiles | ForEach-Object {
    $relative = $_
    if (-not (Test-E1FinalSnapshotNodeRelativePathValid $relative)) { throw "final_snapshot_node_relative_path_invalid: $relative" }
    $nativeRelative = $relative.Replace('/', [IO.Path]::DirectorySeparatorChar)
    $full = Join-Path $repoRoot $nativeRelative
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "final_snapshot_listed_node_file_missing: $relative" }
    $isPowerShellFile = $relative -match '\.(ps1|psm1)$'
    [ordered]@{
      name                 = $relative
      sha256               = Get-E1FinalSnapshotFileSha256 $full
      parses_as_valid_ps51 = if ($isPowerShellFile) { Test-E1FinalSnapshotValidPowerShell51Syntax $full } else { $null }
    }
  })

  $runnerEntry = New-E1FinalSnapshotFileEntry $auditsRoot $runnerScriptName
  $processModuleEntry = New-E1FinalSnapshotFileEntry $auditsRoot $processModuleName

  return [ordered]@{
    schema                                        = 1
    generated_at_utc                              = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    repo_root                                     = $repoRoot
    runner_script                                 = $runnerEntry
    process_module                                = $processModuleEntry
    allowed_scripts                               = $allowedScriptEntries
    trusted_support_files                         = $trustedSupportFileEntries
    trusted_node_files                            = $trustedNodeFileEntries
    broker_capability_names                       = @(Get-E1BrokerCapabilityNames)
    non_elevated_principal_grant_excludes_write_rights = Test-E1FinalSnapshotNonElevatedGrantExcludesWriteRights
  }
}

Export-ModuleMember -Function `
  Get-E1FinalSnapshotRepoRoot, `
  Get-E1FinalSnapshotAuditsRoot, `
  Get-E1FinalSnapshotRunnerScriptName, `
  Get-E1FinalSnapshotProcessModuleName, `
  Get-E1FinalSnapshotFileSha256, `
  Get-E1FinalSnapshotLiteralArrayAssignment, `
  Test-E1FinalSnapshotValidPowerShell51Syntax, `
  New-E1FinalSnapshotFileEntry, `
  Test-E1FinalSnapshotNodeRelativePathValid, `
  Test-E1FinalSnapshotNonElevatedGrantExcludesWriteRights, `
  New-E1FinalSnapshotManifest
