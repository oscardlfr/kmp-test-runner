Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:E1SourceCommit = '7d45eae4f8720a0c77f507712ba2437ff974b6ed'
$script:E1FailureCodes = @(
    'none','preflight_failed','postflight_failed','postflight_pending','attempt_exists','interrupted',
    'product_failed','product_timeout','product_contract','dry_plan_failed','dry_plan_contract','terminal_write_failed',
    'evidence_mismatch','path_invalid','path_outside_root','path_link','guest_identity','json_size','timestamp_invalid',
    'evidence_stale','target_invalid','readiness_tools','attestation_path','ledger_time','attestation_shape','attestation_expiry',
    'job_create','stream_create','attributes_create','attributes_update','process_create','process_wait','process_exit',
    'live_custody','live_overlap','ambient_credentials','environment_override','git_failed','git_output_size',
    'repo_commit','repo_tree','repo_root','repo_dirty','repo_overlap','validation_overlap','operation_invalid',
    'records_changed','evidence_changed','result_shape','report_path','identity_invalid','credential_path','credential_shape',
    'host_privilege','vm_not_running','transport_timeout','transport_shape','transport_failed','readiness_changed',
    'module_hash_mismatch','module_target_mismatch','report_write_failed','profile_registry',
    'source_artifacts','source_artifact_limit','source_tracked_changed','source_index_changed','java_toolchain'
)

function Get-E1FailureCode($Failure, [string]$Fallback = 'preflight_failed') {
    $exception = $Failure.Exception
    for ($i = 0; $null -ne $exception -and $i -lt 8; $i++) {
        if ($exception.Message -cin $script:E1FailureCodes) { return $exception.Message }
        $exception = $exception.InnerException
    }
    if ($Fallback -cin $script:E1FailureCodes -and $Fallback -cne 'none') { return $Fallback }
    return 'preflight_failed'
}

function ConvertFrom-E1Json([string]$Text) {
    $options = @{ InputObject = $Text; ErrorAction = 'Stop' }
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $options.DateKind = 'String' }
    ConvertFrom-Json @options
}

function Get-E1Field($Value, [string]$Name) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [Collections.IDictionary]) { return ,$Value[$Name] }
    $property = $Value.PSObject.Properties[$Name]
    if ($null -ne $property) { return ,$property.Value }
    return $null
}

function Test-E1Exact($Actual, $Expected) {
    if ($Expected -is [bool]) { return $Actual -is [bool] -and $Actual -eq $Expected }
    if ($Expected -is [int]) {
        return ($Actual -is [int] -or $Actual -is [long]) -and $Actual -eq $Expected
    }
    return $Actual -is [string] -and $Actual -ceq $Expected
}

function Assert-E1Fields($Value, $Expected) {
    foreach ($key in $Expected.Keys) {
        if (-not (Test-E1Exact (Get-E1Field $Value $key) $Expected[$key])) { throw 'evidence_mismatch' }
    }
}

function Resolve-E1Path([string]$Path, [string]$Root = 'C:\kmp-eval') {
    $normalized = $Path.Replace('/', '\')
    if ($normalized -notmatch '^C:\\[A-Za-z0-9 _.-]+(?:\\[A-Za-z0-9 _.-]+)*$') { throw 'path_invalid' }
    foreach ($segment in $normalized.Substring(3).Split('\')) {
        if ($segment -in @('.', '..') -or $segment.EndsWith('.') -or $segment.EndsWith(' ')) { throw 'path_invalid' }
    }
    $full = $normalized
    $prefix = $Root.Replace('/', '\').TrimEnd('\') + '\'
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'path_outside_root' }
    $current = if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { $full } else { $null }
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
                (Get-E1Field $item 'LinkType') -eq 'HardLink') { throw 'path_link' }
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
    return $full
}

function Assert-E1GuestIdentity {
    param($ComputerName, $HostComputerName, $ExpectedGuest, $ActualVmId, $ExpectedVmId,
        $Manufacturer, $Model, $User, $ExpectedUser)
    $actual = [guid]::Empty
    $expected = [guid]::Empty
    if (-not [guid]::TryParse([string]$ActualVmId, [ref]$actual) -or
        -not [guid]::TryParse([string]$ExpectedVmId, [ref]$expected) -or
        $actual -eq [guid]::Empty -or $actual -ne $expected -or
        $ComputerName -ine $ExpectedGuest -or $ComputerName -ieq $HostComputerName -or
        $Manufacturer -cne 'Microsoft Corporation' -or $Model -cne 'Virtual Machine' -or
        $User -ine $ExpectedUser -or $User -in @('root', 'SYSTEM', 'LOCAL SERVICE', 'NETWORK SERVICE')) {
        throw 'guest_identity'
    }
}

function Get-E1Sha256([byte[]]$Bytes) {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return -join ($hasher.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) }
    finally { $hasher.Dispose() }
}

function Read-E1Json([string]$Path, [int]$MaxBytes = 1048576) {
    $full = Resolve-E1Path $Path
    $item = Get-Item -LiteralPath $full -Force
    if ($item.PSIsContainer -or $item.Length -gt $MaxBytes) { throw 'json_size' }
    $bytes = [IO.File]::ReadAllBytes($full)
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes).TrimStart([char]0xfeff)
    return @{ value = (ConvertFrom-E1Json $text); sha256 = (Get-E1Sha256 $bytes) }
}

function Get-E1Timestamp($Value) {
    if ($Value -isnot [string] -or $Value -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$') { throw 'timestamp_invalid' }
    return [datetime]::Parse($Value, [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AdjustToUniversal)
}

function Assert-E1Fresh($Value, [datetime]$NowUtc) {
    $timestamp = Get-E1Timestamp $Value
    $age = ($NowUtc.ToUniversalTime() - $timestamp).TotalSeconds
    if ($age -lt -300 -or $age -gt 3600) { throw 'evidence_stale' }
    return $timestamp
}

function Assert-E1Evidence {
    param($Readiness, $Ledger, $Attestation, [string]$VMName, [string]$TargetCommit,
        [string]$TargetTree, [string]$AttestationPath, [datetime]$NowUtc = [datetime]::UtcNow)
    if ($TargetCommit -cnotmatch '^[a-f0-9]{40}$' -or $TargetTree -cnotmatch '^[a-f0-9]{40}$') { throw 'target_invalid' }
    $NowUtc = $NowUtc.ToUniversalTime()
    Assert-E1Fields $Readiness @{ verdict = 'PASS'; vm_name = $VMName; vm_state = 'Running'; target_commit = $TargetCommit; target_tree = $TargetTree }
    $readinessTime = Assert-E1Fresh (Get-E1Field $Readiness 'generated_at_utc') $NowUtc
    $guest = Get-E1Field $Readiness 'guest'
    Assert-E1Fields $guest @{ verdict = 'PASS'; harness_head = $TargetCommit; harness_tree = $TargetTree; source_head = $script:E1SourceCommit }
    Assert-E1Fields $guest @{ planned_sessions = 8 }
    $claude = Get-E1Field (Get-E1Field $guest 'tools') 'claude'
    if ($claude -isnot [string] -or $claude -cnotmatch '^2\.1\.238(?: \(Claude Code\))?$') { throw 'readiness_tools' }
    Assert-E1Fields (Get-E1Field $guest 'tools') @{ java_present = $true }
    if ((Resolve-E1Path (Get-E1Field $guest 'attestation_path')) -ine (Resolve-E1Path $AttestationPath)) { throw 'attestation_path' }
    Assert-E1Fields (Get-E1Field $Readiness 'privacy') @{
        raw_transcript_content_read = $false; stderr_content_read = $false
        attestation_content_printed = $false; dry_run_stdout_printed = $false
    }
    Assert-E1Fields $Ledger @{ verdict = 'PASS' }
    Assert-E1Fields (Get-E1Field $Ledger 'tools') @{ java_present = $true; claude_logged_in = $true }
    $ledgerClaude = Get-E1Field (Get-E1Field $Ledger 'tools') 'claude'
    if ($ledgerClaude -isnot [string] -or $ledgerClaude -cnotmatch '^2\.1\.238(?: \(Claude Code\))?$') { throw 'readiness_tools' }
    $ledgerTime = Assert-E1Fresh (Get-E1Field $Ledger 'generated_at_utc') $NowUtc
    if ($ledgerTime -gt $readinessTime -or ($readinessTime - $ledgerTime).TotalSeconds -gt 300) { throw 'ledger_time' }
    Assert-E1Fields (Get-E1Field $Ledger 'anchors') @{
        harness_commit_actual = $TargetCommit; harness_commit_expected = $TargetCommit
        harness_tree_actual = $TargetTree; harness_tree_expected = $TargetTree
        source_commit_actual = $script:E1SourceCommit; source_commit_expected = $script:E1SourceCommit
    }
    Assert-E1Fields (Get-E1Field $Ledger 'zero_live_confirmation') @{
        no_non_dry_run_command_executed_by_readiness = $true; no_calibrate_or_smoke = $true
        raw_transcript_content_read = $false; stderr_content_read = $false
    }
    Assert-E1Fields (Get-E1Field $Ledger 'operator_confirmation') @{
        boundary_kind = 'dedicated-ephemeral-runner'; workspace = 'campaign-only'; credentials = 'runtime-only'
        network = 'restricted'; normal_home_mounted = $false; ambient_secrets_present = $false
        disposable_home = $true; rollback_or_destroy_required = $true; supplied_in_session = $true
    }
    Assert-E1Fields (Get-E1Field $Ledger 'network') @{ allowed_probe_count = 4; blocked_probe_count = 6; blocked_probe_success_count = 0 }
    $oldPlan = Get-E1Field (Get-E1Field $Ledger 'R7_campaign_dry_run') 'pass_dry_run'
    Assert-E1Fields $oldPlan @{
        campaign_design_id = 'claude-product-vs-free-baseline-v1'; planned_sessions = 8; plan_length = 8
        strict_cell_count = 0; unrestricted_cell_count = 8; strict_cells_with_attestation_hash = 0
        unrestricted_cells_with_attestation_hash = 8; distinct_attestation_hashes_among_unrestricted = 1
        attestation_hash_matches_fresh_attestation = $true; attestation_path_leaked_in_output = $false
        attestation_content_leaked_in_output = $false; attestation_timestamps_leaked_in_output = $false
    }
    $expectedAttestation = @{
        schema = 1; profile_id = 'sandboxed-unrestricted-v1'; runtime_id = 'claude-code'
        campaign_id = 'evidence1-product-free-stageb'; platform = 'windows'
        boundary_kind = 'dedicated-ephemeral-runner'; network_mode = 'restricted'
        workspace_scope = 'campaign-only'; runtime_credential_scope = 'runtime-only'
        normal_maintainer_home_mounted = $false; ambient_secrets_present = $false
        disposable_home = $true; rollback_or_destroy_required = $true; harness_sha = $TargetCommit
    }
    Assert-E1Fields $Attestation $expectedAttestation
    $names = @($Attestation.PSObject.Properties.Name)
    if ($names.Count -ne 16 -or @($names | Where-Object { $_ -notin @($expectedAttestation.Keys) + @('created_at','expires_at') }).Count) { throw 'attestation_shape' }
    $created = Assert-E1Fresh (Get-E1Field $Attestation 'created_at') $NowUtc
    $expires = Get-E1Timestamp (Get-E1Field $Attestation 'expires_at')
    if ($created -gt $ledgerTime -or ($expires - $NowUtc).TotalSeconds -le 360 -or
        ($expires - $created).TotalHours -gt 24 -or $expires -le $created) { throw 'attestation_expiry' }
    # This closed schema contains only ASCII enum strings, SHA, UTC timestamps, integer 1 and booleans.
    # Sorted compact JSON therefore matches the harness canonical JSON byte contract exactly.
    $canonical = [ordered]@{}
    foreach ($key in ($names | Sort-Object -CaseSensitive)) { $canonical[$key] = Get-E1Field $Attestation $key }
    $hash = Get-E1Sha256 ([Text.Encoding]::UTF8.GetBytes(($canonical | ConvertTo-Json -Compress)))
    Assert-E1Fields $guest @{ attestation_sha256 = $hash }
    Assert-E1Fields (Get-E1Field $Ledger 'r5_attestation') @{ ok = $true; schema = 1; attestation_sha256 = $hash }
    return $hash
}

function Get-E1WetChecks($Envelope, $ProcessExitCode, $WallSeconds) {
    $tests = Get-E1Field $Envelope 'tests'
    $coverage = Get-E1Field $Envelope 'coverage'
    $errorValue = Get-E1Field $Envelope 'errors'
    $errors = @($errorValue)
    $firstError = if ($errors.Count -eq 1) { $errors[0] } else { $null }
    $bucketValue = Get-E1Field (Get-E1Field $coverage 'module_buckets') 'with_data'
    $buckets = @($bucketValue)
    return [ordered]@{
        tool = (Test-E1Exact (Get-E1Field $Envelope 'tool') 'kmp-test')
        subcommand = (Test-E1Exact (Get-E1Field $Envelope 'subcommand') 'parallel')
        tests_total = (Test-E1Exact (Get-E1Field $tests 'total') 1)
        tests_passed = (Test-E1Exact (Get-E1Field $tests 'passed') 1)
        tests_failed = (Test-E1Exact (Get-E1Field $tests 'failed') 0)
        individual_total = (Test-E1Exact (Get-E1Field $tests 'individual_total') 4)
        missed_lines = (Test-E1Exact (Get-E1Field $coverage 'missed_lines') 23)
        modules_contributing = (Test-E1Exact (Get-E1Field $coverage 'modules_contributing') 1)
        with_data = ($bucketValue -is [array] -and $buckets.Count -eq 1 -and (Test-E1Exact $buckets[0] ':core:domain'))
        error_count = ($errorValue -is [array] -and $errors.Count -eq 1)
        error_code = (Test-E1Exact (Get-E1Field $firstError 'code') 'coverage_threshold_exceeded')
        error_threshold = (Test-E1Exact (Get-E1Field $firstError 'threshold') 15)
        error_missed_lines = (Test-E1Exact (Get-E1Field $firstError 'missed_lines') 23)
        envelope_exit = (Test-E1Exact (Get-E1Field $Envelope 'exit_code') 1)
        process_exit = (Test-E1Exact $ProcessExitCode 1)
        wall_budget = ($WallSeconds -is [ValueType] -and $WallSeconds -isnot [bool] -and $WallSeconds -ge 0 -and $WallSeconds -le 300)
    }
}

function Initialize-E1ProcessJob {
    if ('Evidence1.ValidationJob' -as [type]) { return }
    # JOB_LIST makes job membership atomic with process creation (Windows 10+); there is no
    # suspended-child/AssignProcessToJobObject crash window. HANDLE_LIST limits inheritance.
    # https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
    # Closing this job cannot terminate a process from another operation or an existing Gradle daemon.
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
namespace Evidence1 {
  public sealed class ProcessResult {
    public int ExitCode; public bool TimedOut; public double WallSeconds; public bool CleanupOk;
  }
  public static class ValidationJob {
    [StructLayout(LayoutKind.Sequential)] struct Limits {
      public long PerProcess, PerJob; public uint Flags; public UIntPtr Min, Max;
      public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Extended {
      public Limits Basic; public ulong R1,R2,R3,R4,R5,R6;
      public UIntPtr P1,P2,P3,P4;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
      public long T1,T2,T3,T4; public uint Faults,Total,Active,Terminated;
    }
    [StructLayout(LayoutKind.Sequential)] struct Security {
      public int Length; public IntPtr Descriptor; public int Inherit;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
      public int Size; public string Reserved,Desktop,Title;
      public int X,Y,W,H,CX,CY,Fill,Flags; public short Show,ReservedSize;
      public IntPtr ReservedPtr,Input,Output,Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct Info { public IntPtr Process,Thread; public uint Pid,Tid; }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Startup; public IntPtr Attributes; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a,string n);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr j,int c,ref Extended x,int s);
    [DllImport("kernel32.dll")] static extern bool QueryInformationJobObject(IntPtr j,int c,ref Accounting x,int s,IntPtr r);
    [DllImport("kernel32.dll")] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
    [DllImport("kernel32.dll")] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr key,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr j,uint e);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr p,uint e);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr p,out uint e);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string p,uint a,uint s,ref Security sec,uint c,uint f,IntPtr t);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref StartupEx startup,out Info info);
    public static string Quote(string arg) {
      var b = new StringBuilder("\""); int slash=0;
      foreach(char c in arg) {
        if(c=='\\') { slash++; continue; }
        if(c=='"') { b.Append('\\',slash*2+1).Append(c); slash=0; continue; }
        b.Append('\\',slash).Append(c); slash=0;
      }
      return b.Append('\\',slash*2).Append('"').ToString();
    }
    public static ProcessResult Run(string exe,string[] args,string cwd,string stdout,string stderr,int seconds) {
      IntPtr job=IntPtr.Zero, o=IntPtr.Zero, e=IntPtr.Zero, input=IntPtr.Zero;
      IntPtr attributes=IntPtr.Zero, jobList=IntPtr.Zero, handleList=IntPtr.Zero; bool initialized=false;
      Info pi=new Info(); var clock=new Stopwatch();
      try {
        job=CreateJobObject(IntPtr.Zero,null);
        var limits=new Extended(); limits.Basic.Flags=0x2000;
        if(job==IntPtr.Zero || !SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits))) throw new Exception("job_create");
        var sec=new Security { Length=Marshal.SizeOf(typeof(Security)), Inherit=1 };
        o=CreateFile(stdout,0x40000000,3,ref sec,1,0,IntPtr.Zero);
        e=CreateFile(stderr,0x40000000,3,ref sec,1,0,IntPtr.Zero);
        input=CreateFile("NUL",0x80000000,3,ref sec,3,0,IntPtr.Zero);
        if(o==new IntPtr(-1)||e==new IntPtr(-1)||input==new IntPtr(-1)) throw new Exception("stream_create");
        IntPtr size=IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
        attributes=Marshal.AllocHGlobal(size);
        if(!InitializeProcThreadAttributeList(attributes,2,0,ref size)) throw new Exception("attributes_create");
        initialized=true; jobList=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList,job);
        handleList=Marshal.AllocHGlobal(IntPtr.Size*3);
        Marshal.WriteIntPtr(handleList,0,input); Marshal.WriteIntPtr(handleList,IntPtr.Size,o); Marshal.WriteIntPtr(handleList,IntPtr.Size*2,e);
        if(!UpdateProcThreadAttribute(attributes,0,new IntPtr(0x2000D),jobList,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero)||
           !UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handleList,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero)) throw new Exception("attributes_update");
        var start=new StartupEx { Startup=new Startup { Size=Marshal.SizeOf(typeof(StartupEx)), Flags=0x100, Input=input, Output=o, Error=e }, Attributes=attributes };
        var cmd=new StringBuilder(Quote(exe)); foreach(var arg in args) cmd.Append(' ').Append(Quote(arg));
        clock.Start();
        if(!CreateProcess(exe,cmd,IntPtr.Zero,IntPtr.Zero,true,0x08080000,IntPtr.Zero,cwd,ref start,out pi)) throw new Exception("process_create");
        uint wait=WaitForSingleObject(pi.Process,(uint)(seconds*1000));
        if(wait!=0 && wait!=258) throw new Exception("process_wait");
        clock.Stop(); uint exit;
        if(!GetExitCodeProcess(pi.Process,out exit)) throw new Exception("process_exit");
        bool stopped=TerminateJobObject(job,124);
        var deadline=Stopwatch.StartNew(); var accounting=new Accounting();
        while(stopped && deadline.ElapsedMilliseconds<10000) {
          if(!QueryInformationJobObject(job,1,ref accounting,Marshal.SizeOf(accounting),IntPtr.Zero)) { stopped=false; break; }
          if(accounting.Active==0) break;
          System.Threading.Thread.Sleep(20);
        }
        return new ProcessResult { ExitCode=wait==258?124:(int)exit, TimedOut=wait==258,
          WallSeconds=clock.Elapsed.TotalSeconds, CleanupOk=stopped&&accounting.Active==0 };
      } finally {
        if(pi.Process!=IntPtr.Zero) { TerminateProcess(pi.Process,124); WaitForSingleObject(pi.Process,10000); CloseHandle(pi.Process); }
        if(pi.Thread!=IntPtr.Zero) CloseHandle(pi.Thread);
        if(job!=IntPtr.Zero) CloseHandle(job);
        if(initialized) DeleteProcThreadAttributeList(attributes);
        foreach(var p in new[]{attributes,jobList,handleList}) if(p!=IntPtr.Zero) Marshal.FreeHGlobal(p);
        foreach(var h in new[]{o,e,input}) if(h!=IntPtr.Zero&&h!=new IntPtr(-1)) CloseHandle(h);
      }
    }
  }
}
'@ | Out-Null
}

function Invoke-E1OwnedProcess([string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory,
    [string]$Stdout, [string]$Stderr, [int]$Seconds) {
    Initialize-E1ProcessJob
    return [Evidence1.ValidationJob]::Run($Executable, $Arguments, $WorkingDirectory, $Stdout, $Stderr, $Seconds)
}

function New-E1Result([string]$Operation, [string]$TargetCommit, [string]$TargetTree) {
    return [ordered]@{
        schema = 2; operation = $Operation; state = 'failed'; failure_code = 'preflight_failed'; stage = 'preflight'
        target_commit = $TargetCommit; target_tree = $TargetTree; source_commit = $script:E1SourceCommit
        agent_calls = 0; live_records_created = $null; product_invocations = 0; dry_plan_invocations = 0
        product_report_build_writes_expected = ($Operation -eq 'wet-v2')
        checks = [ordered]@{}; hashes = [ordered]@{}
        failures = [ordered]@{ primary = $null; postflight = $null; persistence = $null; transport = $null }
        processes = [ordered]@{ product = $null; product_dry_plan = $null; free_baseline_dry_plan = $null }
    }
}

function Set-E1Failure($Result, [string]$Phase, [string]$Code) {
    if (-not (Test-E1Exact (Get-E1Field $Result 'schema') 2) -or
        $Phase -cnotin @('primary','postflight','persistence','transport') -or
        $Code -cnotin $script:E1FailureCodes -or $Code -cin @('none','postflight_pending')) { throw 'result_shape' }
    if ($null -eq $Result.failures[$Phase]) { $Result.failures[$Phase] = $Code }
    $Result.state = 'failed'
    $Result.failure_code = $Code
}

function Get-E1ObjectKeys($Value) {
    if ($Value -is [Collections.IDictionary]) { return @($Value.Keys) }
    if ($Value -is [pscustomobject]) { return @($Value.PSObject.Properties | ForEach-Object { $_.Name }) }
    throw 'result_shape'
}

function Assert-E1Keys($Value, [string[]]$Expected) {
    $keys = @(Get-E1ObjectKeys $Value)
    if ($keys.Count -ne $Expected.Count -or @($keys | Where-Object { $_ -cnotin $Expected }).Count) { throw 'result_shape' }
}

function ConvertTo-E1ProcessObservation($Value) {
    Assert-E1Keys $Value @('exit_code','wall_seconds','timed_out','cleanup_ok')
    $exit = Get-E1Field $Value 'exit_code'
    $wall = Get-E1Field $Value 'wall_seconds'
    if (($exit -isnot [int] -and $exit -isnot [long]) -or $exit -lt [int]::MinValue -or $exit -gt [int]::MaxValue) { throw 'result_shape' }
    if (($wall -isnot [double] -and $wall -isnot [decimal] -and $wall -isnot [int] -and $wall -isnot [long]) -or
        [double]::IsNaN($wall) -or [double]::IsInfinity($wall) -or $wall -lt 0 -or $wall -gt 86400) { throw 'result_shape' }
    $timedOut = Get-E1Field $Value 'timed_out'; $cleanup = Get-E1Field $Value 'cleanup_ok'
    if ($timedOut -isnot [bool] -or $cleanup -isnot [bool]) { throw 'result_shape' }
    return [ordered]@{ exit_code = $exit; wall_seconds = $wall; timed_out = $timedOut; cleanup_ok = $cleanup }
}

function Set-E1ProcessObservation($Result, [string]$Slot, $Process) {
    if ($Slot -cnotin @('product','product_dry_plan','free_baseline_dry_plan')) { throw 'result_shape' }
    $Result.processes[$Slot] = ConvertTo-E1ProcessObservation @{
        exit_code = $Process.ExitCode; wall_seconds = $Process.WallSeconds
        timed_out = $Process.TimedOut; cleanup_ok = $Process.CleanupOk
    }
}

function Write-E1Record([IO.FileStream]$Stream, $Record) {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Record | ConvertTo-Json -Depth 12 -Compress))
    $Stream.Position = 0
    $Stream.SetLength(0)
    $Stream.Write($bytes, 0, $bytes.Length)
    $Stream.Flush($true)
}

function Write-E1ProgressRecord([IO.FileStream]$Stream, $Record) {
    try { Write-E1Record $Stream $Record }
    catch { Set-E1Failure $Record 'persistence' 'terminal_write_failed'; throw 'terminal_write_failed' }
}

function Invoke-E1WetAttempt {
    param([string]$Directory, [string]$TargetCommit, [string]$TargetTree, [string]$Node,
        [string]$EntryPoint, [string]$SourceDir, $EvidenceHashes = @{})
    $result = New-E1Result 'wet-v2' $TargetCommit $TargetTree
    $result.stage = 'product'
    foreach ($key in $EvidenceHashes.Keys) { $result.hashes[$key] = $EvidenceHashes[$key] }
    $marker = $null
    try {
        $result.failure_code = 'attempt_exists'
        $marker = [IO.File]::Open((Join-Path $Directory "wet-v2-$TargetCommit.json"), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $result.state = 'started'
        $result.failure_code = 'interrupted'
        Write-E1ProgressRecord $marker $result
        $stdout = Join-Path $Directory "wet-v2-$TargetCommit.stdout.json"
        $stderr = Join-Path $Directory "wet-v2-$TargetCommit.stderr.txt"
        $result.product_invocations = 1
        Write-E1ProgressRecord $marker $result
        $result.failure_code = 'product_failed'
        # The client JVM system property overrides gradle.properties without a --stop/--fresh-daemon.
        # Any disposable single-use JVM remains a descendant in this invocation's Windows job.
        # https://docs.gradle.org/current/userguide/gradle_daemon.html#sec:disabling_the_daemon
        $previousGradleOpts = $env:GRADLE_OPTS
        try {
            $env:GRADLE_OPTS = '-Dorg.gradle.daemon=false'
            $result.checks.gradle_daemon_disabled = $true
            $process = Invoke-E1OwnedProcess $Node @($EntryPoint, 'parallel', '--json', '--project-root', '.', '--module-filter', ':core:domain', '--min-missed-lines', '15') $SourceDir $stdout $stderr 300
        } finally { $env:GRADLE_OPTS = $previousGradleOpts }
        Set-E1ProcessObservation $result 'product' $process
        $result.checks.owned_tree_stopped = Test-E1Exact $process.CleanupOk $true
        $result.checks.not_timed_out = Test-E1Exact $process.TimedOut $false
        $result.failure_code = if ($process.TimedOut) { 'product_timeout' } else { 'product_contract' }
        if (Test-Path -LiteralPath $stdout) {
            $bytes = [IO.File]::ReadAllBytes($stdout)
            $result.hashes.product_stdout_sha256 = Get-E1Sha256 $bytes
            if ($bytes.Length -le 1048576) {
                try {
                    $envelope = ConvertFrom-E1Json ([Text.UTF8Encoding]::new($false, $true).GetString($bytes))
                    $wet = Get-E1WetChecks $envelope $process.ExitCode $process.WallSeconds
                    foreach ($key in $wet.Keys) { $result.checks[$key] = $wet[$key] }
                } catch { $result.checks.valid_json = $false }
            } else { $result.checks.valid_json = $false }
        } else { $result.checks.valid_json = $false }
        if (-not ($result.checks.Values -contains $false)) { $result.state = 'validated'; $result.failure_code = 'postflight_pending' }
    } catch {
        if ($null -eq $result.failures.persistence) { Set-E1Failure $result 'primary' (Get-E1FailureCode $_ $result.failure_code) }
    } finally {
        if ($result.state -ne 'validated' -and $null -eq $result.failures.persistence) { Set-E1Failure $result 'primary' $result.failure_code }
        if ($marker) {
            $state = $result.state
            if ($state -eq 'validated') { $result.state = 'started' }
            try { Write-E1Record $marker $result; $result.state = $state }
            catch { Set-E1Failure $result 'persistence' 'terminal_write_failed' }
            finally { $marker.Dispose() }
        }
    }
    return $result
}

function Get-E1ProfileHash($Registry) {
    Assert-E1Fields $Registry @{ schema = 1 }
    $profiles = Get-E1Field $Registry 'execution_profiles'
    if ($profiles -isnot [array]) { throw 'profile_registry' }
    $selected = @($profiles | Where-Object { (Get-E1Field $_ 'id') -ceq 'sandboxed-unrestricted-v1' })
    if ($selected.Count -ne 1) { throw 'profile_registry' }
    $profile = $selected[0]
    Assert-E1Fields $profile @{
        id = 'sandboxed-unrestricted-v1'; enabled = $true; isolation_attestation_required = $true
        isolation_kind = 'external-sandbox'; network_mode = 'restricted'; policy_mode = 'not_applicable'
    }
    $runtimes = Get-E1Field $profile 'supported_runtime_ids'
    $caps = Get-E1Field $profile 'required_capabilities'
    if ($runtimes -isnot [array] -or 'claude-code' -cnotin $runtimes -or $caps -isnot [array]) { throw 'profile_registry' }
    foreach ($cap in $caps) { if ($cap -isnot [string] -or $cap -cnotmatch '^[A-Za-z][A-Za-z0-9]*$') { throw 'profile_registry' } }
    $projection = [ordered]@{}
    foreach ($key in @('id','isolation_attestation_required','isolation_kind','network_mode','policy_mode','required_capabilities')) {
        $projection[$key] = Get-E1Field $profile $key
    }
    return Get-E1Sha256 ([Text.Encoding]::UTF8.GetBytes(($projection | ConvertTo-Json -Depth 5 -Compress)))
}

function Get-E1DryChecks($Plan, [string]$Design, [string]$AttestationHash, [string]$ExpectedProfileHash) {
    $product = $Design -ceq 'claude-product-canary-v1'
    $planValue = Get-E1Field $Plan 'plan'
    $cells = @($planValue)
    $cell = if ($cells.Count -eq 1) { $cells[0] } else { $null }
    $expected = @{
        dry_run = $true; scenario_id = 'coverage-threshold-failure-v2'; campaign_design_id = $Design
        repeats = 1; planned_sessions = 1; runtime_id = 'claude-code'; max_budget_usd = 2; seed = 20260821
    }
    $checks = [ordered]@{
        known_design = ($Design -cin @('claude-product-canary-v1', 'claude-free-baseline-canary-v1'))
        plan_length = ($planValue -is [array] -and $cells.Count -eq 1)
        profile_registry_bound = ($ExpectedProfileHash -cmatch '^[a-f0-9]{64}$')
    }
    foreach ($key in $expected.Keys) { $checks[$key] = Test-E1Exact (Get-E1Field $Plan $key) $expected[$key] }
    $expectedCell = @{
        order_index = 0; repetition_index = 0
        campaign_cell_label = $(if ($product) { 'A' } else { 'B' })
        condition = $(if ($product) { 'current-skill' } else { 'no-skill' })
        product_access_mode = $(if ($product) { 'product-assisted' } else { 'free-baseline-no-product' })
        execution_profile_id = 'sandboxed-unrestricted-v1'; execution_profile_isolation_kind = 'external-sandbox'
        execution_profile_network_mode = 'restricted'; execution_profile_policy_mode = 'not_applicable'
        execution_profile_isolation_attestation_sha256 = $AttestationHash; execution_profile_sha256 = $ExpectedProfileHash
    }
    foreach ($key in $expectedCell.Keys) { $checks[$key] = Test-E1Exact (Get-E1Field $cell $key) $expectedCell[$key] }
    return $checks
}

function Invoke-E1DryAttempt {
    param([string]$Directory, [string]$TargetCommit, [string]$TargetTree, [string]$Node,
        [string]$HarnessDir, [string]$SourceDir, [string]$AttestationFile, $EvidenceHashes)
    $result = New-E1Result 'dry-v3' $TargetCommit $TargetTree
    $result.stage = 'dry_plan'
    foreach ($key in $EvidenceHashes.Keys) { $result.hashes[$key] = $EvidenceHashes[$key] }
    $marker = $null
    try {
        $result.failure_code = 'attempt_exists'
        $marker = [IO.File]::Open((Join-Path $Directory "dry-v3-$TargetCommit.json"), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $result.state = 'started'; $result.failure_code = 'interrupted'
        Write-E1ProgressRecord $marker $result
        foreach ($arm in @('product', 'free-baseline')) {
            $design = "claude-$arm-canary-v1"
            $stdout = Join-Path $Directory "dry-v3-$TargetCommit-$arm.stdout.json"
            $stderr = Join-Path $Directory "dry-v3-$TargetCommit-$arm.stderr.txt"
            $result.dry_plan_invocations++
            Write-E1ProgressRecord $marker $result
            $result.failure_code = 'dry_plan_failed'
            $process = Invoke-E1OwnedProcess $Node @(
                (Join-Path $HarnessDir 'tools\agentic-eval\cli.mjs'), 'run', '--scenario', 'coverage-threshold-failure-v2',
                '--campaign-design', $design, '--runtime', 'claude-code', '--source-repo-dir', $SourceDir,
                '--isolation-attestation-file', $AttestationFile, '--seed', '20260821', '--max-budget-usd', '2', '--dry-run'
            ) $HarnessDir $stdout $stderr 60
            $prefix = $arm.Replace('-', '_')
            Set-E1ProcessObservation $result "${prefix}_dry_plan" $process
            $result.checks["${prefix}_process"] = (Test-E1Exact $process.ExitCode 0) -and (Test-E1Exact $process.TimedOut $false) -and (Test-E1Exact $process.CleanupOk $true)
            if (-not $result.checks["${prefix}_process"]) { throw 'dry_plan_failed' }
            $result.checks["${prefix}_stderr_empty"] = (Get-Item -LiteralPath $stderr).Length -eq 0
            $parsed = Read-E1Json $stdout
            $result.hashes["${prefix}_stdout_sha256"] = $parsed.sha256
            $checks = Get-E1DryChecks $parsed.value $design $EvidenceHashes.attestation_canonical_sha256 $EvidenceHashes.execution_profile_sha256
            foreach ($key in $checks.Keys) { $result.checks["${prefix}_$key"] = $checks[$key] }
            if ($result.checks.Values -contains $false) { throw 'dry_plan_contract' }
        }
        $result.state = 'validated'; $result.failure_code = 'postflight_pending'
    } catch {
        if ($null -eq $result.failures.persistence) { Set-E1Failure $result 'primary' (Get-E1FailureCode $_ $result.failure_code) }
    }
    finally {
        if ($marker) {
            $state = $result.state
            if ($state -eq 'validated') { $result.state = 'started' }
            try { Write-E1Record $marker $result; $result.state = $state }
            catch { Set-E1Failure $result 'persistence' 'terminal_write_failed' }
            finally { $marker.Dispose() }
        }
    }
    return $result
}

function Assert-E1NoLiveCustody($Placement, $Copy, $Handoff, [string]$VMName, $Readiness) {
    if ($null -eq $Placement -and $null -eq $Copy -and $null -eq $Handoff) { return }
    Assert-E1Fields $Placement @{ verdict = 'PASS'; vm_name = $VMName }
    Assert-E1Fields $Copy @{ verdict = 'PASS'; vm_name = $VMName; raw_content_read = $false }
    $runId = Get-E1Field $Placement 'run_id'
    if ($runId -isnot [string] -or $runId -cnotmatch '^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$') { throw 'live_custody' }
    $exit = Get-E1Field $Copy 'stage_b_exit'
    Assert-E1Fields $exit @{ valid = $true }
    $terminal = Get-E1Field $exit 'record'
    Assert-E1Fields $terminal @{ schema = 1; run_id = $runId }
    if ((Get-E1Field $terminal 'state') -cnotin @('exited','wrapper_error','terminated_after_launcher_exit') -or
        (Get-E1Field $terminal 'exit_code_source') -cnotin @('launcher_record','process_exit_code','wrapper_error') -or
        ((Get-E1Field $terminal 'exit_code') -isnot [int] -and (Get-E1Field $terminal 'exit_code') -isnot [long])) { throw 'live_custody' }
    if ($null -ne $Handoff) { Assert-E1Fields $Handoff @{ state = 'started'; run_id = $runId; vm_name = $VMName } }
    $copyTime = Get-E1Timestamp (Get-E1Field $Copy 'generated_at_utc')
    if ($copyTime -lt (Get-E1Timestamp (Get-E1Field $Placement 'generated_at_utc')) -or
        $copyTime -gt (Get-E1Timestamp (Get-E1Field $Readiness 'generated_at_utc'))) { throw 'live_custody' }
}

function Assert-E1NoGuestLive([string]$SourceDir) {
    # Names only: command lines may contain credentials or model prompts.
    if (@(Get-Process | Where-Object { $_.ProcessName -imatch '^(node|claude|kmp-test)(\.exe)?$' }).Count -ne 0 -or
        (Test-Path -LiteralPath (Join-Path $SourceDir '.kmp-test-runner.lock'))) { throw 'live_overlap' }
    $secretNames = @('ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','OPENAI_API_KEY',
        'GOOGLE_API_KEY','AZURE_OPENAI_API_KEY','GH_TOKEN','GITHUB_TOKEN')
    foreach ($name in [Environment]::GetEnvironmentVariables().Keys) {
        if ($name -in $secretNames -or $name -like 'COPILOT_*') { throw 'ambient_credentials' }
        if ($name -like 'KMP_*' -or $name -like 'ORG_GRADLE_PROJECT_*' -or
            $name -in @('NODE_OPTIONS','NODE_PATH','JAVA_OPTS','JAVA_TOOL_OPTIONS','_JAVA_OPTIONS','JDK_JAVA_OPTIONS')) { throw 'environment_override' }
    }
    if ($env:GRADLE_OPTS -and $env:GRADLE_OPTS -cne '-Dorg.gradle.daemon=false') { throw 'environment_override' }
}

function Invoke-E1Git([string]$Root, [string[]]$Arguments, [string]$Directory) {
    $id = [guid]::NewGuid().ToString('N')
    $stdout = Join-Path $Directory "$id.git.stdout.txt"
    $stderr = Join-Path $Directory "$id.git.stderr.txt"
    $process = Invoke-E1OwnedProcess 'C:\Program Files\Git\cmd\git.exe' (@('--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', $Root) + $Arguments) $Root $stdout $stderr 20
    if ($process.ExitCode -ne 0 -or $process.TimedOut -or -not $process.CleanupOk) { throw 'git_failed' }
    if ((Get-Item -LiteralPath $stdout).Length -gt 1048576) { throw 'git_output_size' }
    return [IO.File]::ReadAllText($stdout).Trim()
}

function Assert-E1RepoIdentity([string]$Root, [string]$Commit, [string]$Tree, [string]$Directory) {
    if ((Invoke-E1Git $Root @('rev-parse','HEAD') $Directory) -cne $Commit) { throw 'repo_commit' }
    $actualTree = Invoke-E1Git $Root @('rev-parse','HEAD^{tree}') $Directory
    if ($actualTree -cnotmatch '^[a-f0-9]{40}$' -or ($Tree -and $actualTree -cne $Tree)) { throw 'repo_tree' }
    if ((Resolve-E1Path (Invoke-E1Git $Root @('rev-parse','--show-toplevel') $Directory)) -ine $Root) { throw 'repo_root' }
    return $actualTree
}

function Assert-E1Repo([string]$Root, [string]$Commit, [string]$Tree, [string]$Directory) {
    $actualTree = Assert-E1RepoIdentity $Root $Commit $Tree $Directory
    if ((Invoke-E1Git $Root @('status','--porcelain=v1','--untracked-files=all') $Directory)) { throw 'repo_dirty' }
    return $actualTree
}

function Get-E1ArtifactKind([string]$RelativePath) {
    # Exact producers: project-model.js/cache.js and coverage-orchestrator.js.
    # V2 has no instrumented/benchmark flags, so their logs are not authorized.
    if ($RelativePath -cmatch '^\.kmp-test-runner/cache/model-[a-f0-9]{40}\.json$') { return 'model' }
    if ($RelativePath -cmatch '^\.kmp-test-runner/cache/tasks-[a-f0-9]{40}\.txt$') { return 'tasks' }
    if ($RelativePath -ceq '.kmp-test-runner/reports/coverage/latest.md') { return 'latest' }
    if ($RelativePath -cmatch '^\.kmp-test-runner/reports/coverage/[0-9]{8}-[0-9]{6}-[0-9]{6}\.md$') { return 'report' }
    throw 'source_artifacts'
}

function Get-E1SourceFileHash([string]$Path, [long]$MaxBytes) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        if ($stream.Length -gt $MaxBytes) { throw 'source_artifact_limit' }
        return -join ($hasher.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })
    } finally { $hasher.Dispose(); $stream.Dispose() }
}

function Get-E1RuntimeArtifacts([string]$Root) {
    $artifacts = @{}; $directories = @(); $bytes = 0L; $entries = 0
    $runtime = Join-Path $Root '.kmp-test-runner'
    if (Test-Path -LiteralPath $runtime) {
        $null = Resolve-E1Path $runtime
        if (-not (Get-Item -LiteralPath $runtime -Force).PSIsContainer) { throw 'source_artifacts' }
        $directories += '.kmp-test-runner'
        $pending = [Collections.Generic.Queue[string]]::new(); $pending.Enqueue($runtime)
        while ($pending.Count) {
            foreach ($entry in (Get-ChildItem -LiteralPath $pending.Dequeue() -Force)) {
                if (++$entries -gt 128) { throw 'source_artifact_limit' }
                $null = Resolve-E1Path $entry.FullName
                $relative = $entry.FullName.Substring($Root.Length + 1).Replace('\','/')
                if ($entry.PSIsContainer) {
                    # cleanupInitScript removes its file, not the containing directory.
                    # Files below init-scripts remain rejected by Get-E1ArtifactKind.
                    if ($relative -cnotin @('.kmp-test-runner/cache','.kmp-test-runner/reports','.kmp-test-runner/reports/coverage','.kmp-test-runner/init-scripts')) { throw 'source_artifacts' }
                    $directories += $relative
                    $pending.Enqueue($entry.FullName)
                } else {
                    $kind = Get-E1ArtifactKind $relative
                    # probeGradleTasksCached persists spawnGradle's 64 MiB stdout
                    # budget. Keep room for that cache plus the model and reports.
                    $limit = if ($kind -ceq 'tasks') { 67108864L } else { 8388608L }
                    $bytes += $entry.Length
                    if ($entry.Length -gt $limit -or $bytes -gt 134217728) { throw 'source_artifact_limit' }
                    # Fingerprint bytes only; never parse or emit cache/report contents.
                    $artifacts[$relative] = @{
                        kind = $kind; length = $entry.Length; modified = $entry.LastWriteTimeUtc.Ticks
                        sha256 = Get-E1SourceFileHash $entry.FullName $limit
                    }
                }
            }
        }
    }
    return @{ files = $artifacts; directories_sha256 = (Get-E1Sha256 ([Text.Encoding]::UTF8.GetBytes((($directories | Sort-Object -CaseSensitive) -join "`n")))) }
}

function Get-E1SourceSnapshot([string]$Root, [string]$Commit, [string]$Tree, [string]$Directory) {
    $Root = Resolve-E1Path $Root
    $actualTree = Assert-E1RepoIdentity $Root $Commit $Tree $Directory
    # Do not repair flags or trust status when index flags can conceal edits.
    $flags = Invoke-E1Git $Root @('ls-files','-v','-z') $Directory
    foreach ($entry in $flags.Split([char]0)) {
        if ($entry -and $entry -cnotmatch '^H ') { throw 'repo_dirty' }
    }
    $runtime = Get-E1RuntimeArtifacts $Root
    $artifacts = $runtime.files
    $status = Invoke-E1Git $Root @('status','--porcelain=v1','-z','--untracked-files=all') $Directory
    foreach ($entry in $status.Split([char]0)) {
        if (-not $entry) { continue }
        if (-not $entry.StartsWith('?? ', [StringComparison]::Ordinal)) { throw 'repo_dirty' }
        $relative = $entry.Substring(3)
        $null = Get-E1ArtifactKind $relative
        if (-not $artifacts.ContainsKey($relative)) { throw 'source_artifacts' }
    }
    # Hash actual tracked bytes as well as index entries: assume-unchanged/skip-worktree
    # must not hide a source edit behind an otherwise clean git status.
    $index = Invoke-E1Git $Root @('ls-files','--stage','-z') $Directory
    $rows = @(); $bytes = 0L
    foreach ($entry in $index.Split([char]0)) {
        if (-not $entry) { continue }
        if ($entry -cnotmatch '^([0-9]{6}) ([a-f0-9]{40}) 0\t(.+)$') { throw 'repo_dirty' }
        $relative = $Matches[3]
        $path = Resolve-E1Path (Join-Path $Root $relative)
        $item = Get-Item -LiteralPath $path -Force
        $bytes += $item.Length
        if ($item.PSIsContainer -or $rows.Count -ge 20000 -or $bytes -gt 536870912) { throw 'source_artifact_limit' }
        $rows += $relative + '|' + (Get-E1SourceFileHash $path 536870912)
    }
    return @{
        tree = $actualTree; artifacts = $artifacts
        artifact_directories_sha256 = $runtime.directories_sha256
        index_sha256 = Get-E1Sha256 ([Text.Encoding]::UTF8.GetBytes($index))
        tracked_sha256 = Get-E1Sha256 ([Text.Encoding]::UTF8.GetBytes(($rows -join "`n")))
    }
}

function Assert-E1SourcePostflight([string]$Root, [string]$Commit, [string]$Tree, [string]$Directory, $Before, [string]$Operation = 'wet-v2') {
    if ($Operation -cnotin @('wet-v2','dry-v3')) { throw 'operation_invalid' }
    $after = Get-E1SourceSnapshot $Root $Commit $Tree $Directory
    if ($Before.index_sha256 -cne $after.index_sha256) { throw 'source_index_changed' }
    if ($Before.tracked_sha256 -cne $after.tracked_sha256) { throw 'source_tracked_changed' }
    if ($Operation -ceq 'dry-v3' -and $Before.artifact_directories_sha256 -cne $after.artifact_directories_sha256) { throw 'source_artifacts' }
    foreach ($path in $Before.artifacts.Keys) {
        if (-not $after.artifacts.ContainsKey($path)) { throw 'source_artifacts' }
    }
    # All model/probe consumers share one deterministic key over the unchanged
    # source inputs (project/cache.js computeCacheKey excludes build/.gradle).
    # This is a distinct-key bound, not a bound on calls or writes to that key.
    $changed = @{ model = 0; tasks = 0; report = 0; latest = 0 }
    foreach ($path in $after.artifacts.Keys) {
        $value = $after.artifacts[$path]; $previous = $Before.artifacts[$path]
        if ($null -eq $previous -or $value.length -ne $previous.length -or $value.modified -ne $previous.modified -or $value.sha256 -cne $previous.sha256) {
            if ($Operation -ceq 'dry-v3') { throw 'source_artifacts' }
            if ($null -ne $previous -and $value.kind -ceq 'report') { throw 'source_artifacts' }
            if (++$changed[$value.kind] -gt 1) { throw 'source_artifact_limit' }
        }
    }
}

function Assert-E1ToolPath([string]$Path) {
    $current = $Path
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
                (Get-E1Field $item 'LinkType') -eq 'HardLink') { throw 'java_toolchain' }
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Get-E1Java21 {
    $root = 'C:\Program Files\Eclipse Adoptium'
    Assert-E1ToolPath $root
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'java_toolchain' }
    $jdk = Get-ChildItem -LiteralPath $root -Directory | Where-Object Name -like 'jdk-21*' |
        Sort-Object Name -Descending | Select-Object -First 1
    if (-not $jdk) { throw 'java_toolchain' }
    $java = Join-Path $jdk.FullName 'bin\java.exe'
    Assert-E1ToolPath $java
    if (-not (Test-Path -LiteralPath $java -PathType Leaf)) { throw 'java_toolchain' }
    return @{ home = $jdk.FullName; executable = $java }
}

function Invoke-E1Java21Environment([string]$Directory, [scriptblock]$Action) {
    $oldHome = $env:JAVA_HOME; $oldPath = $env:PATH
    try {
        $java = Get-E1Java21
        $env:JAVA_HOME = $java.home
        $paths = @((Join-Path $java.home 'bin'), 'C:\Windows\System32', 'C:\Program Files\Git\cmd',
            'C:\Program Files\Git\bin', 'C:\Program Files\nodejs', (Join-Path $env:USERPROFILE 'AppData\Roaming\npm'), $oldPath)
        $env:PATH = ($paths | Where-Object { $_ }) -join ';'
        $id = [guid]::NewGuid().ToString('N')
        $stdout = Join-Path $Directory "$id.java.stdout.txt"; $stderr = Join-Path $Directory "$id.java.stderr.txt"
        $process = Invoke-E1OwnedProcess $java.executable @('-version') $Directory $stdout $stderr 15
        if ($process.ExitCode -ne 0 -or $process.TimedOut -or -not $process.CleanupOk) { throw 'java_toolchain' }
        $text = ''
        foreach ($path in @($stdout, $stderr)) {
            if ((Get-Item -LiteralPath $path).Length -gt 8192) { throw 'java_toolchain' }
            $text += [Text.UTF8Encoding]::new($false, $true).GetString([IO.File]::ReadAllBytes($path)) + "`n"
        }
        if ($text -cnotmatch '(?m)^(?:openjdk|java) version "21(?:\.[0-9]+){0,3}(?:[-+][A-Za-z0-9.-]+)?"') { throw 'java_toolchain' }
        & $Action $java
    } finally { $env:JAVA_HOME = $oldHome; $env:PATH = $oldPath }
}

function Get-E1RecordsSnapshot([string]$HarnessDir) {
    $root = Resolve-E1Path (Join-Path $HarnessDir 'tools\runs')
    $rows = @()
    $keys = @()
    if (Test-Path -LiteralPath $root) {
        $pending = [Collections.Generic.Queue[string]]::new(); $pending.Enqueue($root)
        while ($pending.Count) {
            $directory = $pending.Dequeue()
            foreach ($entry in (Get-ChildItem -LiteralPath $directory -Force)) {
                $null = Resolve-E1Path $entry.FullName
                if ($entry.PSIsContainer) { $pending.Enqueue($entry.FullName) }
                else {
                    $keys += $entry.FullName.Substring($root.Length)
                    $rows += '{0}|{1}|{2}' -f $entry.FullName.Substring($root.Length), $entry.Length, $entry.LastWriteTimeUtc.Ticks
                }
            }
        }
    }
    return @{ count = $rows.Count; keys = $keys; sha256 = (Get-E1Sha256 ([Text.Encoding]::UTF8.GetBytes((($rows | Sort-Object) -join "`n")))) }
}

function Set-E1RecordsCheck($Record, $Before, $After) {
    $Record.live_records_created = @($After.keys | Where-Object { $_ -cnotin $Before.keys }).Count
    $Record.hashes.records_metadata_before_sha256 = $Before.sha256
    $Record.hashes.records_metadata_after_sha256 = $After.sha256
    if ($Before.sha256 -cne $After.sha256) { throw 'records_changed' }
}

function Complete-E1Attempt($Result, [string]$Directory, [scriptblock]$Postflight) {
    $Result.stage = 'postflight'
    $Result.checks.postflight = $false
    try {
        & $Postflight $Result
        $Result.checks.postflight = $true
        if ($Result.state -ceq 'validated') { $Result.state = 'passed'; $Result.failure_code = 'none'; $Result.stage = 'complete' }
    } catch {
        Set-E1Failure $Result 'postflight' (Get-E1FailureCode $_ 'postflight_failed')
    } finally {
        $stream = $null
        try {
            $stream = [IO.File]::Open((Join-Path $Directory "$($Result.operation)-$($Result.target_commit).json"), [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::Read)
            Write-E1Record $stream $Result
        } catch { Set-E1Failure $Result 'persistence' 'terminal_write_failed' }
        finally { if ($stream) { $stream.Dispose() } }
    }
    return $Result
}

function Invoke-E1GuestValidation($Config, $Readiness, [string]$ReadinessHash, [string]$ModuleHash) {
    $result = New-E1Result $Config.Operation $Config.TargetCommit $Config.TargetTree
    $mutex = $null; $locked = $false; $previousEnvironment = $null
    try {
        $result.stage = 'guest_identity'
        $identity = Get-CimInstance -ClassName Win32_ComputerSystem
        $guestVm = Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters' -Name VirtualMachineId
        Assert-E1GuestIdentity -ComputerName $env:COMPUTERNAME -HostComputerName $Config.HostComputerName -ExpectedGuest $Config.GuestComputerName `
            -ActualVmId $guestVm -ExpectedVmId $Config.VMId -Manufacturer $identity.Manufacturer -Model $identity.Model -User $env:USERNAME -ExpectedUser $Config.GuestUser
        $result.checks.guest_identity = $true
        $result.stage = 'guest_paths'
        $harness = Resolve-E1Path $Config.HarnessDir
        $source = Resolve-E1Path $Config.NowInAndroidDir
        if ($harness -ieq $source -or $harness.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $source.StartsWith($harness + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'repo_overlap' }
        $attestationPath = Resolve-E1Path $Config.AttestationFile 'C:\kmp-eval\measurement-scopes'
        $ledgerPath = Resolve-E1Path 'C:\kmp-eval\scratch\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1\READINESS.json'
        $directory = Resolve-E1Path 'C:\kmp-eval\scratch\evidence1-validation-ops'
        $result.stage = 'guest_evidence'
        $attestation = Read-E1Json $attestationPath 16384
        $ledger = Read-E1Json $ledgerPath
        $hash = Assert-E1Evidence $Readiness $ledger.value $attestation.value $Config.VMName $Config.TargetCommit $Config.TargetTree $attestationPath
        $result.stage = 'guest_overlap'
        Assert-E1NoGuestLive $source
        $mutex = [Threading.Mutex]::new($false, 'Global\Evidence1ValidationOps')
        $locked = $mutex.WaitOne(0)
        if (-not $locked) { throw 'validation_overlap' }
        $result.failure_code = 'attempt_exists'
        if (Test-Path -LiteralPath (Join-Path $directory "$($Config.Operation)-$($Config.TargetCommit).json")) { throw 'attempt_exists' }
        $result.failure_code = 'preflight_failed'
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
        $null = Resolve-E1Path $directory
        $previousEnvironment = @{}
        foreach ($name in @('TEMP','TMP','GIT_OPTIONAL_LOCKS')) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
        $env:TEMP = $directory; $env:TMP = $directory
        $env:GIT_OPTIONAL_LOCKS = '0'
        $result.stage = 'guest_repositories'
        $null = Assert-E1Repo $harness $Config.TargetCommit $Config.TargetTree $directory
        $sourceSnapshot = Get-E1SourceSnapshot $source $script:E1SourceCommit '' $directory
        $sourceTree = $sourceSnapshot.tree
        $entryPoint = Resolve-E1Path (Join-Path $harness 'bin\kmp-test.js')
        $targetModule = Resolve-E1Path (Join-Path $harness 'docs\audits\evidence1-validation-ops.psm1')
        if ((Get-FileHash -LiteralPath $targetModule -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ModuleHash) { throw 'module_target_mismatch' }
        $scenario = Read-E1Json (Join-Path $harness 'tools\agentic-eval\corpus\scenarios\coverage-threshold-failure-v2.json')
        Assert-E1Fields $scenario.value @{ id = 'coverage-threshold-failure-v2'; project_commit = $script:E1SourceCommit }
        $registry = Read-E1Json (Join-Path $harness 'tools\agentic-eval\execution-profiles\registry.json')
        $profileHash = Get-E1ProfileHash $registry.value
        $hashes = @{
            readiness_sha256 = $ReadinessHash; ledger_sha256 = $ledger.sha256
            attestation_sha256 = $attestation.sha256; attestation_canonical_sha256 = $hash
            validation_module_sha256 = $ModuleHash; scenario_sha256 = $scenario.sha256
            product_entry_sha256 = (Get-FileHash -LiteralPath $entryPoint -Algorithm SHA256).Hash.ToLowerInvariant()
            execution_profile_sha256 = $profileHash; execution_profile_registry_sha256 = $registry.sha256
        }
        $before = Get-E1RecordsSnapshot $harness
        Assert-E1NoGuestLive $source
        # Recheck freshness immediately before the only permitted executable dispatches.
        $null = Assert-E1Evidence $Readiness $ledger.value $attestation.value $Config.VMName $Config.TargetCommit $Config.TargetTree $attestationPath
        $node = 'C:\Program Files\nodejs\node.exe'
        if ($Config.Operation -ceq 'wet-v2') {
            $result.stage = 'guest_toolchain'
            $result = Invoke-E1Java21Environment $directory {
                param($java)
                $null = Assert-E1Evidence $Readiness $ledger.value $attestation.value $Config.VMName $Config.TargetCommit $Config.TargetTree $attestationPath
                $wet = Invoke-E1WetAttempt $directory $Config.TargetCommit $Config.TargetTree $node $entryPoint $source $hashes
                $wet.checks.java21_verified = $true
                return $wet
            }
        } elseif ($Config.Operation -ceq 'dry-v3') {
            $result = Invoke-E1DryAttempt $directory $Config.TargetCommit $Config.TargetTree $node $harness $source $attestationPath $hashes
        } else { throw 'operation_invalid' }
        $result.checks.guest_identity = $true
        $result.checks.preflight = $true
        $result.checks.module_target = $true
        if ($result.failure_code -cne 'attempt_exists') {
            $result = Complete-E1Attempt $result $directory {
                param($record)
                $after = Get-E1RecordsSnapshot $harness
                Set-E1RecordsCheck $record $before $after
                $null = Assert-E1Repo $harness $Config.TargetCommit $Config.TargetTree $directory
                $null = Assert-E1SourcePostflight $source $script:E1SourceCommit $sourceTree $directory $sourceSnapshot -Operation $Config.Operation
                $record.checks.source_integrity = $true
                if ((Read-E1Json $ledgerPath).sha256 -cne $ledger.sha256 -or (Read-E1Json $attestationPath 16384).sha256 -cne $attestation.sha256) { throw 'evidence_changed' }
                $null = Assert-E1Evidence $Readiness $ledger.value $attestation.value $Config.VMName $Config.TargetCommit $Config.TargetTree $attestationPath
                Assert-E1NoGuestLive $source
            }
        }
    } catch {
        $fallback = if ($result.state -in @('passed','validated')) { 'postflight_failed' } else { $result.failure_code }
        Set-E1Failure $result 'primary' (Get-E1FailureCode $_ $fallback)
    } finally {
        if ($null -ne $previousEnvironment) {
            foreach ($name in $previousEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
        }
        if ($locked) { $mutex.ReleaseMutex() }
        if ($mutex) { $mutex.Dispose() }
    }
    return $result
}

function ConvertTo-E1SafeResult($Raw, [string]$Operation, [string]$TargetCommit, [string]$TargetTree) {
    if ($Operation -cnotin @('wet-v2','dry-v3')) { throw 'result_shape' }
    $schema = Get-E1Field $Raw 'schema'
    if (-not (Test-E1Exact $schema 1) -and -not (Test-E1Exact $schema 2)) { throw 'result_shape' }
    Assert-E1Fields $Raw @{ operation = $Operation; target_commit = $TargetCommit; target_tree = $TargetTree; source_commit = $script:E1SourceCommit; agent_calls = 0 }
    $safe = New-E1Result $Operation $TargetCommit $TargetTree
    $safe.schema = $schema
    if ($schema -eq 1) { $safe.Remove('failures'); $safe.Remove('processes') }
    $rawKeys = @(Get-E1ObjectKeys $Raw | Where-Object { $_ -cnotin @('PSComputerName','RunspaceId','PSShowComputerName') })
    if ($rawKeys.Count -ne $safe.Keys.Count -or @($rawKeys | Where-Object { $_ -cnotin $safe.Keys }).Count) { throw 'result_shape' }
    Assert-E1Fields $Raw @{ product_report_build_writes_expected = ($Operation -ceq 'wet-v2') }
    $state = Get-E1Field $Raw 'state'
    $code = Get-E1Field $Raw 'failure_code'
    if ($state -isnot [string] -or $code -isnot [string] -or
        $state -cnotin @('passed','failed') -or $code -cnotin $script:E1FailureCodes) { throw 'result_shape' }
    $safe.state = $state; $safe.failure_code = $code
    $stage = Get-E1Field $Raw 'stage'
    if ($stage -isnot [string] -or $stage -cnotin @('preflight','guest_identity','guest_paths','guest_evidence','guest_overlap','guest_repositories','guest_toolchain','product','dry_plan','postflight','complete')) { throw 'result_shape' }
    $safe.stage = $stage
    if ($schema -eq 2) {
        $failures = Get-E1Field $Raw 'failures'
        Assert-E1Keys $failures @($safe.failures.Keys)
        foreach ($phase in @($safe.failures.Keys)) {
            $failure = Get-E1Field $failures $phase
            if ($null -ne $failure -and ($failure -isnot [string] -or $failure -cnotin $script:E1FailureCodes -or $failure -cin @('none','postflight_pending'))) { throw 'result_shape' }
            $safe.failures[$phase] = $failure
        }
        $processes = Get-E1Field $Raw 'processes'
        Assert-E1Keys $processes @($safe.processes.Keys)
        foreach ($slot in @($safe.processes.Keys)) {
            $observation = Get-E1Field $processes $slot
            if ($null -ne $observation) { $safe.processes[$slot] = ConvertTo-E1ProcessObservation $observation }
        }
        if (($Operation -ceq 'wet-v2' -and ($safe.processes.product_dry_plan -or $safe.processes.free_baseline_dry_plan)) -or
            ($Operation -ceq 'dry-v3' -and $safe.processes.product)) { throw 'result_shape' }
    }
    foreach ($key in @('product_invocations','dry_plan_invocations','live_records_created')) {
        $count = Get-E1Field $Raw $key
        if ($key -eq 'live_records_created' -and $null -eq $count -and $state -ceq 'failed') { continue }
        if (($count -isnot [int] -and $count -isnot [long]) -or $count -lt 0 -or $count -gt 1000000) { throw 'result_shape' }
        $safe[$key] = $count
    }
    if ($safe.product_invocations -gt 1 -or $safe.dry_plan_invocations -gt 2) { throw 'result_shape' }
    if ($schema -eq 2 -and (($safe.processes.product -and $safe.product_invocations -ne 1) -or
        ($safe.processes.product_dry_plan -and $safe.dry_plan_invocations -lt 1) -or
        ($safe.processes.free_baseline_dry_plan -and $safe.dry_plan_invocations -ne 2))) { throw 'result_shape' }
    $requiredChecks = @('guest_identity','preflight','postflight','module_target')
    if ($Operation -ceq 'wet-v2') { $requiredChecks += @('gradle_daemon_disabled','owned_tree_stopped','not_timed_out') + @((Get-E1WetChecks $null 0 0).Keys) }
    if ($schema -eq 2) { $requiredChecks += 'source_integrity' }
    if ($schema -eq 2 -and $Operation -ceq 'wet-v2') { $requiredChecks += 'java21_verified' }
    foreach ($arm in @('product','free_baseline')) {
        if ($Operation -ceq 'dry-v3') {
            $requiredChecks += "${arm}_process", "${arm}_stderr_empty"
            $requiredChecks += @((Get-E1DryChecks $null 'claude-product-canary-v1' ('0' * 64)).Keys | ForEach-Object { "${arm}_$_" })
        }
    }
    $allowedChecks = $requiredChecks + @('valid_json')
    $checks = Get-E1Field $Raw 'checks'
    $names = @(Get-E1ObjectKeys $checks)
    foreach ($key in $names) {
        $value = Get-E1Field $checks $key
        if ($key -cnotin $allowedChecks -or $value -isnot [bool]) { throw 'result_shape' }
        $safe.checks[$key] = $value
    }
    $allowedHashes = @('readiness_sha256','ledger_sha256','attestation_sha256','attestation_canonical_sha256',
        'validation_module_sha256','scenario_sha256','product_entry_sha256','product_stdout_sha256',
        'records_metadata_before_sha256','records_metadata_after_sha256','execution_profile_sha256','execution_profile_registry_sha256')
    if ($Operation -ceq 'dry-v3') { $allowedHashes += 'free_baseline_stdout_sha256' }
    $hashes = Get-E1Field $Raw 'hashes'
    $names = @(Get-E1ObjectKeys $hashes)
    foreach ($key in $names) {
        $value = Get-E1Field $hashes $key
        if ($key -cnotin $allowedHashes -or $value -isnot [string] -or $value -cnotmatch '^[a-f0-9]{64}$') { throw 'result_shape' }
        $safe.hashes[$key] = $value
    }
    if ($state -ceq 'passed') {
        if ($schema -eq 2) {
            if (@($safe.failures.Values | Where-Object { $null -ne $_ }).Count) { throw 'result_shape' }
            $slots = if ($Operation -ceq 'wet-v2') { @('product') } else { @('product_dry_plan','free_baseline_dry_plan') }
            foreach ($slot in $slots) {
                $p = $safe.processes[$slot]
                $expectedExit = if ($slot -ceq 'product') { 1 } else { 0 }
                $budget = if ($slot -ceq 'product') { 300 } else { 60 }
                if ($null -eq $p -or $p.exit_code -ne $expectedExit -or $p.timed_out -or -not $p.cleanup_ok -or $p.wall_seconds -gt $budget) { throw 'result_shape' }
            }
        }
        if ($code -cne 'none' -or $stage -cne 'complete' -or -not (Test-E1Exact $safe.live_records_created 0) -or $safe.checks.Values -contains $false) { throw 'result_shape' }
        foreach ($key in $requiredChecks) {
            if (-not (Test-E1Exact (Get-E1Field $safe.checks $key) $true)) { throw 'result_shape' }
        }
        foreach ($key in $allowedHashes) { if ($null -eq (Get-E1Field $safe.hashes $key)) { throw 'result_shape' } }
        if (($Operation -ceq 'wet-v2' -and ($safe.product_invocations -ne 1 -or $safe.dry_plan_invocations -ne 0)) -or
            ($Operation -ceq 'dry-v3' -and ($safe.product_invocations -ne 0 -or $safe.dry_plan_invocations -ne 2))) { throw 'result_shape' }
    }
    return $safe
}

function Get-E1ReceiverScript {
    return {
        param($ModuleText, $Config, $Readiness, $ReadinessHash, $ModuleHash)
        $ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $receivedHash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($ModuleText)) | ForEach-Object { $_.ToString('x2') }) }
        finally { $sha.Dispose() }
        if ($ModuleHash -cnotmatch '^[a-f0-9]{64}$' -or $receivedHash -cne $ModuleHash) { throw 'module_hash_mismatch' }
        $module = New-Module -Name Evidence1ValidationRuntime -ScriptBlock ([scriptblock]::Create($ModuleText))
        Import-Module $module -DisableNameChecking
        Invoke-E1GuestValidation $Config $Readiness $ReadinessHash $ModuleHash
    }
}

function Invoke-E1ValidationDirect {
    [CmdletBinding()]
    param([string]$Operation, [string]$TargetCommit, [string]$TargetTree,
        [string]$VMName, [string]$GuestComputerName, [string]$GuestCredentialPath,
        [string]$HarnessDir, [string]$NowInAndroidDir, [string]$AttestationFile, [string]$ReportPath)
    $result = New-E1Result $Operation '' ''
    $result.target_commit = $null; $result.target_tree = $null
    $session = $null; $job = $null; $report = $null; $transportStarted = $false
    try {
        $result.stage = 'host_parameters'
        if ($Operation -cnotin @('wet-v2','dry-v3')) { throw 'operation_invalid' }
        $reportRoot = if ($Operation -ceq 'wet-v2') { 'C:\kmp-eval\scratch\hyperv-verify-wet-gate-v2-direct' } else { 'C:\kmp-eval\scratch\hyperv-verify-canary-dryrun-v3-direct' }
        $report = Resolve-E1Path $ReportPath $reportRoot
        if ([IO.Path]::GetExtension($report) -ine '.json') { $report = $null; throw 'report_path' }
        if ($TargetCommit -cnotmatch '^[a-f0-9]{40}$' -or $TargetTree -cnotmatch '^[a-f0-9]{40}$') { throw 'target_invalid' }
        $result.target_commit = $TargetCommit; $result.target_tree = $TargetTree
        if ($VMName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,63}$' -or
            $GuestComputerName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,14}$' -or $GuestComputerName -ieq $env:COMPUTERNAME) { throw 'identity_invalid' }
        $credentialPath = Resolve-E1Path $GuestCredentialPath 'C:\kmp-eval\scratch\hyperv-create-runner'
        if ([IO.Path]::GetExtension($credentialPath) -ine '.clixml') { throw 'credential_path' }
        $null = Resolve-E1Path $HarnessDir
        $null = Resolve-E1Path $NowInAndroidDir
        $null = Resolve-E1Path $AttestationFile 'C:\kmp-eval\measurement-scopes'
        $result.stage = 'host_privilege'
        if ($env:OS -ne 'Windows_NT' -or -not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'host_privilege' }
        $result.stage = 'host_vm'
        $vm = Get-VM -Name $VMName -ErrorAction Stop
        if ($vm.State.ToString() -cne 'Running') { throw 'vm_not_running' }
        $readinessPath = 'C:\kmp-eval\scratch\hyperv-regenerate-readiness-direct\HYPERV-REGENERATE-READINESS-DIRECT.json'
        $result.stage = 'host_evidence'
        $readiness = Read-E1Json $readinessPath
        Assert-E1Fields $readiness.value @{ verdict = 'PASS'; vm_name = $VMName; vm_state = 'Running'; target_commit = $TargetCommit; target_tree = $TargetTree }
        $null = Assert-E1Fresh (Get-E1Field $readiness.value 'generated_at_utc') ([datetime]::UtcNow)
        $result.stage = 'host_custody'
        $custody = @()
        foreach ($path in @(
            'C:\kmp-eval\scratch\hyperv-place-live-autorun\HYPERV-PLACE-LIVE-AUTORUN.json',
            'C:\kmp-eval\scratch\hyperv-copy-live-artifacts\HYPERV-COPY-LIVE-ARTIFACTS.json',
            'C:\kmp-eval\scratch\hyperv-start-authorized-live\HYPERV-START-AUTHORIZED-LIVE.json'
        )) {
            $null = Resolve-E1Path $path
            if (Test-Path -LiteralPath $path) { $custody += (Read-E1Json $path).value } else { $custody += $null }
        }
        Assert-E1NoLiveCustody $custody[0] $custody[1] $custody[2] $VMName $readiness.value
        $result.stage = 'host_credential'
        $stored = Import-Clixml -LiteralPath $credentialPath
        if ($stored -isnot [pscredential] -or $stored.UserName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$') { throw 'credential_shape' }
        $credential = [pscredential]::new("$GuestComputerName\$($stored.UserName)", $stored.Password)
        $config = @{
            Operation = $Operation; TargetCommit = $TargetCommit; TargetTree = $TargetTree
            VMName = $VMName; VMId = $vm.Id.ToString(); GuestComputerName = $GuestComputerName
            HostComputerName = $env:COMPUTERNAME; GuestUser = $stored.UserName
            HarnessDir = $HarnessDir; NowInAndroidDir = $NowInAndroidDir; AttestationFile = $AttestationFile
        }
        $modulePath = Resolve-E1Path (Join-Path $PSScriptRoot 'evidence1-validation-ops.psm1')
        $moduleBytes = [IO.File]::ReadAllBytes($modulePath)
        $moduleHash = Get-E1Sha256 $moduleBytes
        $result.hashes.readiness_sha256 = $readiness.sha256
        $result.hashes.validation_module_sha256 = $moduleHash
        $result.failure_code = 'transport_failed'
        $result.stage = 'transport'
        $transportStarted = $true
        $session = New-PSSession -VMName $VMName -Credential $credential -ErrorAction Stop -WarningAction SilentlyContinue
        $job = Invoke-Command -Session $session -AsJob -ScriptBlock (Get-E1ReceiverScript) `
            -ArgumentList ([Text.Encoding]::UTF8.GetString($moduleBytes)), $config, $readiness.value, $readiness.sha256, $moduleHash
        $complete = Wait-Job -Job $job -Timeout 600
        if (-not $complete) { throw 'transport_timeout' }
        $raw = @(Receive-Job -Job $job -ErrorAction Stop 3>$null 4>$null 5>$null 6>$null)
        if ($raw.Count -ne 1) { throw 'transport_shape' }
        if (-not (Test-E1Exact (Get-E1Field $raw[0] 'schema') 2)) { throw 'result_shape' }
        $result = ConvertTo-E1SafeResult $raw[0] $Operation $TargetCommit $TargetTree
        if ((Read-E1Json $readinessPath).sha256 -cne $readiness.sha256) { throw 'readiness_changed' }
    } catch {
        $fallback = if ($result.state -eq 'passed') { 'postflight_failed' } else { $result.failure_code }
        $phase = if ($transportStarted) { 'transport' } else { 'primary' }
        Set-E1Failure $result $phase (Get-E1FailureCode $_ $fallback)
    } finally {
        if ($job) { Stop-Job -Job $job -ErrorAction SilentlyContinue 2>$null; Remove-Job -Job $job -Force -ErrorAction SilentlyContinue 2>$null }
        if ($session) { Remove-PSSession -Session $session -ErrorAction SilentlyContinue 2>$null }
        if ($report) {
            try {
                $null = Resolve-E1Path $report
                New-Item -ItemType Directory -Path (Split-Path -Parent $report) -Force | Out-Null
                [IO.File]::WriteAllText($report, ($result | ConvertTo-Json -Depth 12 -Compress), [Text.UTF8Encoding]::new($false))
            } catch { Set-E1Failure $result 'persistence' 'report_write_failed' }
        }
    }
    return $result
}

Export-ModuleMember -Function *-E1*
