param(
  [ValidateSet('Bootstrap', 'Verify')]
  [string]$Mode = 'Verify',
  [string]$ProfilePath = '',
  [Parameter(Mandatory = $true)] [string]$InputLockPath,
  [Parameter(Mandatory = $true)] [string]$GuestCredentialPath,
  [ValidateSet('true','false')] [string]$RecoverUnauthenticatedProbeState = 'false',
  [string]$ReceiptPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$AllowedHandlers = @('git-portable-zip', 'node-portable-zip', 'jdk-portable-zip', 'android-sdk-zip', 'claude-npm-zip', 'codex-single-exe')
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($ProfilePath)) { $ProfilePath = Join-Path $scriptRoot 'evidence1-windows-hyperv-v1.json' }
Import-Module (Join-Path $scriptRoot 'Evidence1.Provisioning.psm1') -Force
$recoverProbeState = $RecoverUnauthenticatedProbeState -ceq 'true'

function Fail([string]$Code) { Write-Error "HARD STOP: $Code"; exit 1 }

$session = $null
$results = @()
$mutationPerformed = $false
$transactionId = [guid]::NewGuid().ToString('N')
$rollbackComplete = $null
$guestSetup = $null
try {
  $scratchRoots = @('C:\kmp-eval\scratch', [IO.Path]::GetTempPath())
  $receiptFull = New-E1ReceiptPath $ReceiptPath ("toolchain-" + $Mode.ToLowerInvariant())
  $credentialFull = Assert-E1PathInside $GuestCredentialPath $scratchRoots 'guest_credential_path_outside_scratch'
$plan = Get-E1ProvisioningPlan $ProfilePath $InputLockPath -AllowSealedRuntimeCommitDrift
  $profile = $plan.profile
  $profileSha = Get-E1Sha256 $ProfilePath
  $inputLockSha = Get-E1Sha256 $InputLockPath
  Assert-E1Administrator
  if (-not (Test-Path -LiteralPath $credentialFull -PathType Leaf)) { throw 'guest_credential_missing' }
  Import-Module Hyper-V -ErrorAction Stop
  $vm = Get-VM -Name $profile.vm.name -ErrorAction SilentlyContinue
  if (-not $vm) { throw 'vm_missing' }
  if ($vm.State -ne 'Running') { throw 'vm_must_be_running' }
  $networkBefore = @(Get-VMNetworkAdapter -VM $vm)
  if ($networkBefore.Count -ne 1 -or -not [string]::IsNullOrWhiteSpace([string]$networkBefore[0].SwitchName)) {
    throw 'vm_network_not_disconnected'
  }
  $stored = Import-Clixml -LiteralPath $credentialFull
  if ([string]$stored.UserName -cne [string]$profile.guest.local_user) { throw 'guest_credential_identity_mismatch' }
  $credential = [pscredential]::new("$($profile.guest.computer_name)\$($stored.UserName)", $stored.Password)
  $session = New-PSSession -VMName $profile.vm.name -Credential $credential -ErrorAction Stop
  $guestSetup = Invoke-Command -Session $session -ScriptBlock {
    param($Mode,$Profile,$RecoverUnauthenticatedProbeState)
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    if ($env:COMPUTERNAME -ine [string]$Profile.guest.computer_name) { throw 'guest_computer_identity_mismatch' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if ($identity.Name.Split('\')[-1] -cne [string]$Profile.guest.local_user) { throw 'guest_user_identity_mismatch' }
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'guest_administrator_required' }
    $priorUserEnvironment = [ordered]@{
      Path = [Environment]::GetEnvironmentVariable('Path', 'User')
      CODEX_HOME = [Environment]::GetEnvironmentVariable('CODEX_HOME', 'User')
      CLAUDE_CONFIG_DIR = [Environment]::GetEnvironmentVariable('CLAUDE_CONFIG_DIR', 'User')
      ANDROID_HOME = [Environment]::GetEnvironmentVariable('ANDROID_HOME', 'User')
      ANDROID_SDK_ROOT = [Environment]::GetEnvironmentVariable('ANDROID_SDK_ROOT', 'User')
    }
    $createdStatePaths = @()
    if ($RecoverUnauthenticatedProbeState) {
      foreach ($runtime in @($Profile.toolchain)) {
        $runtimeRoot = Join-Path $Profile.guest.toolchain_root "$($runtime.id)\$($runtime.version)"
        if (Test-Path -LiteralPath $runtimeRoot) { throw 'auth_state_recovery_toolchain_present' }
      }
    }
    $statePaths = @([string]$Profile.guest.codex_home, [string]$Profile.guest.claude_config_dir)
    foreach ($statePath in $statePaths) {
      if (Test-Path -LiteralPath $statePath) {
        if (@(Get-ChildItem -LiteralPath $statePath -Force -ErrorAction Stop).Count -ne 0) {
          if (-not $RecoverUnauthenticatedProbeState) { throw 'auth_state_not_empty' }
          $reparse = @(Get-ChildItem -LiteralPath $statePath -Recurse -Force -ErrorAction Stop | Where-Object {
            ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
          })
          if ($reparse.Count -ne 0) { throw 'auth_state_recovery_reparse_rejected' }
          Remove-Item -LiteralPath $statePath -Recurse -Force
          New-Item -ItemType Directory -Force -Path $statePath | Out-Null
          $createdStatePaths += $statePath
        }
      } elseif ($Mode -ceq 'Bootstrap') {
        New-Item -ItemType Directory -Force -Path $statePath | Out-Null
        $createdStatePaths += $statePath
      } else { throw 'auth_state_missing' }
    }
    $env:CODEX_HOME = [string]$Profile.guest.codex_home
    $env:CLAUDE_CONFIG_DIR = [string]$Profile.guest.claude_config_dir
    $forbiddenNames = @($Profile.guest.forbidden_environment_names)
    $forbiddenPrefixes = @($Profile.guest.forbidden_environment_prefixes)
    $presentNames = @(Get-ChildItem Env: | Where-Object {
      $name = [string]$_.Name
      ($name -cin $forbiddenNames) -or @($forbiddenPrefixes | Where-Object { $name.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
    })
    if ($presentNames.Count -ne 0) { throw 'credential_environment_override_present' }
    [ordered]@{
      identity = [ordered]@{
        computer_name = [string]$env:COMPUTERNAME
        local_user = [string]$Profile.guest.local_user
        user_sid = [string]$identity.User.Value
        administrator = $true
      }
      prior_user_environment = $priorUserEnvironment
      created_state_paths = $createdStatePaths
      recovered_unauthenticated_probe_state = $RecoverUnauthenticatedProbeState
    }
  } -ArgumentList $Mode,$profile,$recoverProbeState
  if ([bool]$guestSetup.recovered_unauthenticated_probe_state) { $mutationPerformed = $true }
  $probePath = @($profile.toolchain | ForEach-Object {
    Join-Path "$($profile.guest.toolchain_root)\$($_.id)\$($_.version)" $_.path_relative
  }) -join ';'

  foreach ($runtime in $profile.toolchain) {
    if ($runtime.install_handler -notin $AllowedHandlers) { throw 'unsupported_install_handler' }
    $artifact = @($plan.artifacts | Where-Object id -eq $runtime.id)
    if ($artifact.Count -ne 1) { throw 'artifact_identity_mismatch' }
    $stageExtension = if ($runtime.install_handler -ceq 'codex-single-exe') { '.exe' } else { '.zip' }
    $guestStage = "$($profile.guest.staging_root)\$($runtime.id)$stageExtension"
    if ($Mode -ceq 'Bootstrap') {
      Invoke-Command -Session $session -ScriptBlock {
        param($Stage)
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Stage) | Out-Null
        Remove-Item -LiteralPath $Stage -Force -ErrorAction SilentlyContinue
      } -ArgumentList $guestStage
      Copy-Item -ToSession $session -LiteralPath $artifact[0].source_path -Destination $guestStage
    }

    $result = Invoke-Command -Session $session -ScriptBlock {
      param($Mode,$Runtime,$GuestStage,$ExpectedSha,$ExpectedBytes,$ToolchainRoot,$ProbePath,$TransactionId)
      Set-StrictMode -Version Latest
      $ErrorActionPreference = 'Stop'
      $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
      $env:Path = @($ProbePath, $machinePath) -join ';'

      function Get-Sha256([string]$Path) {
        $stream = [IO.File]::OpenRead($Path)
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try { return (([BitConverter]::ToString($algorithm.ComputeHash($stream))) -replace '-', '').ToLowerInvariant() }
        finally { $algorithm.Dispose(); $stream.Dispose() }
      }
      function Invoke-VersionProbe([string]$CommandPath, $Runtime) {
        $prior = $ErrorActionPreference
        $priorCodexHome = $env:CODEX_HOME
        $priorClaudeConfigDir = $env:CLAUDE_CONFIG_DIR
        $probeRoot = Join-Path $env:TEMP ('Evidence1CliProbe-' + [guid]::NewGuid().ToString('N'))
        try {
          New-Item -ItemType Directory -Path $probeRoot | Out-Null
          $env:CODEX_HOME = Join-Path $probeRoot 'codex'
          $env:CLAUDE_CONFIG_DIR = Join-Path $probeRoot 'claude'
          New-Item -ItemType Directory -Path $env:CODEX_HOME,$env:CLAUDE_CONFIG_DIR | Out-Null
          $ErrorActionPreference = 'Continue'
          $output = @(& $CommandPath $Runtime.version_argument 2>&1)
          $exitCode = $LASTEXITCODE
        } finally {
          $ErrorActionPreference = $prior
          $env:CODEX_HOME = $priorCodexHome
          $env:CLAUDE_CONFIG_DIR = $priorClaudeConfigDir
          if (Test-Path -LiteralPath $probeRoot) { Remove-Item -LiteralPath $probeRoot -Recurse -Force }
        }
        $text = ($output -join "`n").Trim()
        if ($exitCode -ne 0 -or $text -notmatch $Runtime.version_pattern) { throw 'runtime_version_mismatch' }
        if ($text -notmatch $Runtime.version_capture_pattern -or -not $Matches.ContainsKey('version')) {
          throw 'runtime_version_resolution_failed'
        }
        return [string]$Matches.version
      }
      function Assert-PublisherSignature([string]$CommandPath, $Runtime) {
        if ($Runtime.id -ne 'codex-cli') { return }
        $signature = Get-AuthenticodeSignature -LiteralPath $CommandPath -ErrorAction Stop
        if ([string]$signature.Status -cne 'Valid' -or -not $signature.SignerCertificate -or
            [string]$signature.SignerCertificate.Subject -cne [string]$Runtime.authenticode_subject) {
          throw 'codex_publisher_signature_invalid'
        }
      }
      function Get-TreeIdentity([string]$Root) {
        $files = @(Get-ChildItem -LiteralPath $Root -Recurse -Force -File | Where-Object Name -ne '.evidence1-artifact.json' | Sort-Object FullName)
        $builder = [Text.StringBuilder]::new()
        [int64]$totalBytes = 0
        foreach ($file in $files) {
          $relative = $file.FullName.Substring($Root.Length).TrimStart('\').Replace('\','/')
          $fileSha = Get-Sha256 $file.FullName
          $null = $builder.Append($relative).Append("`0").Append($file.Length).Append("`0").Append($fileSha).Append("`n")
          $totalBytes += $file.Length
        }
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try {
          $digest = $algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($builder.ToString()))
          $treeSha = ([BitConverter]::ToString($digest) -replace '-', '').ToLowerInvariant()
        } finally { $algorithm.Dispose() }
        return [ordered]@{ sha256 = $treeSha; file_count = $files.Count; bytes = $totalBytes }
      }

      $root = Join-Path $ToolchainRoot "$($Runtime.id)\$($Runtime.version)"
      $marker = Join-Path $root '.evidence1-artifact.json'
      $changed = $false
      if ($Mode -ceq 'Bootstrap') {
        $stage = Get-Item -LiteralPath $GuestStage -ErrorAction Stop
        $sha = Get-Sha256 $GuestStage
        if ($stage.Length -ne $ExpectedBytes -or $sha -cne $ExpectedSha) { throw 'guest_artifact_identity_mismatch' }
        if (Test-Path -LiteralPath $marker -PathType Leaf) {
          $prior = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
          if ($prior.sha256 -cne $ExpectedSha -or $prior.version -cne $Runtime.version) { throw 'installed_runtime_drift' }
        } elseif (Test-Path -LiteralPath $root) {
          throw 'unmanaged_runtime_destination'
        } else {
          $parent = Split-Path -Parent $root
          New-Item -ItemType Directory -Force -Path $parent | Out-Null
          $incoming = Join-Path $parent ('.incoming-' + [guid]::NewGuid().ToString('N'))
          try {
            New-Item -ItemType Directory -Path $incoming | Out-Null
            if ($Runtime.install_handler -eq 'codex-single-exe') {
              Copy-Item -LiteralPath $GuestStage -Destination (Join-Path $incoming 'codex.exe')
            } else {
              Expand-Archive -LiteralPath $GuestStage -DestinationPath $incoming
            }
            $incomingCommand = Join-Path $incoming $Runtime.command_relative
            if (-not (Test-Path -LiteralPath $incomingCommand -PathType Leaf)) { throw 'runtime_archive_layout_mismatch' }
            if ($Runtime.PSObject.Properties.Name -contains 'required_files') {
              foreach ($requiredFile in @($Runtime.required_files)) {
                if (-not (Test-Path -LiteralPath (Join-Path $incoming ([string]$requiredFile)) -PathType Leaf)) {
                  throw 'runtime_archive_layout_mismatch'
                }
              }
            }
            $null = Invoke-VersionProbe $incomingCommand $Runtime
            Assert-PublisherSignature $incomingCommand $Runtime
            $tree = Get-TreeIdentity $incoming
            [IO.File]::WriteAllText(
              (Join-Path $incoming '.evidence1-artifact.json'),
              (@{
                id=$Runtime.id; version=$Runtime.version; sha256=$ExpectedSha; bytes=$ExpectedBytes
                installed_tree_sha256=$tree.sha256; installed_file_count=$tree.file_count; installed_bytes=$tree.bytes
                transaction_id=$TransactionId
              } | ConvertTo-Json),
              [Text.UTF8Encoding]::new($false)
            )
            Move-Item -LiteralPath $incoming -Destination $root
            $changed = $true
          } finally {
            if ($incoming -and (Test-Path -LiteralPath $incoming)) { Remove-Item -LiteralPath $incoming -Recurse -Force }
          }
        }
        Remove-Item -LiteralPath $GuestStage -Force -ErrorAction SilentlyContinue
      }

      if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { throw 'runtime_not_bootstrapped' }
      $installed = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
      if ($installed.sha256 -cne $ExpectedSha -or $installed.version -cne $Runtime.version -or $installed.bytes -ne $ExpectedBytes) {
        throw 'installed_runtime_drift'
      }
      $installedTree = Get-TreeIdentity $root
      if ($installed.installed_tree_sha256 -cne $installedTree.sha256 -or
          $installed.installed_file_count -ne $installedTree.file_count -or $installed.installed_bytes -ne $installedTree.bytes) {
        throw 'installed_runtime_tree_drift'
      }
      $commandPath = Join-Path $root $Runtime.command_relative
      if (-not (Test-Path -LiteralPath $commandPath -PathType Leaf)) { throw 'runtime_command_missing' }
      if ($Runtime.PSObject.Properties.Name -contains 'required_files') {
        foreach ($requiredFile in @($Runtime.required_files)) {
          if (-not (Test-Path -LiteralPath (Join-Path $root ([string]$requiredFile)) -PathType Leaf)) {
            throw 'runtime_required_file_missing'
          }
        }
      }
      $resolvedVersion = Invoke-VersionProbe $commandPath $Runtime
      $helpVerified = $null
      $publisherVerified = $null
      $secondaryVersions = @()
      if ($Runtime.PSObject.Properties.Name -contains 'secondary_commands') {
        foreach ($secondary in @($Runtime.secondary_commands)) {
          $secondaryPath = Join-Path $root $secondary.command_relative
          if (-not (Test-Path -LiteralPath $secondaryPath -PathType Leaf)) { throw 'runtime_secondary_command_missing' }
          $secondaryVersion = Invoke-VersionProbe $secondaryPath $secondary
          $secondaryVersions += [ordered]@{ id = $secondary.id; resolved_version = $secondaryVersion }
        }
      }
      if ($Runtime.id -eq 'codex-cli') {
        $prior = $ErrorActionPreference
        $priorCodexHome = $env:CODEX_HOME
        $priorClaudeConfigDir = $env:CLAUDE_CONFIG_DIR
        $probeRoot = Join-Path $env:TEMP ('Evidence1CliProbe-' + [guid]::NewGuid().ToString('N'))
        try {
          New-Item -ItemType Directory -Path $probeRoot | Out-Null
          $env:CODEX_HOME = Join-Path $probeRoot 'codex'
          $env:CLAUDE_CONFIG_DIR = Join-Path $probeRoot 'claude'
          New-Item -ItemType Directory -Path $env:CODEX_HOME,$env:CLAUDE_CONFIG_DIR | Out-Null
          $ErrorActionPreference = 'Continue'
          $helpOutput = @(& $commandPath --help 2>&1)
          $helpExit = $LASTEXITCODE
        } finally {
          $ErrorActionPreference = $prior
          $env:CODEX_HOME = $priorCodexHome
          $env:CLAUDE_CONFIG_DIR = $priorClaudeConfigDir
          if (Test-Path -LiteralPath $probeRoot) { Remove-Item -LiteralPath $probeRoot -Recurse -Force }
        }
        if ($helpExit -ne 0 -or $helpOutput.Count -lt 1) { throw 'codex_help_probe_failed' }
        $helpVerified = $true
        Assert-PublisherSignature $commandPath $Runtime
        $publisherVerified = $true
      }
      [ordered]@{
        id=$Runtime.id; version=$Runtime.version; install_handler=$Runtime.install_handler
        artifact_sha256=$ExpectedSha; artifact_bytes=$ExpectedBytes; resolved_version=$resolvedVersion
        installed_tree_sha256=$installedTree.sha256; installed_file_count=$installedTree.file_count
        installed_bytes=$installedTree.bytes; secondary_versions=$secondaryVersions
        changed=$changed; verified=$true; help_verified=$helpVerified; publisher_verified=$publisherVerified
      }
    } -ArgumentList $Mode,$runtime,$guestStage,$artifact[0].sha256,$artifact[0].bytes,$profile.guest.toolchain_root,$probePath,$transactionId
    $results += $result
    if ([bool]$result.changed) { $mutationPerformed = $true }
  }

  $environment = Invoke-Command -Session $session -ScriptBlock {
    param($Mode,$Profile)
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'
    $paths = @($Profile.toolchain | ForEach-Object {
      Join-Path "$($Profile.guest.toolchain_root)\$($_.id)\$($_.version)" $_.path_relative
    })
    $canonicalPath = $paths -join ';'
    $codexHome = [string]$Profile.guest.codex_home
    $claudeConfigDir = [string]$Profile.guest.claude_config_dir
    if ($Mode -ceq 'Bootstrap') {
      if (Test-Path -LiteralPath $codexHome) {
        if (@(Get-ChildItem -LiteralPath $codexHome -Force -ErrorAction Stop).Count -ne 0) { throw 'codex_home_not_empty' }
      } else {
        New-Item -ItemType Directory -Force -Path $codexHome | Out-Null
      }
      [Environment]::SetEnvironmentVariable('Path', $canonicalPath, 'User')
      [Environment]::SetEnvironmentVariable('CODEX_HOME', $codexHome, 'User')
      [Environment]::SetEnvironmentVariable('CLAUDE_CONFIG_DIR', $claudeConfigDir, 'User')
      [Environment]::SetEnvironmentVariable('ANDROID_HOME', [string]$Profile.guest.android_sdk_root, 'User')
      [Environment]::SetEnvironmentVariable('ANDROID_SDK_ROOT', [string]$Profile.guest.android_sdk_root, 'User')
    }
    $actualPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $actualCodexHome = [Environment]::GetEnvironmentVariable('CODEX_HOME', 'User')
    $actualClaudeConfigDir = [Environment]::GetEnvironmentVariable('CLAUDE_CONFIG_DIR', 'User')
    $actualAndroidHome = [Environment]::GetEnvironmentVariable('ANDROID_HOME', 'User')
    $actualAndroidSdkRoot = [Environment]::GetEnvironmentVariable('ANDROID_SDK_ROOT', 'User')
    if ($actualPath -cne $canonicalPath) { throw 'toolchain_path_drift' }
    if ($actualCodexHome -cne $codexHome) { throw 'codex_home_drift' }
    if ($actualClaudeConfigDir -cne $claudeConfigDir) { throw 'claude_config_dir_drift' }
    if ($actualAndroidHome -cne [string]$Profile.guest.android_sdk_root -or
        $actualAndroidSdkRoot -cne [string]$Profile.guest.android_sdk_root) { throw 'android_sdk_environment_drift' }
    if (-not (Test-Path -LiteralPath $codexHome -PathType Container)) { throw 'codex_home_missing' }
    if (@(Get-ChildItem -LiteralPath $codexHome -Force -ErrorAction Stop).Count -ne 0) { throw 'codex_home_not_empty' }
    if (-not (Test-Path -LiteralPath $claudeConfigDir -PathType Container)) { throw 'claude_config_dir_missing' }
    if (@(Get-ChildItem -LiteralPath $claudeConfigDir -Force -ErrorAction Stop).Count -ne 0) { throw 'claude_config_dir_not_empty' }
    $forbiddenNames = @($Profile.guest.forbidden_environment_names)
    $forbiddenPrefixes = @($Profile.guest.forbidden_environment_prefixes)
    $presentNames = @(Get-ChildItem Env: | Where-Object {
      $name = [string]$_.Name
      ($name -cin $forbiddenNames) -or @($forbiddenPrefixes | Where-Object { $name.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
    } | Select-Object -ExpandProperty Name)
    if ($presentNames.Count -ne 0) { throw 'credential_environment_override_present' }
    [ordered]@{
      deterministic_path = $true; codex_home_bound = $true; codex_home_empty = $true
      claude_config_dir_bound = $true; claude_config_dir_empty = $true
      android_sdk_environment_bound = $true
      credential_environment_override_count = 0
    }
  } -ArgumentList $Mode,$profile

  $safeResults = @($results | ForEach-Object {
    [ordered]@{
      id=$_.id; version=$_.version; install_handler=$_.install_handler
      artifact_sha256=$_.artifact_sha256; artifact_bytes=$_.artifact_bytes; resolved_version=$_.resolved_version
      installed_tree_sha256=$_.installed_tree_sha256; installed_file_count=$_.installed_file_count
      installed_bytes=$_.installed_bytes; secondary_versions=@($_.secondary_versions)
      changed=[bool]$_.changed; verified=[bool]$_.verified; help_verified=$_.help_verified
      publisher_verified=$_.publisher_verified
    }
  })
  $networkAfter = @(Get-VMNetworkAdapter -VM $vm)
  if ($networkAfter.Count -ne 1 -or -not [string]::IsNullOrWhiteSpace([string]$networkAfter[0].SwitchName)) {
    throw 'vm_network_not_disconnected'
  }
  $verifiedAt = [DateTime]::UtcNow
  Write-E1ReceiptAtomically $receiptFull ([ordered]@{
    schema = 2; verdict = 'PASS'; mode = $Mode; profile_id = $profile.profile_id
    profile_sha256 = $profileSha; input_lock_sha256 = $inputLockSha
    vm_id = ([string]$vm.Id).ToLowerInvariant(); guest_identity = $guestSetup.identity
    generated_at_utc = $verifiedAt.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    valid_until_utc = $verifiedAt.AddSeconds([int]$profile.checkpoint.max_verify_age_seconds).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    runtimes = $safeResults; environment = $environment
    changed = @($safeResults | Where-Object changed).Count -gt 0
    auth_material_copied = $false; auth_material_read = $false; network_used = $false
    mutation_performed = $mutationPerformed
    private_paths_persisted = $false; guest_windows_credential_value_persisted = $false
    inference_sessions_consumed = 0; next_phase = 'verify-offline'
  })
  Write-Host "[evidence1-bootstrap-toolchain] $Mode PASS: $receiptFull"
} catch {
  $originalFailure = [string]$_.Exception.Message
  if ($Mode -ceq 'Bootstrap' -and $session -and $guestSetup -and (Get-Variable profile -ErrorAction SilentlyContinue)) {
    try {
      $rollback = Invoke-Command -Session $session -ScriptBlock {
        param($Profile,$TransactionId,$PriorUserEnvironment,$CreatedStatePaths)
        Set-StrictMode -Version Latest
        $ErrorActionPreference = 'Stop'
        $removed = @()
        foreach ($runtime in @($Profile.toolchain)) {
          $root = Join-Path $Profile.guest.toolchain_root "$($runtime.id)\$($runtime.version)"
          $markerPath = Join-Path $root '.evidence1-artifact.json'
          if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
            $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json -ErrorAction Stop
            $markerTransaction = if ($marker.PSObject.Properties.Name -contains 'transaction_id') { [string]$marker.transaction_id } else { '' }
            if ($markerTransaction -ceq $TransactionId) {
              Remove-Item -LiteralPath $root -Recurse -Force
              if (Test-Path -LiteralPath $root) { throw 'toolchain_rollback_failed' }
              $removed += [string]$runtime.id
            }
          }
          $stageExtension = if ($runtime.install_handler -ceq 'codex-single-exe') { '.exe' } else { '.zip' }
          $stage = "$($Profile.guest.staging_root)\$($runtime.id)$stageExtension"
          Remove-Item -LiteralPath $stage -Force -ErrorAction SilentlyContinue
        }
        foreach ($entry in $PriorUserEnvironment.PSObject.Properties) {
          [Environment]::SetEnvironmentVariable([string]$entry.Name, $entry.Value, 'User')
        }
        foreach ($statePath in @($CreatedStatePaths)) {
          if ((Test-Path -LiteralPath $statePath -PathType Container) -and
              @(Get-ChildItem -LiteralPath $statePath -Force -ErrorAction Stop).Count -eq 0) {
            Remove-Item -LiteralPath $statePath -Force
          }
        }
        [ordered]@{ complete = $true; removed_runtime_ids = $removed }
      } -ArgumentList $profile,$transactionId,$guestSetup.prior_user_environment,(,@($guestSetup.created_state_paths))
      if (@($rollback.removed_runtime_ids).Count -gt 0) { $mutationPerformed = $true }
      $rollbackComplete = [bool]$rollback.complete
    } catch { $rollbackComplete = $false }
  }
  $reason = Get-E1ClosedReason $originalFailure (@(
    'receipt_path_outside_scratch','guest_credential_path_outside_scratch','guest_credential_missing',
    'guest_credential_identity_mismatch','guest_computer_identity_mismatch','guest_user_identity_mismatch',
    'guest_administrator_required','vm_missing','vm_must_be_running','vm_network_not_disconnected',
    'unsupported_install_handler',
    'artifact_identity_mismatch','guest_artifact_identity_mismatch','installed_runtime_drift','installed_runtime_tree_drift',
    'unmanaged_runtime_destination','runtime_archive_layout_mismatch','runtime_not_bootstrapped',
    'runtime_command_missing','runtime_secondary_command_missing','runtime_required_file_missing','runtime_version_mismatch',
    'runtime_version_resolution_failed','codex_help_probe_failed',
    'codex_publisher_signature_invalid','auth_state_not_empty','auth_state_missing','auth_state_recovery_reparse_rejected',
    'auth_state_recovery_toolchain_present','codex_home_not_empty',
    'toolchain_path_drift','codex_home_drift','codex_home_missing','claude_config_dir_drift',
    'claude_config_dir_missing','claude_config_dir_not_empty','android_sdk_environment_drift','credential_environment_override_present',
    'administrator_required','iso_missing','iso_size_mismatch','iso_hash_mismatch','artifact_cardinality_mismatch'
  ) + @(Get-E1HostDependencyFailureCodes)) 'toolchain_operation_failed'
  try {
    $receiptFull = New-E1ReceiptPath $ReceiptPath ("toolchain-" + $Mode.ToLowerInvariant() + '-failed')
    Write-E1ReceiptAtomically $receiptFull ([ordered]@{
      schema = 2; verdict = 'FAIL'; mode = $Mode; reason_code = $reason
      generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      auth_material_copied = $false; auth_material_read = $false; network_used = $false
      private_paths_persisted = $false; guest_windows_credential_value_persisted = $false
      mutation_performed = $mutationPerformed
      completed_runtime_ids = @($results | ForEach-Object { [string]$_.id })
      rollback_complete = $rollbackComplete
      mutation_state_complete = ($rollbackComplete -eq $true)
      inference_sessions_consumed = 0
    })
  } catch { }
  Fail $reason
} finally {
  if ($session) { Remove-PSSession -Session $session -ErrorAction SilentlyContinue }
}
