# evidence1-guest-bundle-contract.psm1
#
# ADR-S1's guest.invoke_bundle capability -- the shared plumbing every
# evidence1-hyperv-*-direct.ps1 script today hand-rolls (its own New-PSSession,
# its own Invoke-Command, its own multi-candidate logon-name loop, its own
# sanitized-result re-projection). See docs/audits/evidence1-phase3a-architecture-note.md
# section 2 for the five scripts this was extracted from.
#
# ADR-S1, quoted exactly: "guest.invoke_bundle SHALL execute only inside the
# disposable VM through PowerShell Direct. It SHALL NOT execute caller-provided
# host PowerShell. Host paths, VM identity, destination roots, and operation
# schemas remain validated by the broker."
#
# This module is how that constraint is enforced STRUCTURALLY, not by
# convention:
#
#   - Get-E1GuestBundleRegistry returns a CLOSED, fixed set of named bundles.
#     Every bundle's scriptblock is a literal written in THIS file at authoring
#     time. There is no parameter anywhere in this module or in
#     evidence1-guest-bundle-hyperv.psm1's public Invoke-E1GuestBundle through
#     which a caller can pass a [scriptblock], a code string, or anything else
#     that would be interpreted as code. A caller supplies exactly two things:
#     a bundle NAME (matched against the closed registry -- Assert-E1GuestBundleName
#     throws for anything not in it) and a hashtable of primitive-typed
#     ARGUMENTS (matched against that bundle's OWN declared schema --
#     Assert-E1GuestBundleArguments throws for an unknown, missing, or
#     wrong-shaped argument). Neither path lets caller-supplied text become
#     caller-supplied code.
#   - Every bundle also declares its exact result key set
#     (Assert-E1GuestBundleResultShape), so a bundle whose guest-side logic
#     drifts from what it claims to return is caught here, not silently passed
#     through to whatever wrote the receipt.
#
# Adding a NEW bundle to the registry is still "the broker's own reviewed code
# changes" -- exactly as adding a new entry to evidence1-host-elevated-runner.ps1's
# $AllowedScripts is today. This module does not make that step lighter-weight;
# it only removes the need for every operation to hand-rewrite the session/
# transport/timeout/cleanup plumbing around it, and it removes any parameter
# through which that reviewed-code requirement could be bypassed at call time.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-E1GuestBundleNames {
  return @((Get-E1GuestBundleRegistry).Keys | Sort-Object)
}

function Assert-E1GuestBundleName([string]$Name) {
  if ($Name -cnotin (Get-E1GuestBundleNames)) { throw "guest_bundle_name_invalid: $Name" }
}

# $Arguments is a plain hashtable of primitive values (string/int/bool/string[]).
# Validated key-for-key against the bundle's declared schema: every declared
# argument must be present, no undeclared argument may be present, and each
# value must pass that argument's own validator scriptblock (also a fixed,
# authored-in-this-file value -- never caller-supplied).
# Reads one named value out of $Container regardless of whether it is a dictionary (['key']
# indexing) or a PSCustomObject (only .PSObject.Properties[key].Value works) -- the exact same
# shape problem Get-E1GuestBundlePropertyNames exists to solve for key NAMES, just for the value
# lookup Assert-E1GuestBundleArguments also needs. Mirrors
# evidence1-broker-capability-contract.psm1's own Get-E1BrokerCapabilityValue.
function Get-E1GuestBundleArgumentValue($Container, [string]$Key) {
  # Reproduced live (Windows PowerShell 5.1, the broker's own engine): an EMPTY array collapses
  # to $null the moment it passes through an intermediate "$value = if (...) {...}"
  # assignment-as-expression -- not just at a bare `return`. An empty TempDirNames/
  # CompactSeedNames argument (the normal case for a private-roots-only cleanup pass) silently
  # became $null this way, which then failed its own "$v -is [array]" validator for the wrong
  # reason. Confirmed by direct comparison of three mechanisms: assigning through an if-expression
  # first and comma-wrapping afterward still collapsed it; a comma applied immediately at the same
  # statement that reads the value did not. So each branch below reads-and-returns in one
  # statement, never through an intermediate variable. Scalars are unaffected regardless (the
  # comma-vs-bare split only changes behavior for an actual empty array), so every other bundle's
  # scalar-string arguments still come back as plain strings, not one-element arrays.
  if ($Container -is [Collections.IDictionary]) {
    if ($Container[$Key] -is [array]) { return ,$Container[$Key] }
    return $Container[$Key]
  }
  $property = $Container.PSObject.Properties[$Key]
  if ($null -eq $property) { return $null }
  if ($property.Value -is [array]) { return ,$property.Value }
  return $property.Value
}

# 2026-09-29 (found live dispatching run-agentic-eval-disk-cleanup, before any delete ran):
# .Keys / [$key] indexing only work on a Hashtable/OrderedDictionary. Every prior bundle this
# function validated successfully had either an empty argument_schema or scalar-string arguments
# supplied directly by evidence1-run.ps1's own already-a-hashtable call sites -- this path had
# never actually been exercised against a real ConvertFrom-Json PSCustomObject (the shape
# $Arguments becomes crossing the broker's own JSON round trip,
# Submit-E1BrokerCapabilityOperation) until now. Reproduced directly: $json | ConvertFrom-Json |
# Assert-E1GuestBundleArguments threw "property 'Keys' not found" before this fix. Fixed using
# this file's own already-established dual-shape idiom (Get-E1GuestBundlePropertyNames, already
# used by Assert-E1GuestBundleResultShape a few lines below -- this function was the one call site
# that never got the same treatment).
function Assert-E1GuestBundleArguments([string]$Name, $Arguments) {
  Assert-E1GuestBundleName $Name
  $bundle = (Get-E1GuestBundleRegistry)[$Name]
  if ($null -eq $Arguments) { $Arguments = @{} }
  $suppliedKeys = @(Get-E1GuestBundlePropertyNames $Arguments | Sort-Object)
  $declaredKeys = @($bundle.argument_schema.Keys | Sort-Object)
  if (@(Compare-Object $suppliedKeys $declaredKeys).Count -ne 0) {
    throw "guest_bundle_argument_shape_invalid: $Name expects exactly [$($declaredKeys -join ', ')]"
  }
  foreach ($key in $declaredKeys) {
    $validator = $bundle.argument_schema[$key]
    $ok = & $validator (Get-E1GuestBundleArgumentValue $Arguments $key)
    if ($ok -ne $true) { throw "guest_bundle_argument_invalid: $Name.$key" }
  }
}

# Returns the property/key NAMES of $Value regardless of whether it is a raw
# dictionary ([ordered]@{}, e.g. straight from a fake or hyperv result, never
# serialized) or a PSCustomObject (e.g. a real guest job's Receive-Job output,
# or anything from ConvertFrom-Json). Needed because .PSObject.Properties.Name
# on a Hashtable/OrderedDictionary reflects the .NET TYPE's own members
# (Count, Keys, IsFixedSize, ...), not the dictionary's actual entries -- the
# exact bug this project's shape-asserts hit the first time evidence1-run.ps1
# was actually run against the fake backends. Same idiom
# evidence1-validation-forensics.psm1:98 already uses -- copied, not reinvented.
function Get-E1GuestBundlePropertyNames($Value) {
  if ($Value -is [Collections.IDictionary]) { return @($Value.Keys) }
  return @($Value.PSObject.Properties.Name)
}

function Assert-E1GuestBundleResultShape([string]$Name, $Result) {
  Assert-E1GuestBundleName $Name
  $bundle = (Get-E1GuestBundleRegistry)[$Name]
  if ($null -eq $Result) { throw "guest_bundle_result_missing: $Name" }
  $actual = @(Get-E1GuestBundlePropertyNames $Result | Sort-Object)
  $expected = @($bundle.result_keys | Sort-Object)
  if (@(Compare-Object $actual $expected).Count -eq 0) { return }
  # A bundle may also declare optional_result_keys: keys that exist for only one of the shapes it returns, and
  # then all of them together. Bundles that declare none keep the exact check above.
  if ($bundle.Contains('optional_result_keys')) {
    $withOptional = @(@($bundle.result_keys) + @($bundle.optional_result_keys) | Sort-Object)
    if (@(Compare-Object $actual $withOptional).Count -eq 0) { return }
  }
  throw "guest_bundle_result_shape_invalid: $Name"
}

# Common argument validators, reusable across bundle definitions below.
function Test-E1GuestBundleCanonicalToolchainPath($Value) {
  # Every guest-side canonical tool this codebase installs lives under one of
  # these two roots (see evidence1-hyperv-verify-guest-codex-preflight-direct.ps1
  # and evidence1-hyperv-install-guest-codex-cli-direct.ps1) -- a bundle
  # argument that names a command to run inside the guest must resolve under
  # one of them, never an arbitrary guest path.
  if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) { return $false }
  return $Value -match '^C:\\Evidence1Toolchain\\' -or $Value -match '^C:\\Evidence1RuntimeState\\'
}

# The closed bundle registry. Each entry:
#   description       -- human-readable, for the architecture note / future docs
#   argument_schema    -- ORDERED map of argument name -> validator scriptblock.
#                          Order matters, not just presence: evidence1-guest-bundle-hyperv.psm1
#                          builds the positional -ArgumentList for Invoke-Command
#                          by walking argument_schema.Keys in order and looking
#                          up each value, so a bundle's argument_schema key
#                          order MUST exactly match its scriptblock's param()
#                          order. Keep the two adjacent when adding a bundle so
#                          this is easy to eyeball.
#   result_keys         -- exact expected key set of what the scriptblock returns
#   optional_result_keys -- (rare, optional) keys the scriptblock returns for only one of its shapes; a result
#                          carries all of them or none (Assert-E1GuestBundleResultShape)
#   scriptblock          -- the fixed, literal code that runs inside the guest.
#                           Takes its arguments via param() bound through
#                           -ArgumentList only (see evidence1-guest-bundle-hyperv.psm1) --
#                           never $using:, for the same reason documented in
#                           evidence1-network-backend-hyperv.psm1.
#
# Two worked examples ported from the read scripts, deliberately modest in
# scope for this groundwork round -- see the architecture note section 4 for
# what's NOT ported yet (the full interactive/device OAuth flows, and any
# bundle that needs a file copied into the guest first).
function Get-E1GuestBundleRegistry {
  return [ordered]@{

    # Ported from the one-liner repeated verbatim in
    # evidence1-hyperv-run-claude-auth-direct.ps1 line 35 and
    # evidence1-hyperv-run-codex-device-auth-direct.ps1 line 57. No arguments,
    # read-only, no auth/credential material touched.
    'get-firewall-sealed-state' = [ordered]@{
      description    = 'Read-only: are all three guest firewall profiles enabled with default outbound Block.'
      argument_schema = [ordered]@{}
      result_keys      = @('sealed')
      scriptblock        = {
        $profiles = @(Get-NetFirewallProfile -Profile Domain, Private, Public)
        $sealed = $profiles.Count -eq 3 -and @($profiles | Where-Object {
          $_.Enabled.ToString() -ne 'True' -or $_.DefaultOutboundAction.ToString() -ne 'Block'
        }).Count -eq 0
        [ordered]@{ sealed = [bool]$sealed }
      }
    }

    'get-cli-version' = [ordered]@{
      description     = 'Read-only: resolve one canonical toolchain command and return its version.'
      argument_schema = [ordered]@{
        CommandPath = { param($v) Test-E1GuestBundleCanonicalToolchainPath $v }
      }
      result_keys      = @('command_found', 'version_text')
      scriptblock      = {
        param($CommandPath)
        $ErrorActionPreference = 'Stop'
        $command = Get-Command $CommandPath -ErrorAction SilentlyContinue
        if (-not $command) {
          return [ordered]@{ command_found = $false; version_text = $null }
        }
        $env:Path = @(
          (Split-Path -Parent $command.Source),
          'C:\Evidence1Toolchain\node\24.19.0',
          $env:Path
        ) -join ';'
        if ($command.Source -match '\\codex-cli\\') {
          $env:CODEX_HOME = 'C:\Evidence1RuntimeState\codex'
          $env:KMP_EVAL_CODEX_HOME = 'C:\Evidence1RuntimeState\codex'
          $env:KMP_EVAL_CODEX_RUNTIME_ROOT = 'C:\Evidence1RuntimeState'
        } elseif ($command.Source -match '\\claude-code\\') {
          foreach ($name in @('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN')) {
            [Environment]::SetEnvironmentVariable($name, $null, 'Process')
          }
          $claudeConfig = [Environment]::GetEnvironmentVariable('CLAUDE_CONFIG_DIR', 'Machine')
          if (-not [string]::IsNullOrWhiteSpace($claudeConfig)) { $env:CLAUDE_CONFIG_DIR = $claudeConfig }
        }
        $versionText = $null
        try { $versionText = [string](& $command.Source --version 2>$null | Select-Object -First 1) } catch { }
        [ordered]@{ command_found = $true; version_text = $versionText }
      }
    }

    # Generalizes the read-only half of
    # evidence1-hyperv-verify-guest-codex-preflight-direct.ps1 lines 183-199 and
    # evidence1-hyperv-verify-guest-claude-auth-direct.ps1 lines 216-224: run
    # '<command> --version', then a login/auth status probe, from a fixed,
    # canonical toolchain path -- never an arbitrary command. Deliberately
    # does NOT read, copy, or print any credential/auth file content (matching
    # every source script's own "codex_auth_material_read: false" /
    # "auth_content_read: false" privacy field) -- it only ever looks at the
    # login CLI's own exit code.
    'get-cli-version-and-login-status' = [ordered]@{
      description    = 'Read-only: --version output and a login/auth status exit-code probe for one canonical toolchain command.'
      argument_schema = [ordered]@{
        CommandPath     = { param($v) Test-E1GuestBundleCanonicalToolchainPath $v }
        LoginStatusArgs = { param($v) $v -is [string[]] -and $v.Count -ge 1 -and $v.Count -le 3 -and
                             @($v | Where-Object { $_ -notmatch '^[A-Za-z][A-Za-z0-9_-]{0,31}$' }).Count -eq 0 }
      }
      result_keys      = @('command_found', 'version_text', 'login_status_exit_code')
      scriptblock        = {
        param($CommandPath, $LoginStatusArgs)
        $ErrorActionPreference = 'Stop'
        $command = Get-Command $CommandPath -ErrorAction SilentlyContinue
        if (-not $command) {
          return [ordered]@{ command_found = $false; version_text = $null; login_status_exit_code = $null }
        }
        $env:Path = @(
          (Split-Path -Parent $command.Source),
          'C:\Evidence1Toolchain\node\24.19.0',
          $env:Path
        ) -join ';'
        if ($command.Source -match '\\codex-cli\\') {
          $env:CODEX_HOME = 'C:\Evidence1RuntimeState\codex'
          $env:KMP_EVAL_CODEX_HOME = 'C:\Evidence1RuntimeState\codex'
          $env:KMP_EVAL_CODEX_RUNTIME_ROOT = 'C:\Evidence1RuntimeState'
        } elseif ($command.Source -match '\\claude-code\\') {
          foreach ($name in @('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN')) {
            [Environment]::SetEnvironmentVariable($name, $null, 'Process')
          }
          $claudeConfig = [Environment]::GetEnvironmentVariable('CLAUDE_CONFIG_DIR', 'Machine')
          if (-not [string]::IsNullOrWhiteSpace($claudeConfig)) { $env:CLAUDE_CONFIG_DIR = $claudeConfig }
        }
        $versionText = $null
        try { $versionText = [string](& $command.Source --version 2>$null | Select-Object -First 1) } catch { }
        $previousPreference = $ErrorActionPreference
        $loginExit = $null
        try {
          $ErrorActionPreference = 'Continue'
          & $command.Source @LoginStatusArgs *> $null
          $loginExit = $LASTEXITCODE
        } finally {
          $ErrorActionPreference = $previousPreference
        }
        [ordered]@{
          command_found          = $true
          version_text           = $versionText
          login_status_exit_code = $loginExit
        }
      }
    }

    'refresh-claude-account-binding' = [ordered]@{
      description     = 'Refresh the local Claude credential fingerprint after a verified OAuth renewal; consumes no inference session.'
      argument_schema = [ordered]@{
        ExpectedAccount      = { param($v) $v -is [string] -and $v -cmatch '^[a-z0-9][a-z0-9._-]{0,63}$' }
        ExpectedSubscription = { param($v) $v -is [string] -and $v -ceq 'max' }
        ExpectedTier         = { param($v) $v -is [string] -and $v -ceq 'default_claude_max_20x' }
      }
      result_keys      = @('binding_refreshed', 'identity_matched', 'subscription_matched', 'tier_matched', 'required_scopes_present', 'expiry_valid', 'login_status_exit_code', 'credential_sha256')
      scriptblock      = {
        param($ExpectedAccount, $ExpectedSubscription, $ExpectedTier)
        Set-StrictMode -Version Latest
        $ErrorActionPreference = 'Stop'

        $config = [Environment]::GetEnvironmentVariable('CLAUDE_CONFIG_DIR', 'Machine')
        if ([string]::IsNullOrWhiteSpace($config)) { $config = $env:CLAUDE_CONFIG_DIR }
        if ([string]::IsNullOrWhiteSpace($config)) { throw 'claude_binding_config_dir_missing' }
        $config = [IO.Path]::GetFullPath($config).TrimEnd('\')
        if (-not $config.Equals('C:\Evidence1RuntimeState\claude', [StringComparison]::OrdinalIgnoreCase)) {
          throw 'claude_binding_config_dir_invalid'
        }

        $credentialPath = Join-Path $config '.credentials.json'
        $bindingPath = Join-Path $config 'account-binding.json'
        if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf) -or
            -not (Test-Path -LiteralPath $bindingPath -PathType Leaf)) {
          throw 'claude_binding_material_missing'
        }

        $credential = Get-Content -LiteralPath $credentialPath -Raw | ConvertFrom-Json -ErrorAction Stop
        $binding = Get-Content -LiteralPath $bindingPath -Raw | ConvertFrom-Json -ErrorAction Stop
        $oauth = $credential.claudeAiOauth
        $scopes = @($oauth.scopes | ForEach-Object { [string]$_ })
        $expiryMilliseconds = [int64]0
        $expiryValid = [int64]::TryParse([string]$oauth.expiresAt, [ref]$expiryMilliseconds) -and
          [DateTimeOffset]::FromUnixTimeMilliseconds($expiryMilliseconds).UtcDateTime -gt [datetime]::UtcNow.AddMinutes(5)
        $identityMatched = [string]$binding.account -ceq $ExpectedAccount
        $subscriptionMatched = [string]$oauth.subscriptionType -ceq $ExpectedSubscription
        $tierMatched = [string]$oauth.rateLimitTier -ceq $ExpectedTier
        $scopesMatched = $scopes -ccontains 'user:inference' -and $scopes -ccontains 'user:sessions:claude_code'

        $claude = 'C:\Evidence1Toolchain\claude-code\2.1.238\claude.cmd'
        $node = 'C:\Evidence1Toolchain\node\24.19.0'
        if (-not (Test-Path -LiteralPath $claude -PathType Leaf) -or -not (Test-Path -LiteralPath $node -PathType Container)) {
          throw 'claude_binding_toolchain_missing'
        }
        $env:Path = $node + ';' + $env:Path
        $env:CLAUDE_CONFIG_DIR = $config
        foreach ($name in @('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN')) {
          [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        }
        $previousPreference = $ErrorActionPreference
        try {
          $ErrorActionPreference = 'Continue'
          & $claude auth status *> $null
          $loginExit = $LASTEXITCODE
        } finally {
          $ErrorActionPreference = $previousPreference
        }

        $credentialSha = (Get-FileHash -LiteralPath $credentialPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $canRefresh = $identityMatched -and $subscriptionMatched -and $tierMatched -and $scopesMatched -and
          $expiryValid -and [int]$loginExit -eq 0 -and $credentialSha -cmatch '^[0-9a-f]{64}$'
        if ($canRefresh) {
          $marker = [ordered]@{
            schema = 1
            account = $ExpectedAccount
            credential_sha256 = $credentialSha
            created_at_utc = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
            identity_method = 'verified_session_binding_refresh'
          }
          $temporary = $bindingPath + '.tmp'
          [IO.File]::WriteAllText($temporary, ($marker | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
          Move-Item -LiteralPath $temporary -Destination $bindingPath -Force
        }

        [ordered]@{
          binding_refreshed       = [bool]$canRefresh
          identity_matched        = [bool]$identityMatched
          subscription_matched    = [bool]$subscriptionMatched
          tier_matched            = [bool]$tierMatched
          required_scopes_present = [bool]$scopesMatched
          expiry_valid            = [bool]$expiryValid
          login_status_exit_code  = [int]$loginExit
          credential_sha256       = $credentialSha
        }
      }
    }

    # 2026-09-29 (canary attempt 1 on 8869d9c2, Amendment A6): read-only guest disk
    # inventory. Closed enum, no caller-supplied path anywhere -- every location it reports
    # on is a fixed literal already established elsewhere in this contract (private_root's
    # own C:\Evidence1Private convention, the canonical toolchain/harness/seed paths every
    # other bundle in this file already hardcodes). Never deletes anything; the cleanup
    # bundle (run-agentic-eval-disk-cleanup) is separate and requires its own explicit
    # allowlist and approval.
    'inventory-guest-disk-usage' = [ordered]@{
      description     = 'Read-only: guest C: free/total, per-campaign C:\Evidence1Private sizes, %TEMP% usage (with harness-prefixed dirs broken out), the compact per-session Gradle seed copies under C:\E1G, and the canonical harness checkout / source template / Gradle seed sizes.'
      argument_schema = [ordered]@{}
      result_keys      = @(
        'c_drive_free_bytes', 'c_drive_total_bytes', 'private_roots',
        'temp_total_bytes', 'temp_harness_prefixed_count', 'temp_harness_prefixed_bytes',
        'compact_gradle_seed_copies_count', 'compact_gradle_seed_copies_bytes',
        'harness_checkout_bytes', 'source_template_bytes', 'canonical_gradle_seed_bytes'
      )
      scriptblock       = {
        $ErrorActionPreference = 'Stop'
        function Get-E1GuestDiskInventoryDirectoryBytes([string]$Path) {
          if (-not (Test-Path -LiteralPath $Path)) { return 0 }
          $sum = 0
          Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction SilentlyContinue |
            ForEach-Object { $sum += $_.Length }
          return [int64]$sum
        }
        $drive = Get-PSDrive -Name 'C'
        $privateRoots = @()
        $evidence1PrivateRoot = 'C:\Evidence1Private'
        if (Test-Path -LiteralPath $evidence1PrivateRoot) {
          foreach ($modeDir in @(Get-ChildItem -LiteralPath $evidence1PrivateRoot -Directory -Force -ErrorAction SilentlyContinue)) {
            foreach ($campaignDir in @(Get-ChildItem -LiteralPath $modeDir.FullName -Directory -Force -ErrorAction SilentlyContinue)) {
              $privateRoots += [ordered]@{
                mode        = [string]$modeDir.Name
                campaign_id = [string]$campaignDir.Name
                bytes       = Get-E1GuestDiskInventoryDirectoryBytes $campaignDir.FullName
              }
            }
          }
        }
        $tempRoot = [string]$env:TEMP
        $harnessPrefixedDirs = @(Get-ChildItem -LiteralPath $tempRoot -Directory -Force -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -like 'kmp-agentic-eval-*' })
        $harnessPrefixedBytes = 0
        foreach ($d in $harnessPrefixedDirs) { $harnessPrefixedBytes += Get-E1GuestDiskInventoryDirectoryBytes $d.FullName }
        $compactSeedRoot = 'C:\E1G'
        $compactSeedDirs = @(Get-ChildItem -LiteralPath $compactSeedRoot -Directory -Force -ErrorAction SilentlyContinue)
        $compactSeedBytes = 0
        foreach ($d in $compactSeedDirs) { $compactSeedBytes += Get-E1GuestDiskInventoryDirectoryBytes $d.FullName }
        [ordered]@{
          c_drive_free_bytes                = [int64]$drive.Free
          c_drive_total_bytes               = [int64]($drive.Used + $drive.Free)
          private_roots                      = $privateRoots
          temp_total_bytes                   = Get-E1GuestDiskInventoryDirectoryBytes $tempRoot
          temp_harness_prefixed_count        = [int]$harnessPrefixedDirs.Count
          temp_harness_prefixed_bytes        = [int64]$harnessPrefixedBytes
          compact_gradle_seed_copies_count   = [int]$compactSeedDirs.Count
          compact_gradle_seed_copies_bytes   = [int64]$compactSeedBytes
          harness_checkout_bytes             = Get-E1GuestDiskInventoryDirectoryBytes 'C:\kmp-eval\agentic-evidence2-harness-checkout-v1'
          source_template_bytes              = Get-E1GuestDiskInventoryDirectoryBytes 'C:\kmp-eval\NowInAndroid-evidence1-coverage-threshold-windows-stageb-v1'
          canonical_gradle_seed_bytes        = Get-E1GuestDiskInventoryDirectoryBytes (Join-Path $env:USERPROFILE '.gradle')
        }
      }
    }

    # 2026-09-29 (canary attempt 1 on 8869d9c2, Amendment A6): delete-only, closed-enum cleanup.
    # Every argument is validated against a fixed-root, no-traversal pattern -- PrivateRootRelativePaths
    # can only ever resolve under C:\Evidence1Private, TempDirNames only under the guest user's own
    # %TEMP% and only with the kmp-agentic-eval- prefix this contract's own temp-resource convention
    # already uses, CompactSeedNames only under C:\E1G. None of the three can ever traverse ('..') or
    # reference an absolute path -- each is a single path SEGMENT, not a path. The canonical Gradle
    # seed, the current harness checkout, the source template, the toolchain, and provider auth state
    # are structurally unreachable from any of the three roots this bundle touches. Long-path-safe
    # delete (Remove-E1GuestBundleLongPathTree's own pattern, copied per this file's established
    # independently-self-contained-bundle discipline). A per-item failure is caught and reported, never
    # aborts the remaining items.
    # The first draft's
    # PrivateRootRelativePaths pattern allowed '.'/'..' inside the second segment (it was in the
    # allowed character class), so 'eval-v2-gate\..' validated and Join-Path/GetFullPath would
    # have resolved it to C:\Evidence1Private itself -- deleting every campaign root, including
    # any live evidence never copied to the host. Fixed with two independent layers, neither
    # trusting the other: (1) the regex below now excludes '.' from every segment outright (none
    # of this bundle's real names ever need one, so this is simpler than a narrower '..'-only
    # exclusion and strictly safer); (2) the scriptblock re-validates every resolved path via
    # Assert-E1CleanupPathConfined -- GetFullPath, a strict "starts with root\firstSegment\" AND
    # "not equal to root\firstSegment" check, plus a hard refusal if the resolved path equals or
    # is an ancestor/descendant of the canonical Gradle seed, the current harness checkout, the
    # source template, or C:\Evidence1Toolchain. A caller mistake in the request cannot reach
    # rmSync without passing both.
    # After four per-shape transport patch rounds (a sign that "the
    # abstraction is the defect"): list arguments are now JSON-encoded STRINGS, not arrays.
    # Strings survive the broker's own JSON round trip byte-for-byte (proven all session by
    # raw_envelope_json, this file's OWN pre-existing large-string-over-the-same-transport
    # precedent) -- the entire array-collapse bug CLASS (PSCustomObject-vs-Hashtable container,
    # empty array to $null, empty array to empty dictionary, one-element array to a bare scalar,
    # all four confirmed live, not hypothetical) applies only to PowerShell's own array/collection
    # types crossing that boundary, never to a string.
    #
    # 2026-09-29 (root cause isolated after the foreach-loop rewrite below alone did not fix a
    # residual PS 5.1-only failure): parsing must NOT wrap the ConvertFrom-Json CALL directly in
    # `@(...)` as one statement. `@(ConvertFrom-Json '[]')` is a ONE-element array in Windows
    # PowerShell 5.1 (containing the empty array as its sole element), not @() -- confirmed by an
    # 8-way side-by-side matrix (literal vs variable input, top-level vs scriptblock invocation,
    # with/without $ErrorActionPreference='Stop', with/without Set-StrictMode all held constant):
    # only the one-statement-vs-two-statement wrapping changed the result. Assigning the raw
    # ConvertFrom-Json result to a variable FIRST, then wrapping THAT variable with `@()` on a
    # separate statement, is correct in every case (0/1/N elements) because `@()` around an
    # already-materialized array does not add another layer, while `@()` around the live cmdlet
    # call captures its single non-enumerated output object as one array element. Every parse
    # site below (three validators, three scriptblock-body assignments) uses the two-statement
    # form for this reason -- a single-statement `@(ConvertFrom-Json $x)` must never be
    # reintroduced here.
    'run-agentic-eval-disk-cleanup' = [ordered]@{
      description     = 'Delete-only, closed-enum guest disk cleanup of named private-root/temp/compact-seed leaf paths, each argument a JSON-encoded array of path segments.'
      argument_schema = [ordered]@{
        # Each validated by parsing then checking every element via an explicit foreach, never a
        # pipe (a piped "$parsed | Where-Object {...}" has its own separate collapse history this
        # session -- see the empty-array-to-$null note on Get-E1GuestBundleArgumentValue above).
        # ConvertFrom-Json's result is assigned to a plain variable FIRST, then wrapped with
        # `@()` on its own, separate statement -- never `@(ConvertFrom-Json $v)` as one statement,
        # which is a ONE-element array (not @()) for the empty-JSON-array case specifically in
        # Windows PowerShell 5.1 (root cause isolated and recorded above this bundle's
        # description). Malformed JSON or a non-array top level fails closed (caught, returns
        # $false) rather than throwing out of the validator itself. No '.' anywhere in any segment
        # (stricter than, and supersedes, a narrower '..'-only exclusion -- none of this bundle's
        # real names ever need one).
        PrivateRootRelativePathsJson = { param($v)
          if ($v -isnot [string]) { return $false }
          try { $parsedRaw = ConvertFrom-Json $v } catch { return $false }
          $parsed = @($parsedRaw)
          foreach ($item in $parsed) { if ([string]$item -notmatch '^[A-Za-z0-9_-]+\\[A-Za-z0-9_-]+$') { return $false } }
          return $true }
        TempDirNamesJson             = { param($v)
          if ($v -isnot [string]) { return $false }
          try { $parsedRaw = ConvertFrom-Json $v } catch { return $false }
          $parsed = @($parsedRaw)
          foreach ($item in $parsed) { if ([string]$item -notmatch '^kmp-agentic-eval-[A-Za-z0-9_-]+$') { return $false } }
          return $true }
        CompactSeedNamesJson         = { param($v)
          if ($v -isnot [string]) { return $false }
          try { $parsedRaw = ConvertFrom-Json $v } catch { return $false }
          $parsed = @($parsedRaw)
          foreach ($item in $parsed) { if ([string]$item -notmatch '^[A-Za-z0-9]+$') { return $false } }
          return $true }
      }
      result_keys      = @(
        'private_roots_deleted', 'private_roots_failed', 'temp_dirs_deleted', 'temp_dirs_failed',
        'compact_seeds_deleted', 'compact_seeds_failed', 'c_drive_free_bytes_before', 'c_drive_free_bytes_after'
      )
      scriptblock       = {
        param($PrivateRootRelativePathsJson, $TempDirNamesJson, $CompactSeedNamesJson)
        $ErrorActionPreference = 'Stop'
        # Two-statement parse -- see the root-cause note above this bundle's description. A
        # single-statement `@(ConvertFrom-Json $x)` silently turns an empty JSON array into a
        # one-element array (containing the empty array) in Windows PowerShell 5.1.
        $PrivateRootRelativePathsRaw = ConvertFrom-Json $PrivateRootRelativePathsJson
        $PrivateRootRelativePaths = @($PrivateRootRelativePathsRaw)
        $TempDirNamesRaw = ConvertFrom-Json $TempDirNamesJson
        $TempDirNames = @($TempDirNamesRaw)
        $CompactSeedNamesRaw = ConvertFrom-Json $CompactSeedNamesJson
        $CompactSeedNames = @($CompactSeedNamesRaw)
        # Second, independent layer -- never trusts the argument_schema regex above alone.
        # $Root\$FirstSegment is the confinement boundary: the resolved target must sit STRICTLY
        # inside it (a real descendant), never equal to it and never outside it. $FirstSegment is
        # $null for TempDirNames/CompactSeedNames (single-segment, confined directly to $Root).
        function Assert-E1CleanupPathConfined([string]$Root, [string]$FirstSegment, [string]$Candidate) {
          $resolvedRoot = ([IO.Path]::GetFullPath($Root)).TrimEnd('\')
          $boundary = if ($FirstSegment) { Join-Path $resolvedRoot $FirstSegment } else { $resolvedRoot }
          $boundaryFull = ([IO.Path]::GetFullPath($boundary)).TrimEnd('\')
          $resolvedCandidate = [IO.Path]::GetFullPath($Candidate)
          if ($resolvedCandidate -ceq $boundaryFull) { throw "cleanup_target_equals_boundary: $resolvedCandidate" }
          if (-not $resolvedCandidate.StartsWith($boundaryFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "cleanup_target_outside_boundary: $resolvedCandidate"
          }
          $protectedRoots = @(
            ([IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.gradle'))).TrimEnd('\'),
            ([IO.Path]::GetFullPath('C:\kmp-eval\agentic-evidence2-harness-checkout-v1')).TrimEnd('\'),
            ([IO.Path]::GetFullPath('C:\kmp-eval\NowInAndroid-evidence1-coverage-threshold-windows-stageb-v1')).TrimEnd('\'),
            ([IO.Path]::GetFullPath('C:\Evidence1Toolchain')).TrimEnd('\')
          )
          foreach ($protected in $protectedRoots) {
            if ($resolvedCandidate -ceq $protected -or
                $resolvedCandidate.StartsWith($protected + '\', [StringComparison]::OrdinalIgnoreCase) -or
                $protected.StartsWith($resolvedCandidate + '\', [StringComparison]::OrdinalIgnoreCase)) {
              throw "cleanup_target_touches_protected_root: $resolvedCandidate"
            }
          }
          return $resolvedCandidate
        }
        # Root cause of a 100% delete failure, confirmed live:
        # the child node.exe process was launched with an EMPTY environment (@{}) -- no
        # SystemRoot/PATH/TEMP, which broke process startup itself, not the delete logic. Fixed
        # by inheriting this session's OWN already-correct basic environment instead of the
        # full Claude/Codex-oriented New-E1DualConditionCanaryRuntimeEnvironment (which requires
        # dot-sourcing evidence1-dual-condition-canary-launch.ps1 -InternalLibrary with
        # HarnessDir/SourceTemplateDir parameters this bundle has no other reason to take --
        # this delete-only operation needs a process that can start and touch the filesystem,
        # nothing Claude/Codex/Gradle-specific).
        function Get-E1CleanupChildEnvironment {
          $env2 = @{}
          foreach ($name in @('SystemRoot', 'Path', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'ProgramData')) {
            $value = [Environment]::GetEnvironmentVariable($name)
            if (-not [string]::IsNullOrEmpty($value)) { $env2[$name] = $value }
          }
          return $env2
        }
        # 2026-09-29 (real-guest-dispatch root cause, found after the JSON-string fix's first
        # live run failed 120/120 with zero deletions): $script:E1InternalBoundedProcess is NOT an
        # ambient value every guest bundle gets for free -- confirmed live, is-null=True at this
        # bundle's own dispatch context. It is populated only by dot-sourcing
        # evidence1-dual-condition-canary-launch.ps1 -InternalLibrary (see that script's own
        # $script:E1InternalBoundedProcess assignment), which this bundle deliberately does not do
        # (it takes no HarnessDir/SourceTemplateDir and has no other reason to pull in that
        # script's full Claude/Codex/JDK/Android environment). Importing the sibling contract
        # module directly and taking its exported Invoke-E1BoundedProcess scriptblock is the same
        # three lines that dot-source performs internally, without any of the rest of it. The
        # harness-checkout root is the same fixed guest literal inventory-guest-disk-usage already
        # hardcodes (harness_checkout_bytes), not a parameter -- this bundle has none to take.
        function Get-E1CleanupBoundedProcess {
          $modulePath = 'C:\kmp-eval\agentic-evidence2-harness-checkout-v1\docs\audits\evidence1-dual-condition-canary-contract.psm1'
          # Same guard run-agentic-eval-product-smoke already sets before its own dot-source of
          # the sibling launch script -- confirmed live: without it, Import-Module here throws
          # "running scripts is disabled on this system" (the guest's default restricted policy).
          Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
          $module = Import-Module -Name $modulePath -Force -DisableNameChecking -PassThru
          $boundedProcess = $module.ExportedCommands['Invoke-E1BoundedProcess'].ScriptBlock
          if ($null -eq $boundedProcess) { throw 'agentic_eval_cleanup_bounded_process_export_missing' }
          return $boundedProcess
        }
        function Remove-E1CleanupLongPathTree($BoundedProcess, [hashtable]$Environment, [string]$Path) {
          if (-not (Test-Path -LiteralPath $Path)) { return 0 }
          $node = 'C:\Evidence1Toolchain\node\24.19.0\node.exe'
          $script = 'const fs=require(''node:fs'');const targetPath=process.argv[1];let n=0;try{n=fs.readdirSync(targetPath).length}catch{n=0}fs.rmSync(targetPath,{recursive:true,force:true,maxRetries:3});process.stdout.write(String(n))'
          $deleteParameters = @{
            FileName = [string]$node
            Arguments = [string[]]@('-e', $script, $Path)
            WorkingDirectory = 'C:\Evidence1Private'
            EnvironmentVariables = $Environment
            TimeoutSeconds = [int]900
          }
          $delete = & $BoundedProcess @deleteParameters
          if ($delete.exit_code -ne 0 -or -not $delete.cleanup_ok) {
            throw "guest_long_path_delete_failed: $Path (exit_code=$($delete.exit_code) cleanup_ok=$($delete.cleanup_ok))"
          }
          $entriesRemoved = 0
          [void][int]::TryParse(([string]$delete.stdout).Trim(), [ref]$entriesRemoved)
          return $entriesRemoved
        }
        $childEnvironment = Get-E1CleanupChildEnvironment
        $boundedProcess = Get-E1CleanupBoundedProcess
        $freeBefore = [int64](Get-PSDrive -Name 'C').Free
        $privateDeleted = @(); $privateFailed = @()
        foreach ($rel in $PrivateRootRelativePaths) {
          try {
            $firstSegment = ([string]$rel).Split('\')[0]
            $full = Assert-E1CleanupPathConfined 'C:\Evidence1Private' $firstSegment (Join-Path 'C:\Evidence1Private' $rel)
            $null = Remove-E1CleanupLongPathTree $boundedProcess $childEnvironment $full
            $privateDeleted += $rel
          } catch { $privateFailed += $rel }
        }
        $tempDeleted = @(); $tempFailed = @()
        foreach ($name in $TempDirNames) {
          try {
            $full = Assert-E1CleanupPathConfined $env:TEMP $null (Join-Path $env:TEMP $name)
            $null = Remove-E1CleanupLongPathTree $boundedProcess $childEnvironment $full
            $tempDeleted += $name
          } catch { $tempFailed += $name }
        }
        $seedDeleted = @(); $seedFailed = @()
        foreach ($name in $CompactSeedNames) {
          try {
            $full = Assert-E1CleanupPathConfined 'C:\E1G' $null (Join-Path 'C:\E1G' $name)
            $null = Remove-E1CleanupLongPathTree $boundedProcess $childEnvironment $full
            $seedDeleted += $name
          } catch { $seedFailed += $name }
        }
        $freeAfter = [int64](Get-PSDrive -Name 'C').Free
        [ordered]@{
          private_roots_deleted     = @($privateDeleted)
          private_roots_failed      = @($privateFailed)
          temp_dirs_deleted         = @($tempDeleted)
          temp_dirs_failed          = @($tempFailed)
          compact_seeds_deleted     = @($seedDeleted)
          compact_seeds_failed      = @($seedFailed)
          c_drive_free_bytes_before = $freeBefore
          c_drive_free_bytes_after  = $freeAfter
        }
      }
    }

    # Provider-free functional gate for the exact product path exercised by the
    # campaign's scenario.  This deliberately runs the real CLI against a
    # disposable clone while invoking neither Claude nor Codex.  ScenarioId
    # selects the smoke: coverage-threshold-failure-v2 runs the canonical
    # coverage command and asserts its envelope (unchanged); a scenario of family
    # multi-module-tests gets its patch applied to the clone, runs the kmp-test
    # arguments its ground-truth file names, and asserts the failing modules, test
    # classes and failing-test count against that ground truth.  Any other scenario
    # is refused (smoke_scenario_unsupported).
    'run-agentic-eval-product-smoke' = [ordered]@{
      description     = 'Execute the scenario''s canonical kmp-test command in a disposable guest clone without starting a provider.'
      argument_schema = [ordered]@{
        HarnessDir = { param($v) $v -is [string] -and $v -cmatch '^[A-Za-z]:\\' }
        SourceTemplateDir = { param($v) $v -is [string] -and $v -cmatch '^[A-Za-z]:\\' }
        SmokeRoot = { param($v) $v -is [string] -and $v -cmatch '^C:\\Evidence1Private\\' }
        # A stale guest harness checkout can pass this
        # smoke's own semantic check while measuring the WRONG product tree entirely -- caught
        # live via a real envelope reporting version:"0.15.0" against an expected 0.16.0. These
        # five expected values all trace to ONE source of truth (the caller's own already-
        # resolved target commit, e.g. evidence1-run.ps1's ToolchainReady receipt) -- never a
        # second, independently-hardcoded "expected version" string anywhere in this file.
        ExpectedProductCommit = { param($v) $v -is [string] -and $v -cmatch '^[0-9a-f]{40}$' }
        ExpectedProductVersion = { param($v) $v -is [string] -and $v -cmatch '^\d+\.\d+\.\d+$' }
        ExpectedLibTreeHash = { param($v) $v -is [string] -and $v -cmatch '^[0-9a-f]{40}$' }
        ExpectedBinTreeHash = { param($v) $v -is [string] -and $v -cmatch '^[0-9a-f]{40}$' }
        ExpectedSkillsTreeHash = { param($v) $v -is [string] -and $v -cmatch '^[0-9a-f]{40}$' }
        ExpectedSourceCommit = { param($v) $v -is [string] -and $v -cmatch '^[0-9a-f]{40}$' }
        # The manifest's scenario_id: a bare kebab-case corpus id, the same shape cli.mjs accepts for --scenario.
        # Whether the bundle supports it is decided in the guest from the scenario's own files, never here.
        ScenarioId = { param($v) $v -is [string] -and $v -cmatch '^[a-z0-9-]+$' }
      }
      result_keys = @('verdict', 'reason_code', 'exit_code', 'error_codes', 'tests_total', 'tests_passed', 'coverage_missed_lines', 'individual_total', 'inference_sessions_consumed', 'raw_envelope_json', 'stdout_tail', 'stderr_tail', 'exception_type', 'exception_message', 'exception_stack_trace', 'long_path_delete_entries_removed', 'product_identity_verified', 'product_identity_mismatches', 'observed_product_commit', 'observed_product_version', 'observed_lib_tree_hash', 'observed_bin_tree_hash', 'observed_skills_tree_hash', 'identity_diagnostics', 'source_identity_verified', 'observed_source_commit', 'observed_source_tree', 'expected_source_tree', 'gradle_memory_override_sha256', 'no_gradle_daemon_survived', 'kmp_test_duration_ms')
      # What a multi-module-tests scenario's smoke observed in the envelope; the coverage smoke never returns them.
      optional_result_keys = @('observed_failing_modules', 'observed_failed_test_classes', 'observed_failed_count')
      scriptblock = {
        param($HarnessDir, $SourceTemplateDir, $SmokeRoot, $ExpectedProductCommit, $ExpectedProductVersion, $ExpectedLibTreeHash, $ExpectedBinTreeHash, $ExpectedSkillsTreeHash, $ExpectedSourceCommit, $ScenarioId)

        # Diagnosability: a semantic mismatch previously left only the six
        # summary fields above -- no way to see WHAT kmp-test actually printed without a separate,
        # ad hoc guest probe. Bounded, not raw: last 200 lines each of stdout/stderr, matching this
        # module's own established length-cap discipline (Get-E1GuestBundleSanitizedErrorText,
        # evidence1-guest-bundle-hyperv.psm1) scaled to a line count generous enough to show a full
        # Gradle error block (e.g. "Cannot locate tasks that match...") rather than one collapsed line.
        #
        # raw_envelope_json is the trimmed stdout TEXT, never a parsed object (a finding
        # verified against Invoke-E1GuestBundle's own contract.psm1:767/845 ConvertTo-Json -Depth
        # 5): a parsed $report object crosses PS-remoting serialization and then this module's own
        # -Depth 5 re-encoding, and a real kmp-test envelope nests past that (e.g.
        # execution.legs[0].execution.* sits at depth >=6), silently flattening those nodes into
        # opaque strings. A plain string carries no such depth and survives both hops byte-identical
        # -- see Evidence1-Guest-Bundle-Contract.Tests.ps1's own round-trip regression test. Bounded
        # to 256 KiB with an explicit truncation marker, matching the stdout_tail/stderr_tail
        # bounding discipline above rather than an unbounded dump.
        function Get-E1GuestBundleTailLines([string]$Text, [int]$MaxLines = 200) {
          if ([string]::IsNullOrEmpty($Text)) { return @() }
          $lines = $Text -split '\r?\n'
          if ($lines.Count -le $MaxLines) { return $lines }
          return $lines[-$MaxLines..-1]
        }

        # Proven live: PowerShell 5.1's own
        # Remove-Item -Recurse -Force hits .NET's classic MAX_PATH (260 chars) on a leftover
        # Gradle typesafe-project-accessor tree (deep under
        # gradle-home\caches\<ver>\dependencies-accessors\<hash>\classes\org\gradle\accessors\dm\...)
        # -- a prior SUCCESSFUL smoke run generates that tree, and the next run's own pre-clean
        # then throws "Could not find a part of the path '...'" trying to delete it. Node's
        # fs.rmSync has no such limit -- the same reason the seed COPY a few lines below (already
        # Node's cpSync) never hit this. Routed through the same bounded-process helper and guest
        # node binary every other file operation here already uses, not a second mechanism.
        # Reports the top-level entry count it removed, not a bare "it worked" -- NOT a deepest
        # path length: the first live attempt against this fix's own real leftover tree timed
        # out the whole bundle, because computing that figure needed a full
        # second recursive readdirSync traversal of the tree before the delete even started.
        # One readdirSync on the root is a cheap, still-useful signal in its place.
        function Remove-E1GuestBundleLongPathTree($BoundedProcess, [hashtable]$Environment, [string]$Path) {
          if (-not (Test-Path -LiteralPath $Path)) { return 0 }
          $node = 'C:\Evidence1Toolchain\node\24.19.0\node.exe'
          # Single-quoted PS string -- no interpolation, no backslash-escaping games -- the path
          # itself travels as a separate argv element, never concatenated into this source text.
          # nodePath.join (not manual '\\' concatenation) for the same reason: correct on this
          # platform without a second place to get backslash-escaping wrong.
          $script = 'const fs=require(''node:fs'');const targetPath=process.argv[1];let n=0;try{n=fs.readdirSync(targetPath).length}catch{n=0}fs.rmSync(targetPath,{recursive:true,force:true,maxRetries:3});process.stdout.write(String(n))'
          $deleteParameters = @{
            FileName = [string]$node
            Arguments = [string[]]@('-e', $script, $Path)
            WorkingDirectory = 'C:\Evidence1Private'
            EnvironmentVariables = $Environment
            TimeoutSeconds = [int]900
          }
          $delete = & $BoundedProcess @deleteParameters
          if ($delete.exit_code -ne 0 -or -not $delete.cleanup_ok) {
            # 2026-09-29 (found live, first standalone smoke run against this fix): a bare path
            # in the throw message gave no way to tell WHY the delete itself failed (timeout on
            # a large tree during the walk(), a real node error, cleanup_ok false for an
            # unrelated reason) without a second diagnostic round. Bounded stdout/stderr fixes
            # that the same way this module bounds every other guest-side error text.
            $deleteStdout = ([string]$delete.stdout)
            if ($deleteStdout.Length -gt 1000) { $deleteStdout = $deleteStdout.Substring(0, 1000) + '...(truncated)' }
            $deleteStderr = ([string]$delete.stderr)
            if ($deleteStderr.Length -gt 1000) { $deleteStderr = $deleteStderr.Substring(0, 1000) + '...(truncated)' }
            throw "guest_long_path_delete_failed: $Path (exit_code=$($delete.exit_code) cleanup_ok=$($delete.cleanup_ok) stdout=$deleteStdout stderr=$deleteStderr)"
          }
          $entriesRemoved = 0
          [void][int]::TryParse(([string]$delete.stdout).Trim(), [ref]$entriesRemoved)
          return $entriesRemoved
        }

        # Evidence3, scenario-driven smoke. Which smoke a scenario id gets, decided from the scenario's own
        # files in the harness checkout: coverage-threshold-failure-v2 (the scenario this smoke was written for)
        # needs no file; a scenario of family multi-module-tests is described by its scenario file (the patch
        # it applies), its ground-truth file (what must fail) and that file's smoke block (the kmp-test
        # arguments). Everything else, and any file that is missing, malformed or incomplete, is unsupported.
        # Never throws: the caller turns "unsupported" into smoke_scenario_unsupported before any guest work.
        function Resolve-E1SmokeScenario([string]$HarnessDir, [string]$ScenarioId) {
          $unsupported = [ordered]@{ supported = $false }
          if ($ScenarioId -ceq 'coverage-threshold-failure-v2') { return [ordered]@{ supported = $true; mode = 'coverage-v2' } }
          try {
            if ($ScenarioId -cnotmatch '^[a-z0-9-]+$') { return $unsupported }
            $corpus = Join-Path $HarnessDir 'tools\agentic-eval\corpus'
            $scenarioPath = Join-Path $corpus "scenarios\$ScenarioId.json"
            $truthPath = Join-Path $corpus "expected\$ScenarioId.json"
            if (-not (Test-Path -LiteralPath $scenarioPath -PathType Leaf) -or -not (Test-Path -LiteralPath $truthPath -PathType Leaf)) { return $unsupported }
            $scenario = [IO.File]::ReadAllText($scenarioPath) | ConvertFrom-Json
            $truth = [IO.File]::ReadAllText($truthPath) | ConvertFrom-Json
            $family = [string]$scenario.family
            $nextFamilies = @('multi-module-coverage', 'changed-dependents', 'compile-failure')
            if (($family -cne 'multi-module-tests' -and $family -cnotin $nextFamilies) -or $scenario.id -cne $ScenarioId) { return $unsupported }
            $fixture = if ($null -ne $scenario.PSObject.Properties['fixture_setup']) { $scenario.fixture_setup } else { $null }
            $paths = @()
            if ($family -cne 'multi-module-coverage') {
              if ($family -ceq 'changed-dependents' -and $fixture.operation -cne 'commit_patch') { return $unsupported }
              if ($family -cne 'changed-dependents' -and $fixture.operation -cne 'apply_patch') { return $unsupported }
              if ([string]$fixture.patch_file -cnotmatch '^[a-z0-9-]+\.patch$') { return $unsupported }
              $paths = @($fixture.expected_paths | ForEach-Object { [string]$_ })
              if ($paths.Count -eq 0 -or @($paths | Where-Object { $_ -cnotmatch '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$' -or $_ -cmatch '(^|/)\.\.?(/|$)' }).Count -ne 0) { return $unsupported }
              if ($family -ceq 'changed-dependents' -and [string]$fixture.expected_parent -cne [string]$scenario.project_commit) { return $unsupported }
            }
            $expected = $truth.expected
            $outcomeKind = [string]$expected.outcome_kind
            if ($family -ceq 'multi-module-tests') {
              $failingModules = @($expected.failing_modules | ForEach-Object { [string]$_ })
              $failedClasses = @($expected.failed_test_classes | ForEach-Object { [string]$_ })
              if ($outcomeKind -ceq 'tests_failed') {
                if ($failingModules.Count -eq 0 -or $failedClasses.Count -eq 0) { return $unsupported }
              } elseif ($outcomeKind -ceq 'tests_passed') {
                if ($failingModules.Count -ne 0 -or $failedClasses.Count -ne 0) { return $unsupported }
              } else { return $unsupported }
              if ($expected.failed_count -isnot [int] -and $expected.failed_count -isnot [long]) { return $unsupported }
            }
            $kmpTestArguments = @($truth.smoke.kmp_test_args | ForEach-Object { [string]$_ })
            if ($kmpTestArguments.Count -eq 0 -or @($kmpTestArguments | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -ne 0) { return $unsupported }
            return [ordered]@{
              supported = $true
              mode = $family
              patch_file = $(if ($family -ceq 'multi-module-coverage') { $null } else { [string]$fixture.patch_file })
              expected_paths = @($paths)
              kmp_test_args = @($kmpTestArguments)
              expected = $expected
            }
          } catch { return $unsupported }
        }

        # What a kmp-test envelope says failed, in the terms the multi-module-tests ground truth uses: the Gradle
        # paths of the modules that have failing tests (the envelope names a module with or without its leading
        # colon), the simple names of the classes of those tests, and the number of distinct failing tests. A test
        # is "<fully qualified class>.<method>", the method possibly followed by a bracketed parameter label that
        # may itself contain dots; a name with no class part counts as a failing test and names no class. Sets are
        # ordinal and sorted, so a receipt is stable. Never throws: no usable report is an empty observation.
        function Get-E1SmokeMultiModuleObservation($Report) {
          $modules = New-Object 'System.Collections.Generic.SortedSet[string]' ([StringComparer]::Ordinal)
          $classes = New-Object 'System.Collections.Generic.SortedSet[string]' ([StringComparer]::Ordinal)
          $tests = New-Object 'System.Collections.Generic.SortedSet[string]' ([StringComparer]::Ordinal)
          if ($null -ne $Report -and $null -ne $Report.PSObject.Properties['modules']) {
            foreach ($module in @($Report.modules)) {
              if ($null -eq $module -or $null -eq $module.PSObject.Properties['test_failures']) { continue }
              $moduleTests = @()
              foreach ($failure in @($module.test_failures)) {
                if ($null -eq $failure -or $null -eq $failure.PSObject.Properties['test']) { continue }
                $test = [string]$failure.test
                if (-not [string]::IsNullOrWhiteSpace($test)) { $moduleTests += $test }
              }
              if ($moduleTests.Count -eq 0 -or $null -eq $module.PSObject.Properties['name']) { continue }
              $name = [string]$module.name
              [void]$modules.Add($(if ($name.StartsWith(':')) { $name } else { ':' + $name }))
              foreach ($test in $moduleTests) {
                [void]$tests.Add($test)
                $head = $test
                $bracket = $head.IndexOf('[')
                if ($bracket -ge 0) { $head = $head.Substring(0, $bracket) }
                $methodDot = $head.LastIndexOf('.')
                if ($methodDot -lt 1) { continue }
                $classPart = $head.Substring(0, $methodDot)
                [void]$classes.Add($classPart.Substring($classPart.LastIndexOf('.') + 1))
              }
            }
          }
          return [ordered]@{
            failing_modules = @($modules)
            failed_test_classes = @($classes)
            failed_count = [int]$tests.Count
          }
        }

        # The ground-truth comparison: the failing modules and test classes as ordinal sets (exact case, any
        # order) and the failing-test count as an integer.
        function Test-E1SmokeMultiModuleMatches($Observation, $Expected) {
          $setKey = {
            param($Values)
            $set = New-Object 'System.Collections.Generic.SortedSet[string]' ([StringComparer]::Ordinal)
            foreach ($value in @($Values)) { if ($null -ne $value) { [void]$set.Add([string]$value) } }
            return [string]::Join("`n", $set)
          }
          return ((& $setKey $Observation.failing_modules) -ceq (& $setKey $Expected.failing_modules)) -and
            ((& $setKey $Observation.failed_test_classes) -ceq (& $setKey $Expected.failed_test_classes)) -and
            ([int]$Observation.failed_count -eq [int]$Expected.failed_count)
        }

        # `git status --porcelain` after the scenario's patch: exactly one unstaged modification (" M <path>") for
        # each expected path and nothing else, the same postcondition the harness checks after apply_patch.
        function Test-E1SmokePatchPostcondition([string]$PorcelainOutput, [string[]]$ExpectedPaths) {
          $lines = @(($PorcelainOutput -split "`r?`n") | Where-Object { $_.Length -gt 0 })
          if ($ExpectedPaths.Count -eq 0 -or $lines.Count -ne $ExpectedPaths.Count) { return $false }
          $got = New-Object 'System.Collections.Generic.SortedSet[string]' ([StringComparer]::Ordinal)
          foreach ($line in $lines) {
            if (-not $line.StartsWith(' M ', [StringComparison]::Ordinal)) { return $false }
            [void]$got.Add($line.Substring(3))
          }
          $want = New-Object 'System.Collections.Generic.SortedSet[string]' ([StringComparer]::Ordinal)
          foreach ($path in $ExpectedPaths) { [void]$want.Add($path) }
          return ($got.Count -eq $ExpectedPaths.Count) -and ([string]::Join("`n", $got) -ceq [string]::Join("`n", $want))
        }

        Set-StrictMode -Version Latest
        $ErrorActionPreference = 'Stop'

        # An uncaught exception anywhere in the body below
        # (e.g. the long-path delete itself failing for an unrelated reason) previously bubbled
        # all the way to the host's own Receive-Job catch, wrapped generically as
        # "guest_bundle_failed: <raw .NET message>" -- no exception type, no stack trace, no way
        # to tell which line failed without a fresh diagnostic round. Wrapping the whole body
        # means a future failure names its own line directly in this receipt.
        try {
          $observedProductCommit = $null
          $observedProductVersion = $null
          $observedLibTreeHash = $null
          $observedBinTreeHash = $null
          $observedSkillsTreeHash = $null
          $identityMismatches = @()
          $sourceIdentityVerified = $false
          $observedSourceCommit = $null
          $observedSourceTree = $null
          $expectedSourceTree = $null
          $gradleMemoryOverrideSha256 = $null
          $noGradleDaemonSurvived = $false
          $kmpTestDurationMs = $null

          # Which smoke this scenario gets, decided before any guest work (no clone, no seed, no process) from the
          # scenario's own files; anything this bundle cannot run is refused here, with the full result shape.
          $smokeScenario = Resolve-E1SmokeScenario $HarnessDir $ScenarioId
          if (-not $smokeScenario.supported) {
            return [ordered]@{
              verdict = 'FAIL'
              reason_code = 'smoke_scenario_unsupported'
              exit_code = $null
              error_codes = @()
              tests_total = 0
              tests_passed = 0
              coverage_missed_lines = 0
              individual_total = 0
              inference_sessions_consumed = 0
              raw_envelope_json = $null
              stdout_tail = @()
              stderr_tail = @()
              exception_type = $null
              exception_message = $null
              exception_stack_trace = $null
              long_path_delete_entries_removed = $null
              product_identity_verified = $false
              product_identity_mismatches = @()
              observed_product_commit = $null
              observed_product_version = $null
              observed_lib_tree_hash = $null
              observed_bin_tree_hash = $null
              observed_skills_tree_hash = $null
              identity_diagnostics = $null
              source_identity_verified = $false
              observed_source_commit = $null
              observed_source_tree = $null
              expected_source_tree = $null
              gradle_memory_override_sha256 = $null
              no_gradle_daemon_survived = $false
              kmp_test_duration_ms = $null
            }
          }
          $isMultiModule = ($smokeScenario.mode -ceq 'multi-module-tests')
          $isNextMilestone = @('multi-module-coverage', 'changed-dependents', 'compile-failure') -ccontains $smokeScenario.mode
          $hasScenarioPatch = $isMultiModule -or @('changed-dependents', 'compile-failure') -ccontains $smokeScenario.mode

          $worker = Join-Path $HarnessDir 'docs\audits\evidence1-dual-condition-canary-launch.ps1'
          if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) { throw 'product_smoke_worker_missing' }
          Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
          # Root cause, proven live: dot-sourcing binds the
          # WORKER's own param() block in THIS caller's scope. The worker declares
          # $HarnessDir/$SourceTemplateDir with its OWN Evidence1 stage-B defaults,
          # so an unqualified ". $worker -InternalLibrary" silently resets both
          # variables here to those defaults -- confirmed live: this bundle's own
          # identity check (below) observed HEAD 2c177c0 (the Evidence1 fixture)
          # 80s after ToolchainReady had verified ee6d82b in the same guest
          # directory. The directory never changed; the variable did. Passing the
          # current values back in makes the rebind a no-op instead of a silent
          # reset -- see Evidence1-Guest-Bundle-Contract.Tests.ps1's AST guard,
          # which fails closed on any FUTURE dot-source of this worker that omits
          # an overlapping name.
          . $worker -InternalLibrary -HarnessDir $HarnessDir -SourceTemplateDir $SourceTemplateDir

          $environment = New-E1DualConditionCanaryRuntimeEnvironment
          $git = 'C:\Evidence1Toolchain\git\2.55.0.windows.5\cmd\git.exe'
          $node = 'C:\Evidence1Toolchain\node\24.19.0\node.exe'
          $cli = Join-Path $HarnessDir 'bin\kmp-test.js'

          # A checkout git-verified correct at sync
          # time (evidence1-hyperv-update-harness-from-bundle.ps1's own HEAD/tree hard
          # check, guest-side) has already been observed, live, to still run a stale
          # kmp-test moments later (envelope version 0.15.0 against an expected/
          # checked-out 0.16.0) -- root cause not yet isolated. Re-verifying here,
          # before paying for pre-clean/seed/clone, catches a checkout that regressed
          # or never matched what ToolchainReady's receipt claims; it will NOT by
          # itself catch the specific anomaly above (that checkout was already
          # git-correct) -- the late version check below (after kmp-test's own
          # envelope is parsed) is what actually catches that one. Both run
          # regardless, since each covers a different failure mode.
          if (Test-Path -LiteralPath $HarnessDir) {
            $observedProductCommit = ([string](& $git -C $HarnessDir rev-parse HEAD 2>$null)).Trim()
            $observedLibTreeHash = ([string](& $git -C $HarnessDir rev-parse 'HEAD:lib' 2>$null)).Trim()
            $observedBinTreeHash = ([string](& $git -C $HarnessDir rev-parse 'HEAD:bin' 2>$null)).Trim()
            $observedSkillsTreeHash = ([string](& $git -C $HarnessDir rev-parse 'HEAD:.skills' 2>$null)).Trim()
          }
          if ($observedProductCommit -cne $ExpectedProductCommit) { $identityMismatches += "commit: expected $ExpectedProductCommit, observed '$observedProductCommit'" }
          if ($observedLibTreeHash -cne $ExpectedLibTreeHash) { $identityMismatches += "lib tree: expected $ExpectedLibTreeHash, observed '$observedLibTreeHash'" }
          if ($observedBinTreeHash -cne $ExpectedBinTreeHash) { $identityMismatches += "bin tree: expected $ExpectedBinTreeHash, observed '$observedBinTreeHash'" }
          if ($observedSkillsTreeHash -cne $ExpectedSkillsTreeHash) { $identityMismatches += "skills tree: expected $ExpectedSkillsTreeHash, observed '$observedSkillsTreeHash'" }
          if ($identityMismatches.Count -gt 0) {
            return [ordered]@{
              verdict = 'FAIL'
              reason_code = 'product_identity_mismatch'
              exit_code = $null
              error_codes = @()
              tests_total = 0
              tests_passed = 0
              coverage_missed_lines = 0
              individual_total = 0
              inference_sessions_consumed = 0
              raw_envelope_json = $null
              stdout_tail = @()
              stderr_tail = @()
              exception_type = $null
              exception_message = $null
              exception_stack_trace = $null
              long_path_delete_entries_removed = $null
              product_identity_verified = $false
              product_identity_mismatches = @($identityMismatches)
              observed_product_commit = $observedProductCommit
              observed_product_version = $null
              observed_lib_tree_hash = $observedLibTreeHash
              observed_bin_tree_hash = $observedBinTreeHash
              observed_skills_tree_hash = $observedSkillsTreeHash
              identity_diagnostics = $null
              source_identity_verified = $false
              observed_source_commit = $null
              observed_source_tree = $null
              expected_source_tree = $null
              gradle_memory_override_sha256 = $null
              no_gradle_daemon_survived = $false
              kmp_test_duration_ms = $null
            }
          }

          # This directory contains only provider-free disposable smoke state.
          # A failed/aborted DryRunPassed attempt must be resumable without a
          # manual guest cleanup step or a new campaign identity.
          $longPathDeleteMaxLength = Remove-E1GuestBundleLongPathTree $script:E1InternalBoundedProcess $environment $SmokeRoot
          # 2026-09-29 (canary attempt 1 on 8869d9c2, Amendment A6): checked AFTER the pre-clean
          # above (which can itself free real space) and BEFORE the clone/Gradle-home materialize
          # below (the actual space-consuming steps) -- never before the pre-clean, which would
          # reject a run the pre-clean's own reclaim could have made room for.
          $guestFreeBytes = [int64](Get-PSDrive -Name 'C').Free
          if ($guestFreeBytes -lt 32212254720) { throw "guest_disk_space_insufficient:$guestFreeBytes" }
          $null = New-Item -ItemType Directory -Path $SmokeRoot -Force
          $cloneRoot = Join-Path $SmokeRoot 'source'
          # A bare "product_smoke_input_missing" gave no
          # way to tell WHICH of five inputs was absent without a second diagnostic round --
          # confirmed live, on the first run after the dot-source fix: SourceTemplateDir turned out to be the
          # Evidence2 anchor fixture, never before actually exercised because the dot-source
          # bug had always silently substituted Evidence1's own (already-provisioned) one.
          $requiredSmokeInputs = [ordered]@{
            GitExecutable = $git
            NodeExecutable = $node
            KmpTestCli = $cli
            SourceTemplateDir = $SourceTemplateDir
            GradleUserHomeSeedDir = $script:E1GradleUserHomeSeedDir
          }
          foreach ($inputName in $requiredSmokeInputs.Keys) {
            if (-not (Test-Path -LiteralPath $requiredSmokeInputs[$inputName])) { throw "product_smoke_input_missing:$inputName" }
          }

          # The live harness never runs against the guest user's ambient Gradle
          # home. Reproduce its isolated seed copy here so this gate exercises
          # the same cold fixture/cache boundary instead of a warmed workspace.
          $gradleHome = Join-Path $SmokeRoot 'gradle-home'
          $seedCopyParameters = @{
            FileName = [string]$node
            Arguments = [string[]]@('-e', "require('node:fs').cpSync(process.argv[1],process.argv[2],{recursive:true})", $script:E1GradleUserHomeSeedDir, $gradleHome)
            WorkingDirectory = [string]$SmokeRoot
            EnvironmentVariables = [hashtable]$environment
            TimeoutSeconds = [int]300
          }
          $seedCopy = & $script:E1InternalBoundedProcess @seedCopyParameters
          if ($seedCopy.exit_code -ne 0 -or -not $seedCopy.cleanup_ok) { throw 'product_smoke_gradle_seed_copy_failed' }
          $environment.GRADLE_USER_HOME = $gradleHome
          # Amendment A5: NiA's own project-level
          # gradle.properties commits -Xms4g for the Gradle daemon PLUS -Xms4g for the Kotlin
          # daemon -- 8GB up front against this VM's fixed, non-dynamic 8GB RAM allocation
          # (confirmed: two live "Gradle build daemon disappeared unexpectedly" deaths).
          # GRADLE_USER_HOME-level properties take precedence over the project's own, so this
          # symmetric override applies without ever touching the checked-out project tree --
          # lower caps, no -Xms commitment. The certified seed itself is never written to; this
          # writes into the fresh per-run copy at $gradleHome only.
          $gradleMemoryOverridePath = Join-Path $gradleHome 'gradle.properties'
          # The seed copy
          # already carries its own gradle.properties (org.gradle.daemon=false +
          # org.gradle.java.installations.auto-download=false, written at warm time,
          # evidence1-hyperv-warm-canonical-gradle-cache-direct.ps1:41) -- a blind overwrite here
          # silently DROPPED both, the opposite of the goal (the daemon then stayed alive after
          # each build). Fail closed instead of silently dropping any key this canonical content
          # doesn't recognize.
          $gradleCanonicalPropertiesKeys = @('org.gradle.daemon', 'org.gradle.java.installations.auto-download', 'org.gradle.configuration-cache', 'org.gradle.jvmargs', 'kotlin.daemon.jvmargs')
          if (Test-Path -LiteralPath $gradleMemoryOverridePath -PathType Leaf) {
            foreach ($existingLine in (Get-Content -LiteralPath $gradleMemoryOverridePath)) {
              $trimmedExistingLine = $existingLine.Trim()
              if ($trimmedExistingLine -eq '' -or $trimmedExistingLine.StartsWith('#') -or $trimmedExistingLine.StartsWith('!')) { continue }
              $eqIndex = $trimmedExistingLine.IndexOf('=')
              $existingKey = $(if ($eqIndex -eq -1) { $trimmedExistingLine } else { $trimmedExistingLine.Substring(0, $eqIndex).Trim() })
              if ($gradleCanonicalPropertiesKeys -cnotcontains $existingKey) { throw "gradle_user_home_properties_unexpected_key:$existingKey" }
            }
          }
          # ONE canonical five-key content, byte-identical (LF only, never `r`n) to node's own
          # GRADLE_USER_HOME_CANONICAL_PROPERTIES (materialize.mjs) -- proven identical by a
          # cross-language SHA-256 test, not assumed.
          $gradleMemoryOverrideContent = "org.gradle.daemon=false`norg.gradle.java.installations.auto-download=false`norg.gradle.configuration-cache=false`norg.gradle.jvmargs=-Dfile.encoding=UTF-8 -XX:+UseG1GC -XX:SoftRefLRUPolicyMSPerMB=1 -XX:ReservedCodeCacheSize=256m -XX:+HeapDumpOnOutOfMemoryError -Xmx3g`nkotlin.daemon.jvmargs=-Dfile.encoding=UTF-8 -XX:+UseG1GC -XX:SoftRefLRUPolicyMSPerMB=1 -XX:ReservedCodeCacheSize=320m -XX:+HeapDumpOnOutOfMemoryError -Xmx2g`n"
          [IO.File]::WriteAllText($gradleMemoryOverridePath, $gradleMemoryOverrideContent, [Text.UTF8Encoding]::new($false))
          $gradleMemoryOverrideSha256 = (Get-FileHash -LiteralPath $gradleMemoryOverridePath -Algorithm SHA256).Hash.ToLowerInvariant()
          $cloneParameters = @{
            FileName = [string]$git
            Arguments = [string[]]@('clone', '--no-local', '--no-hardlinks', '--quiet', $SourceTemplateDir, $cloneRoot)
            WorkingDirectory = [string]$SmokeRoot
            EnvironmentVariables = [hashtable]$environment
            TimeoutSeconds = [int]300
          }
          $clone = & $script:E1InternalBoundedProcess @cloneParameters
          if ($clone.exit_code -ne 0 -or -not $clone.cleanup_ok) { throw 'product_smoke_clone_failed' }

          # The clone above preserves whatever commit
          # $SourceTemplateDir's own HEAD was checked out to on the guest -- correct only because
          # that checkout is independently verified elsewhere, never because a plain `git clone`
          # itself pins anything. Assert it here too, fail-closed, before paying for the actual
          # kmp-test run: expected tree is resolved from $ExpectedSourceCommit directly inside the
          # clone's own repo (which has that commit's full history), not a second externally-
          # supplied tree value to keep in sync -- catches content-level drift a bare commit-SHA
          # string match would miss.
          $sourceHeadResult = & $script:E1InternalBoundedProcess -FileName $git -Arguments @('-C', $cloneRoot, 'rev-parse', 'HEAD') -WorkingDirectory $cloneRoot -EnvironmentVariables $environment -TimeoutSeconds 30
          if ($sourceHeadResult.exit_code -ne 0 -or -not $sourceHeadResult.cleanup_ok) { throw 'product_smoke_source_identity_unreadable' }
          $observedSourceCommit = ([string]$sourceHeadResult.stdout).Trim()
          $sourceTreeResult = & $script:E1InternalBoundedProcess -FileName $git -Arguments @('-C', $cloneRoot, 'rev-parse', 'HEAD^{tree}') -WorkingDirectory $cloneRoot -EnvironmentVariables $environment -TimeoutSeconds 30
          if ($sourceTreeResult.exit_code -ne 0 -or -not $sourceTreeResult.cleanup_ok) { throw 'product_smoke_source_identity_unreadable' }
          $observedSourceTree = ([string]$sourceTreeResult.stdout).Trim()
          $expectedSourceTreeResult = & $script:E1InternalBoundedProcess -FileName $git -Arguments @('-C', $cloneRoot, 'rev-parse', "$ExpectedSourceCommit^{tree}") -WorkingDirectory $cloneRoot -EnvironmentVariables $environment -TimeoutSeconds 30
          if ($expectedSourceTreeResult.exit_code -ne 0 -or -not $expectedSourceTreeResult.cleanup_ok) { throw 'product_smoke_source_identity_unreadable' }
          $expectedSourceTree = ([string]$expectedSourceTreeResult.stdout).Trim()
          $sourceIdentityVerified = ($observedSourceCommit -ceq $ExpectedSourceCommit -and $observedSourceTree -ceq $expectedSourceTree)

          # multi-module-tests scenario: the scenario's own patch goes onto the disposable clone first, the way the
          # harness applies it to each session's checkout (git apply --check, then git apply; nothing staged), and
          # the clone must then differ from the pinned commit by exactly the files the scenario names. A clone that
          # is not the pinned source is refused here, before the patch and before a kmp-test run that can take an
          # hour, because nothing measured on it would mean anything.
          if ($hasScenarioPatch) {
            if (-not $sourceIdentityVerified) { throw "product_smoke_source_identity_mismatch:$observedSourceCommit" }
            $patchPath = Join-Path $HarnessDir (Join-Path 'tools\agentic-eval\corpus\fixtures' $smokeScenario.patch_file)
            if (-not (Test-Path -LiteralPath $patchPath -PathType Leaf)) { throw "product_smoke_patch_missing:$($smokeScenario.patch_file)" }
            $patchCheck = & $script:E1InternalBoundedProcess -FileName $git -Arguments @('-C', $cloneRoot, 'apply', '--check', $patchPath) -WorkingDirectory $cloneRoot -EnvironmentVariables $environment -TimeoutSeconds 60
            if ($patchCheck.exit_code -ne 0 -or -not $patchCheck.cleanup_ok) { throw "product_smoke_patch_check_failed:$($smokeScenario.patch_file)" }
            $patchApply = & $script:E1InternalBoundedProcess -FileName $git -Arguments @('-C', $cloneRoot, 'apply', $patchPath) -WorkingDirectory $cloneRoot -EnvironmentVariables $environment -TimeoutSeconds 60
            if ($patchApply.exit_code -ne 0 -or -not $patchApply.cleanup_ok) { throw "product_smoke_patch_apply_failed:$($smokeScenario.patch_file)" }
            $patchStatus = & $script:E1InternalBoundedProcess -FileName $git -Arguments @('-C', $cloneRoot, 'status', '--porcelain') -WorkingDirectory $cloneRoot -EnvironmentVariables $environment -TimeoutSeconds 60
            if ($patchStatus.exit_code -ne 0 -or -not $patchStatus.cleanup_ok) { throw 'product_smoke_patch_status_unreadable' }
            if (-not (Test-E1SmokePatchPostcondition ([string]$patchStatus.stdout) @($smokeScenario.expected_paths))) { throw "product_smoke_patch_postcondition_failed:$($smokeScenario.patch_file)" }
            if ($smokeScenario.mode -ceq 'changed-dependents') {
              # A committed edit is the fixture's changed --base comparison point.
              $commitEnvironment = [hashtable]$environment.Clone()
              $commitEnvironment.GIT_AUTHOR_DATE = '2000-01-01T00:00:00Z'
              $commitEnvironment.GIT_COMMITTER_DATE = '2000-01-01T00:00:00Z'
              $gitAdd = & $script:E1InternalBoundedProcess -FileName $git -Arguments ([string[]]@('-C', $cloneRoot, 'add', '--') + [string[]]@($smokeScenario.expected_paths)) -WorkingDirectory $cloneRoot -EnvironmentVariables $commitEnvironment -TimeoutSeconds 60
              if ($gitAdd.exit_code -ne 0 -or -not $gitAdd.cleanup_ok) { throw 'product_smoke_commit_add_failed' }
              $gitCommit = & $script:E1InternalBoundedProcess -FileName $git -Arguments @('-C', $cloneRoot, '-c', 'core.hooksPath=NUL', '-c', 'commit.gpgsign=false', '-c', 'user.name=KMP Test Runner Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'test(fixture): apply committed scenario edit') -WorkingDirectory $cloneRoot -EnvironmentVariables $commitEnvironment -TimeoutSeconds 60
              if ($gitCommit.exit_code -ne 0 -or -not $gitCommit.cleanup_ok) { throw 'product_smoke_commit_failed' }
              $commitParent = & $script:E1InternalBoundedProcess -FileName $git -Arguments @('-C', $cloneRoot, 'rev-parse', 'HEAD^') -WorkingDirectory $cloneRoot -EnvironmentVariables $commitEnvironment -TimeoutSeconds 60
              $commitStatus = & $script:E1InternalBoundedProcess -FileName $git -Arguments @('-C', $cloneRoot, 'status', '--porcelain') -WorkingDirectory $cloneRoot -EnvironmentVariables $commitEnvironment -TimeoutSeconds 60
              if ($commitParent.exit_code -ne 0 -or $commitStatus.exit_code -ne 0 -or ([string]$commitParent.stdout).Trim() -cne $ExpectedSourceCommit -or -not [string]::IsNullOrWhiteSpace([string]$commitStatus.stdout)) { throw 'product_smoke_commit_postcondition_failed' }
            }
          }

          # The coverage smoke's command and its 900 s bound are the ones this bundle has always run. A
          # multi-module-tests scenario runs the arguments its own ground-truth file names, with the same CLI and
          # project root, bounded at 3300 s.
          $kmpTestArguments = [string[]]@($cli, 'parallel', '--module-filter', ':core:domain', '--min-missed-lines', '15', '--json', '--project-root', $cloneRoot)
          $kmpTestTimeoutSeconds = [int]900
          if ($isMultiModule -or $isNextMilestone) {
            $kmpTestArguments = [string[]]@($cli) + [string[]]@($smokeScenario.kmp_test_args) + [string[]]@('--project-root', $cloneRoot)
            $kmpTestTimeoutSeconds = [int]3300
          }
          $processParameters = @{
            FileName = [string]$node
            Arguments = $kmpTestArguments
            WorkingDirectory = [string]$HarnessDir
            EnvironmentVariables = [hashtable]$environment
            TimeoutSeconds = $kmpTestTimeoutSeconds
          }
          # The kmp-test process's wall time, as the receipt reports it (both families): measured around the one
          # call that runs it, not around the clone, the patch or the daemon check.
          $kmpTestWatch = [Diagnostics.Stopwatch]::StartNew()
          $process = & $script:E1InternalBoundedProcess @processParameters
          $kmpTestWatch.Stop()
          $kmpTestDurationMs = [int64]$kmpTestWatch.ElapsedMilliseconds
          # Amendment A5: direct evidence that the
          # org.gradle.daemon=false override actually took effect -- `gradlew --status` against the
          # SAME GRADLE_USER_HOME the build just used, right after it, lists any daemon still alive
          # (a row starting "<PID> IDLE|BUSY ..."); a clean shutdown prints none. Best-effort: a
          # failure here never masks the real smoke result above, only records that this specific
          # check itself could not run.
          $noGradleDaemonSurvived = $false
          try {
            $gradlewForStatus = Join-Path $cloneRoot 'gradlew.bat'
            $daemonStatusParameters = @{
              FileName = [string]$gradlewForStatus
              Arguments = [string[]]@('--status')
              WorkingDirectory = [string]$cloneRoot
              EnvironmentVariables = [hashtable]$environment
              TimeoutSeconds = [int]60
            }
            $daemonStatusProcess = & $script:E1InternalBoundedProcess @daemonStatusParameters
            $noGradleDaemonSurvived = [bool]($daemonStatusProcess.cleanup_ok -and $daemonStatusProcess.exit_code -eq 0 -and
              (([string]$daemonStatusProcess.stdout) -notmatch '(?im)^\s*\d+\s+(IDLE|BUSY)\b'))
          } catch { $noGradleDaemonSurvived = $false }
          $report = $null
          try { $report = ([string]$process.stdout).Trim() | ConvertFrom-Json -ErrorAction Stop } catch { }
          $errorCodes = if ($null -eq $report) { @() } else { @($report.errors | ForEach-Object { [string]$_.code }) }
          $testsTotal = if ($null -eq $report -or $null -eq $report.tests) { 0 } else { [int]$report.tests.total }
          $testsPassed = if ($null -eq $report -or $null -eq $report.tests) { 0 } else { [int]$report.tests.passed }
          $missedLines = if ($null -eq $report -or $null -eq $report.coverage) { 0 } else { [int]$report.coverage.missed_lines }
          $individualTotal = if ($null -eq $report -or $null -eq $report.tests) { 0 } else { [int]$report.tests.individual_total }

          # multi-module-tests scenario: what the envelope reports failed, compared with the scenario's ground truth.
          $observedFailingModules = @()
          $observedFailedTestClasses = @()
          $observedFailedCount = 0
          $multiModuleMatches = $false
          if ($isMultiModule) {
            $multiModuleObservation = Get-E1SmokeMultiModuleObservation $report
            $observedFailingModules = @($multiModuleObservation.failing_modules)
            $observedFailedTestClasses = @($multiModuleObservation.failed_test_classes)
            $observedFailedCount = [int]$multiModuleObservation.failed_count
            $multiModuleMatches = Test-E1SmokeMultiModuleMatches $multiModuleObservation $smokeScenario.expected
          }
          $nextMilestoneMatches = $false
          if ($isNextMilestone -and $null -ne $report) {
            # Reuse the host grader's closed, family-specific envelope contract. The raw
            # envelope and private ground truth travel as files to avoid command-line
            # truncation and PowerShell's default JSON serialization depth limit.
            $smokeEnvelopePath = Join-Path $SmokeRoot 'next-milestone-envelope.json'
            [IO.File]::WriteAllText($smokeEnvelopePath, ([string]$process.stdout).Trim(), [Text.UTF8Encoding]::new($false))
            $smokeVerifier = @'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [harnessDir, scenarioId, family, envelopePath] = process.argv.slice(1);
const { evidenceMatches } = await import(pathToFileURL(join(harnessDir, 'tools', 'agentic-eval', 'graders-next-milestone.mjs')).href);
const expected = JSON.parse(readFileSync(join(harnessDir, 'tools', 'agentic-eval', 'corpus', 'expected', `${scenarioId}.json`), 'utf8')).expected;
const envelope = JSON.parse(readFileSync(envelopePath, 'utf8'));
const valid = envelope.tool === 'kmp-test' && envelope.schema_version === 3 && evidenceMatches({ family, expected }, envelope) === true;
process.stdout.write(valid ? 'MATCH' : 'MISMATCH');
'@
            $verifyProcess = & $script:E1InternalBoundedProcess -FileName $node -Arguments @('--input-type=module', '-e', $smokeVerifier, $HarnessDir, $ScenarioId, $smokeScenario.mode, $smokeEnvelopePath) -WorkingDirectory $HarnessDir -EnvironmentVariables $environment -TimeoutSeconds 60
            $nextMilestoneMatches = $verifyProcess.exit_code -eq 0 -and $verifyProcess.cleanup_ok -and ([string]$verifyProcess.stdout).Trim() -ceq 'MATCH'
          }

          $observedProductVersion = if ($null -eq $report) { $null } else { [string]$report.version }
          if ($observedProductVersion -cne $ExpectedProductVersion) { $identityMismatches += "version: expected $ExpectedProductVersion, observed '$observedProductVersion'" }
          $productIdentityVerified = ($identityMismatches.Count -eq 0)

          # The check above only catches a version
          # mismatch, it doesn't explain one -- the observed anomaly was a checkout
          # already git-verified correct at 0.16.0 (this bundle's own early check, above,
          # would have passed it) that still ran a kmp-test reporting 0.15.0. Capture the
          # evidence the leading hypothesis needs -- Node's ESM loader resolves
          # import.meta.url through a reparse point, so a junctioned lib/bin would make
          # readVersion() read a DIFFERENT tree's package.json than the one checked out --
          # every run, not only on a mismatch, so a future occurrence has the answer on the
          # first receipt instead of a second live-debugging round. Unproven, so captured
          # rather than assumed.
          $identityDiagnosticsScriptPath = Join-Path $SmokeRoot 'identity-diagnostics.js'
          $identityDiagnosticsScript = @'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function safeRealpath(candidatePath) {
  try { return fs.realpathSync(candidatePath); } catch (error) { return null; }
}

const harnessDir = process.argv[2];
const binPath = path.join(harnessDir, 'bin', 'kmp-test.js');
const builderPath = path.join(harnessDir, 'lib', 'envelope', 'builder.js');
const packageJsonPath = path.join(harnessDir, 'package.json');

const result = {
  bin_realpath: safeRealpath(binPath),
  builder_realpath: safeRealpath(builderPath),
  package_json_realpath: safeRealpath(packageJsonPath),
  builder_resolved_package_json_path: null,
  builder_resolved_package_json_sha256: null,
  builder_resolved_package_json_version: null,
  builder_resolved_package_json_error: null,
};

if (result.builder_realpath) {
  const resolvedPath = path.join(path.dirname(result.builder_realpath), '..', '..', 'package.json');
  result.builder_resolved_package_json_path = resolvedPath;
  try {
    const buf = fs.readFileSync(resolvedPath);
    result.builder_resolved_package_json_sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    result.builder_resolved_package_json_version = JSON.parse(buf.toString('utf8')).version;
  } catch (error) {
    result.builder_resolved_package_json_error = String((error && error.message) || error);
  }
}

process.stdout.write(JSON.stringify(result));
'@
          Set-Content -LiteralPath $identityDiagnosticsScriptPath -Value $identityDiagnosticsScript -Encoding UTF8 -NoNewline
          $identityDiagnosticsParameters = @{
            FileName = [string]$node
            Arguments = [string[]]@($identityDiagnosticsScriptPath, $HarnessDir)
            WorkingDirectory = [string]$SmokeRoot
            EnvironmentVariables = [hashtable]$environment
            TimeoutSeconds = [int]60
          }
          $identityDiagnosticsProcess = & $script:E1InternalBoundedProcess @identityDiagnosticsParameters
          $identityDiagnosticsParsed = $null
          if ($identityDiagnosticsProcess.exit_code -eq 0 -and $identityDiagnosticsProcess.cleanup_ok) {
            try { $identityDiagnosticsParsed = ([string]$identityDiagnosticsProcess.stdout).Trim() | ConvertFrom-Json -ErrorAction Stop } catch { $identityDiagnosticsParsed = $null }
          }
          $versionCommandParameters = @{
            FileName = [string]$node
            Arguments = [string[]]@($cli, '--version', '--json')
            WorkingDirectory = [string]$HarnessDir
            EnvironmentVariables = [hashtable]$environment
            TimeoutSeconds = [int]60
          }
          $versionCommandProcess = & $script:E1InternalBoundedProcess @versionCommandParameters
          $reparseAttributes = [ordered]@{}
          foreach ($subdirName in @('bin', 'lib', 'scripts')) {
            $subdirPath = Join-Path $HarnessDir $subdirName
            $reparseAttributes[$subdirName] = if (Test-Path -LiteralPath $subdirPath) { [string](Get-Item -LiteralPath $subdirPath -Force).Attributes } else { $null }
          }
          $pathKey = @($environment.Keys) | Where-Object { $_ -ieq 'Path' } | Select-Object -First 1
          $pathEntriesOfInterest = if ($pathKey) { @(([string]$environment[$pathKey] -split ';') | Where-Object { $_ -match '(?i)node|kmp-test' }) } else { @() }
          $identityDiagnostics = [ordered]@{
            version_command_stdout = @(Get-E1GuestBundleTailLines ([string]$versionCommandProcess.stdout))
            bin_realpath = if ($null -eq $identityDiagnosticsParsed) { $null } else { $identityDiagnosticsParsed.bin_realpath }
            builder_realpath = if ($null -eq $identityDiagnosticsParsed) { $null } else { $identityDiagnosticsParsed.builder_realpath }
            package_json_realpath = if ($null -eq $identityDiagnosticsParsed) { $null } else { $identityDiagnosticsParsed.package_json_realpath }
            builder_resolved_package_json_path = if ($null -eq $identityDiagnosticsParsed) { $null } else { $identityDiagnosticsParsed.builder_resolved_package_json_path }
            builder_resolved_package_json_sha256 = if ($null -eq $identityDiagnosticsParsed) { $null } else { $identityDiagnosticsParsed.builder_resolved_package_json_sha256 }
            builder_resolved_package_json_version = if ($null -eq $identityDiagnosticsParsed) { $null } else { $identityDiagnosticsParsed.builder_resolved_package_json_version }
            builder_resolved_package_json_error = if ($null -eq $identityDiagnosticsParsed) { $null } else { $identityDiagnosticsParsed.builder_resolved_package_json_error }
            reparse_attributes = $reparseAttributes
            path_entries_of_interest = @($pathEntriesOfInterest)
          }

          if ($isMultiModule) {
            # kmp-test exits 1 when tests fail and 0 when they all pass; either way what it reports must be exactly
            # what the scenario's ground truth says.
            $expectedExitCode = $(if ($smokeScenario.expected.outcome_kind -ceq 'tests_failed') { 1 } else { 0 })
            $semanticPass = $productIdentityVerified -and $sourceIdentityVerified -and $process.cleanup_ok -and $process.exit_code -eq $expectedExitCode -and
              $multiModuleMatches
          } elseif ($isNextMilestone) {
            $semanticPass = $productIdentityVerified -and $sourceIdentityVerified -and $process.cleanup_ok -and $process.exit_code -eq 1 -and $nextMilestoneMatches
          } else {
            $semanticPass = $productIdentityVerified -and $sourceIdentityVerified -and $process.cleanup_ok -and $process.exit_code -eq 1 -and
              $errorCodes -contains 'coverage_threshold_exceeded' -and
              $testsTotal -eq 1 -and $testsPassed -eq 1 -and $missedLines -eq 23 -and $individualTotal -eq 4
          }
          $smokeResult = [ordered]@{
            verdict = $(if ($semanticPass) { 'PASS' } else { 'FAIL' })
            reason_code = $(
              if ($semanticPass) { $null }
              elseif (-not $productIdentityVerified) { 'product_identity_mismatch' }
              elseif (-not $sourceIdentityVerified) { 'product_smoke_source_identity_mismatch' }
              elseif ($null -eq $report) { 'product_smoke_output_invalid' }
              else { 'product_smoke_semantic_mismatch' }
            )
            exit_code = [int]$process.exit_code
            error_codes = @($errorCodes)
            tests_total = $testsTotal
            tests_passed = $testsPassed
            coverage_missed_lines = $missedLines
            individual_total = $individualTotal
            inference_sessions_consumed = 0
            raw_envelope_json = $(if ($null -eq $process.stdout) { $null } else {
              $trimmed = ([string]$process.stdout).Trim()
              if ($trimmed.Length -gt 262144) { $trimmed.Substring(0, 262144) + '...(truncated)' } else { $trimmed }
            })
            stdout_tail = @(Get-E1GuestBundleTailLines ([string]$process.stdout))
            stderr_tail = @(Get-E1GuestBundleTailLines ([string]$process.stderr))
            exception_type = $null
            exception_message = $null
            exception_stack_trace = $null
            long_path_delete_entries_removed = $longPathDeleteMaxLength
            product_identity_verified = $productIdentityVerified
            product_identity_mismatches = @($identityMismatches)
            observed_product_commit = $observedProductCommit
            observed_product_version = $observedProductVersion
            observed_lib_tree_hash = $observedLibTreeHash
            observed_bin_tree_hash = $observedBinTreeHash
            observed_skills_tree_hash = $observedSkillsTreeHash
            identity_diagnostics = $identityDiagnostics
            source_identity_verified = $sourceIdentityVerified
            observed_source_commit = $observedSourceCommit
            observed_source_tree = $observedSourceTree
            expected_source_tree = $expectedSourceTree
            gradle_memory_override_sha256 = $gradleMemoryOverrideSha256
            no_gradle_daemon_survived = $noGradleDaemonSurvived
            kmp_test_duration_ms = $kmpTestDurationMs
          }
          # Only a multi-module-tests scenario's receipt carries what the envelope reported (the coverage smoke
          # returns none of these three keys, so its receipt only gains kmp_test_duration_ms).
          if ($isMultiModule) {
            $smokeResult['observed_failing_modules'] = @($observedFailingModules)
            $smokeResult['observed_failed_test_classes'] = @($observedFailedTestClasses)
            $smokeResult['observed_failed_count'] = [int]$observedFailedCount
          }
          # 2026-09-29 (canary attempt 1 on 8869d9c2, Amendment A6): the pre-clean above only
          # protects the NEXT run's own replay -- nothing previously removed this run's own
          # materialized clone/gradle-home after a SUCCESSFUL smoke, leaving it on guest disk
          # indefinitely. Best-effort: a cleanup failure here must never turn a real PASS/FAIL
          # smoke result into bundle_exception, so it is swallowed, not rethrown.
          try { $null = Remove-E1GuestBundleLongPathTree $script:E1InternalBoundedProcess $environment $SmokeRoot } catch { }
          $smokeResult
        } catch {
          $boundedMessage = [string]$_.Exception.Message
          if ($boundedMessage.Length -gt 4000) { $boundedMessage = $boundedMessage.Substring(0, 4000) + '...(truncated)' }
          $boundedStack = [string]$_.ScriptStackTrace
          if ($boundedStack.Length -gt 4000) { $boundedStack = $boundedStack.Substring(0, 4000) + '...(truncated)' }
          [ordered]@{
            verdict = 'FAIL'
            reason_code = 'bundle_exception'
            exit_code = $null
            error_codes = @()
            tests_total = 0
            tests_passed = 0
            coverage_missed_lines = 0
            individual_total = 0
            inference_sessions_consumed = 0
            raw_envelope_json = $null
            stdout_tail = @()
            stderr_tail = @()
            exception_type = [string]$_.Exception.GetType().FullName
            exception_message = $boundedMessage
            exception_stack_trace = $boundedStack
            long_path_delete_entries_removed = $null
            product_identity_verified = $false
            product_identity_mismatches = @($identityMismatches)
            observed_product_commit = $observedProductCommit
            observed_product_version = $observedProductVersion
            observed_lib_tree_hash = $observedLibTreeHash
            observed_bin_tree_hash = $observedBinTreeHash
            observed_skills_tree_hash = $observedSkillsTreeHash
            identity_diagnostics = $null
            source_identity_verified = $sourceIdentityVerified
            observed_source_commit = $observedSourceCommit
            observed_source_tree = $observedSourceTree
            expected_source_tree = $expectedSourceTree
            gradle_memory_override_sha256 = $gradleMemoryOverrideSha256
            no_gradle_daemon_survived = $noGradleDaemonSurvived
            kmp_test_duration_ms = $kmpTestDurationMs
          }
        }
      }
    }

    # Feasibility probe (eval v2): a minimal, standalone sibling of
    # run-agentic-eval-product-smoke above -- same disposable-clone/cold-seed
    # discipline, but runs one named Gradle task with --offline directly,
    # never kmp-test, never a provider. Answers whether a held-out scenario's
    # own Gradle task resolves fully from the VM's already-provisioned cache
    # before any live session is spent on it -- this VM's network is already
    # "restricted" per its own execution profile; this bundle never touches
    # network adapters itself, --offline is what actually forces the question.
    'run-gradle-task-offline' = [ordered]@{
      description     = 'Execute one named Gradle task with --offline in a disposable guest clone, without starting a provider, to test cache-only resolution.'
      argument_schema = [ordered]@{
        HarnessDir        = { param($v) $v -is [string] -and $v -cmatch '^[A-Za-z]:\\' }
        SourceTemplateDir = { param($v) $v -is [string] -and $v -cmatch '^[A-Za-z]:\\' }
        GradleTask        = { param($v) $v -is [string] -and $v -cmatch '^:[A-Za-z0-9:_-]+$' }
        ProbeRoot         = { param($v) $v -is [string] -and $v -cmatch '^C:\\Evidence1Private\\' }
      }
      result_keys = @('verdict', 'reason_code', 'exit_code', 'offline_resolved', 'diagnostic_tail', 'exception_type', 'exception_message', 'exception_stack_trace', 'long_path_delete_entries_removed', 'gradle_memory_override_sha256')
      scriptblock = {
        param($HarnessDir, $SourceTemplateDir, $GradleTask, $ProbeRoot)

        # Identical to
        # run-agentic-eval-product-smoke's own helper of the same name; duplicated, not shared,
        # since each bundle's scriptblock is self-contained (no cross-scriptblock imports once
        # shipped to the guest). See that bundle's own copy for the full rationale.
        function Remove-E1GuestBundleLongPathTree($BoundedProcess, [hashtable]$Environment, [string]$Path) {
          if (-not (Test-Path -LiteralPath $Path)) { return 0 }
          $node = 'C:\Evidence1Toolchain\node\24.19.0\node.exe'
          $script = 'const fs=require(''node:fs'');const targetPath=process.argv[1];let n=0;try{n=fs.readdirSync(targetPath).length}catch{n=0}fs.rmSync(targetPath,{recursive:true,force:true,maxRetries:3});process.stdout.write(String(n))'
          $deleteParameters = @{
            FileName = [string]$node
            Arguments = [string[]]@('-e', $script, $Path)
            WorkingDirectory = 'C:\Evidence1Private'
            EnvironmentVariables = $Environment
            TimeoutSeconds = [int]900
          }
          $delete = & $BoundedProcess @deleteParameters
          if ($delete.exit_code -ne 0 -or -not $delete.cleanup_ok) {
            # 2026-09-29 (found live, first standalone smoke run against this fix): a bare path
            # in the throw message gave no way to tell WHY the delete itself failed (timeout on
            # a large tree during the walk(), a real node error, cleanup_ok false for an
            # unrelated reason) without a second diagnostic round. Bounded stdout/stderr fixes
            # that the same way this module bounds every other guest-side error text.
            $deleteStdout = ([string]$delete.stdout)
            if ($deleteStdout.Length -gt 1000) { $deleteStdout = $deleteStdout.Substring(0, 1000) + '...(truncated)' }
            $deleteStderr = ([string]$delete.stderr)
            if ($deleteStderr.Length -gt 1000) { $deleteStderr = $deleteStderr.Substring(0, 1000) + '...(truncated)' }
            throw "guest_long_path_delete_failed: $Path (exit_code=$($delete.exit_code) cleanup_ok=$($delete.cleanup_ok) stdout=$deleteStdout stderr=$deleteStderr)"
          }
          $entriesRemoved = 0
          [void][int]::TryParse(([string]$delete.stdout).Trim(), [ref]$entriesRemoved)
          return $entriesRemoved
        }

        Set-StrictMode -Version Latest
        $ErrorActionPreference = 'Stop'

        # See run-agentic-eval-product-smoke's own identical
        # wrapping for the full rationale -- an uncaught exception here previously bubbled to the
        # host's generic "guest_bundle_failed: <raw message>" wrapper with no stack trace.
        try {
          $gradleMemoryOverrideSha256 = $null
          # $script:E1GradleUserHomeSeedDir / $script:E1InternalBoundedProcess /
          # New-E1DualConditionCanaryRuntimeEnvironment all come from dot-sourcing
          # the launch script in library mode -- the exact same prerequisite step
          # run-agentic-eval-product-smoke above takes, omitted from this bundle's
          # first draft (caught live: "cannot be retrieved because it has not
          # been set" the first time this ran against the real guest).
          $worker = Join-Path $HarnessDir 'docs\audits\evidence1-dual-condition-canary-launch.ps1'
          if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) { throw 'gradle_offline_probe_worker_missing' }
          Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
          # (Root cause, proven live against the smoke bundle's
          # own identical dot-source): passing the current values back in makes the
          # worker's own param-rebind a no-op instead of a silent reset to its Evidence1
          # stage-B defaults -- see this bundle's own copy of the incident note above.
          . $worker -InternalLibrary -HarnessDir $HarnessDir -SourceTemplateDir $SourceTemplateDir

          $environment = New-E1DualConditionCanaryRuntimeEnvironment
          # Same resumability rule as run-agentic-eval-product-smoke: a failed/
          # aborted probe must be re-runnable without a manual guest cleanup step.
          $longPathDeleteMaxLength = Remove-E1GuestBundleLongPathTree $script:E1InternalBoundedProcess $environment $ProbeRoot
          $null = New-Item -ItemType Directory -Path $ProbeRoot -Force
          $cloneRoot = Join-Path $ProbeRoot 'source'
          $git = 'C:\Evidence1Toolchain\git\2.55.0.windows.5\cmd\git.exe'
          $node = 'C:\Evidence1Toolchain\node\24.19.0\node.exe'
          # Named, same treatment as
          # run-agentic-eval-product-smoke's own identical guard -- see its comment.
          $requiredOfflineProbeInputs = [ordered]@{
            GitExecutable = $git
            NodeExecutable = $node
            SourceTemplateDir = $SourceTemplateDir
            GradleUserHomeSeedDir = $script:E1GradleUserHomeSeedDir
          }
          foreach ($inputName in $requiredOfflineProbeInputs.Keys) {
            if (-not (Test-Path -LiteralPath $requiredOfflineProbeInputs[$inputName])) { throw "gradle_offline_probe_input_missing:$inputName" }
          }

          # Reproduce the live harness's own isolated, cold-seed Gradle home --
          # this probe means nothing if it silently resolves from a warmed
          # ambient cache instead of the same fixture the real cell would see.
          $gradleHome = Join-Path $ProbeRoot 'gradle-home'
          $seedCopyParameters = @{
            FileName = [string]$node
            Arguments = [string[]]@('-e', "require('node:fs').cpSync(process.argv[1],process.argv[2],{recursive:true})", $script:E1GradleUserHomeSeedDir, $gradleHome)
            WorkingDirectory = [string]$ProbeRoot
            EnvironmentVariables = [hashtable]$environment
            TimeoutSeconds = [int]300
          }
          $seedCopy = & $script:E1InternalBoundedProcess @seedCopyParameters
          if ($seedCopy.exit_code -ne 0 -or -not $seedCopy.cleanup_ok) { throw 'gradle_offline_probe_seed_copy_failed' }
          $environment.GRADLE_USER_HOME = $gradleHome
          # Amendment A5: see run-agentic-eval-product-smoke's
          # own identical write for the full rationale -- same symmetric, GRADLE_USER_HOME-level
          # override, the certified seed itself never written to.
          $gradleMemoryOverridePath = Join-Path $gradleHome 'gradle.properties'
          # The seed copy
          # already carries its own gradle.properties (org.gradle.daemon=false +
          # org.gradle.java.installations.auto-download=false, written at warm time,
          # evidence1-hyperv-warm-canonical-gradle-cache-direct.ps1:41) -- a blind overwrite here
          # silently DROPPED both, the opposite of the goal (the daemon then stayed alive after
          # each build). Fail closed instead of silently dropping any key this canonical content
          # doesn't recognize.
          $gradleCanonicalPropertiesKeys = @('org.gradle.daemon', 'org.gradle.java.installations.auto-download', 'org.gradle.configuration-cache', 'org.gradle.jvmargs', 'kotlin.daemon.jvmargs')
          if (Test-Path -LiteralPath $gradleMemoryOverridePath -PathType Leaf) {
            foreach ($existingLine in (Get-Content -LiteralPath $gradleMemoryOverridePath)) {
              $trimmedExistingLine = $existingLine.Trim()
              if ($trimmedExistingLine -eq '' -or $trimmedExistingLine.StartsWith('#') -or $trimmedExistingLine.StartsWith('!')) { continue }
              $eqIndex = $trimmedExistingLine.IndexOf('=')
              $existingKey = $(if ($eqIndex -eq -1) { $trimmedExistingLine } else { $trimmedExistingLine.Substring(0, $eqIndex).Trim() })
              if ($gradleCanonicalPropertiesKeys -cnotcontains $existingKey) { throw "gradle_user_home_properties_unexpected_key:$existingKey" }
            }
          }
          # ONE canonical five-key content, byte-identical (LF only, never `r`n) to node's own
          # GRADLE_USER_HOME_CANONICAL_PROPERTIES (materialize.mjs) -- proven identical by a
          # cross-language SHA-256 test, not assumed.
          $gradleMemoryOverrideContent = "org.gradle.daemon=false`norg.gradle.java.installations.auto-download=false`norg.gradle.configuration-cache=false`norg.gradle.jvmargs=-Dfile.encoding=UTF-8 -XX:+UseG1GC -XX:SoftRefLRUPolicyMSPerMB=1 -XX:ReservedCodeCacheSize=256m -XX:+HeapDumpOnOutOfMemoryError -Xmx3g`nkotlin.daemon.jvmargs=-Dfile.encoding=UTF-8 -XX:+UseG1GC -XX:SoftRefLRUPolicyMSPerMB=1 -XX:ReservedCodeCacheSize=320m -XX:+HeapDumpOnOutOfMemoryError -Xmx2g`n"
          [IO.File]::WriteAllText($gradleMemoryOverridePath, $gradleMemoryOverrideContent, [Text.UTF8Encoding]::new($false))
          $gradleMemoryOverrideSha256 = (Get-FileHash -LiteralPath $gradleMemoryOverridePath -Algorithm SHA256).Hash.ToLowerInvariant()

          $cloneParameters = @{
            FileName = [string]$git
            Arguments = [string[]]@('clone', '--no-local', '--no-hardlinks', '--quiet', $SourceTemplateDir, $cloneRoot)
            WorkingDirectory = [string]$ProbeRoot
            EnvironmentVariables = [hashtable]$environment
            TimeoutSeconds = [int]300
          }
          $clone = & $script:E1InternalBoundedProcess @cloneParameters
          if ($clone.exit_code -ne 0 -or -not $clone.cleanup_ok) { throw 'gradle_offline_probe_clone_failed' }

          $gradlew = Join-Path $cloneRoot 'gradlew.bat'
          if (-not (Test-Path -LiteralPath $gradlew)) { throw 'gradle_offline_probe_gradlew_missing' }
          $taskParameters = @{
            FileName = [string]$gradlew
            Arguments = [string[]]@($GradleTask, '--offline')
            WorkingDirectory = [string]$cloneRoot
            EnvironmentVariables = [hashtable]$environment
            TimeoutSeconds = [int]900
          }
          $task = & $script:E1InternalBoundedProcess @taskParameters
          $offlineResolved = [bool]($task.cleanup_ok -and $task.exit_code -eq 0)
          # Bounded, not raw: the same single-line/length-cap discipline this
          # repo already established for sanitized guest error text (see
          # evidence1-guest-bundle-hyperv.psm1's Get-E1GuestBundleSanitizedErrorText)
          # -- enough to see WHAT failed (e.g. "Could not resolve"), never an
          # unbounded raw command/path dump.
          $combined = ([string]$task.stdout + "`n" + [string]$task.stderr)
          $singleLine = ($combined -replace '[\r\n]+', ' ').Trim()
          if ($singleLine.Length -gt 2000) { $singleLine = $singleLine.Substring($singleLine.Length - 2000, 2000) }
          [ordered]@{
            verdict = $(if ($offlineResolved) { 'PASS' } else { 'FAIL' })
            reason_code = $(if ($offlineResolved) { $null } else { 'gradle_offline_probe_task_failed' })
            exit_code = [int]$task.exit_code
            offline_resolved = $offlineResolved
            diagnostic_tail = $(if ($offlineResolved) { $null } else { $singleLine })
            exception_type = $null
            exception_message = $null
            exception_stack_trace = $null
            long_path_delete_entries_removed = $longPathDeleteMaxLength
            gradle_memory_override_sha256 = $gradleMemoryOverrideSha256
          }
        } catch {
          $boundedMessage = [string]$_.Exception.Message
          if ($boundedMessage.Length -gt 4000) { $boundedMessage = $boundedMessage.Substring(0, 4000) + '...(truncated)' }
          $boundedStack = [string]$_.ScriptStackTrace
          if ($boundedStack.Length -gt 4000) { $boundedStack = $boundedStack.Substring(0, 4000) + '...(truncated)' }
          [ordered]@{
            verdict = 'FAIL'
            reason_code = 'bundle_exception'
            exit_code = $null
            offline_resolved = $false
            diagnostic_tail = $null
            exception_type = [string]$_.Exception.GetType().FullName
            exception_message = $boundedMessage
            exception_stack_trace = $boundedStack
            long_path_delete_entries_removed = $null
            gradle_memory_override_sha256 = $gradleMemoryOverrideSha256
          }
        }
      }
    }

    # Smoke-failure diagnosis: run-agentic-eval-product-smoke failed with
    # task_not_found/module_failed/coverage_data_unavailable on :core:domain, matching
    # cache.js's own silent-null-on-probe-failure path (its `gradlew tasks --all --quiet`
    # discovery probe, lib/project/cache.js:319). This bundle answers WHY that probe fails in the
    # guest -- a closed set of exactly three predefined diagnostic invocations, never a
    # free-form command: ProbeMode is a fixed enum, not a caller-supplied
    # args array, so this stays "the broker's own reviewed code," not a new caller-code channel
    # (see this module's own header on that exact boundary). Every mode uses the smoke bundle's
    # own env construction (seed copy, New-E1DualConditionCanaryRuntimeEnvironment) so the probe
    # measures the same fixture the real smoke/cell would see, and runs `gradlew --stop` against
    # that same GRADLE_USER_HOME afterward so no daemon lingers between probes.
    'run-gradle-diagnostic-probe' = [ordered]@{
      description     = 'Run one of a closed set of named Gradle diagnostic invocations (the tasks-discovery probe, with and without --offline, and the core:domain:test dispatch) in a disposable guest clone, to diagnose why kmp-test''s own gradlew tasks --all --quiet probe silently returns null.'
      argument_schema = [ordered]@{
        HarnessDir        = { param($v) $v -is [string] -and $v -cmatch '^[A-Za-z]:\\' }
        SourceTemplateDir = { param($v) $v -is [string] -and $v -cmatch '^[A-Za-z]:\\' }
        ProbeMode         = { param($v) $v -is [string] -and @('tasks-probe', 'tasks-probe-offline', 'core-domain-test') -contains $v }
        ProbeRoot         = { param($v) $v -is [string] -and $v -cmatch '^C:\\Evidence1Private\\' }
      }
      result_keys = @('verdict', 'reason_code', 'exit_code', 'wall_time_ms', 'output_tail', 'output_head', 'gradle_version_output', 'exception_type', 'exception_message', 'exception_stack_trace', 'long_path_delete_entries_removed', 'gradle_memory_override_sha256')
      scriptblock = {
        param($HarnessDir, $SourceTemplateDir, $ProbeMode, $ProbeRoot)

        function Get-E1GuestBundleDiagnosticTailLines([string]$Text, [int]$MaxLines = 60) {
          if ([string]::IsNullOrEmpty($Text)) { return @() }
          $lines = $Text -split '\r?\n'
          if ($lines.Count -le $MaxLines) { return $lines }
          return $lines[-$MaxLines..-1]
        }

        # A tail-only capture silently drops a crash's own exception head once the stack
        # trace and Gradle's own failure footer push it past the last 60 lines.
        # Bounded to the same discipline as
        # the tail helper: fixed line count, no unbounded text ever leaves the guest.
        function Get-E1GuestBundleDiagnosticHeadLines([string]$Text, [int]$MaxLines = 40) {
          if ([string]::IsNullOrEmpty($Text)) { return @() }
          $lines = $Text -split '\r?\n'
          $matchIndex = -1
          for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match 'Exception|Caused by') { $matchIndex = $i; break }
          }
          if ($matchIndex -lt 0) { return @() }
          $endIndex = [Math]::Min($lines.Count - 1, $matchIndex + $MaxLines - 1)
          return $lines[$matchIndex..$endIndex]
        }

        # Identical to
        # run-agentic-eval-product-smoke's own helper of the same name; duplicated, not shared,
        # since each bundle's scriptblock is self-contained (no cross-scriptblock imports once
        # shipped to the guest). See that bundle's own copy for the full rationale.
        function Remove-E1GuestBundleLongPathTree($BoundedProcess, [hashtable]$Environment, [string]$Path) {
          if (-not (Test-Path -LiteralPath $Path)) { return 0 }
          $node = 'C:\Evidence1Toolchain\node\24.19.0\node.exe'
          $script = 'const fs=require(''node:fs'');const targetPath=process.argv[1];let n=0;try{n=fs.readdirSync(targetPath).length}catch{n=0}fs.rmSync(targetPath,{recursive:true,force:true,maxRetries:3});process.stdout.write(String(n))'
          $deleteParameters = @{
            FileName = [string]$node
            Arguments = [string[]]@('-e', $script, $Path)
            WorkingDirectory = 'C:\Evidence1Private'
            EnvironmentVariables = $Environment
            TimeoutSeconds = [int]900
          }
          $delete = & $BoundedProcess @deleteParameters
          if ($delete.exit_code -ne 0 -or -not $delete.cleanup_ok) {
            # 2026-09-29 (found live, first standalone smoke run against this fix): a bare path
            # in the throw message gave no way to tell WHY the delete itself failed (timeout on
            # a large tree during the walk(), a real node error, cleanup_ok false for an
            # unrelated reason) without a second diagnostic round. Bounded stdout/stderr fixes
            # that the same way this module bounds every other guest-side error text.
            $deleteStdout = ([string]$delete.stdout)
            if ($deleteStdout.Length -gt 1000) { $deleteStdout = $deleteStdout.Substring(0, 1000) + '...(truncated)' }
            $deleteStderr = ([string]$delete.stderr)
            if ($deleteStderr.Length -gt 1000) { $deleteStderr = $deleteStderr.Substring(0, 1000) + '...(truncated)' }
            throw "guest_long_path_delete_failed: $Path (exit_code=$($delete.exit_code) cleanup_ok=$($delete.cleanup_ok) stdout=$deleteStdout stderr=$deleteStderr)"
          }
          $entriesRemoved = 0
          [void][int]::TryParse(([string]$delete.stdout).Trim(), [ref]$entriesRemoved)
          return $entriesRemoved
        }

        Set-StrictMode -Version Latest
        $ErrorActionPreference = 'Stop'

        # See run-agentic-eval-product-smoke's own identical
        # wrapping for the full rationale -- an uncaught exception here previously bubbled to the
        # host's generic "guest_bundle_failed: <raw message>" wrapper with no stack trace.
        try {
          $gradleMemoryOverrideSha256 = $null
          $worker = Join-Path $HarnessDir 'docs\audits\evidence1-dual-condition-canary-launch.ps1'
          if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) { throw 'gradle_diagnostic_probe_worker_missing' }
          Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
          # (Root cause, proven live against the smoke bundle's
          # own identical dot-source): passing the current values back in makes the
          # worker's own param-rebind a no-op instead of a silent reset to its Evidence1
          # stage-B defaults -- see run-agentic-eval-product-smoke's own incident note.
          . $worker -InternalLibrary -HarnessDir $HarnessDir -SourceTemplateDir $SourceTemplateDir

          $environment = New-E1DualConditionCanaryRuntimeEnvironment
          $longPathDeleteMaxLength = Remove-E1GuestBundleLongPathTree $script:E1InternalBoundedProcess $environment $ProbeRoot
          $null = New-Item -ItemType Directory -Path $ProbeRoot -Force
          $cloneRoot = Join-Path $ProbeRoot 'source'
          $git = 'C:\Evidence1Toolchain\git\2.55.0.windows.5\cmd\git.exe'
          $node = 'C:\Evidence1Toolchain\node\24.19.0\node.exe'
          # Named, same treatment as
          # run-agentic-eval-product-smoke's own identical guard -- see its comment.
          $requiredDiagnosticProbeInputs = [ordered]@{
            GitExecutable = $git
            NodeExecutable = $node
            SourceTemplateDir = $SourceTemplateDir
            GradleUserHomeSeedDir = $script:E1GradleUserHomeSeedDir
          }
          foreach ($inputName in $requiredDiagnosticProbeInputs.Keys) {
            if (-not (Test-Path -LiteralPath $requiredDiagnosticProbeInputs[$inputName])) { throw "gradle_diagnostic_probe_input_missing:$inputName" }
          }

          $gradleHome = Join-Path $ProbeRoot 'gradle-home'
          $seedCopyParameters = @{
            FileName = [string]$node
            Arguments = [string[]]@('-e', "require('node:fs').cpSync(process.argv[1],process.argv[2],{recursive:true})", $script:E1GradleUserHomeSeedDir, $gradleHome)
            WorkingDirectory = [string]$ProbeRoot
            EnvironmentVariables = [hashtable]$environment
            TimeoutSeconds = [int]300
          }
          $seedCopy = & $script:E1InternalBoundedProcess @seedCopyParameters
          if ($seedCopy.exit_code -ne 0 -or -not $seedCopy.cleanup_ok) { throw 'gradle_diagnostic_probe_seed_copy_failed' }
          $environment.GRADLE_USER_HOME = $gradleHome
          # Amendment A5: see run-agentic-eval-product-smoke's
          # own identical write for the full rationale -- same symmetric, GRADLE_USER_HOME-level
          # override, the certified seed itself never written to.
          $gradleMemoryOverridePath = Join-Path $gradleHome 'gradle.properties'
          # The seed copy
          # already carries its own gradle.properties (org.gradle.daemon=false +
          # org.gradle.java.installations.auto-download=false, written at warm time,
          # evidence1-hyperv-warm-canonical-gradle-cache-direct.ps1:41) -- a blind overwrite here
          # silently DROPPED both, the opposite of the goal (the daemon then stayed alive after
          # each build). Fail closed instead of silently dropping any key this canonical content
          # doesn't recognize.
          $gradleCanonicalPropertiesKeys = @('org.gradle.daemon', 'org.gradle.java.installations.auto-download', 'org.gradle.configuration-cache', 'org.gradle.jvmargs', 'kotlin.daemon.jvmargs')
          if (Test-Path -LiteralPath $gradleMemoryOverridePath -PathType Leaf) {
            foreach ($existingLine in (Get-Content -LiteralPath $gradleMemoryOverridePath)) {
              $trimmedExistingLine = $existingLine.Trim()
              if ($trimmedExistingLine -eq '' -or $trimmedExistingLine.StartsWith('#') -or $trimmedExistingLine.StartsWith('!')) { continue }
              $eqIndex = $trimmedExistingLine.IndexOf('=')
              $existingKey = $(if ($eqIndex -eq -1) { $trimmedExistingLine } else { $trimmedExistingLine.Substring(0, $eqIndex).Trim() })
              if ($gradleCanonicalPropertiesKeys -cnotcontains $existingKey) { throw "gradle_user_home_properties_unexpected_key:$existingKey" }
            }
          }
          # ONE canonical five-key content, byte-identical (LF only, never `r`n) to node's own
          # GRADLE_USER_HOME_CANONICAL_PROPERTIES (materialize.mjs) -- proven identical by a
          # cross-language SHA-256 test, not assumed.
          $gradleMemoryOverrideContent = "org.gradle.daemon=false`norg.gradle.java.installations.auto-download=false`norg.gradle.configuration-cache=false`norg.gradle.jvmargs=-Dfile.encoding=UTF-8 -XX:+UseG1GC -XX:SoftRefLRUPolicyMSPerMB=1 -XX:ReservedCodeCacheSize=256m -XX:+HeapDumpOnOutOfMemoryError -Xmx3g`nkotlin.daemon.jvmargs=-Dfile.encoding=UTF-8 -XX:+UseG1GC -XX:SoftRefLRUPolicyMSPerMB=1 -XX:ReservedCodeCacheSize=320m -XX:+HeapDumpOnOutOfMemoryError -Xmx2g`n"
          [IO.File]::WriteAllText($gradleMemoryOverridePath, $gradleMemoryOverrideContent, [Text.UTF8Encoding]::new($false))
          $gradleMemoryOverrideSha256 = (Get-FileHash -LiteralPath $gradleMemoryOverridePath -Algorithm SHA256).Hash.ToLowerInvariant()

          $cloneParameters = @{
            FileName = [string]$git
            Arguments = [string[]]@('clone', '--no-local', '--no-hardlinks', '--quiet', $SourceTemplateDir, $cloneRoot)
            WorkingDirectory = [string]$ProbeRoot
            EnvironmentVariables = [hashtable]$environment
            TimeoutSeconds = [int]300
          }
          $clone = & $script:E1InternalBoundedProcess @cloneParameters
          if ($clone.exit_code -ne 0 -or -not $clone.cleanup_ok) { throw 'gradle_diagnostic_probe_clone_failed' }

          $gradlew = Join-Path $cloneRoot 'gradlew.bat'
          if (-not (Test-Path -LiteralPath $gradlew)) { throw 'gradle_diagnostic_probe_gradlew_missing' }

          # The exact three diagnostic invocations -- P1/P3 deliberately omit --offline
          # (that absence is the whole point of the diagnosis); P2 is P1 plus --offline.
          $gradleArgs = switch ($ProbeMode) {
            'tasks-probe'         { @('tasks', '--all', '--quiet') }
            'tasks-probe-offline' { @('tasks', '--all', '--quiet', '--offline') }
            'core-domain-test'    { @(':core:domain:test') }
          }

          # A window well past the product's own 60s default (lib/project/cache.js's
          # DEFAULT_PROBE_TIMEOUT_MS) so a slow-but-eventually-completing probe reports its real
          # wall time here instead of being cut off at the exact boundary being investigated.
          $started = Get-Date
          $task = & $script:E1InternalBoundedProcess -FileName $gradlew -Arguments $gradleArgs `
            -WorkingDirectory $cloneRoot -EnvironmentVariables $environment -TimeoutSeconds 180
          $wallTimeMs = [int](((Get-Date) - $started).TotalMilliseconds)

          # Same GRADLE_USER_HOME as the probe itself -- stops any daemon this probe started so it
          # can never linger into (or contend with) a later probe run against a different clone.
          $null = & $script:E1InternalBoundedProcess -FileName $gradlew -Arguments @('--stop') `
            -WorkingDirectory $cloneRoot -EnvironmentVariables $environment -TimeoutSeconds 60

          # Gradle's own --version banner reports both the Gradle version and the Kotlin
          # (embedded) version in one call -- exactly the pair the daemon-failure diagnosis
          # needed, without adding a caller-controlled argument to fetch it.
          $versionResult = & $script:E1InternalBoundedProcess -FileName $gradlew -Arguments @('--version') `
            -WorkingDirectory $cloneRoot -EnvironmentVariables $environment -TimeoutSeconds 60

          $combined = ([string]$task.stdout + "`n" + [string]$task.stderr)
          $succeeded = [bool]($task.cleanup_ok -and $task.exit_code -eq 0)
          [ordered]@{
            verdict = $(if ($succeeded) { 'PASS' } else { 'FAIL' })
            reason_code = $(if ($succeeded) { $null } else { 'gradle_diagnostic_probe_task_failed' })
            exit_code = [int]$task.exit_code
            wall_time_ms = $wallTimeMs
            output_tail = @(Get-E1GuestBundleDiagnosticTailLines $combined)
            output_head = @(Get-E1GuestBundleDiagnosticHeadLines $combined)
            gradle_version_output = [string]$versionResult.stdout
            exception_type = $null
            exception_message = $null
            exception_stack_trace = $null
            long_path_delete_entries_removed = $longPathDeleteMaxLength
            gradle_memory_override_sha256 = $gradleMemoryOverrideSha256
          }
        } catch {
          $boundedMessage = [string]$_.Exception.Message
          if ($boundedMessage.Length -gt 4000) { $boundedMessage = $boundedMessage.Substring(0, 4000) + '...(truncated)' }
          $boundedStack = [string]$_.ScriptStackTrace
          if ($boundedStack.Length -gt 4000) { $boundedStack = $boundedStack.Substring(0, 4000) + '...(truncated)' }
          [ordered]@{
            verdict = 'FAIL'
            reason_code = 'bundle_exception'
            exit_code = $null
            wall_time_ms = $null
            output_tail = @()
            output_head = @()
            gradle_version_output = $null
            exception_type = [string]$_.Exception.GetType().FullName
            exception_message = $boundedMessage
            exception_stack_trace = $boundedStack
            long_path_delete_entries_removed = $null
            gradle_memory_override_sha256 = $gradleMemoryOverrideSha256
          }
        }
      }
    }

    # The canonical Evidence1 session worker.  This is deliberately an
    # internal-only registry entry: callers can name a reviewed bundle and
    # pass serialized data, but never a command, script, or host path.  The
    # worker validates that the supplied cell belongs to CurrentCampaignInputs
    # before it can reach the harness.
    'run-agentic-eval-session' = [ordered]@{
      description     = 'Internal: execute exactly one manifest-enumerated Evidence1 campaign cell inside the disposable guest.'
      argument_schema = [ordered]@{
        CurrentCampaignInputsJson = { param($v) $v -is [string] -and $v.Length -ge 2 -and $v.Length -le 65536 }
        CellJson = { param($v) $v -is [string] -and $v.Length -ge 2 -and $v.Length -le 4096 }
      }
      result_keys = @('schema', 'runtime_id', 'model_id', 'round_index', 'session_id', 'started_at_utc', 'completed_at_utc', 'exit_code', 'verdict', 'reason_code', 'output_summary')
      scriptblock = {
        param($CurrentCampaignInputsJson, $CellJson)
        Set-StrictMode -Version Latest
        $ErrorActionPreference = 'Stop'
        try {
          $currentCampaignInputs = $CurrentCampaignInputsJson | ConvertFrom-Json -ErrorAction Stop
          $cell = $CellJson | ConvertFrom-Json -ErrorAction Stop
        } catch { throw 'agentic_eval_session_arguments_invalid' }
        $harnessDir = [string]$currentCampaignInputs.harness_dir
        if ([string]::IsNullOrWhiteSpace($harnessDir)) { throw 'agentic_eval_session_harness_missing' }
        $worker = Join-Path $harnessDir 'docs\audits\evidence1-dual-condition-canary-launch.ps1'
        if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) { throw 'agentic_eval_session_worker_missing' }
        # PowerShell Direct sessions inherit the guest's machine policy, which
        # can reject even a dot-sourced script from the synchronized harness.
        # Limit the override to this ephemeral remoting process; no user or
        # machine policy is persisted or weakened.
        Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
        # Root cause: $harnessDir is the only worker-param
        # overlap this scriptblock holds before the dot-source (traced: every read
        # inside Invoke-E1DualConditionCanarySession and its callees below goes
        # through $CurrentCampaignInputs.harness_dir/.source_template_dir, never a
        # bare $HarnessDir/$SourceTemplateDir -- this is what keeps a live session
        # safe today) -- passed explicitly anyway so it stays true if that ever
        # changes, matching every other dot-source site's fix.
        . $worker -InternalLibrary -HarnessDir $harnessDir
        Invoke-E1DualConditionCanarySession -CurrentCampaignInputs $currentCampaignInputs -Cell $cell
      }
    }

    'get-dual-condition-plan-bindings' = [ordered]@{
      description     = 'Dry-run only: normalize the injected campaign references and report observed source provenance.'
      argument_schema = [ordered]@{
        HarnessDir = { param($v) $v -is [string] -and $v -match '^[A-Za-z]:\\' }
        SourceTemplateDir = { param($v) $v -is [string] -and $v -match '^[A-Za-z]:\\' }
        ClaudeAttestationFile = { param($v) $v -is [string] -and $v -match '^[A-Za-z]:\\' }
        CodexAttestationFile = { param($v) $v -is [string] -and $v -match '^[A-Za-z]:\\' }
        ReadinessPath = { param($v) $v -is [string] -and $v -match '^[A-Za-z]:\\' }
        PrivateRoot = { param($v) $v -is [string] -and $v -match '^[A-Za-z]:\\' }
        ProviderTimeoutSeconds = { param($v) (($v -is [int]) -or ($v -is [long])) -and $v -ge 1 -and $v -le 86400 }
      }
      result_keys      = @('harness_dir', 'source_template_dir', 'claude_attestation_file', 'codex_attestation_file', 'readiness_path', 'private_root', 'provider_timeout_seconds', 'observed_provenance', 'inference_sessions_consumed')
      scriptblock      = {
        param($HarnessDir, $SourceTemplateDir, $ClaudeAttestationFile, $CodexAttestationFile, $ReadinessPath, $PrivateRoot, $ProviderTimeoutSeconds)
        Set-StrictMode -Version Latest
        $ErrorActionPreference = 'Stop'

        function Resolve-E1ObservedReference([string]$Path, [bool]$MustExist) {
          $full = [IO.Path]::GetFullPath($Path)
          if ($MustExist -and -not (Test-Path -LiteralPath $full)) { throw 'dual_condition_plan_input_missing' }
          return $full
        }
        function Get-E1ObservedGitReference([string]$Root, [string]$Revision) {
          $git = Get-Command git.exe -ErrorAction SilentlyContinue
          if ($null -eq $git) { return $null }
          $previousPreference = $ErrorActionPreference
          try {
            $ErrorActionPreference = 'Continue'
            $value = [string](& $git.Source -C $Root rev-parse $Revision 2>$null | Select-Object -First 1)
            if ($LASTEXITCODE -ne 0) { return $null }
            return $value.Trim()
          } finally { $ErrorActionPreference = $previousPreference }
        }

        $harness = Resolve-E1ObservedReference $HarnessDir $true
        $source = Resolve-E1ObservedReference $SourceTemplateDir $true
        $claudeAttestation = Resolve-E1ObservedReference $ClaudeAttestationFile $true
        $codexAttestation = Resolve-E1ObservedReference $CodexAttestationFile $true
        $readiness = Resolve-E1ObservedReference $ReadinessPath $true
        $private = Resolve-E1ObservedReference $PrivateRoot $false
        [ordered]@{
          harness_dir = $harness
          source_template_dir = $source
          claude_attestation_file = $claudeAttestation
          codex_attestation_file = $codexAttestation
          readiness_path = $readiness
          private_root = $private
          provider_timeout_seconds = [int]$ProviderTimeoutSeconds
          observed_provenance = [ordered]@{
            harness_commit = Get-E1ObservedGitReference $harness 'HEAD'
            harness_tree = Get-E1ObservedGitReference $harness 'HEAD^{tree}'
            source_commit = Get-E1ObservedGitReference $source 'HEAD'
            source_tree = Get-E1ObservedGitReference $source 'HEAD^{tree}'
          }
          inference_sessions_consumed = 0
        }
      }
    }

    'prepare-agentic-eval-isolation-attestations' = [ordered]@{
      description     = 'Create fresh Claude and Codex isolation attestations for the synchronized harness without consuming inference.'
      argument_schema = [ordered]@{
        HarnessCommit = { param($v) $v -is [string] -and $v -cmatch '^[0-9a-f]{40}$' }
        CampaignId = { param($v) $v -is [string] -and $v -cmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$' }
        ClaudeAttestationFile = { param($v) $v -is [string] -and $v -cmatch '^C:\\kmp-eval\\measurement-scopes\\[^\\]+\.json$' }
        CodexAttestationFile = { param($v) $v -is [string] -and $v -cmatch '^C:\\kmp-eval\\measurement-scopes\\[^\\]+\.json$' }
      }
      result_keys      = @('harness_commit', 'expires_at', 'inference_sessions_consumed')
      scriptblock      = {
        param($HarnessCommit, $CampaignId, $ClaudeAttestationFile, $CodexAttestationFile)
        Set-StrictMode -Version Latest
        $ErrorActionPreference = 'Stop'

        function Write-E1IsolationAttestation([string]$Path, [string]$RuntimeId, [string]$CreatedAt, [string]$ExpiresAt) {
          $parent = Split-Path -Parent $Path
          New-Item -ItemType Directory -Force -Path $parent | Out-Null
          $value = [ordered]@{
            schema = 1; profile_id = 'sandboxed-unrestricted-v1'; runtime_id = $RuntimeId
            campaign_id = $CampaignId; platform = 'windows'; boundary_kind = 'dedicated-ephemeral-runner'
            network_mode = 'restricted'; workspace_scope = 'campaign-only'; runtime_credential_scope = 'runtime-only'
            normal_maintainer_home_mounted = $false; ambient_secrets_present = $false
            disposable_home = $true; rollback_or_destroy_required = $true; harness_sha = $HarnessCommit
            created_at = $CreatedAt; expires_at = $ExpiresAt
          }
          $temporary = $Path + '.tmp-' + [guid]::NewGuid().ToString('N')
          try {
            [IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
            Move-Item -LiteralPath $temporary -Destination $Path -Force
          } finally {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
          }
        }

        $now = [DateTime]::UtcNow
        $createdAt = $now.ToString('yyyy-MM-ddTHH:mm:ssZ')
        $expiresAt = $now.AddHours(23).ToString('yyyy-MM-ddTHH:mm:ssZ')
        Write-E1IsolationAttestation $ClaudeAttestationFile 'claude-code' $createdAt $expiresAt
        Write-E1IsolationAttestation $CodexAttestationFile 'codex-cli' $createdAt $expiresAt
        [ordered]@{
          harness_commit = $HarnessCommit
          expires_at = $expiresAt
          inference_sessions_consumed = 0
        }
      }
    }

    'refresh-codex-isolation-attestation' = [ordered]@{
      description     = 'Refresh the guest Codex isolation attestation from the current verified Claude attestation; consumes no inference session.'
      argument_schema = [ordered]@{}
      result_keys      = @('attestation_refreshed', 'harness_sha', 'attestation_sha256', 'expires_at', 'inference_sessions_consumed')
      scriptblock      = {
        Set-StrictMode -Version Latest
        $ErrorActionPreference = 'Stop'
        $harness = 'C:\kmp-eval\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1'
        $git = 'C:\Evidence1Toolchain\git\2.55.0.windows.5\cmd\git.exe'
        $sourcePath = 'C:\kmp-eval\measurement-scopes\evidence1-claude-windows-isolation-attestation-stageb-v1.json'
        $destinationPath = 'C:\kmp-eval\measurement-scopes\evidence1-codex-windows-isolation-attestation.json'
        foreach ($path in @($harness, $git, $sourcePath)) { if (-not (Test-Path -LiteralPath $path)) { throw 'codex_attestation_input_missing' } }
        $source = Get-Content -LiteralPath $sourcePath -Raw | ConvertFrom-Json -ErrorAction Stop
        $head = ([string](& $git -C $harness rev-parse HEAD 2>$null | Select-Object -First 1)).Trim()
        $expires = [datetime]::MinValue
        if (-not [datetime]::TryParse([string]$source.expires_at, [ref]$expires) -or
            $source.schema -ne 1 -or [string]$source.profile_id -cne 'sandboxed-unrestricted-v1' -or
            [string]$source.runtime_id -cne 'claude-code' -or [string]$source.platform -cne 'windows' -or
            [string]$source.network_mode -cne 'restricted' -or [string]$source.harness_sha -cne $head -or
            $source.normal_maintainer_home_mounted -ne $false -or $source.ambient_secrets_present -ne $false -or
            $source.disposable_home -ne $true -or $source.rollback_or_destroy_required -ne $true -or
            $expires.ToUniversalTime() -le [datetime]::UtcNow.AddMinutes(5)) { throw 'codex_attestation_source_invalid' }
        $expectedExpires = $expires.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        $persisted = $null
        $refreshed = $false
        if (Test-Path -LiteralPath $destinationPath -PathType Leaf) {
          try { $candidate = Get-Content -LiteralPath $destinationPath -Raw | ConvertFrom-Json -ErrorAction Stop }
          catch { $candidate = $null }
          $candidateCreated = [datetime]::MinValue
          if ($null -ne $candidate -and
              [datetime]::TryParse([string]$candidate.created_at, [ref]$candidateCreated) -and
              $candidateCreated.ToUniversalTime() -le [datetime]::UtcNow -and
              $candidate.schema -eq 1 -and [string]$candidate.profile_id -ceq 'sandboxed-unrestricted-v1' -and
              [string]$candidate.runtime_id -ceq 'codex-cli' -and
              [string]$candidate.campaign_id -ceq 'evidence1-dual-condition-canary' -and
              [string]$candidate.platform -ceq 'windows' -and
              [string]$candidate.boundary_kind -ceq [string]$source.boundary_kind -and
              [string]$candidate.network_mode -ceq 'restricted' -and
              [string]$candidate.workspace_scope -ceq [string]$source.workspace_scope -and
              [string]$candidate.runtime_credential_scope -ceq [string]$source.runtime_credential_scope -and
              $candidate.normal_maintainer_home_mounted -eq $false -and $candidate.ambient_secrets_present -eq $false -and
              $candidate.disposable_home -eq $true -and $candidate.rollback_or_destroy_required -eq $true -and
              [string]$candidate.harness_sha -ceq $head -and [string]$candidate.expires_at -ceq $expectedExpires) {
            $persisted = $candidate
          }
        }
        if ($null -eq $persisted) {
          $now = [datetime]::UtcNow
          $value = [ordered]@{
            schema = 1; profile_id = 'sandboxed-unrestricted-v1'; runtime_id = 'codex-cli'
            campaign_id = 'evidence1-dual-condition-canary'; platform = 'windows'
            boundary_kind = [string]$source.boundary_kind; network_mode = 'restricted'
            workspace_scope = [string]$source.workspace_scope; runtime_credential_scope = [string]$source.runtime_credential_scope
            normal_maintainer_home_mounted = $false; ambient_secrets_present = $false
            disposable_home = $true; rollback_or_destroy_required = $true; harness_sha = $head
            created_at = $now.ToString('yyyy-MM-ddTHH:mm:ssZ'); expires_at = $expectedExpires
          }
          $temporary = $destinationPath + '.tmp'
          [IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
          Move-Item -LiteralPath $temporary -Destination $destinationPath -Force
          $persisted = Get-Content -LiteralPath $destinationPath -Raw | ConvertFrom-Json -ErrorAction Stop
          $refreshed = $true
        }

        function Get-TextSha([string]$Value) {
          $sha = [Security.Cryptography.SHA256]::Create()
          try { return -join ($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Value)) | ForEach-Object { $_.ToString('x2') }) }
          finally { $sha.Dispose() }
        }
        function ConvertTo-CanonicalJson($Value) {
          if ($null -eq $Value) { return 'null' }
          if ($Value -is [string]) { return ConvertTo-Json -InputObject $Value -Compress }
          if ($Value -is [bool]) { return $(if ($Value) { 'true' } else { 'false' }) }
          if (($Value -is [int]) -or ($Value -is [long])) { return $Value.ToString([Globalization.CultureInfo]::InvariantCulture) }
          if ($Value -is [Collections.IDictionary]) { [string[]]$names=@($Value.Keys|ForEach-Object{[string]$_});[Array]::Sort($names,[StringComparer]::Ordinal);return '{'+(($names|ForEach-Object{"$(ConvertTo-CanonicalJson $_):$(ConvertTo-CanonicalJson $Value[$_])"})-join',')+'}' }
          if ($Value -is [pscustomobject]) { [string[]]$names=@($Value.PSObject.Properties.Name);[Array]::Sort($names,[StringComparer]::Ordinal);return '{'+(($names|ForEach-Object{"$(ConvertTo-CanonicalJson $_):$(ConvertTo-CanonicalJson $Value.$_)"})-join',')+'}' }
          if ($Value -is [Collections.IEnumerable]) { return '['+((@($Value)|ForEach-Object{ConvertTo-CanonicalJson $_})-join',')+']' }
          throw 'codex_attestation_canonical_json'
        }
        [ordered]@{
          attestation_refreshed = $refreshed; harness_sha = $head
          attestation_sha256 = Get-TextSha (ConvertTo-CanonicalJson $persisted)
          expires_at = [string]$persisted.expires_at; inference_sessions_consumed = 0
        }
      }
    }
  }
}

Export-ModuleMember -Function `
  Get-E1GuestBundleNames, `
  Assert-E1GuestBundleName, `
  Assert-E1GuestBundleArguments, `
  Assert-E1GuestBundleResultShape, `
  Get-E1GuestBundleRegistry, `
  Get-E1GuestBundleArgumentValue
