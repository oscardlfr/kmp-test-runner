# evidence1-broker-status-real.psm1
#
# Production broker.status (ADR-S1): moved verbatim, behavior-for-behavior,
# out of evidence1-broker-status-contract.psm1 as part of Phase 3c's fix-
# forward split -- see that file's header for why. NOT renamed "-hyperv.psm1"
# like every other capability's real implementation: this never touches
# Hyper-V, a VM, an adapter, or PowerShell Direct. It reads this HOST's own
# Scheduled Task, filesystem, and ACLs only -- Get-ScheduledTask, file hashes
# under the deployment root, Get-Acl. Nothing here was rewritten; every
# function below is byte-for-byte the same logic that lived in the contract
# module before this split, just now producing its final return via the
# shared New-E1BrokerStatusResult constructor instead of a fourth inline
# [ordered]@{} literal.
#
# DRAFTED CODE THAT ALREADY RUNS FOR REAL, UNLIKE EVERY -hyperv.psm1 SIBLING:
# unlike the Hyper-V-touching real implementations (which remain drafted,
# never executed, per this whole task's standing boundary), THIS module's
# logic already executes for real every time evidence1-install.ps1 or a real
# evidence1-run.ps1 BrokerReady runs -- it is the same logic that was already
# live inside evidence1-install.ps1 before Phase 3a factored it out, moved
# again here without any behavior change. The move itself was not executed
# or re-verified against a live broker this round (still within the standing
# never-execute-evidence1-install.ps1/evidence1-run.ps1 boundary); it was
# checked by direct line-for-line comparison against the pre-split file
# instead -- see the architecture note for the diff account.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'evidence1-broker-status-contract.psm1') -Force -DisableNameChecking -Global

function Resolve-E1BrokerFullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

# Duplicated (deliberately, not overlooked) rather than imported from
# elsewhere -- see the identical note this carried in the pre-split contract
# module; unchanged reasoning, just relocated.
function Get-E1BrokerFileSha256([string]$Path) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
  } finally { $stream.Dispose() }
}

function Convert-E1BrokerNodeRelativePath([string]$RelativePath) {
  if ([string]::IsNullOrWhiteSpace($RelativePath) -or $RelativePath.Contains('\') -or
      $RelativePath.StartsWith('/') -or $RelativePath -cmatch '(^|/)(\.|\.\.)(/|$)' -or
      $RelativePath -cmatch ':') { throw 'node_runtime_relative_path_invalid' }
  return $RelativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
}

# Locale-independent scheduled task inspection. schtasks.exe /fo list text
# output is localized (observed as Spanish on the host this was written
# against -- "Nombre de tarea", "Modo de inicio de sesion", etc.), so it must
# never be parsed as a source of truth. Get-ScheduledTask's .Actions is a
# structured, non-localized property.
function Get-E1BrokerDeployedRoot {
  Import-Module ScheduledTasks -ErrorAction Stop
  $task = Get-ScheduledTask -TaskName (Get-E1BrokerRequiredTaskName) -ErrorAction SilentlyContinue
  if (-not $task) { return $null }
  $actions = @($task.Actions)
  if ($actions.Count -ne 1 -or [string]$actions[0].Execute -notlike '*powershell.exe') {
    throw 'scheduled_task_action_shape_unexpected'
  }
  $match = [regex]::Match([string]$actions[0].Arguments, '-AllowedRoot\s+"([^"]+)"')
  if (-not $match.Success) { throw 'scheduled_task_action_allowedroot_unresolvable' }
  return Resolve-E1BrokerFullPath $match.Groups[1].Value
}

# Read-only port of the ACL shape evidence1-host-elevated-runner-install.ps1
# writes (Set-E1InstallProtectedAcl) and evidence1-host-elevated-runner.ps1
# re-verifies on every dispatch (Assert-E1RunnerProtectedAcl): owner is
# Administrators, rules are protected (non-inherited), and there are exactly
# three ACEs -- SYSTEM full control, Administrators full control, the
# recorded principal read+execute. This is independent, outside-the-broker
# confirmation, not a substitute for the broker's own enforcement.
function Test-E1BrokerProtectedAcl([string]$Path, [string]$PrincipalSid, [bool]$IsDirectory) {
  try {
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -cne 'S-1-5-32-544' -or -not $acl.AreAccessRulesProtected) { return $false }
    $rules = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 3) { return $false }
    $readExecute = [int]([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)
    $expected = @{
      'S-1-5-18' = [int][Security.AccessControl.FileSystemRights]::FullControl
      'S-1-5-32-544' = [int][Security.AccessControl.FileSystemRights]::FullControl
      $PrincipalSid = $readExecute
    }
    $wantedInheritance = if ($IsDirectory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($rule in $rules) {
      $sid = $rule.IdentityReference.Value
      if (-not $expected.ContainsKey($sid) -or
          $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
          [int]$rule.FileSystemRights -ne $expected[$sid] -or
          $rule.InheritanceFlags -ne $wantedInheritance) { return $false }
    }
    return $true
  } catch {
    return $false
  }
}

# Independent, non-elevated re-verification of one deployment directory:
# re-hash every file the manifest claims and compare, and check the ACL
# shape. Returns $null if the directory or its manifest cannot be read at
# all (e.g. this account is not the principal recorded at install time) --
# never throws for that case.
function Get-E1BrokerDeploymentState([string]$DeploymentRoot) {
  $manifestPath = Join-Path $DeploymentRoot 'evidence1-host-elevated-runner-manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $null }
  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -ErrorAction Stop

    $runnerScriptName = Get-E1BrokerRunnerScriptName
    $processModuleName = Get-E1BrokerProcessModuleName
    $requiredSchema = Get-E1BrokerRequiredManifestSchema
    $selfInstallScriptName = Get-E1BrokerSelfInstallScriptName

    $hashesValid = $true
    $runnerPath = Join-Path $DeploymentRoot $runnerScriptName
    if ((Get-E1BrokerFileSha256 $runnerPath) -cne [string]$manifest.runner_sha256) { $hashesValid = $false }
    $modulePath = Join-Path $DeploymentRoot $processModuleName
    if ($hashesValid -and (Get-E1BrokerFileSha256 $modulePath) -cne [string]$manifest.process_module_sha256) { $hashesValid = $false }
    if ($hashesValid) {
      foreach ($entry in @($manifest.scripts)) {
        $path = Join-Path $DeploymentRoot ([string]$entry.name)
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-E1BrokerFileSha256 $path) -cne [string]$entry.sha256) {
          $hashesValid = $false; break
        }
      }
    }
    if ($hashesValid) {
      foreach ($entry in @($manifest.support_files)) {
        $path = Join-Path $DeploymentRoot ([string]$entry.name)
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-E1BrokerFileSha256 $path) -cne [string]$entry.sha256) {
          $hashesValid = $false; break
        }
      }
    }
    if ($hashesValid -and $manifest.PSObject.Properties.Name -contains 'node_files') {
      $nodeRoot = Join-Path $DeploymentRoot 'node-runtime'
      foreach ($entry in @($manifest.node_files)) {
        $path = Join-Path $nodeRoot (Convert-E1BrokerNodeRelativePath ([string]$entry.name))
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-E1BrokerFileSha256 $path) -cne [string]$entry.sha256) {
          $hashesValid = $false; break
        }
      }
    }

    $principalSid = [string]$manifest.principal_sid
    $aclValid = (Test-E1BrokerProtectedAcl $DeploymentRoot $principalSid $true) -and
                (Test-E1BrokerProtectedAcl $manifestPath $principalSid $false)

    $scriptNames = @($manifest.scripts | ForEach-Object { [string]$_.name })
    $selfUpdateCapable = ([int]$manifest.schema -ge $requiredSchema) -and
                          ($scriptNames -ccontains $selfInstallScriptName)

    return New-E1BrokerStatusResult -TaskExists $true -Readable $true -DeploymentRoot $DeploymentRoot `
      -ManifestSchema ([int]$manifest.schema) -SourceGitCommit ([string]$manifest.source_git_commit) `
      -PrincipalSid $principalSid -ScriptCount (@($manifest.scripts).Count) `
      -HashesValid $hashesValid -AclValid $aclValid -SelfUpdateCapable $selfUpdateCapable
  } catch {
    return $null
  }
}

# The public broker.status capability. Always returns the same ten keys
# regardless of branch (task missing, deployment unreadable, or fully
# readable) so callers can dot-access any field -- e.g.
# $status.self_update_capable -- without first checking whether that key
# happens to exist. Takes no parameters: the task name is canonical
# (Get-E1BrokerRequiredTaskName), not caller-configurable, for the same
# reason evidence1-install.ps1's pinned self-install arguments aren't.
function Get-E1BrokerStatus {
  [CmdletBinding()]
  param()
  $root = Get-E1BrokerDeployedRoot
  if (-not $root) {
    return New-E1BrokerStatusResult -TaskExists $false -Readable $false -HashesValid $false -AclValid $false -SelfUpdateCapable $false
  }
  $state = Get-E1BrokerDeploymentState $root
  if (-not $state) {
    return New-E1BrokerStatusResult -TaskExists $true -Readable $false -DeploymentRoot $root -HashesValid $false -AclValid $false -SelfUpdateCapable $false
  }
  Assert-E1BrokerStatusResult $state
  return $state
}

Export-ModuleMember -Function `
  Get-E1BrokerDeploymentState, `
  Get-E1BrokerStatus
