Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:E1ForensicErrors = @('coverage_threshold_exceeded','coverage_data_unavailable','module_failed','gradle_timeout','no_test_modules','unsupported_class_version','task_not_found','jdk_mismatch','no_summary','unknown')
$script:E1ForensicWarnings = @('coverage_report_dispatch_failed','coverage_aggregation_failed','coverage_aggregation_drift','coverage_report_write_failed','coverage_aggregation_skipped','no_coverage_data','coverage_xml_disabled','coverage_xml_oversized','coverage_parse_failed','unknown')
$script:E1ForensicReasons = @('report-dispatch-failed','aggregation-failed','target-no-xml','target-parse-error','target-not-detected','no-contributing-data','unknown')
$script:E1ForensicMetrics = @('envelope_exit','tests_total','tests_passed','tests_failed','individual_total','missed_lines','modules_contributing','module_failed_setup_count','with_data_count','threshold','error_missed_lines')

function Assert-E1ForensicKeys($Value, [string[]]$Keys) {
    if ($null -eq $Value -or $Value -is [array] -or $Value -is [string]) { throw 'forensic_shape' }
    $actual = if ($Value -is [Collections.IDictionary]) { @($Value.Keys) } else { @($Value.PSObject.Properties.Name) }
    if ($actual.Count -ne $Keys.Count -or @($actual | Where-Object { $_ -cnotin $Keys }).Count) { throw 'forensic_shape' }
}

function Get-E1ForensicNumber($Object, [string]$Name) {
    $exists = $null -ne $Object -and $(if ($Object -is [Collections.IDictionary]) { $Object.Contains($Name) } else { $null -ne $Object.PSObject.Properties[$Name] })
    $v = Get-E1Field $Object $Name
    $state = if (-not $exists) { 'missing' } elseif ($null -eq $v) { 'null' } elseif (($v -is [int] -or $v -is [long]) -and $v -ge 0 -and $v -le 4294967295) { 'recorded' } else { 'invalid' }
    return [ordered]@{ status = $state; value = $(if ($state -ceq 'recorded') { $v } else { $null }) }
}

function Get-E1ForensicCodes($Values, [string]$Field, [string[]]$Allowed) {
    $counts = [ordered]@{}
    foreach ($key in $Allowed) { $counts[$key] = 0 }
    $valid = $Values -is [array]
    if ($valid) {
        foreach ($item in $Values) {
            $code = Get-E1Field $item $Field
            $key = if ($code -is [string] -and $code -cin $Allowed) { $code } else { 'unknown' }
            $counts[$key]++
        }
    }
    return [ordered]@{ status = $(if ($valid) { 'recorded' } else { 'not-recorded' }); count = $(if ($valid) { $Values.Count } else { $null }); counts = $counts }
}

function Get-E1ForensicProductSummary($Envelope) {
    $tests = Get-E1Field $Envelope 'tests'
    $coverage = Get-E1Field $Envelope 'coverage'
    $errors = Get-E1Field $Envelope 'errors'
    $warnings = Get-E1Field $Envelope 'warnings'
    $withData = Get-E1Field (Get-E1Field $coverage 'module_buckets') 'with_data'
    $thresholdErrors = @()
    $availabilityErrors = @()
    $setupCount = $null
    if ($errors -is [array]) {
        $thresholdErrors = @($errors | Where-Object { (Get-E1Field $_ 'code') -ceq 'coverage_threshold_exceeded' })
        $availabilityErrors = @($errors | Where-Object { (Get-E1Field $_ 'code') -ceq 'coverage_data_unavailable' })
        $setupCount = @($errors | Where-Object { (Get-E1Field $_ 'code') -ceq 'module_failed' -and (Test-E1Exact (Get-E1Field $_ 'setup_failed') $true) }).Count
    }
    $thresholdError = if ($thresholdErrors.Count -eq 1) { $thresholdErrors[0] } else { $null }
    $metrics = [ordered]@{ envelope_exit = (Get-E1ForensicNumber $Envelope 'exit_code') }
    foreach ($name in @('total','passed','failed')) { $metrics["tests_$name"] = Get-E1ForensicNumber $tests $name }
    $metrics.individual_total = Get-E1ForensicNumber $tests 'individual_total'
    foreach ($name in @('missed_lines','modules_contributing')) { $metrics[$name] = Get-E1ForensicNumber $coverage $name }
    $metrics.module_failed_setup_count = Get-E1ForensicNumber @{ value = $setupCount } 'value'
    $metrics.with_data_count = Get-E1ForensicNumber @{ value = $(if ($withData -is [array]) { $withData.Count } else { $null }) } 'value'
    $metrics.threshold = Get-E1ForensicNumber $thresholdError 'threshold'
    $metrics.error_missed_lines = Get-E1ForensicNumber $thresholdError 'missed_lines'
    return [ordered]@{
        schema = 1; tool_match = (Test-E1Exact (Get-E1Field $Envelope 'tool') 'kmp-test')
        subcommand_match = (Test-E1Exact (Get-E1Field $Envelope 'subcommand') 'parallel')
        metrics = $metrics
        error_codes = (Get-E1ForensicCodes $errors 'code' $script:E1ForensicErrors)
        warning_codes = (Get-E1ForensicCodes $warnings 'code' $script:E1ForensicWarnings)
        coverage_reasons = (Get-E1ForensicCodes $(if ($errors -is [array]) { ,$availabilityErrors } else { $null }) 'reason' $script:E1ForensicReasons)
        with_data_target_match = $(if ($withData -is [array]) { $withData.Count -eq 1 -and (Test-E1Exact $withData[0] ':core:domain') } else { $null })
    }
}

function Assert-E1ForensicSummary($Summary) {
    Assert-E1ForensicKeys $Summary @('schema','tool_match','subcommand_match','metrics','error_codes','warning_codes','coverage_reasons','with_data_target_match')
    Assert-E1Fields $Summary @{ schema = 1 }
    foreach ($name in @('tool_match','subcommand_match')) { if ((Get-E1Field $Summary $name) -isnot [bool]) { throw 'forensic_shape' } }
    $match = Get-E1Field $Summary 'with_data_target_match'
    if ($null -ne $match -and $match -isnot [bool]) { throw 'forensic_shape' }
    $metrics = Get-E1Field $Summary 'metrics'
    Assert-E1ForensicKeys $metrics $script:E1ForensicMetrics
    foreach ($name in $script:E1ForensicMetrics) {
        $metric = Get-E1Field $metrics $name
        Assert-E1ForensicKeys $metric @('status','value')
        $state = Get-E1Field $metric 'status'; $v = Get-E1Field $metric 'value'
        if ($state -isnot [string] -or $state -cnotin @('recorded','missing','null','invalid')) { throw 'forensic_shape' }
        if ($state -ceq 'recorded') {
            if (($v -isnot [int] -and $v -isnot [long]) -or $v -lt 0 -or $v -gt 4294967295) { throw 'forensic_shape' }
        } elseif ($null -ne $v) { throw 'forensic_shape' }
    }
    $maps = @{ error_codes = $script:E1ForensicErrors; warning_codes = $script:E1ForensicWarnings; coverage_reasons = $script:E1ForensicReasons }
    foreach ($name in $maps.Keys) {
        $map = Get-E1Field $Summary $name
        Assert-E1ForensicKeys $map @('status','count','counts')
        $state = Get-E1Field $map 'status'; $count = Get-E1Field $map 'count'; $counts = Get-E1Field $map 'counts'
        if ($state -isnot [string]) { throw 'forensic_shape' }
        Assert-E1ForensicKeys $counts $maps[$name]
        $sum = 0L
        foreach ($key in $maps[$name]) {
            $v = Get-E1Field $counts $key
            if (($v -isnot [int] -and $v -isnot [long]) -or $v -lt 0 -or $v -gt 1048576) { throw 'forensic_shape' }
            $sum += $v
        }
        if ($state -ceq 'recorded') {
            if (($count -isnot [int] -and $count -isnot [long]) -or $count -ne $sum) { throw 'forensic_shape' }
        } elseif ($state -cne 'not-recorded' -or $null -ne $count -or $sum -ne 0) { throw 'forensic_shape' }
    }
}

function ConvertTo-E1ForensicReceipt($Raw, [string]$ExpectedProductHash) {
    $marker = Get-E1Field $Raw 'marker_sha256'
    $product = Get-E1Field $Raw 'product_sha256'
    if ($marker -isnot [string] -or $product -isnot [string] -or
        $marker -cnotmatch '^[a-f0-9]{64}$' -or $product -cnotmatch '^[a-f0-9]{64}$' -or
        $product -cne $ExpectedProductHash) { throw 'forensic_hash' }
    $summary = Get-E1Field $Raw 'summary'
    Assert-E1ForensicSummary $summary
    return @{ marker_sha256=$marker; product_sha256=$product; summary=$summary }
}

function Read-E1ForensicArtifact([string]$Path, [string]$ExpectedSha, [int]$MaxBytes = 1048576) {
    if ($ExpectedSha -and $ExpectedSha -cnotmatch '^[a-f0-9]{64}$') { throw 'forensic_hash' }
    $path = Resolve-E1Path $Path
    $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $null = Resolve-E1Path $path
        if ($stream.Length -le 0 -or $stream.Length -gt $MaxBytes) { throw 'forensic_size' }
        $bytes = [byte[]]::new([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -eq 0) { throw 'forensic_size' }; $offset += $read
        }
        $hash = Get-E1Sha256 $bytes
        if ($ExpectedSha -and $hash -cne $ExpectedSha) { throw 'forensic_hash' }
        $value = ConvertFrom-E1Json ([Text.UTF8Encoding]::new($false, $true).GetString($bytes).TrimStart([char]0xfeff))
        return @{ sha256 = $hash; value = $value }
    } finally { $stream.Dispose() }
}

function Assert-E1ForensicSubject($Report, [string]$Commit, [string]$Tree) {
    if ($Commit -cnotmatch '^[a-f0-9]{40}$' -or $Tree -cnotmatch '^[a-f0-9]{40}$') { throw 'forensic_subject' }
    $schema = Get-E1Field $Report 'schema'
    if (-not (Test-E1Exact $schema 1) -and -not (Test-E1Exact $schema 2)) { throw 'forensic_subject' }
    Assert-E1Fields $Report @{ operation='wet-v2'; target_commit=$Commit; target_tree=$Tree; source_commit='7d45eae4f8720a0c77f507712ba2437ff974b6ed'; agent_calls=0; product_invocations=1; dry_plan_invocations=0 }
    $state = Get-E1Field $Report 'state'
    $hash = Get-E1Field (Get-E1Field $Report 'hashes') 'product_stdout_sha256'
    if ($state -isnot [string] -or $state -cnotin @('passed','failed') -or
        $hash -isnot [string] -or $hash -cnotmatch '^[a-f0-9]{64}$') { throw 'forensic_subject' }
}

function Assert-E1ForensicMarker($Marker, $Report) {
    Assert-E1ForensicSubject $Marker $Report.target_commit $Report.target_tree
    foreach ($key in @('schema','state','failure_code')) {
        if ((Get-E1Field $Marker $key) -cne (Get-E1Field $Report $key)) { throw 'forensic_marker' }
    }
    if ((Get-E1Field (Get-E1Field $Marker 'hashes') 'product_stdout_sha256') -cne $Report.hashes.product_stdout_sha256) { throw 'forensic_marker' }
}

function Get-E1ForensicHistory($Report) {
    # Never manufacture process exit/duration or a secondary exception for a schema 1 record.
    if ((Get-E1Field $Report 'schema') -eq 2) {
        $null = ConvertTo-E1SafeResult $Report 'wet-v2' $Report.target_commit $Report.target_tree
        $process = Get-E1Field (Get-E1Field $Report 'processes') 'product'
        $postflight = Get-E1Field (Get-E1Field $Report 'failures') 'postflight'
    } else { $process = $null; $postflight = $null }
    return [ordered]@{
        process = @{ status = $(if ($null -ne $process) { 'recorded' } else { 'not-recorded' }); value = $process }
        postflight_failure = @{ status = $(if ($null -ne $postflight) { 'recorded' } else { 'not-recorded' }); value = $postflight }
    }
}

function Get-E1ForensicReceiverScript {
    return {
        param($UtilityText, $UtilityHash, $ForensicText, $ForensicHash, $Config)
        $ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
        foreach ($pair in @(@($UtilityText,$UtilityHash), @($ForensicText,$ForensicHash))) {
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $h = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($pair[0])) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
            if ($pair[1] -cnotmatch '^[a-f0-9]{64}$' -or $h -cne $pair[1]) { throw 'forensic_module_hash' }
        }
        Import-Module (New-Module -Name Evidence1ForensicUtility -ScriptBlock ([scriptblock]::Create($UtilityText))) -DisableNameChecking
        Import-Module (New-Module -Name Evidence1ForensicReader -ScriptBlock ([scriptblock]::Create($ForensicText))) -DisableNameChecking
        $identity = Get-CimInstance Win32_ComputerSystem
        $id = Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters' -Name VirtualMachineId
        Assert-E1GuestIdentity $env:COMPUTERNAME $Config.HostComputerName 'Evidence1Runner' $id $Config.VMId $identity.Manufacturer $identity.Model $env:USERNAME $Config.GuestUser
        Assert-E1ForensicSubject $Config.Report $Config.Commit $Config.Tree
        $prefix = 'C:\kmp-eval\scratch\evidence1-validation-ops\wet-v2-' + $Config.Commit
        $marker = Read-E1ForensicArtifact ($prefix + '.json') ''
        Assert-E1ForensicMarker $marker.value $Config.Report
        $product = Read-E1ForensicArtifact ($prefix + '.stdout.json') $Config.Report.hashes.product_stdout_sha256
        $summary = Get-E1ForensicProductSummary $product.value
        Assert-E1ForensicSummary $summary
        # Reopen with the first digest: a concurrent mutation is not accepted as the same evidence.
        $null = Read-E1ForensicArtifact ($prefix + '.json') $marker.sha256
        $null = Read-E1ForensicArtifact ($prefix + '.stdout.json') $product.sha256
        return @{ marker_sha256=$marker.sha256; product_sha256=$product.sha256; summary=$summary }
    }
}

function Invoke-E1ForensicRead([string]$TargetCommit, [string]$TargetTree, [string]$ExpectedReportSha256) {
    $result = [ordered]@{
        schema=1; operation='wet-v2-forensic-read'; state='failed'; failure_code='forensic_failed'
        subject=$null; hashes=@{}; product=$null; historical=$null
        agent_calls=0; product_invocations=0; guest_writes=0; raw_transcript_read=$false; stderr_read=$false
    }
    $session = $null; $job = $null
    try {
        if ($ExpectedReportSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'forensic_hash' }
        $reportPath = 'C:\kmp-eval\scratch\hyperv-verify-wet-gate-v2-direct\HYPERV-VERIFY-WET-GATE-V2-DIRECT.json'
        $report = Read-E1ForensicArtifact $reportPath $ExpectedReportSha256
        Assert-E1ForensicSubject $report.value $TargetCommit $TargetTree
        $result.subject = @{ target_commit=$TargetCommit; target_tree=$TargetTree; source_commit=$report.value.source_commit; host_report_sha256=$report.sha256 }
        $result.historical = Get-E1ForensicHistory $report.value
        if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'host_privilege' }
        $vm = Get-VM -Name 'Evidence1-Runner' -ErrorAction Stop
        if ($vm.State.ToString() -cne 'Running') { throw 'vm_not_running' }
        $credentialPath = Resolve-E1Path 'C:\kmp-eval\scratch\hyperv-create-runner\Evidence1-Runner.guest-credential.clixml'
        $stored = Import-Clixml -LiteralPath $credentialPath
        if ($stored -isnot [pscredential] -or $stored.UserName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$') { throw 'credential_shape' }
        $credential = [pscredential]::new("Evidence1Runner\$($stored.UserName)", $stored.Password)
        $utility = [IO.File]::ReadAllBytes((Resolve-E1Path (Join-Path $PSScriptRoot 'evidence1-validation-ops.psm1')))
        $forensic = [IO.File]::ReadAllBytes((Resolve-E1Path (Join-Path $PSScriptRoot 'evidence1-validation-forensics.psm1')))
        $result.hashes.utility_sha256 = Get-E1Sha256 $utility
        $result.hashes.collector_sha256 = Get-E1Sha256 $forensic
        $config = @{ Commit=$TargetCommit; Tree=$TargetTree; Report=$report.value; VMId=$vm.Id.ToString(); HostComputerName=$env:COMPUTERNAME; GuestUser=$stored.UserName }
        $session = New-PSSession -VMName 'Evidence1-Runner' -Credential $credential -ErrorAction Stop
        $job = Invoke-Command -Session $session -AsJob -ScriptBlock (Get-E1ForensicReceiverScript) -ArgumentList ([Text.Encoding]::UTF8.GetString($utility)), $result.hashes.utility_sha256, ([Text.Encoding]::UTF8.GetString($forensic)), $result.hashes.collector_sha256, $config
        if (-not (Wait-Job $job -Timeout 60)) { throw 'transport_timeout' }
        $received = @(Receive-Job $job -ErrorAction Stop 3>$null 4>$null 5>$null 6>$null)
        if ($received.Count -ne 1) { throw 'forensic_shape' }
        $raw = ConvertTo-E1ForensicReceipt $received[0] $report.value.hashes.product_stdout_sha256
        $null = Read-E1ForensicArtifact $reportPath $report.sha256
        $result.hashes.marker_sha256 = $raw.marker_sha256
        $result.hashes.product_sha256 = $raw.product_sha256
        $result.product = $raw.summary
        $result.state='passed'; $result.failure_code='none'
    } catch {
        $allowed = @('forensic_hash','forensic_size','forensic_subject','forensic_marker','forensic_module_hash','forensic_shape','host_privilege','vm_not_running','credential_shape','guest_identity','transport_timeout','path_invalid','path_outside_root','path_link')
        $exception = $_.Exception
        for ($i=0; $null -ne $exception -and $i -lt 8; $i++) {
            if ($exception.Message -cin $allowed) { $result.failure_code=$exception.Message; break }
            $exception=$exception.InnerException
        }
    } finally {
        if ($job) { Stop-Job $job -ErrorAction SilentlyContinue 2>$null; Remove-Job $job -Force -ErrorAction SilentlyContinue 2>$null }
        if ($session) { Remove-PSSession $session -ErrorAction SilentlyContinue 2>$null }
    }
    return $result
}

Export-ModuleMember -Function *-E1Forensic*
