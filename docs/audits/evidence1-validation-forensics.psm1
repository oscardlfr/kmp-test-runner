Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:E1ForensicErrors = @('coverage_threshold_exceeded','coverage_data_unavailable','module_failed','gradle_timeout','no_test_modules','unsupported_class_version','task_not_found','jdk_mismatch','no_summary','unknown')
$script:E1ForensicWarnings = @('coverage_report_dispatch_failed','coverage_aggregation_failed','coverage_aggregation_drift','coverage_report_write_failed','coverage_aggregation_skipped','no_coverage_data','coverage_xml_disabled','coverage_xml_oversized','coverage_parse_failed','unknown')
$script:E1ForensicReasons = @('report-dispatch-failed','aggregation-failed','target-no-xml','target-parse-error','target-not-detected','no-contributing-data','unknown')
$script:E1ForensicMetrics = @('envelope_exit','tests_total','tests_passed','tests_failed','individual_total','missed_lines','modules_contributing','module_failed_setup_count','with_data_count','threshold','error_missed_lines')
$script:E1ForensicGradlePatterns = [ordered]@{
    build_failed='^\s*(?:\[[^\]]+\]\s*)?BUILD FAILED\b'
    dependency_resolution='Could not resolve all (files|dependencies)|Could not resolve [^\r\n]+'
    repository_transport='Could not (GET|HEAD|PUT)\b'
    tls_handshake='SSLHandshakeException|handshake_failure'
    tls_certificate='PKIX path building failed|unable to find valid certification path'
    dns_failure='UnknownHostException|No such host is known'
    http_unauthorized='Received status code 401\b'
    http_forbidden='Received status code 403\b'
    http_not_found='Received status code 404\b'
    http_proxy_auth='Received status code 407\b'
    http_throttled='Received status code 429\b'
    http_server_error='Received status code 5[0-9]{2}\b'
    sdk_missing='SDK location not found'
    java_version='requires Java [0-9]+|requires JVM runtime version'
    compilation='Compilation error|Compilation failed'
    plugin_resolution='Plugin \[.*\] was not found'
    file_permission='AccessDeniedException|Access is denied|Permission denied'
    file_lock='Timeout waiting to lock|being used by another process'
    daemon_disappeared='Gradle build daemon disappeared unexpectedly'
    memory_exhausted='OutOfMemoryError|Java heap space'
    connection_timeout='SocketTimeoutException|Read timed out|Connect timed out'
    connection_refused='Connection refused'
    connection_reset='Connection reset'
    task_missing='Cannot locate tasks that match|Task .+ not found in'
    invalid_option='Unknown command-line option'
    class_version='UnsupportedClassVersionError|Unsupported class file major version'
}

function Get-E1ForensicGradleSummary([string]$Text) {
    if ($Text.Length -gt 1048576) { throw 'forensic_size' }
    $signals = [ordered]@{}
    foreach ($key in $script:E1ForensicGradlePatterns.Keys) { $signals[$key] = 0 }
    # A line can carry several signatures. Counts are observations, not causal verdicts.
    foreach ($line in ($Text -split '\r?\n')) {
        foreach ($key in $script:E1ForensicGradlePatterns.Keys) {
            if ([regex]::IsMatch($line, $script:E1ForensicGradlePatterns[$key],
                [Text.RegularExpressions.RegexOptions]::IgnoreCase, [timespan]::FromSeconds(1))) { $signals[$key]++ }
        }
    }
    return @{ schema=1; signals=$signals }
}

function Assert-E1ForensicGradleSummary($Summary) {
    Assert-E1ForensicKeys $Summary @('schema','signals')
    $schema = Get-E1Field $Summary 'schema'
    if (-not (Test-E1Exact $schema 1) -or @($schema.PSObject.Properties).Count) { throw 'forensic_shape' }
    $signals = Get-E1Field $Summary 'signals'
    Assert-E1ForensicKeys $signals @($script:E1ForensicGradlePatterns.Keys)
    foreach ($key in $script:E1ForensicGradlePatterns.Keys) {
        $n = Get-E1Field $signals $key
        if (($n -isnot [int] -and $n -isnot [long]) -or $n -lt 0 -or $n -gt 1048576 -or @($n.PSObject.Properties).Count) { throw 'forensic_shape' }
    }
}

function Read-E1ForensicGradleLog([string]$Path, [string]$ExpectedSha, [int]$MaxBytes = 1048576) {
    if ($ExpectedSha -and $ExpectedSha -cnotmatch '^[a-f0-9]{64}$') { throw 'forensic_hash' }
    if ($MaxBytes -le 0 -or $MaxBytes -gt 1048576) { throw 'forensic_size' }
    $path = Resolve-E1Path $Path
    $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $null = Resolve-E1Path $path
        if ($stream.Length -gt $MaxBytes) { throw 'forensic_size' }
        $bytes = [byte[]]::new([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($read -eq 0) { throw 'forensic_size' }; $offset += $read
        }
        $hash = Get-E1Sha256 $bytes
        if ($ExpectedSha -and $hash -cne $ExpectedSha) { throw 'forensic_hash' }
        try { $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes).TrimStart([char]0xfeff) }
        catch { throw 'forensic_encoding' }
        $summary = Get-E1ForensicGradleSummary $text
        Assert-E1ForensicGradleSummary $summary
        return @{ sha256=$hash; summary=$summary }
    } finally { $stream.Dispose() }
}

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

function ConvertTo-E1ForensicReceipt($Raw, [string]$ExpectedProductHash, [switch]$IncludeGradleDiagnostics) {
    $marker = Get-E1Field $Raw 'marker_sha256'
    $product = Get-E1Field $Raw 'product_sha256'
    if ($marker -isnot [string] -or $product -isnot [string] -or
        $marker -cnotmatch '^[a-f0-9]{64}$' -or $product -cnotmatch '^[a-f0-9]{64}$' -or
        $product -cne $ExpectedProductHash) { throw 'forensic_hash' }
    $summary = Get-E1Field $Raw 'summary'
    Assert-E1ForensicSummary $summary
    $safe = @{ marker_sha256=$marker; product_sha256=$product; summary=$summary }
    if ($IncludeGradleDiagnostics) {
        $keys = @(Get-E1ObjectKeys $Raw | Where-Object { $_ -cnotin @('PSComputerName','RunspaceId','PSShowComputerName') })
        if ($keys.Count -ne 5 -or @($keys | Where-Object { $_ -cnotin @('marker_sha256','product_sha256','summary','gradle_sha256','gradle_summary') }).Count) { throw 'forensic_shape' }
        $hash = Get-E1Field $Raw 'gradle_sha256'
        if ($hash -isnot [string] -or $hash -cnotmatch '^[a-f0-9]{64}$') { throw 'forensic_hash' }
        $gradle = Get-E1Field $Raw 'gradle_summary'
        Assert-E1ForensicGradleSummary $gradle
        $safe.gradle_sha256=$hash; $safe.gradle_summary=$gradle
    }
    return $safe
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
        try { $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes).TrimStart([char]0xfeff) }
        catch { throw 'forensic_encoding' }
        try { $value = ConvertFrom-E1Json $text }
        catch { throw 'forensic_json' }
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
        $includeGradle = Get-E1Field $Config 'IncludeGradleDiagnostics'
        if ($null -ne $includeGradle -and $includeGradle -isnot [bool]) { throw 'forensic_shape' }
        $receipt = @{ marker_sha256=$marker.sha256; product_sha256=$product.sha256; summary=$summary }
        if ($includeGradle -eq $true) {
            Assert-E1Fields $Config.Report @{ state='failed' }
            $gradle = Read-E1ForensicGradleLog ($prefix + '.stderr.txt') ''
            $null = Read-E1ForensicGradleLog ($prefix + '.stderr.txt') $gradle.sha256
            $receipt.gradle_sha256=$gradle.sha256; $receipt.gradle_summary=$gradle.summary
        }
        # Reopen with the first digest: a concurrent mutation is not accepted as the same evidence.
        $null = Read-E1ForensicArtifact ($prefix + '.json') $marker.sha256
        $null = Read-E1ForensicArtifact ($prefix + '.stdout.json') $product.sha256
        return $receipt
    }
}

function Invoke-E1ForensicRead([string]$TargetCommit, [string]$TargetTree, [string]$ExpectedReportSha256, [switch]$IncludeGradleDiagnostics) {
    $result = [ordered]@{
        schema=1; operation='wet-v2-forensic-read'; state='failed'; failure_code='forensic_failed'
        subject=$null; hashes=@{}; product=$null; historical=$null
        agent_calls=0; product_invocations=0; guest_writes=0; raw_transcript_read=$false; stderr_read=$false
    }
    if ($IncludeGradleDiagnostics) {
        $result.schema=2; $result.gradle_diagnostics=$null
        $result.gradle_stderr_read_requested=$true
    }
    $session = $null; $job = $null
    try {
        if ($ExpectedReportSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'forensic_hash' }
        $reportPath = 'C:\kmp-eval\scratch\hyperv-verify-wet-gate-v2-direct\HYPERV-VERIFY-WET-GATE-V2-DIRECT.json'
        $report = Read-E1ForensicArtifact $reportPath $ExpectedReportSha256
        Assert-E1ForensicSubject $report.value $TargetCommit $TargetTree
        if ($IncludeGradleDiagnostics) { Assert-E1Fields $report.value @{ state='failed' } }
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
        $config = @{ Commit=$TargetCommit; Tree=$TargetTree; Report=$report.value; VMId=$vm.Id.ToString(); HostComputerName=$env:COMPUTERNAME; GuestUser=$stored.UserName; IncludeGradleDiagnostics=[bool]$IncludeGradleDiagnostics }
        $session = New-PSSession -VMName 'Evidence1-Runner' -Credential $credential -ErrorAction Stop
        # Transport failure cannot prove whether the optional log was read remotely.
        if ($IncludeGradleDiagnostics) { $result.stderr_read=$null }
        $job = Invoke-Command -Session $session -AsJob -ScriptBlock (Get-E1ForensicReceiverScript) -ArgumentList ([Text.Encoding]::UTF8.GetString($utility)), $result.hashes.utility_sha256, ([Text.Encoding]::UTF8.GetString($forensic)), $result.hashes.collector_sha256, $config
        if (-not (Wait-Job $job -Timeout 60)) { throw 'transport_timeout' }
        $received = @(Receive-Job $job -ErrorAction Stop 3>$null 4>$null 5>$null 6>$null)
        if ($received.Count -ne 1) { throw 'forensic_shape' }
        $raw = ConvertTo-E1ForensicReceipt $received[0] $report.value.hashes.product_stdout_sha256 -IncludeGradleDiagnostics:$IncludeGradleDiagnostics
        $null = Read-E1ForensicArtifact $reportPath $report.sha256
        $result.hashes.marker_sha256 = $raw.marker_sha256
        $result.hashes.product_sha256 = $raw.product_sha256
        $result.product = $raw.summary
        if ($IncludeGradleDiagnostics) {
            $result.hashes.gradle_stderr_sha256=$raw.gradle_sha256
            $result.gradle_diagnostics=$raw.gradle_summary
            $result.stderr_read=$true
        }
        $result.state='passed'; $result.failure_code='none'
    } catch {
        $allowed = @('forensic_hash','forensic_size','forensic_encoding','forensic_json','forensic_subject','forensic_marker','forensic_module_hash','forensic_shape','host_privilege','vm_not_running','credential_shape','guest_identity','transport_timeout','path_invalid','path_outside_root','path_link')
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

function New-E1ForensicInventory {
    return @{ schema=1; metadata_sha256=$null; counts=@{
        model=0; tasks=0; report=0; latest=0; init_directory=0; empty_init_directory=0
        residual_init_files=0; unknown_files=0; unknown_directories=0; unsafe_entries=0
    } }
}

function Assert-E1ForensicInventory($Value) {
    Assert-E1ForensicKeys $Value @('schema','metadata_sha256','counts')
    if (-not (Test-E1Exact $Value.schema 1) -or $Value.metadata_sha256 -isnot [string] -or
        $Value.metadata_sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'forensic_shape' }
    $keys = @((New-E1ForensicInventory).counts.Keys)
    Assert-E1ForensicKeys $Value.counts $keys
    foreach ($key in $keys) {
        $n = $Value.counts.$key
        if (($n -isnot [int] -and $n -isnot [long]) -or $n -lt 0 -or $n -gt 128) { throw 'forensic_shape' }
    }
}

function ConvertTo-E1ForensicInventoryReceipt($Raw) {
    $keys=@(Get-E1ObjectKeys $Raw | Where-Object { $_ -cnotin @('PSComputerName','RunspaceId','PSShowComputerName') })
    if ($keys.Count -ne 3 -or @($keys | Where-Object { $_ -cnotin @('schema','metadata_sha256','counts') }).Count) { throw 'forensic_shape' }
    $safe=@{schema=(Get-E1Field $Raw 'schema');metadata_sha256=(Get-E1Field $Raw 'metadata_sha256');counts=(Get-E1Field $Raw 'counts')}
    Assert-E1ForensicInventory $safe
    return $safe
}

function Get-E1ForensicSourceInventory([string]$Root) {
    $rootPath = Resolve-E1Path $Root
    $runtime = Join-Path $rootPath '.kmp-test-runner'
    $result = New-E1ForensicInventory
    $rows = @(); $entries = 0
    $pending = [Collections.Generic.Queue[string]]::new()
    if (Test-Path -LiteralPath $runtime) {
        $null = Resolve-E1Path $runtime
        if (-not (Get-Item -LiteralPath $runtime -Force).PSIsContainer) { throw 'source_artifacts' }
        $rows += [ordered]@{name='.kmp-test-runner';directory=$true;attributes=0;length=0;modified=0}
        $pending.Enqueue($runtime)
    }
    while ($pending.Count) {
        $directory = $pending.Dequeue()
        $childCount = 0
        Get-ChildItem -LiteralPath $directory -Force | ForEach-Object {
            $item = $_
            $childCount++
            if (++$entries -gt 128) { throw 'source_artifact_limit' }
            # Enumeration returns cached FileSystemInfo metadata; refresh before fingerprinting.
            $item.Refresh()
            $relative = $item.FullName.Substring($rootPath.Length + 1).Replace('\','/')
            $rows += [ordered]@{ name=$relative; directory=$item.PSIsContainer; attributes=[int]$item.Attributes
                length=$(if ($item.PSIsContainer) { 0 } else { $item.Length }); modified=$item.LastWriteTimeUtc.Ticks }
            # Inspect metadata only, and never descend through unsafe or unknown directories.
            try { $null = Resolve-E1Path $item.FullName } catch { $result.counts.unsafe_entries++; return }
            if ($item.PSIsContainer) {
                if ($relative -ceq '.kmp-test-runner/init-scripts') { $result.counts.init_directory++ }
                if ($relative -cin @('.kmp-test-runner/cache','.kmp-test-runner/reports','.kmp-test-runner/reports/coverage','.kmp-test-runner/init-scripts')) {
                    $pending.Enqueue($item.FullName)
                } else { $result.counts.unknown_directories++ }
            } elseif ($relative.StartsWith('.kmp-test-runner/init-scripts/', [StringComparison]::Ordinal)) {
                $result.counts.residual_init_files++
            } else {
                try { $kind = Get-E1ArtifactKind $relative; $result.counts[$kind]++ }
                catch { $result.counts.unknown_files++ }
            }
        }
        if ($directory -ieq (Join-Path $runtime 'init-scripts') -and $childCount -eq 0) { $result.counts.empty_init_directory++ }
    }
    $metadata = @($rows | Sort-Object { $_.name } -CaseSensitive) | ConvertTo-Json -Depth 4 -Compress
    $result.metadata_sha256 = Get-E1Sha256 ([Text.Encoding]::UTF8.GetBytes([string]$metadata))
    Assert-E1ForensicInventory $result
    return $result
}

function Get-E1ForensicSourceReceiver {
    return {
        param($UtilityText, $UtilityHash, $ForensicText, $ForensicHash, $Config)
        $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
        foreach ($pair in @(@($UtilityText,$UtilityHash), @($ForensicText,$ForensicHash))) {
            $sha=[Security.Cryptography.SHA256]::Create()
            try { $hash=-join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($pair[0])) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
            if ($pair[1] -cnotmatch '^[a-f0-9]{64}$' -or $hash -cne $pair[1]) { throw 'forensic_module_hash' }
        }
        Import-Module (New-Module -Name Evidence1SourceUtility -ScriptBlock ([scriptblock]::Create($UtilityText))) -DisableNameChecking
        Import-Module (New-Module -Name Evidence1SourceForensics -ScriptBlock ([scriptblock]::Create($ForensicText))) -DisableNameChecking
        $identity=Get-CimInstance Win32_ComputerSystem
        $id=Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters' -Name VirtualMachineId
        Assert-E1GuestIdentity $env:COMPUTERNAME $Config.HostComputerName 'Evidence1Runner' $id $Config.VMId $identity.Manufacturer $identity.Model $env:USERNAME $Config.GuestUser
        $harness=Resolve-E1Path 'C:\kmp-eval\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1'
        $source=Resolve-E1Path 'C:\kmp-eval\NowInAndroid-evidence1-coverage-threshold-windows-stageb-v1'
        function Assert-Anchor([string]$Root, [string]$Ref, [string]$Expected) {
            $actual=@(& 'C:\Program Files\Git\cmd\git.exe' --no-optional-locks -C $Root rev-parse --verify $Ref 2>$null)
            if ($LASTEXITCODE -ne 0 -or $actual.Count -ne 1 -or $actual[0] -cne $Expected) { throw 'forensic_subject' }
        }
        Assert-Anchor $harness 'HEAD' $Config.Commit
        Assert-Anchor $harness 'HEAD^{tree}' $Config.Tree
        Assert-Anchor $source 'HEAD' '7d45eae4f8720a0c77f507712ba2437ff974b6ed'
        $before=Get-E1ForensicSourceInventory $source
        $after=Get-E1ForensicSourceInventory $source
        if ($before.metadata_sha256 -cne $after.metadata_sha256) { throw 'source_inventory_changed' }
        Assert-Anchor $harness 'HEAD' $Config.Commit
        Assert-Anchor $source 'HEAD' '7d45eae4f8720a0c77f507712ba2437ff974b6ed'
        return $after
    }
}

function Invoke-E1ForensicSourceRead([string]$TargetCommit, [string]$TargetTree) {
    $result=@{schema=1;operation='source-artifact-inventory';state='failed';failure_code='forensic_failed'
        target_commit=$null;target_tree=$null;inventory=$null;hashes=@{}
        agent_calls=0;product_invocations=0;guest_writes=0;source_file_contents_read=$false;validation_pass=$false}
    $session=$null; $job=$null
    try {
        if ($TargetCommit -cnotmatch '^[a-f0-9]{40}$' -or $TargetTree -cnotmatch '^[a-f0-9]{40}$') { throw 'forensic_subject' }
        $result.target_commit=$TargetCommit; $result.target_tree=$TargetTree
        if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'host_privilege' }
        $vm=Get-VM -Name 'Evidence1-Runner' -ErrorAction Stop
        if ($vm.State.ToString() -cne 'Running') { throw 'vm_not_running' }
        $stored=Import-Clixml -LiteralPath (Resolve-E1Path 'C:\kmp-eval\scratch\hyperv-create-runner\Evidence1-Runner.guest-credential.clixml')
        if ($stored -isnot [pscredential] -or $stored.UserName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$') { throw 'credential_shape' }
        $credential=[pscredential]::new("Evidence1Runner\$($stored.UserName)",$stored.Password)
        $utility=[IO.File]::ReadAllBytes((Resolve-E1Path (Join-Path $PSScriptRoot 'evidence1-validation-ops.psm1')))
        $forensic=[IO.File]::ReadAllBytes((Resolve-E1Path (Join-Path $PSScriptRoot 'evidence1-validation-forensics.psm1')))
        $result.hashes.utility_sha256=Get-E1Sha256 $utility; $result.hashes.collector_sha256=Get-E1Sha256 $forensic
        $config=@{Commit=$TargetCommit;Tree=$TargetTree;VMId=$vm.Id.ToString();HostComputerName=$env:COMPUTERNAME;GuestUser=$stored.UserName}
        $session=New-PSSession -VMName 'Evidence1-Runner' -Credential $credential -ErrorAction Stop
        $job=Invoke-Command -Session $session -AsJob -ScriptBlock (Get-E1ForensicSourceReceiver) -ArgumentList ([Text.Encoding]::UTF8.GetString($utility)), $result.hashes.utility_sha256, ([Text.Encoding]::UTF8.GetString($forensic)), $result.hashes.collector_sha256, $config
        if (-not (Wait-Job $job -Timeout 60)) { throw 'transport_timeout' }
        $received=@(Receive-Job $job -ErrorAction Stop 3>$null 4>$null 5>$null 6>$null)
        if ($received.Count -ne 1) { throw 'forensic_shape' }
        # Strip only remoting metadata, then validate every retained key and scalar.
        $raw=ConvertTo-E1ForensicInventoryReceipt $received[0]
        $result.inventory=$raw; $result.state='passed'; $result.failure_code='none'
    } catch {
        $allowed=@('forensic_subject','forensic_shape','forensic_module_hash','host_privilege','vm_not_running','credential_shape','guest_identity','transport_timeout','path_invalid','path_outside_root','path_link','source_artifacts','source_artifact_limit','source_inventory_changed')
        $exception=$_.Exception
        for($i=0;$exception -and $i -lt 8;$i++) { if($exception.Message -cin $allowed){$result.failure_code=$exception.Message;break}; $exception=$exception.InnerException }
    } finally {
        if($job){Stop-Job $job -ErrorAction SilentlyContinue 2>$null;Remove-Job $job -Force -ErrorAction SilentlyContinue 2>$null}
        if($session){Remove-PSSession $session -ErrorAction SilentlyContinue 2>$null}
    }
    return $result
}

Export-ModuleMember -Function *-E1Forensic*
