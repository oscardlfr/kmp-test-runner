#Requires -RunAsAdministrator

param(
  [string]$QueueRoot = 'C:\kmp-eval\scratch\host-elevated-runner',
  [string]$AllowedRoot = '',
  [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$AllowedScripts = @(
  'evidence1-hyperv-copy-live-artifacts.ps1',
  'evidence1-hyperv-place-live-autorun.ps1',
  'evidence1-hyperv-read-live-operational-tail.ps1',
  'evidence1-hyperv-read-live-progress.ps1',
  'evidence1-hyperv-regenerate-readiness-direct.ps1',
  'evidence1-hyperv-update-harness-from-bundle.ps1'
)

function Resolve-FullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

function Assert-PathInside([string]$Candidate, [string]$Root, [string]$Label) {
  $candidateFull = Resolve-FullPath $Candidate
  $rootFull = (Resolve-FullPath $Root).TrimEnd('\') + '\'
  if (-not $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label path is outside expected root: $candidateFull"
  }
}

function Write-Response($Request, [int]$ExitCode, [string]$LogPath, [string]$ErrorMessage) {
  $responsePath = Join-Path $script:ResponseDir "$($Request.id).response.json"
  $response = [ordered]@{
    id = $Request.id
    generated_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    exit_code = $ExitCode
    log_path = $LogPath
    error = $ErrorMessage
  }
  ($response | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $responsePath -Encoding UTF8
}

function Quote-ProcessArgument([string]$Argument) {
  if ($Argument -notmatch '[\s"]') {
    return $Argument
  }
  return '"' + ($Argument -replace '"', '\"') + '"'
}

$QueueRoot = Resolve-FullPath $QueueRoot
$AllowedRoot = if ([string]::IsNullOrWhiteSpace($AllowedRoot)) {
  Resolve-FullPath $PSScriptRoot
} else {
  Resolve-FullPath $AllowedRoot
}
Assert-PathInside $QueueRoot 'C:\kmp-eval\scratch\' 'queue'
$RequestDir = Join-Path $QueueRoot 'requests'
$script:ResponseDir = Join-Path $QueueRoot 'responses'
$LogDir = Join-Path $QueueRoot 'logs'
$DoneDir = Join-Path $QueueRoot 'done'
$InProgressDir = Join-Path $QueueRoot 'in-progress'
New-Item -ItemType Directory -Force -Path $RequestDir,$script:ResponseDir,$LogDir,$DoneDir,$InProgressDir | Out-Null
$RunnerTracePath = Join-Path $QueueRoot 'RUNNER-TRACE.log'

function Add-RunnerTrace([string]$Message) {
  $timestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  "[$timestamp] $Message" | Add-Content -LiteralPath $RunnerTracePath -Encoding UTF8
}

trap {
  Add-RunnerTrace ("UNHANDLED: " + ($_ | Out-String))
  throw
}

do {
  $requestFile = Get-ChildItem -LiteralPath $RequestDir -Filter '*.request.json' -File |
    Sort-Object CreationTimeUtc |
    Select-Object -First 1

  if (-not $requestFile) {
    if ($Once) { break }
    Start-Sleep -Seconds 2
    continue
  }

  $request = $null
  $logPath = $null
  $activeRequestPath = $null
  try {
    $activeRequestPath = Join-Path $InProgressDir $requestFile.Name
    Move-Item -LiteralPath $requestFile.FullName -Destination $activeRequestPath -Force
    $request = Get-Content -LiteralPath $activeRequestPath -Raw | ConvertFrom-Json
    if ($request.id -notmatch '^[A-Za-z0-9_.-]+$') {
      throw "invalid request id: $($request.id)"
    }

    $scriptPath = Resolve-FullPath ([string]$request.script_path)
    Assert-PathInside $scriptPath $AllowedRoot 'script'
    $scriptName = Split-Path -Leaf $scriptPath
    if ($AllowedScripts -notcontains $scriptName) {
      throw "script is not allowlisted for Evidence1 elevated runner: $scriptName"
    }

    if (-not (Test-Path -LiteralPath $scriptPath)) {
      throw "script does not exist: $scriptPath"
    }

    $arguments = @()
    if ($null -ne $request.arguments) {
      foreach ($arg in @($request.arguments)) {
        if ($null -eq $arg) {
          throw 'null argument is not allowed'
        }
        $arguments += [string]$arg
      }
    }

    $logPath = Join-Path $LogDir "$($request.id).log"
    $displayArguments = @($arguments | ForEach-Object { Quote-ProcessArgument $_ })
    "COMMAND: powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" $($displayArguments -join ' ')" |
      Set-Content -LiteralPath $logPath -Encoding UTF8
    Add-RunnerTrace "processing request $($request.id) script=$scriptName"

    $stdoutPath = Join-Path $LogDir "$($request.id).stdout.tmp.log"
    $stderrPath = Join-Path $LogDir "$($request.id).stderr.tmp.log"
    try {
      $childArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scriptPath) + $arguments |
        ForEach-Object { Quote-ProcessArgument ([string]$_) }
      Add-RunnerTrace "starting child for $($request.id)"
      $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $childArguments -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
      $process.Refresh()
      $exitCode = $process.ExitCode
      Add-RunnerTrace "child exited code=$exitCode for $($request.id)"
    } catch {
      Add-RunnerTrace ("child launch/capture failed for $($request.id): " + ($_ | Out-String))
      $_ | Out-String | Add-Content -LiteralPath $logPath -Encoding UTF8
      $exitCode = 997
    }

    foreach ($stream in @(
      @{ Label = 'stdout'; Path = $stdoutPath },
      @{ Label = 'stderr'; Path = $stderrPath }
    )) {
      if (Test-Path -LiteralPath $stream.Path) {
        "--- child $($stream.Label): $($stream.Path) ---" | Add-Content -LiteralPath $logPath -Encoding UTF8
        Get-Content -LiteralPath $stream.Path -ErrorAction SilentlyContinue |
          Add-Content -LiteralPath $logPath -Encoding UTF8
      }
    }

    "EXITCODE:$exitCode" | Add-Content -LiteralPath $logPath -Encoding UTF8
    Write-Response $request $exitCode $logPath $null
    Add-RunnerTrace "wrote response for $($request.id) exit=$exitCode"
  } catch {
    Add-RunnerTrace ("request failed: " + ($_ | Out-String))
    if (-not $request) {
      $request = [pscustomobject]@{ id = [System.IO.Path]::GetFileNameWithoutExtension($requestFile.Name) }
    }
    if (-not $logPath) {
      $logPath = Join-Path $LogDir "$($request.id).log"
    }
    $_ | Out-String | Set-Content -LiteralPath $logPath -Encoding UTF8
    Write-Response $request 1 $logPath $_.Exception.Message
  } finally {
    if ($activeRequestPath -and (Test-Path -LiteralPath $activeRequestPath)) {
      $donePath = Join-Path $DoneDir $requestFile.Name
      Move-Item -LiteralPath $activeRequestPath -Destination $donePath -Force -ErrorAction SilentlyContinue
    }
  }
} while (-not $Once)
