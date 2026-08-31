Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

function Invoke-E1ProvisionLifecycle($VM,[string]$JournalPath,[scriptblock]$Warm,[scriptblock]$Certify,[scriptblock]$Quiet,[hashtable]$Binding) {
    $result=@{state='failed';failure_code='preflight_failed';warm=$null;certify=$null;
        network=@{disconnected_verified=$false;restored=$false;isolated_on_return=$null}}
    $mutex=$null;$locked=$false;$started=$false;$safe=$true;$topology=$null
    try {
        $mutex=[Threading.Mutex]::new($false,'Global\Evidence1OfflineNetwork');$locked=$mutex.WaitOne(0)
        if(-not $locked) {throw 'validation_overlap'}
        $JournalPath=Resolve-E1Path $JournalPath
        if(Test-Path -LiteralPath $JournalPath) {throw 'attempt_exists'}
        & $Quiet
        $topology=Get-E1OfflineAdapterSnapshot $VM
        $stream=[IO.File]::Open($JournalPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
        try {Write-E1Record $stream @{schema=1;vm_id=$VM.Id.ToString();topology=$topology;binding=$Binding};$stream.Flush($true)} finally {$stream.Dispose()}
        $started=$true;$safe=$false
        $result.warm=& $Warm
        $safe=$result.warm.checks.network_restored -and ($null -eq $result.warm.process -or $result.warm.process.cleanup_ok)
        if(-not $safe) {throw 'network_restore_required'}
        & $Quiet
        if($result.warm.state -cne 'passed') {$result.failure_code=$result.warm.failure_code;return $result}
        Assert-E1OfflineAdapterState $VM $topology 'original'
        foreach($adapter in @(Get-VMNetworkAdapter -VM $VM)) {Disconnect-VMNetworkAdapter -VMNetworkAdapter $adapter -Confirm:$false | Out-Null}
        Assert-E1OfflineAdapterState $VM $topology 'disconnected'
        $result.network.disconnected_verified=$true
        $assertState=(Get-Command Assert-E1OfflineAdapterState).ScriptBlock
        $monitor={& $assertState $VM $topology 'disconnected'}.GetNewClosure()
        $safe=$false
        $result.certify=& $Certify $monitor
        $safe=$result.certify.checks.network_restored -and ($null -eq $result.certify.process -or $result.certify.process.cleanup_ok)
        $safe=$safe -and $result.certify.hashes.firewall_before_sha256 -ceq $result.warm.hashes.firewall_after_sha256 -and
            $result.certify.hashes.firewall_after_sha256 -ceq $result.warm.hashes.firewall_after_sha256
        if(-not $safe) {throw 'network_restore_required'}
        & $monitor
        $result.failure_code=$result.certify.failure_code
        if($result.certify.state -ceq 'passed') {$result.state='passed';$result.failure_code='none'}
    } catch {
        $result.failure_code='transport_failed'
        if($_.Exception.Message -cin @('attempt_exists','validation_overlap','network_restore_required')) {$result.failure_code=$_.Exception.Message}
    } finally {
        if($started) {
            try {
                if(-not $safe) {throw 'network_restore_required'}
                & $Quiet
                Restore-E1OfflineAdapters $VM $topology
                $result.network.restored=$true
            } catch {
                $result.state='failed';$result.failure_code='network_restore_required'
                # Even a partial firewall or transport failure must leave no NIC online.
                foreach($adapter in @(Get-VMNetworkAdapter -VM $VM)) {
                    try {Disconnect-VMNetworkAdapter -VMNetworkAdapter $adapter -Confirm:$false | Out-Null} catch { }
                }
            }
        }
        if($topology) {
            try {
                $nics=@(Get-VMNetworkAdapter -VM $VM)
                $result.network.isolated_on_return=($nics.Count -eq $topology.Count -and @($nics | Where-Object {$_.Connected -or [guid]$_.SwitchId -ne [guid]::Empty}).Count -eq 0)
            } catch {$result.network.isolated_on_return=$null}
        }
        if($locked) {$mutex.ReleaseMutex()};if($mutex) {$mutex.Dispose()}
    }
    return $result
}

function Invoke-E1CacheProvisionTransport($Session,$Config,[scriptblock]$Monitor) {
    $job=$null
    try {
        $job=Invoke-Command -Session $Session -AsJob -ScriptBlock {param($Config)
            $ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
            Invoke-E1CacheProvisionGuest $Config
        } -ArgumentList $Config
        $watch=[Diagnostics.Stopwatch]::StartNew()
        while(-not (Wait-Job $job -Timeout 5)) {
            if($Monitor) {& $Monitor}
            if($watch.Elapsed.TotalSeconds -gt 1200) {throw 'transport_timeout'}
        }
        if($job.State.ToString() -cne 'Completed') {throw 'transport_failed'}
        $raw=@(Receive-Job $job -ErrorAction Stop 3>$null 4>$null 5>$null 6>$null)
        if($raw.Count -ne 1) {throw 'result_shape'}
        $safe=ConvertTo-E1CacheProvisionReceipt $raw[0]
        if($safe.phase -cne $Config.Phase -or $safe.provision_id -cne $Config.ProvisionId) {throw 'result_shape'}
        return $safe
    } finally {
        if($job) {Stop-Job $job -ErrorAction SilentlyContinue 2>$null;Remove-Job $job -Force -ErrorAction SilentlyContinue 2>$null}
    }
}

function Invoke-E1CacheProvisionDirect([string]$TargetCommit,[string]$TargetTree,[string]$ExpectedReportSha256,[string]$ProvisionId) {
    $result=@{schema=1;operation='gradle-cache-provision';state='failed';failure_code='preflight_failed';subject=$null;module_sha256=$null;warm=$null;certify=$null;network=$null}
    $session=$null;$lease=$false;$release=$false
    try {
        if($ProvisionId -cnotmatch '^[a-f0-9]{32}$' -or $TargetCommit -cnotmatch '^[a-f0-9]{40}$' -or $TargetTree -cnotmatch '^[a-f0-9]{40}$' -or $ExpectedReportSha256 -cnotmatch '^[a-f0-9]{64}$') {throw 'forensic_subject'}
        if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {throw 'host_privilege'}
        $reportPath='C:\kmp-eval\scratch\hyperv-verify-wet-gate-v2-direct\HYPERV-VERIFY-WET-GATE-V2-DIRECT.json'
        $report=Read-E1ForensicArtifact $reportPath $ExpectedReportSha256
        Assert-E1ForensicSubject $report.value $TargetCommit $TargetTree
        Assert-E1Fields $report.value @{state='failed'}
        $result.subject=@{target_commit=$TargetCommit;target_tree=$TargetTree;host_wet_report_sha256=$report.sha256}
        $vm=Get-VM -Name 'Evidence1-Runner' -ErrorAction Stop
        if($vm.State.ToString() -cne 'Running') {throw 'vm_not_running'}
        $root=Resolve-E1Path 'C:\kmp-eval\scratch\hyperv-cache-provision-direct'
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        $journal=Resolve-E1Path (Join-Path $root ($ProvisionId + '.journal.json'))
        if(Test-Path -LiteralPath $journal) {throw 'attempt_exists'}
        $stored=Import-Clixml -LiteralPath (Resolve-E1Path 'C:\kmp-eval\scratch\hyperv-create-runner\Evidence1-Runner.guest-credential.clixml')
        if($stored -isnot [pscredential] -or $stored.UserName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$') {throw 'credential_shape'}
        $credential=[pscredential]::new("Evidence1Runner\$($stored.UserName)",$stored.Password)
        $text=''
        foreach($name in @('evidence1-validation-ops.psm1','evidence1-validation-forensics.psm1','evidence1-gradle-offline-probe.psm1','evidence1-gradle-cache-provision.psm1')) {
            $text += [Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes((Resolve-E1Path (Join-Path $PSScriptRoot $name)))) + "`n"
        }
        $result.module_sha256=Get-E1Sha256 ([Text.Encoding]::UTF8.GetBytes($text))
        $config=@{Commit=$TargetCommit;Tree=$TargetTree;Report=$report.value;VMId=$vm.Id.ToString();HostComputerName=$env:COMPUTERNAME;GuestUser=$stored.UserName;ProvisionId=$ProvisionId;LeaseToken=[guid]::NewGuid().ToString('N');Phase='warm'}
        $session=New-PSSession -VMId $vm.Id -Credential $credential -ErrorAction Stop
        Invoke-Command -Session $session -ScriptBlock {
            param($Text,$Hash,$Config)
            $ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
            $sha=[Security.Cryptography.SHA256]::Create()
            try {$actual=-join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)) | ForEach-Object {$_.ToString('x2')})} finally {$sha.Dispose()}
            if($actual -cne $Hash) {throw 'module_hash_mismatch'}
            Import-Module (New-Module -Name Evidence1CacheProvisionRuntime -ScriptBlock ([scriptblock]::Create($Text))) -Global -DisableNameChecking
            $identity=Get-CimInstance Win32_ComputerSystem
            $vmId=Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters' -Name VirtualMachineId
            Assert-E1GuestIdentity $env:COMPUTERNAME $Config.HostComputerName 'Evidence1Runner' $vmId $Config.VMId $identity.Manufacturer $identity.Model $env:USERNAME $Config.GuestUser
            Initialize-E1OfflineLease
            [E1OfflineValidationLease]::Acquire($Config.LeaseToken)
        } -ArgumentList $text,$result.module_sha256,$config -ErrorAction Stop | Out-Null
        $lease=$true;$release=$true
        $quiet={Invoke-Command -Session $session -ScriptBlock {param($Config)
            if(-not [E1OfflineValidationLease]::Owns($Config.LeaseToken)) {throw 'validation_overlap'}
            Assert-E1OfflineQuiescent 'C:\kmp-eval\NowInAndroid-evidence1-coverage-threshold-windows-stageb-v1'
        } -ArgumentList $config -ErrorAction Stop | Out-Null}.GetNewClosure()
        $warm={Invoke-E1CacheProvisionTransport $session $config $null}.GetNewClosure()
        $certify={param($monitor)
            $config.Phase='certify'
            Invoke-E1CacheProvisionTransport $session $config $monitor
        }.GetNewClosure()
        $release=$false
        $r=Invoke-E1ProvisionLifecycle $vm $journal $warm $certify $quiet @{host=$env:COMPUTERNAME;target_commit=$TargetCommit;target_tree=$TargetTree;report_sha256=$ExpectedReportSha256;module_sha256=$result.module_sha256}
        $release=($r.failure_code -cne 'network_restore_required')
        foreach($key in @('state','failure_code','warm','certify','network')) {$result[$key]=$r[$key]}
        $null=Read-E1ForensicArtifact $reportPath $report.sha256
    } catch {
        $result.state='failed';$result.failure_code=Get-E1FailureCode $_ 'transport_failed'
        if($_.Exception.Message -cin @('forensic_subject','host_privilege','vm_not_running','credential_shape','attempt_exists')) {$result.failure_code=$_.Exception.Message}
    } finally {
        if($session -and $lease -and $release) {
            try {Invoke-Command -Session $session -ScriptBlock {param($token) [E1OfflineValidationLease]::Release($token)} -ArgumentList $config.LeaseToken -ErrorAction Stop | Out-Null}
            catch {$result.state='failed';$result.failure_code='lease_release_failed'}
        }
        if($session) {Remove-PSSession $session -ErrorAction SilentlyContinue 2>$null}
    }
    return $result
}

Export-ModuleMember -Function *-E1*
