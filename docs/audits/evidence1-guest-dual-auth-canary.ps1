param(
  [Parameter(Mandatory = $true)][string]$OperationId,
  [string]$OperationRoot = 'C:\Evidence1Ops\remote-auth-canary-v2',
  [string]$GuestReadinessPath = 'C:\kmp-eval\scratch\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1\READINESS.json',
  [Parameter(Mandatory = $true)][string]$HostReadinessSha256,
  [Parameter(Mandatory = $true)][string]$HostReadinessGeneratedAtUtc,
  [Parameter(Mandatory = $true)][string]$AuthorizationPhrase,
  [Parameter(Mandatory = $true)][string]$ExpectedVMName,
  [Parameter(Mandatory = $true)][string]$ExpectedVMId,
  [string]$ExpectedClaudeVersion = '2.1.238',
  [string]$ExpectedCodexVersion = '0.154.0',
  [string]$CodexModel = 'gpt-5.6-terra',
  [string]$ClaudeCommand = 'C:\Evidence1Toolchain\claude-code\2.1.238\claude.cmd',
  [string]$CodexCommand = 'C:\Evidence1Toolchain\codex-cli\0.154.0\bin\codex.exe',
  [string]$ForbiddenCredentialNameCsv = '',
  [bool]$CleanupOperation = $false,
  [bool]$CleanupOriginStoppedConfirmed = $false,
  [bool]$AbortOperation = $false,
  [switch]$TestMode,
  [ValidateRange(1, 120)][int]$PreflightTimeoutSeconds = 30,
  [ValidateRange(1, 300)][int]$DispatchTimeoutSeconds = 120,
  [ValidateSet(0, 1)][int]$TestFaultAfterSlot = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ExpectedResponse = 'AUTH_CANARY_OK'
$CanaryPrompt = 'This is a deterministic response-format check in an isolated evaluation. Do not access files or invoke tools. Respond with the exact text AUTH_CANARY_OK and nothing else.'
$CanonicalModel = 'gpt-5.6-terra'
$CanonicalClaudeModel = 'claude-sonnet-5'
$AllowedModelPairs = [ordered]@{
  'claude-fable-5' = 'gpt-6-astra'
  'claude-opus-5' = 'gpt-5.6-sol'
  'claude-sonnet-5' = 'gpt-5.6-terra'
  'claude-haiku-4-5-20251001' = 'gpt-5.6-luna'
}
$AllowedClaudeHttpStatuses = @(400, 401, 403, 408, 409, 413, 429, 500, 502, 503, 504, 529)
$script:AbortPath = ''
$script:AbortAckPath = ''
$ForbiddenCredentialNames = @($ForbiddenCredentialNameCsv -split ',' | Where-Object { $_ -ne '' })
$CredentialOverrideNames = @(Get-ChildItem Env: | Where-Object {
    $_.Name -in $ForbiddenCredentialNames -or $_.Name -match '^COPILOT_'
  } | Select-Object -ExpandProperty Name | Sort-Object -Unique)

function Get-E1Sha256([string]$Path) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}

function Get-E1TextSha256([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))) -replace '-', '').ToLowerInvariant()
  } finally { $sha.Dispose() }
}

function Write-E1CreateNewJson([string]$Path, $Value) {
  $parent = Split-Path -Parent $Path
  [void](New-Item -ItemType Directory -Force -Path $parent)
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 20 -Compress))
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
  finally { $stream.Dispose() }
}

function Test-E1ExactKeys($Value, [string[]]$Expected) {
  if ($null -eq $Value -or $Value -isnot [psobject]) { return $false }
  $actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $wanted = @($Expected | Sort-Object)
  return $actual.Count -eq $wanted.Count -and [string]::Join('|', $actual) -ceq [string]::Join('|', $wanted)
}

function ConvertTo-E1ArgumentLine([string[]]$ArgumentList) {
  $parts = foreach ($argument in $ArgumentList) {
    $value = [string]$argument
    if ($value.Length -eq 0) { '""'; continue }
    if ($value -notmatch '[\s"]') { $value; continue }
    $value = $value -replace '(\\*)"', '$1$1\"'
    $value = $value -replace '(\\+)$', '$1$1'
    '"' + $value + '"'
  }
  return [string]::Join(' ', $parts)
}

if (-not ('Evidence1.RemoteAuthJob' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace Evidence1 {
  [StructLayout(LayoutKind.Sequential)]
  public struct JobBasicLimitInformation {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct IoCounters {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JobExtendedLimitInformation {
    public JobBasicLimitInformation BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JobBasicAccountingInformation {
    public long TotalUserTime;
    public long TotalKernelTime;
    public long ThisPeriodTotalUserTime;
    public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount;
    public uint TotalProcesses;
    public uint ActiveProcesses;
    public uint TotalTerminatedProcesses;
  }

  public static class RemoteAuthJob {
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const uint JOB_OBJECT_QUERY = 0x0004;
    const uint JOB_OBJECT_TERMINATE = 0x0008;
    const int JobObjectBasicAccountingInformation = 1;
    const int JobObjectExtendedLimitInformation = 9;
    const int ERROR_ALREADY_EXISTS = 183;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr OpenJobObject(uint access, bool inheritHandle, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, out uint returnedLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    public static IntPtr CreateKillOnClose(string name, out bool alreadyExists, out int error) {
      IntPtr job = CreateJobObject(IntPtr.Zero, name);
      error = Marshal.GetLastWin32Error();
      alreadyExists = error == ERROR_ALREADY_EXISTS;
      if (job == IntPtr.Zero || alreadyExists) {
        if (job != IntPtr.Zero) CloseHandle(job);
        return IntPtr.Zero;
      }
      JobExtendedLimitInformation limits = new JobExtendedLimitInformation();
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int size = Marshal.SizeOf(typeof(JobExtendedLimitInformation));
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(limits, buffer, false);
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size)) {
          error = Marshal.GetLastWin32Error();
          CloseHandle(job);
          return IntPtr.Zero;
        }
      } finally { Marshal.FreeHGlobal(buffer); }
      error = 0;
      return job;
    }

    public static IntPtr OpenForCleanup(string name, out int error) {
      IntPtr job = OpenJobObject(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, false, name);
      error = Marshal.GetLastWin32Error();
      return job;
    }

    public static bool TryGetActiveCount(IntPtr job, out uint active, out int error) {
      active = 0;
      error = 0;
      int size = Marshal.SizeOf(typeof(JobBasicAccountingInformation));
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try {
        uint returned;
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, buffer, (uint)size, out returned)) {
          error = Marshal.GetLastWin32Error();
          return false;
        }
        JobBasicAccountingInformation accounting = (JobBasicAccountingInformation)Marshal.PtrToStructure(buffer, typeof(JobBasicAccountingInformation));
        active = accounting.ActiveProcesses;
        return true;
      } finally { Marshal.FreeHGlobal(buffer); }
    }
  }
}
'@
}

function New-E1KillOnCloseJob([string]$Name) {
  $alreadyExists = $false; $nativeError = 0
  $handle = [Evidence1.RemoteAuthJob]::CreateKillOnClose($Name, [ref]$alreadyExists, [ref]$nativeError)
  if ($handle -eq [IntPtr]::Zero) {
    if ($alreadyExists) { throw 'process_job_replay' }
    throw 'process_job_create_failed'
  }
  return $handle
}

function Close-E1JobObjectBounded([IntPtr]$Handle, [int]$TimeoutMilliseconds = 10000) {
  if ($Handle -eq [IntPtr]::Zero) { return $false }
  $clean = $false; $closeConfirmed = $false
  try {
    $active = [uint32]0; $nativeError = 0
    if ([Evidence1.RemoteAuthJob]::TryGetActiveCount($Handle, [ref]$active, [ref]$nativeError)) {
      $terminated = $active -eq 0 -or [Evidence1.RemoteAuthJob]::TerminateJobObject($Handle, 137)
      if ($terminated) {
        $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
        do {
          if (-not [Evidence1.RemoteAuthJob]::TryGetActiveCount($Handle, [ref]$active, [ref]$nativeError)) { break }
          if ($active -eq 0) { $clean = $true; break }
          Start-Sleep -Milliseconds 50
        } while ([DateTime]::UtcNow -lt $deadline)
      }
    }
  } finally {
    $closeConfirmed = [Evidence1.RemoteAuthJob]::CloseHandle($Handle)
  }
  return [bool]($clean -and $closeConfirmed)
}

function Open-And-Close-E1NamedJob([string]$Name, [int]$TimeoutMilliseconds = 10000) {
  $nativeError = 0
  $handle = [Evidence1.RemoteAuthJob]::OpenForCleanup($Name, [ref]$nativeError)
  if ($handle -eq [IntPtr]::Zero) {
    return [ordered]@{ present = $false; cleanup_confirmed = $nativeError -eq 2 }
  }
  return [ordered]@{ present = $true; cleanup_confirmed = Close-E1JobObjectBounded $handle $TimeoutMilliseconds }
}

function Write-E1AbortAck([bool]$CleanupConfirmed) {
  if (-not $script:AbortAckPath -or -not $CleanupConfirmed) { return }
  if (-not (Test-Path -LiteralPath $script:AbortAckPath)) {
    try {
      Write-E1CreateNewJson $script:AbortAckPath ([ordered]@{
          schema = 1; operation_id = $OperationId; state = 'acknowledged'; cleanup_confirmed = $true
          acknowledged_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        })
    } catch {
      if (-not (Test-Path -LiteralPath $script:AbortAckPath -PathType Leaf)) { throw }
    }
  }
}

function Assert-E1OperationNotAborted {
  if ($script:AbortPath -and (Test-Path -LiteralPath $script:AbortPath)) {
    Write-E1AbortAck $true
    throw 'operation_aborted'
  }
}

function Test-E1RecordedProcessCleanup([string]$ProcessRecordPath) {
  $cleanupPath = $ProcessRecordPath -replace '\.process\.json$', '.process-cleanup.json'
  if (-not (Test-Path -LiteralPath $ProcessRecordPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $cleanupPath -PathType Leaf)) { return $false }
  try {
    $record = Get-Content -LiteralPath $ProcessRecordPath -Raw | ConvertFrom-Json -ErrorAction Stop
    $cleanup = Get-Content -LiteralPath $cleanupPath -Raw | ConvertFrom-Json -ErrorAction Stop
    return (Test-E1ExactKeys $record @('schema','process_id','state','job_object_name','job_object_kill_on_close','job_assignment_confirmed','started_at_utc')) -and
      (Test-E1ExactKeys $cleanup @('schema','job_object_name','job_object_kill_on_close','job_assignment_confirmed','cleanup_confirmed','active_processes','completed_at_utc')) -and
      $record.schema -eq 2 -and $record.job_object_kill_on_close -eq $true -and
      $record.job_assignment_confirmed -eq $true -and $cleanup.schema -eq 1 -and
      $cleanup.job_object_name -ceq $record.job_object_name -and
      $cleanup.job_object_kill_on_close -eq $true -and $cleanup.job_assignment_confirmed -eq $true -and
      $cleanup.cleanup_confirmed -eq $true -and [int]$cleanup.active_processes -eq 0
  } catch { return $false }
}

function Invoke-E1BoundedProcess(
  [string]$Executable,
  [string[]]$Arguments,
  [string]$WorkingDirectory,
  [string]$StdinText,
  [int]$TimeoutSeconds,
  [string]$ProcessRecordPath = ''
) {
  if ($script:AbortPath -and (Test-Path -LiteralPath $script:AbortPath)) {
    Write-E1AbortAck $true
    return [ordered]@{
      process_started = $false; exit_code = $null; timed_out = $false
      process_tree_cleanup_confirmed = $true; stdout = ''; stderr = ''; reason_code = 'operation_aborted_before_spawn'
    }
  }
  if (-not $ProcessRecordPath) { throw 'process_custody_path_missing' }
  $processClaimPath = $ProcessRecordPath -replace '\.process\.json$', '.process-claim.json'
  $processDispatchPath = $ProcessRecordPath -replace '\.process\.json$', '.process-dispatch.json'
  $processCleanupPath = $ProcessRecordPath -replace '\.process\.json$', '.process-cleanup.json'
  $custodyHash = (Get-E1TextSha256 $ProcessRecordPath).Substring(0, 16)
  $jobName = "Global\Evidence1RemoteAuth-$OperationId-$custodyHash"
  $gateName = "Global\Evidence1RemoteAuthGate-$OperationId-$custodyHash"
  $effectiveExecutable = $Executable
  $effectiveArguments = @($Arguments)
  $extension = [IO.Path]::GetExtension($Executable)
  if ($extension -in @('.cmd', '.bat')) {
    $effectiveExecutable = "$env:SystemRoot\System32\cmd.exe"
    $effectiveArguments = @('/d', '/s', '/c', $Executable) + @($Arguments)
  } elseif ($TestMode -and $extension -eq '.ps1') {
    $effectiveExecutable = "$PSHOME\powershell.exe"
    if (-not (Test-Path -LiteralPath $effectiveExecutable -PathType Leaf)) { $effectiveExecutable = (Get-Process -Id $PID).Path }
    $effectiveArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Executable) + @($Arguments)
  }
  # The wrapper cannot launch the requested executable until its named gate is
  # released. This closes Process.Start -> AssignProcessToJobObject: the wrapper
  # is assigned first, and every provider/helper descendant is born in the job.
  $launcherPayload = [ordered]@{ gate = $gateName; executable = $effectiveExecutable; arguments = @($effectiveArguments) }
  $launcherPayloadBase64 = [Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes(($launcherPayload | ConvertTo-Json -Depth 5 -Compress)))
  $launcherSource = @"
`$payload = [Text.UTF8Encoding]::new(`$false).GetString([Convert]::FromBase64String('$launcherPayloadBase64')) | ConvertFrom-Json
`$gate = [Threading.EventWaitHandle]::OpenExisting([string]`$payload.gate)
try {
  if (-not `$gate.WaitOne(30000)) { exit 124 }
  `$targetArguments = @(`$payload.arguments | ForEach-Object { [string]`$_ })
  & ([string]`$payload.executable) @targetArguments
  if (`$null -eq `$LASTEXITCODE) { exit 0 }
  exit `$LASTEXITCODE
} finally { `$gate.Dispose() }
"@
  $launcherEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launcherSource))
  $launcherExecutable = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  if (-not (Test-Path -LiteralPath $launcherExecutable -PathType Leaf)) { $launcherExecutable = (Get-Process -Id $PID).Path }
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $launcherExecutable
  $info.WorkingDirectory = $WorkingDirectory
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.RedirectStandardInput = $true
  $launcherArguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $launcherEncoded)
  $argumentListProperty = $info.GetType().GetProperty('ArgumentList')
  if ($null -ne $argumentListProperty) {
    foreach ($argument in $launcherArguments) { [void]$info.ArgumentList.Add($argument) }
  } else { $info.Arguments = ConvertTo-E1ArgumentLine $launcherArguments }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $info
  $wrapperStarted = $false; $processStarted = $false; $jobAssigned = $false; $jobClosed = $false
  $jobHandle = [IntPtr]::Zero
  $gate = $null
  try {
    Write-E1CreateNewJson $processClaimPath ([ordered]@{
        schema = 2; state = 'pre-spawn'; job_object_name = $jobName; job_object_kill_on_close = $true
        start_gate_name = $gateName; claimed_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      })
    if ($script:AbortPath -and (Test-Path -LiteralPath $script:AbortPath)) {
      Write-E1AbortAck $true
      return [ordered]@{
        process_started = $false; exit_code = $null; timed_out = $false
        process_tree_cleanup_confirmed = $true; stdout = ''; stderr = ''; reason_code = 'operation_aborted_before_spawn'
      }
    }
    $gateCreated = $false
    $gate = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, $gateName, [ref]$gateCreated)
    if (-not $gateCreated) { throw 'process_gate_replay' }
    $jobHandle = New-E1KillOnCloseJob $jobName
    if (-not $process.Start()) { throw 'process_start_failed' }
    $wrapperStarted = $true
    if (-not [Evidence1.RemoteAuthJob]::AssignProcessToJobObject($jobHandle, $process.Handle)) { throw 'process_job_assign_failed' }
    $jobAssigned = $true
    if ($ProcessRecordPath) {
      Write-E1CreateNewJson $ProcessRecordPath ([ordered]@{
          schema = 2; process_id = [int]$process.Id; state = 'assigned'; job_object_name = $jobName
          job_object_kill_on_close = $true; job_assignment_confirmed = $true
          started_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        })
    }
    if ($script:AbortPath -and (Test-Path -LiteralPath $script:AbortPath)) {
      $cleanupConfirmed = Close-E1JobObjectBounded $jobHandle; $jobClosed = $true
      Write-E1AbortAck $cleanupConfirmed
      return [ordered]@{
        process_started = $false; exit_code = $null; timed_out = $false
        process_tree_cleanup_confirmed = [bool]$cleanupConfirmed; stdout = ''; stderr = ''
        reason_code = $(if ($cleanupConfirmed) { 'operation_aborted_before_spawn' } else { 'process_cleanup_failed' })
      }
    }
    if (-not $gate.Set()) { throw 'process_gate_release_failed' }
    $processStarted = $true
    Write-E1CreateNewJson $processDispatchPath ([ordered]@{
        schema = 1; state = 'dispatched'; job_object_name = $jobName
        dispatched_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      })
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if ($StdinText.Length -gt 0) {
      $stdinBytes = [Text.UTF8Encoding]::new($false).GetBytes($StdinText)
      $process.StandardInput.BaseStream.Write($stdinBytes, 0, $stdinBytes.Length)
      $process.StandardInput.BaseStream.Flush()
      $process.StandardInput.BaseStream.Close()
    } else { $process.StandardInput.Close() }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $timedOut = $false; $aborted = $false; $rootExitedNormally = $false; $observedExitCode = $null
    do {
      if ($process.WaitForExit(100)) { $rootExitedNormally = $true; $observedExitCode = [int]$process.ExitCode; break }
      if ($script:AbortPath -and (Test-Path -LiteralPath $script:AbortPath)) { $aborted = $true; break }
      if ([DateTime]::UtcNow -ge $deadline) { $timedOut = $true; break }
    } while ($true)
    $cleanupConfirmed = Close-E1JobObjectBounded $jobHandle
    $jobClosed = $true
    $exited = $process.WaitForExit(2000)
    try { $streamsClosed = [Threading.Tasks.Task]::WaitAll(@($stdoutTask, $stderrTask), 5000) }
    catch { $streamsClosed = $false }
    $cleanupConfirmed = [bool]($cleanupConfirmed -and $exited -and $streamsClosed)
    try {
      Write-E1CreateNewJson $processCleanupPath ([ordered]@{
          schema = 1; job_object_name = $jobName; job_object_kill_on_close = $true
          job_assignment_confirmed = $jobAssigned; cleanup_confirmed = $cleanupConfirmed; active_processes = $(if ($cleanupConfirmed) { 0 } else { $null })
          completed_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        })
    } catch { $cleanupConfirmed = $false }
    if ($aborted) { Write-E1AbortAck $cleanupConfirmed }
    return [ordered]@{
      process_started = $true
      exit_code = $(if ($rootExitedNormally) { $observedExitCode } else { $null })
      timed_out = [bool]$timedOut
      process_tree_cleanup_confirmed = [bool]$cleanupConfirmed
      stdout = $(if ($streamsClosed) { $stdoutTask.Result } else { '' })
      stderr = $(if ($streamsClosed) { $stderrTask.Result } else { '' })
      reason_code = $(if (-not $cleanupConfirmed) { 'process_cleanup_failed' } elseif ($aborted) { 'operation_aborted' } elseif ($timedOut) { 'process_timeout' } else { $null })
    }
  } catch {
    $cleanupConfirmed = $false
    if ($jobHandle -ne [IntPtr]::Zero -and -not $jobClosed) {
      $cleanupConfirmed = Close-E1JobObjectBounded $jobHandle
      $jobClosed = $true
    } elseif (-not $wrapperStarted) { $cleanupConfirmed = $true }
    if ($wrapperStarted) { $null = $process.WaitForExit(2000) }
    if ($processCleanupPath -and -not (Test-Path -LiteralPath $processCleanupPath)) {
      try {
        Write-E1CreateNewJson $processCleanupPath ([ordered]@{
            schema = 1; job_object_name = $jobName; job_object_kill_on_close = $true
            job_assignment_confirmed = $jobAssigned; cleanup_confirmed = $cleanupConfirmed; active_processes = $(if ($cleanupConfirmed) { 0 } else { $null })
            completed_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
          })
      } catch { $cleanupConfirmed = $false }
    }
    return [ordered]@{
      process_started = [bool]$processStarted; exit_code = $null; timed_out = $false
      process_tree_cleanup_confirmed = [bool]$cleanupConfirmed; stdout = ''; stderr = ''
      reason_code = $(if ($processStarted) { 'process_observation_failed' } else { 'process_start_failed' })
    }
  } finally {
    if ($jobHandle -ne [IntPtr]::Zero -and -not $jobClosed) { $null = Close-E1JobObjectBounded $jobHandle }
    if ($null -ne $gate) { $gate.Dispose() }
    $process.Dispose()
  }
}

function New-E1Privacy([bool]$Read) {
  return [ordered]@{
    raw_content_persisted = $false; raw_content_printed = $false
    raw_content_read_in_memory_for_sanitization = $Read; error_text_persisted = $false
  }
}

function New-E1EventCounts([string]$RuntimeId) {
  if ($RuntimeId -eq 'claude-code') {
    return [ordered]@{ system = 0; assistant = 0; user = 0; result = 0; rate_limit_event = 0; unknown = 0 }
  }
  return [ordered]@{
    thread_started = 0; turn_started = 0; turn_completed = 0; turn_failed = 0
    item_started = 0; item_updated = 0; item_completed = 0; error = 0; unknown = 0
  }
}

function New-E1FailedProvider(
  [string]$RuntimeId,
  [int]$Ordinal,
  [string]$ClaimedAt,
  [string]$ReasonCode,
  [bool]$ProcessStarted = $false,
  [bool]$ProcessTreeCleanupConfirmed = $false
) {
  $codex = $RuntimeId -eq 'codex-cli'
  $record = [ordered]@{
    runtime_id = $RuntimeId; dispatch_ordinal = $Ordinal; state = 'failed'; claimed_at_utc = $ClaimedAt
    completed_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ'); elapsed_milliseconds = $null
    cli_version = $(if ($codex) { "codex-cli $ExpectedCodexVersion" } else { $ExpectedClaudeVersion })
    local_auth_status_exit_code = 0; process_started = $ProcessStarted; process_exit_code = $null; timed_out = $false
    process_tree_cleanup_confirmed = $ProcessTreeCleanupConfirmed; reason_code = $ReasonCode
    event_type_counts = New-E1EventCounts $RuntimeId; parse_error_count = 0; agent_message_count = 0
    response_matched = $false; tool_invocation_count = 0
    tools_disabled = $(if ($codex) { $null } else { $true })
    tool_observation = $(if ($codex) { 'not_observed_dispatch_failed' } else { 'tools_disabled_dispatch_failed' })
    http_statuses = $(if ($codex) { $null } else { @() })
    http_status_reason = $(if ($codex) { 'runtime_does_not_expose_http_status' } else { $null })
    terminal = $(if ($codex) {
        [ordered]@{ thread_started_count = 0; turn_completed_count = 0; turn_failed_count = 0; error_event_count = 0 }
      } else { [ordered]@{ present = $false; is_error = $null } })
    credential_override_names = @($CredentialOverrideNames); privacy = New-E1Privacy $false
  }
  if ($codex) { $record['model'] = $CodexModel }
  return $record
}

function Invoke-E1ClaudeCanary([string]$Root, [string]$ClaimedAt, [string]$ProcessPath) {
  $started = [DateTime]::UtcNow
  $result = Invoke-E1BoundedProcess $ClaudeCommand @(
    '-p', '--setting-sources', 'user', '--disable-slash-commands', '--tools', '',
    '--strict-mcp-config', '--mcp-config', (Join-Path $Root 'empty-mcp.json'),
    '--output-format', 'stream-json', '--verbose', '--model', $script:ClaudeModel
  ) $Root $CanaryPrompt $DispatchTimeoutSeconds $ProcessPath
  $events = @(); $malformed = 0
  foreach ($line in @($result.stdout -split "`r?`n" | Where-Object { $_ -ne '' })) {
    try { $event = $line | ConvertFrom-Json -ErrorAction Stop; if ($event -is [pscustomobject]) { $events += $event } else { $malformed++ } }
    catch { $malformed++ }
  }
  $counts = New-E1EventCounts 'claude-code'; $terminal = @(); $tools = 0; $statuses = @(); $resolvedModels = @()
  foreach ($event in $events) {
    $type = if ($event.PSObject.Properties['type']) { [string]$event.type } else { '' }
    if ($counts.Contains($type)) { $counts[$type]++ } else { $counts.unknown++ }
    if ($type -eq 'rate_limit_event') {
      # The envelope itself (type/rate_limit_info/uuid/session_id) stays a
      # closed shape: an unexpected sibling field (e.g. stray raw content)
      # here is genuinely anomalous. The nested rate_limit_info metadata is
      # not closed: Anthropic may add further tier/status fields over time,
      # and an unrecognized additional field there is ordinary API evolution,
      # not a malformed response, as long as the fields this canary actually
      # depends on are present and well-formed.
      $topLevelKeys = @($event.PSObject.Properties.Name)
      $allowedTopLevelKeys = @('type', 'rate_limit_info', 'uuid', 'session_id')
      $info = if ($event.PSObject.Properties['rate_limit_info']) { $event.rate_limit_info } else { $null }
      $infoKeys = if ($info -is [pscustomobject]) { @($info.PSObject.Properties.Name) } else { @() }
      $statusPresent = 'status' -cin $infoKeys -or 'overageStatus' -cin $infoKeys
      $shapeValid = $topLevelKeys.Count -ge 2 -and @($topLevelKeys | Where-Object { $_ -cnotin $allowedTopLevelKeys }).Count -eq 0 -and
        $info -is [pscustomobject] -and $statusPresent
      if (-not $shapeValid) { $counts.unknown++ }
    }
    if ($type -eq 'result') { $terminal += $event }
    if ($type -eq 'system' -and $event.PSObject.Properties['subtype'] -and $event.subtype -eq 'init' -and
      $event.PSObject.Properties['model'] -and -not [string]::IsNullOrWhiteSpace([string]$event.model)) {
      $resolvedModels += [string]$event.model
    }
    if ($type -eq 'assistant' -and $event.PSObject.Properties['message'] -and $event.message.PSObject.Properties['content']) {
      $tools += @($event.message.content | Where-Object { $_.type -eq 'tool_use' }).Count
    }
    if ($type -eq 'system' -and $event.PSObject.Properties['subtype'] -and $event.subtype -eq 'api_retry' -and
      $event.PSObject.Properties['error_status']) {
      $statusText = [string]$event.error_status
      if ($statusText -match '^\d{3}$' -and [int]$statusText -in $AllowedClaudeHttpStatuses) { $statuses += [int]$statusText }
      else { $counts.unknown++ }
    }
  }
  $responseMatched = $terminal.Count -eq 1 -and $terminal[0].PSObject.Properties['result'] -and [string]$terminal[0].result -ceq $ExpectedResponse
  $isError = if ($terminal.Count -eq 1 -and $terminal[0].PSObject.Properties['is_error']) { $terminal[0].is_error } else { $null }
  $resolvedModelMatched = $resolvedModels.Count -eq 1 -and (
    $resolvedModels[0] -ceq $script:ClaudeModel -or
    $resolvedModels[0] -cmatch ('^' + [regex]::Escape($script:ClaudeModel) + '-\d{8}$')
  )
  $passed = $result.exit_code -eq 0 -and -not $result.timed_out -and $result.process_tree_cleanup_confirmed -and
    $malformed -eq 0 -and $counts.unknown -eq 0 -and $terminal.Count -eq 1 -and $responseMatched -and $isError -eq $false -and
    $resolvedModelMatched -and
    $tools -eq 0 -and @($statuses | Where-Object { $_ -in @(401, 403) }).Count -eq 0
  $record = [ordered]@{
    runtime_id = 'claude-code'; dispatch_ordinal = 1; state = $(if ($passed) { 'passed' } else { 'failed' })
    claimed_at_utc = $ClaimedAt; completed_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    elapsed_milliseconds = [int]([DateTime]::UtcNow - $started).TotalMilliseconds; cli_version = $ExpectedClaudeVersion
    local_auth_status_exit_code = 0; process_started = [bool]$result.process_started; process_exit_code = $result.exit_code; timed_out = $result.timed_out
    process_tree_cleanup_confirmed = $result.process_tree_cleanup_confirmed; reason_code = $result.reason_code
    event_type_counts = $counts; parse_error_count = $malformed; agent_message_count = $terminal.Count
    response_matched = [bool]$responseMatched; tool_invocation_count = $tools
    tools_disabled = $true; tool_observation = 'tools_disabled_and_observed_zero_tool_use'
    http_statuses = @($statuses | Sort-Object -Unique); http_status_reason = $null
    terminal = [ordered]@{ present = $terminal.Count -eq 1; is_error = $isError }
    credential_override_names = @($CredentialOverrideNames); privacy = New-E1Privacy $true
  }
  if ($script:ModelPairCanary) {
    $record['model'] = $script:ClaudeModel
    $record['model_resolved'] = $(if ($resolvedModels.Count -eq 1) { $resolvedModels[0] } else { $null })
  }
  return $record
}

function Find-E1CodexErrorCode($Value, [int]$Depth = 0) {
  if ($null -eq $Value -or $Depth -gt 6) { return $null }
  if ($Value -is [array]) {
    foreach ($entry in $Value) {
      $found = Find-E1CodexErrorCode $entry ($Depth + 1)
      if ($found) { return $found }
    }
    return $null
  }
  if ($Value -isnot [pscustomobject]) { return $null }
  foreach ($name in @('code', 'error_code', 'codex_error_info', 'status')) {
    $property = $Value.PSObject.Properties[$name]
    if (-not $property -or $null -eq $property.Value) { continue }
    $candidate = ([string]$property.Value).Trim().ToLowerInvariant()
    if ($candidate -cmatch '^[a-z0-9][a-z0-9_.-]{0,63}$' -and $candidate -cnotin @('error', 'failed', 'turn.failed')) {
      return ($candidate -replace '[^a-z0-9]+', '_').Trim('_')
    }
  }
  foreach ($property in $Value.PSObject.Properties) {
    $found = Find-E1CodexErrorCode $property.Value ($Depth + 1)
    if ($found) { return $found }
  }
  return $null
}

function Invoke-E1CodexCanary([string]$Root, [string]$ClaimedAt, [string]$ProcessPath) {
  $started = [DateTime]::UtcNow
  $result = Invoke-E1BoundedProcess $CodexCommand @(
    'exec', '--json', '--ephemeral', '--color', 'never', '--ignore-user-config', '--ignore-rules',
    '--skip-git-repo-check', '--sandbox', 'read-only', '--model', $CodexModel, '-'
  ) $Root $CanaryPrompt $DispatchTimeoutSeconds $ProcessPath
  $events = @(); $malformed = 0
  foreach ($line in @($result.stdout -split "`r?`n" | Where-Object { $_ -ne '' })) {
    try { $event = $line | ConvertFrom-Json -ErrorAction Stop; if ($event -is [pscustomobject]) { $events += $event } else { $malformed++ } }
    catch { $malformed++ }
  }
  $counts = New-E1EventCounts 'codex-cli'; $messages = @(); $toolIds = @{}
  $typeMap = @{
    'thread.started' = 'thread_started'; 'turn.started' = 'turn_started'; 'turn.completed' = 'turn_completed'
    'turn.failed' = 'turn_failed'; 'item.started' = 'item_started'; 'item.updated' = 'item_updated'
    'item.completed' = 'item_completed'; 'error' = 'error'
  }
  foreach ($event in $events) {
    $type = if ($event.PSObject.Properties['type']) { [string]$event.type } else { '' }
    if ($typeMap.ContainsKey($type)) { $counts[$typeMap[$type]]++ } else { $counts.unknown++ }
    if ($type -match '^item\.') {
      if (-not $event.PSObject.Properties['item'] -or [string]::IsNullOrWhiteSpace([string]$event.item.type)) { $malformed++; continue }
      $itemType = [string]$event.item.type
      if ($type -eq 'item.completed' -and $itemType -eq 'agent_message') { $messages += $event.item }
      if ($itemType -notin @('agent_message', 'reasoning', 'plan', 'plan_update', 'error')) {
        $itemId = if ($event.item.PSObject.Properties['id']) { [string]$event.item.id } else { "$type|$itemType|$($toolIds.Count)" }
        $toolIds[$itemId] = $true
      }
    }
  }
  $responseMatched = $messages.Count -eq 1 -and $messages[0].PSObject.Properties['text'] -and [string]$messages[0].text -ceq $ExpectedResponse
  $providerErrorCode = $result.reason_code
  if (-not $providerErrorCode -and ($counts.turn_failed -gt 0 -or $counts.error -gt 0)) {
    $failureEvents = @($events | Where-Object {
        $_.PSObject.Properties['type'] -and [string]$_.type -in @('error', 'turn.failed')
      })
    foreach ($event in $failureEvents) {
      $safeCode = Find-E1CodexErrorCode $event
      if ($safeCode) { $providerErrorCode = "provider_code_$safeCode"; break }
    }
    if (-not $providerErrorCode) {
      $failureWire = [string]::Join(' ', @($failureEvents | ForEach-Object { $_ | ConvertTo-Json -Depth 8 -Compress }))
      $providerErrorCode = switch -Regex ($failureWire) {
        '(?i)invalid_prompt|usage.policy' { 'provider_invalid_prompt'; break }
        '(?i)server_overloaded|at.capacity' { 'provider_server_overloaded'; break }
        '(?i)rate.?limit|\b429\b' { 'provider_rate_limited'; break }
        '(?i)unauthorized|\b401\b' { 'provider_unauthorized'; break }
        '(?i)forbidden|\b403\b' { 'provider_forbidden'; break }
        '(?i)not.?found|\b404\b' { 'provider_not_found'; break }
        '(?i)verification|required.to.verify' { 'provider_verification_required'; break }
        '(?i)not.supported|unsupported' { 'provider_model_unsupported'; break }
        '(?i)not.available|unavailable|does.not.exist|do.not.have.access' { 'provider_model_unavailable'; break }
        '(?i)ineligible|entitlement|subscription|plan' { 'provider_account_ineligible'; break }
        '(?i)upgrade|client.version|version.required' { 'provider_client_upgrade_required'; break }
        '(?i)authentication|login|refresh.token|access.token' { 'provider_auth_error'; break }
        '(?i)websocket|stream|transport' { 'provider_transport_error'; break }
        '(?i)error.sending.request|connection|network|dns' { 'provider_network_error'; break }
        '(?i)model' { 'provider_model_error'; break }
        '(?i)prompt|policy|safety' { 'provider_request_rejected'; break }
        '(?i)internal|server|service' { 'provider_server_error'; break }
        default { 'provider_failed_unclassified' }
      }
    }
  }
  $passed = $result.exit_code -eq 0 -and -not $result.timed_out -and $result.process_tree_cleanup_confirmed -and
    $malformed -eq 0 -and $counts.unknown -eq 0 -and $counts.thread_started -eq 1 -and $counts.turn_completed -eq 1 -and
    $counts.turn_failed -eq 0 -and $counts.error -eq 0 -and $messages.Count -eq 1 -and $responseMatched -and $toolIds.Count -eq 0
  return [ordered]@{
    runtime_id = 'codex-cli'; dispatch_ordinal = 2; state = $(if ($passed) { 'passed' } else { 'failed' })
    claimed_at_utc = $ClaimedAt; completed_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    elapsed_milliseconds = [int]([DateTime]::UtcNow - $started).TotalMilliseconds; cli_version = "codex-cli $ExpectedCodexVersion"; model = $CodexModel
    local_auth_status_exit_code = 0; process_started = [bool]$result.process_started; process_exit_code = $result.exit_code; timed_out = $result.timed_out
    process_tree_cleanup_confirmed = $result.process_tree_cleanup_confirmed; reason_code = $providerErrorCode
    event_type_counts = $counts; parse_error_count = $malformed; agent_message_count = $messages.Count
    response_matched = [bool]$responseMatched; tool_invocation_count = $toolIds.Count
    tools_disabled = $null; tool_observation = 'observed_zero_tool_items'
    http_statuses = $null; http_status_reason = 'runtime_does_not_expose_http_status'
    terminal = [ordered]@{
      thread_started_count = $counts.thread_started; turn_completed_count = $counts.turn_completed
      turn_failed_count = $counts.turn_failed; error_event_count = $counts.error
    }
    credential_override_names = @($CredentialOverrideNames); privacy = New-E1Privacy $true
  }
}

function Test-E1ProviderSafetyComplete($Provider) {
  if ($Provider.process_started -ne $true -or $Provider.process_tree_cleanup_confirmed -ne $true -or
    $Provider.timed_out -ne $false -or [int]$Provider.parse_error_count -ne 0 -or
    [int]$Provider.event_type_counts.unknown -ne 0 -or [int]$Provider.tool_invocation_count -ne 0) { return $false }
  if ($Provider.reason_code -in @(
      'operation_aborted_before_spawn','operation_aborted','process_start_failed','process_observation_failed','process_timeout','process_cleanup_failed'
    )) { return $false }
  return $true
}

function Write-E1IncompleteTerminal(
  [string]$ReasonCode,
  [int]$ClaimedSessions,
  [int]$DispatchedSessions,
  [bool]$ProcessTreeCleanupConfirmed
) {
  $terminalPath = Join-Path $operationPath 'terminal-incomplete.json'
  Write-E1CreateNewJson $terminalPath ([ordered]@{
      schema = 1; state = 'incomplete'; operation_id = $OperationId
      completed_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      claimed_sessions = $ClaimedSessions; dispatched_sessions = $DispatchedSessions
      reason_code = $ReasonCode; process_tree_cleanup_confirmed = $ProcessTreeCleanupConfirmed
      privacy = New-E1Privacy $false
    })
}

$parsedOperationId = [guid]::Empty
if (-not [guid]::TryParseExact($OperationId, 'D', [ref]$parsedOperationId) -or $parsedOperationId -eq [guid]::Empty -or
  $OperationId -cne $parsedOperationId.ToString('D')) { throw 'operation_id_invalid' }
if ([string]::IsNullOrWhiteSpace($ExpectedVMName) -or
  $ExpectedVMId -cnotmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$') { throw 'e2e_vm_identity_mismatch' }
$script:ClaudeModel = $CanonicalClaudeModel
$script:ModelPairCanary = $false
$modelPairRequestPath = Join-Path (Join-Path $OperationRoot 'model-pair-requests') "$OperationId.json"
if (Test-Path -LiteralPath $modelPairRequestPath -PathType Leaf) {
  $modelPairRequest = Get-Content -LiteralPath $modelPairRequestPath -Raw | ConvertFrom-Json -ErrorAction Stop
  if (-not (Test-E1ExactKeys $modelPairRequest @('schema','operation_id','claude_model','codex_model','campaign_kind')) -or
    $modelPairRequest.schema -ne 1 -or $modelPairRequest.operation_id -cne $OperationId -or
    $modelPairRequest.campaign_kind -cne 'paired-model-availability-canary') { throw 'model_pair_request_invalid' }
  $script:ClaudeModel = [string]$modelPairRequest.claude_model
  $requestedCodexModel = [string]$modelPairRequest.codex_model
  if (-not $AllowedModelPairs.Contains($script:ClaudeModel) -or
    [string]$AllowedModelPairs[$script:ClaudeModel] -cne $requestedCodexModel -or $CodexModel -cne $requestedCodexModel) {
    throw 'model_pair_mismatch'
  }
  $script:ModelPairCanary = $true
} elseif ($CodexModel -cne $CanonicalModel) { throw 'codex_model_mismatch' }
if ($HostReadinessSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'host_readiness_hash_invalid' }
$hostReadinessAt = [DateTime]::MinValue
if (-not [DateTime]::TryParse($HostReadinessGeneratedAtUtc, [ref]$hostReadinessAt)) { throw 'host_readiness_timestamp_invalid' }
if (-not $TestMode) {
  $actualVmId = [string](Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters' -Name VirtualMachineId)
  if ($actualVmId.ToLowerInvariant() -cne $ExpectedVMId.ToLowerInvariant()) { throw 'e2e_vm_identity_mismatch' }
  if ([IO.Path]::GetFullPath($OperationRoot).TrimEnd('\') -cne 'C:\Evidence1Ops\remote-auth-canary-v2') { throw 'operation_root_invalid' }
  if ([IO.Path]::GetFullPath($GuestReadinessPath) -cne 'C:\kmp-eval\scratch\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1\READINESS.json') {
    throw 'guest_readiness_path_invalid'
  }
}
$operationPath = Join-Path $OperationRoot $OperationId
$script:AbortPath = Join-Path $operationPath 'abort.claim.json'
$script:AbortAckPath = Join-Path $operationPath 'abort.ack.json'

if ($AbortOperation) {
  if (-not (Test-Path -LiteralPath $operationPath -PathType Container) -or
    -not (Test-Path -LiteralPath (Join-Path $operationPath 'claim.json') -PathType Leaf)) {
    return [ordered]@{ abort_claimed = $false; abort_acknowledged = $false; cleanup_confirmed = $false; reason_code = 'operation_custody_missing' }
  }
  if (-not (Test-Path -LiteralPath $script:AbortPath)) {
    Write-E1CreateNewJson $script:AbortPath ([ordered]@{
        schema = 1; operation_id = $OperationId; state = 'aborted'
        claimed_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      })
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    if (Test-Path -LiteralPath $script:AbortAckPath -PathType Leaf) {
      try {
        $ack = Get-Content -LiteralPath $script:AbortAckPath -Raw | ConvertFrom-Json -ErrorAction Stop
        $acknowledged = (Test-E1ExactKeys $ack @('schema','operation_id','state','cleanup_confirmed','acknowledged_at_utc')) -and
          $ack.schema -eq 1 -and $ack.operation_id -ceq $OperationId -and
          $ack.state -ceq 'acknowledged' -and $ack.cleanup_confirmed -eq $true
        return [ordered]@{
          abort_claimed = $true; abort_acknowledged = [bool]$acknowledged; cleanup_confirmed = [bool]$acknowledged
          reason_code = $(if ($acknowledged) { $null } else { 'abort_ack_invalid' })
        }
      } catch {
        return [ordered]@{ abort_claimed = $true; abort_acknowledged = $false; cleanup_confirmed = $false; reason_code = 'abort_ack_invalid' }
      }
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  return [ordered]@{ abort_claimed = $true; abort_acknowledged = $false; cleanup_confirmed = $false; reason_code = 'abort_ack_timeout' }
}

if ($CleanupOperation) {
  if (-not $CleanupOriginStoppedConfirmed) {
    return [ordered]@{
      cleanup_confirmed = $false; quiescence_confirmed = $false; process_records_observed = 0
      reason_code = 'origin_stop_not_confirmed'
    }
  }
  if (-not (Test-Path -LiteralPath $operationPath -PathType Container)) {
    return [ordered]@{ cleanup_confirmed = $false; quiescence_confirmed = $false; process_records_observed = 0; reason_code = 'operation_custody_missing' }
  }
  if (-not (Test-Path -LiteralPath $script:AbortPath)) {
    Write-E1CreateNewJson $script:AbortPath ([ordered]@{
        schema = 1; operation_id = $OperationId; state = 'aborted'
        claimed_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      })
  }
  $abortAckValid = $false
  if (Test-Path -LiteralPath $script:AbortAckPath -PathType Leaf) {
    try {
      $cleanupAck = Get-Content -LiteralPath $script:AbortAckPath -Raw | ConvertFrom-Json -ErrorAction Stop
      $abortAckValid = (Test-E1ExactKeys $cleanupAck @('schema','operation_id','state','cleanup_confirmed','acknowledged_at_utc')) -and
        $cleanupAck.schema -eq 1 -and $cleanupAck.operation_id -ceq $OperationId -and
        $cleanupAck.state -ceq 'acknowledged' -and $cleanupAck.cleanup_confirmed -eq $true
    } catch { $abortAckValid = $false }
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  $stableRounds = 0; $observedNames = @{}; $clean = $true; $lastSnapshot = ''
  do {
    $claims = @(Get-ChildItem -LiteralPath $operationPath -Filter '*.process-claim.json' -File -ErrorAction SilentlyContinue)
    $records = @(Get-ChildItem -LiteralPath $operationPath -Filter '*.process.json' -File -ErrorAction SilentlyContinue)
    $dispatchReceipts = @(Get-ChildItem -LiteralPath $operationPath -Filter '*.process-dispatch.json' -File -ErrorAction SilentlyContinue)
    $cleanupReceipts = @(Get-ChildItem -LiteralPath $operationPath -Filter '*.process-cleanup.json' -File -ErrorAction SilentlyContinue)
    $unresolved = 0
    foreach ($claimPath in $claims) {
      $observedNames[$claimPath.Name] = $true
      try { $claim = Get-Content -LiteralPath $claimPath.FullName -Raw | ConvertFrom-Json -ErrorAction Stop }
      catch { $clean = $false; $unresolved++; continue }
      $processFileName = $claimPath.Name -replace '\.process-claim\.json$', '.process.json'
      $processPath = Join-Path $operationPath $processFileName
      $expectedJobName = "Global\Evidence1RemoteAuth-$OperationId-$((Get-E1TextSha256 $processPath).Substring(0, 16))"
      $expectedGateName = "Global\Evidence1RemoteAuthGate-$OperationId-$((Get-E1TextSha256 $processPath).Substring(0, 16))"
      if (-not (Test-E1ExactKeys $claim @('schema','state','job_object_name','job_object_kill_on_close','start_gate_name','claimed_at_utc')) -or
        $claim.schema -ne 2 -or $claim.state -cne 'pre-spawn' -or $claim.job_object_name -cne $expectedJobName -or
        $claim.job_object_kill_on_close -ne $true -or $claim.start_gate_name -cne $expectedGateName) { $clean = $false; $unresolved++; continue }
      $record = $null
      if (Test-Path -LiteralPath $processPath -PathType Leaf) {
        try { $record = Get-Content -LiteralPath $processPath -Raw | ConvertFrom-Json -ErrorAction Stop }
        catch { $clean = $false; $unresolved++; continue }
        $observedNames[[IO.Path]::GetFileName($processPath)] = $true
        if (-not (Test-E1ExactKeys $record @('schema','process_id','state','job_object_name','job_object_kill_on_close','job_assignment_confirmed','started_at_utc')) -or
          $record.schema -ne 2 -or $record.state -cne 'assigned' -or $record.job_object_name -cne $expectedJobName -or
          $record.job_object_kill_on_close -ne $true -or $record.job_assignment_confirmed -ne $true -or
          (($record.process_id -isnot [int]) -and ($record.process_id -isnot [long]))) {
          $clean = $false; $unresolved++; continue
        }
      }
      $jobCleanup = Open-And-Close-E1NamedJob $expectedJobName
      $durableCleanup = if ($null -ne $record) { Test-E1RecordedProcessCleanup $processPath } else { $false }
      $rootAlive = $null -ne $record -and $null -ne (Get-Process -Id ([int]$record.process_id) -ErrorAction SilentlyContinue)
      $jobProof = $jobCleanup.cleanup_confirmed -eq $true -and ($jobCleanup.present -eq $true -or
        $durableCleanup -or ($abortAckValid -and $CleanupOriginStoppedConfirmed -and $claim.job_object_kill_on_close -eq $true))
      if (-not $jobProof -or $rootAlive) { $clean = $false; $unresolved++ }
    }
    foreach ($recordPath in $records) {
      $expectedClaim = $recordPath.Name -replace '\.process\.json$', '.process-claim.json'
      if ($expectedClaim -cnotin @($claims.Name)) { $clean = $false; $unresolved++ }
    }
    foreach ($dispatchPath in $dispatchReceipts) {
      $expectedClaim = $dispatchPath.Name -replace '\.process-dispatch\.json$', '.process-claim.json'
      if ($expectedClaim -cnotin @($claims.Name)) { $clean = $false; $unresolved++; continue }
      try {
        $dispatch = Get-Content -LiteralPath $dispatchPath.FullName -Raw | ConvertFrom-Json -ErrorAction Stop
        $processPath = Join-Path $operationPath ($dispatchPath.Name -replace '\.process-dispatch\.json$', '.process.json')
        $expectedJobName = "Global\Evidence1RemoteAuth-$OperationId-$((Get-E1TextSha256 $processPath).Substring(0, 16))"
        if (-not (Test-E1ExactKeys $dispatch @('schema','state','job_object_name','dispatched_at_utc')) -or
          $dispatch.schema -ne 1 -or $dispatch.state -cne 'dispatched' -or $dispatch.job_object_name -cne $expectedJobName) {
          $clean = $false; $unresolved++
        }
      } catch { $clean = $false; $unresolved++ }
    }
    foreach ($cleanupPath in $cleanupReceipts) {
      $expectedClaim = $cleanupPath.Name -replace '\.process-cleanup\.json$', '.process-claim.json'
      if ($expectedClaim -cnotin @($claims.Name)) { $clean = $false; $unresolved++ }
    }
    $snapshot = [string]::Join('|', @($claims.Name + $records.Name + $dispatchReceipts.Name + $cleanupReceipts.Name | Sort-Object))
    if ($snapshot -ceq $lastSnapshot) { $stableRounds++ } else { $stableRounds = 0 }
    $lastSnapshot = $snapshot
    if ($stableRounds -lt 3) { Start-Sleep -Milliseconds 250 }
  } while ($stableRounds -lt 3 -and [DateTime]::UtcNow -lt $deadline)
  $quiescent = $stableRounds -ge 3
  return [ordered]@{
    cleanup_confirmed = [bool]($clean -and $quiescent); quiescence_confirmed = [bool]$quiescent
    process_records_observed = $observedNames.Count
    reason_code = $(if (-not $clean) { 'process_tree_cleanup_failed' } elseif (-not $quiescent) { 'process_quiescence_not_confirmed' } else { $null })
  }
}

if (-not (Test-Path -LiteralPath $GuestReadinessPath -PathType Leaf)) { throw 'guest_readiness_missing' }
$readiness = Get-Content -LiteralPath $GuestReadinessPath -Raw | ConvertFrom-Json -ErrorAction Stop
$guestReadinessAt = [DateTime]::MinValue
if (-not $readiness.PSObject.Properties['generated_at_utc'] -or
  -not [DateTime]::TryParse([string]$readiness.generated_at_utc, [ref]$guestReadinessAt)) { throw 'guest_readiness_timestamp_invalid' }
$guestReadinessSha256 = Get-E1Sha256 $GuestReadinessPath
$context = [ordered]@{
  vm_name = $ExpectedVMName; vm_id = $ExpectedVMId.ToLowerInvariant(); codex_model = $CanonicalModel
  host_readiness_sha256 = $HostReadinessSha256; host_readiness_generated_at_utc = $hostReadinessAt.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  guest_readiness_sha256 = $guestReadinessSha256; guest_readiness_generated_at_utc = $guestReadinessAt.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}
if ($script:ModelPairCanary) {
  $context['claude_model'] = $script:ClaudeModel
  $context['codex_model'] = $CodexModel
  $context['campaign_kind'] = 'paired-model-availability-canary'
}

$claimPath = Join-Path $operationPath 'claim.json'
$finalPath = Join-Path $operationPath 'final.json'
$requiredPhrase = 'AUTORIZO EXACTAMENTE 2 SESIONES REMOTE-AUTH CANARY PARA ' + ('EVIDENCE' + '1') + ': 1 CLAUDE-CODE Y 1 CODEX-CLI; SIN REINTENTOS, REEMPLAZOS NI RESPAWNS.'
if ($AuthorizationPhrase -cne $requiredPhrase) { throw 'dual_canary_authorization_required' }
$authorizationSha256 = Get-E1TextSha256 $AuthorizationPhrase
$authorizationScopeSha256 = Get-E1TextSha256 ([string]::Join('|', @(
      $authorizationSha256, $ExpectedVMId.ToLowerInvariant(), $script:ClaudeModel, $CodexModel, $HostReadinessSha256, $guestReadinessSha256
    )))
$authorizationClaimPath = Join-Path (Join-Path $OperationRoot 'authorization-claims') "$authorizationScopeSha256.claim.json"
Write-E1CreateNewJson $authorizationClaimPath ([ordered]@{
    schema = 1; state = 'consumed'; operation_id = $OperationId
    authorization_sha256 = $authorizationSha256; authorization_scope_sha256 = $authorizationScopeSha256
    host_readiness_sha256 = $HostReadinessSha256; guest_readiness_sha256 = $guestReadinessSha256
    vm_id = $ExpectedVMId.ToLowerInvariant(); codex_model = $CodexModel
    claimed_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  })
Write-E1CreateNewJson $claimPath ([ordered]@{
    schema = 1; operation_id = $OperationId; state = 'claimed'
    claimed_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    authorization_sha256 = $authorizationSha256; authorization_scope_sha256 = $authorizationScopeSha256; context = $context
  })

$preflightRoot = Join-Path $operationPath 'preflight'
[void](New-Item -ItemType Directory -Force -Path $preflightRoot)
$claudeVersionResult = Invoke-E1BoundedProcess $ClaudeCommand @('--version') $preflightRoot '' $PreflightTimeoutSeconds (Join-Path $operationPath 'preflight-claude-version.process.json')
$claudeAuthResult = Invoke-E1BoundedProcess $ClaudeCommand @('auth', 'status') $preflightRoot '' $PreflightTimeoutSeconds (Join-Path $operationPath 'preflight-claude-auth.process.json')
$codexVersionResult = Invoke-E1BoundedProcess $CodexCommand @('--version') $preflightRoot '' $PreflightTimeoutSeconds (Join-Path $operationPath 'preflight-codex-version.process.json')
$codexAuthResult = Invoke-E1BoundedProcess $CodexCommand @('login', 'status') $preflightRoot '' $PreflightTimeoutSeconds (Join-Path $operationPath 'preflight-codex-auth.process.json')
$preflightResults = @($claudeVersionResult, $claudeAuthResult, $codexVersionResult, $codexAuthResult)
Assert-E1OperationNotAborted
$preflightOk = $claudeVersionResult.exit_code -eq 0 -and -not $claudeVersionResult.timed_out -and $claudeVersionResult.process_tree_cleanup_confirmed -and
  [string]$claudeVersionResult.stdout -match ('^' + [regex]::Escape($ExpectedClaudeVersion)) -and
  $claudeAuthResult.exit_code -eq 0 -and -not $claudeAuthResult.timed_out -and $claudeAuthResult.process_tree_cleanup_confirmed -and
  $codexVersionResult.exit_code -eq 0 -and -not $codexVersionResult.timed_out -and $codexVersionResult.process_tree_cleanup_confirmed -and
  ([string]$codexVersionResult.stdout).Trim() -ceq "codex-cli $ExpectedCodexVersion" -and
  $codexAuthResult.exit_code -eq 0 -and -not $codexAuthResult.timed_out -and $codexAuthResult.process_tree_cleanup_confirmed -and
  $CredentialOverrideNames.Count -eq 0
if (-not $preflightOk) {
  $preflightCleanup = @($preflightResults | Where-Object { $_.process_tree_cleanup_confirmed -ne $true }).Count -eq 0
  Write-E1IncompleteTerminal 'bounded_local_auth_preflight_failed' 0 0 $preflightCleanup
  throw 'bounded_local_auth_preflight_failed'
}

$providers = @(); $claimedSessions = 0; $dispatchedSessions = 0
foreach ($slot in @(
    [ordered]@{ ordinal = 1; runtime = 'claude-code' },
    [ordered]@{ ordinal = 2; runtime = 'codex-cli' }
  )) {
  Assert-E1OperationNotAborted
  $claimedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  Write-E1CreateNewJson (Join-Path $operationPath "slot-$($slot.ordinal).claim.json") ([ordered]@{
      schema = 1; operation_id = $OperationId; runtime_id = $slot.runtime
      dispatch_ordinal = $slot.ordinal; state = 'consumed'; claimed_at_utc = $claimedAt
    })
  $claimedSessions++
  $slotRoot = Join-Path $operationPath "slot-$($slot.ordinal)-workspace"
  [void](New-Item -ItemType Directory -Path $slotRoot)
  if ($slot.ordinal -eq 1) {
    [IO.File]::WriteAllText((Join-Path $slotRoot 'empty-mcp.json'), '{"mcpServers":{}}', [Text.UTF8Encoding]::new($false))
    try { $provider = Invoke-E1ClaudeCanary $slotRoot $claimedAt (Join-Path $operationPath 'slot-1.process.json') }
    catch {
      $processPath = Join-Path $operationPath 'slot-1.process.json'
      $startedUnexpectedly = Test-Path -LiteralPath $processPath -PathType Leaf
      $cleanupUnexpected = -not $startedUnexpectedly
      if ($startedUnexpectedly) {
        try {
          $cleanupUnexpected = Test-E1RecordedProcessCleanup $processPath
        } catch { $cleanupUnexpected = $false }
      }
      $provider = New-E1FailedProvider 'claude-code' 1 $claimedAt 'provider_sanitization_failed' $startedUnexpectedly $cleanupUnexpected
    }
  } else {
    try { $provider = Invoke-E1CodexCanary $slotRoot $claimedAt (Join-Path $operationPath 'slot-2.process.json') }
    catch {
      $processPath = Join-Path $operationPath 'slot-2.process.json'
      $startedUnexpectedly = Test-Path -LiteralPath $processPath -PathType Leaf
      $cleanupUnexpected = -not $startedUnexpectedly
      if ($startedUnexpectedly) {
        try {
          $cleanupUnexpected = Test-E1RecordedProcessCleanup $processPath
        } catch { $cleanupUnexpected = $false }
      }
      $provider = New-E1FailedProvider 'codex-cli' 2 $claimedAt 'provider_sanitization_failed' $startedUnexpectedly $cleanupUnexpected
    }
  }
  Write-E1CreateNewJson (Join-Path $operationPath "slot-$($slot.ordinal).result.json") $provider
  $providers += $provider
  if ($provider.process_started -eq $true) { $dispatchedSessions++ }
  if (-not (Test-E1ProviderSafetyComplete $provider)) {
    Write-E1IncompleteTerminal "slot_$($slot.ordinal)_safety_incomplete" $claimedSessions $dispatchedSessions ([bool]$provider.process_tree_cleanup_confirmed)
    throw "slot_$($slot.ordinal)_safety_incomplete"
  }
  Assert-E1OperationNotAborted
  if ($TestMode -and $TestFaultAfterSlot -eq $slot.ordinal) { throw "test_fault_after_slot_$($slot.ordinal)" }
}

$passed = $providers.Count -eq 2 -and @($providers | Where-Object { $_.state -ne 'passed' }).Count -eq 0
$final = [ordered]@{
  schema = $(if ($script:ModelPairCanary) { 3 } else { 2 }); state = $(if ($passed) { 'passed' } else { 'failed' }); operation_id = $OperationId
  completed_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ'); context = $context
  authorization_scope = [ordered]@{
    authorized_sessions = 2; claimed_sessions = $claimedSessions; dispatched_sessions = $dispatchedSessions
    providers = @('claude-code', 'codex-cli')
    retry_count = 0; replacement_count = 0; respawn_count = 0
  }
  providers = @($providers); credential_override_names = @($CredentialOverrideNames); privacy = New-E1Privacy $true
}
Write-E1CreateNewJson $finalPath $final
# Return only a sanitized JSON value so PowerShell remoting cannot decorate the
# provider record with transport metadata that would violate the closed schema.
return ($final | ConvertTo-Json -Depth 20 -Compress)
