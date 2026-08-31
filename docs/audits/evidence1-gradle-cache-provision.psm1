Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:E1CacheProvisionFailures = @('none','preflight_failed','postflight_failed','config_invalid','attempt_exists',
    'warm_required','context_mismatch','donor_configuration','repository_dns','repository_address','network_restore_failed',
    'network_unsealed','network_connected','cache_busy','cache_empty','cache_limit','cache_changed','cache_destination',
    'wrapper_identity','wrapper_cache_missing','sdk_configuration','gradle_timeout','process_cleanup','gradle_failed',
    'offline_cache_miss','coverage_artifacts','diagnostic_limit','validation_overlap','guest_identity','evidence_changed','records_changed',
    'repo_commit','repo_tree','repo_root','repo_dirty','source_artifacts','source_artifact_limit','source_tracked_changed',
    'source_index_changed','live_overlap','ambient_credentials','environment_override','path_invalid','path_link',
    'path_outside_root','java_toolchain','git_failed','git_output_size','terminal_write_failed','result_shape')

function New-E1CacheProvisionReceipt([string]$Phase, [string]$ProvisionId) {
    return @{
        schema=1; operation='gradle-cache-provision'; provision_id=$ProvisionId; phase=$Phase
        state='failed'; failure_code='preflight_failed'; agent_calls=0; product_calls=0; live_records=0
        gradle_invocations=0; process=$null; cache=$null; gradle_signals=$null; offline_signals=$null; hashes=@{}
        checks=@{guest_identity=$false;source_custody=$false;records_unchanged=$false;postflight=$false;
            network_restored=$false;network_disconnected=$false}
    }
}

function ConvertTo-E1CacheProvisionReceipt($Raw) {
    try {
        $phase=Get-E1Field $Raw 'phase'; $id=Get-E1Field $Raw 'provision_id'
        if($phase -isnot [string] -or $phase -cnotin @('warm','certify') -or
            $id -isnot [string] -or $id -cnotmatch '^[a-f0-9]{32}$') {throw 'result_shape'}
        $safe=New-E1CacheProvisionReceipt $(if($phase -ceq 'warm'){'warm'}else{'certify'}) ([string]::Copy($id))
        $keys=@(Get-E1ObjectKeys $Raw | Where-Object {$_ -cnotin @('PSComputerName','RunspaceId','PSShowComputerName')})
        if($keys.Count -ne $safe.Count -or @($keys | Where-Object {$_ -cnotin @($safe.Keys)}).Count) {throw 'result_shape'}
        foreach($key in @('schema','operation','agent_calls','product_calls','live_records')) {
            if(-not (Test-E1Exact (Get-E1Field $Raw $key) $safe[$key])) {throw 'result_shape'}
        }
        $state=Get-E1Field $Raw 'state';$failure=Get-E1Field $Raw 'failure_code'
        if($state -isnot [string] -or $state -cnotin @('passed','failed') -or
            $failure -isnot [string] -or $failure -cnotin $script:E1CacheProvisionFailures -or
            (($state -ceq 'passed') -ne ($failure -ceq 'none'))) {throw 'result_shape'}
        $safe.state=if($state -ceq 'passed'){'passed'}else{'failed'}
        $safe.failure_code=@($script:E1CacheProvisionFailures | Where-Object {$_ -ceq $failure})[0]
        $calls=Get-E1Field $Raw 'gradle_invocations'
        if(-not (Test-E1Exact $calls 0) -and -not (Test-E1Exact $calls 1)) {throw 'result_shape'}
        $safe.gradle_invocations=if($calls -eq 1){1}else{0}
        $checks=Get-E1Field $Raw 'checks';Assert-E1Keys $checks @($safe.checks.Keys)
        foreach($key in @($safe.checks.Keys)) {
            $value=Get-E1Field $checks $key
            if($value -isnot [bool]) {throw 'result_shape'};$safe.checks[$key]=if($value){$true}else{$false}
        }
        $process=Get-E1Field $Raw 'process'
        if($null -ne $process) {
            $p=ConvertTo-E1ProcessObservation $process
            $safe.process=@{exit_code=([int]($p.exit_code+0));wall_seconds=([double]($p.wall_seconds+0));
                timed_out=$(if($p.timed_out){$true}else{$false});cleanup_ok=$(if($p.cleanup_ok){$true}else{$false})}
        }
        if($calls -eq 0 -and $null -ne $safe.process) {throw 'result_shape'}
        $cache=Get-E1Field $Raw 'cache'
        if($null -ne $cache) {
            Assert-E1Keys $cache @('file_count','bytes','sha256');$safe.cache=@{}
            foreach($key in @('file_count','bytes')) {
                $value=Get-E1Field $cache $key;$max=if($key -ceq 'file_count'){200000}else{17179869184L}
                if(($value -isnot [int] -and $value -isnot [long]) -or $value -lt 0 -or $value -gt $max) {throw 'result_shape'}
                $safe.cache[$key]=[long]($value+0)
            }
            $value=Get-E1Field $cache 'sha256'
            if($value -isnot [string] -or $value -cnotmatch '^[a-f0-9]{64}$') {throw 'result_shape'}
            $safe.cache.sha256=[string]::Copy($value)
        }
        if($phase -ceq 'warm' -and ($null -ne $cache -or $safe.checks.network_disconnected)) {throw 'result_shape'}
        $offline=Get-E1Field $Raw 'offline_signals'
        if($null -ne $offline) {
            Assert-E1Keys $offline @('offline_cache_miss');$value=Get-E1Field $offline 'offline_cache_miss'
            if(($value -isnot [int] -and $value -isnot [long]) -or $value -lt 0 -or $value -gt 100000) {throw 'result_shape'}
            $safe.offline_signals=@{offline_cache_miss=([int]($value+0))}
        }
        $gradle=Get-E1Field $Raw 'gradle_signals'
        if($null -ne $gradle) {
            Assert-E1ForensicGradleSummary $gradle
            $safe.gradle_signals=@{schema=(Get-E1Field $gradle 'schema');signals=@{}}
            $signals=Get-E1Field $gradle 'signals'
            foreach($key in Get-E1ObjectKeys $signals) {$safe.gradle_signals.signals[$key]=Get-E1Field $signals $key}
        }
        $hashes=Get-E1Field $Raw 'hashes'
        foreach($key in Get-E1ObjectKeys $hashes) {
            if($key -cnotin @('wet_marker_sha256','firewall_before_sha256','firewall_after_sha256','context_sha256',
                'wrapper_properties_sha256','wrapper_jar_sha256','java_executable_sha256','sdk_configuration_sha256',
                'sdk_build_tools_sha256','stdout_sha256','stderr_sha256','demo_coverage_sha256','prod_coverage_sha256',
                'records_metadata_before_sha256','records_metadata_after_sha256')) {throw 'result_shape'}
            $value=Get-E1Field $hashes $key
            if($value -isnot [string] -or $value -cnotmatch '^[a-f0-9]{64}$') {throw 'result_shape'};$safe.hashes[$key]=[string]::Copy($value)
        }
        if($safe.checks.network_restored -and (-not $safe.hashes.ContainsKey('firewall_before_sha256') -or
            -not $safe.hashes.ContainsKey('firewall_after_sha256') -or
            $safe.hashes.firewall_before_sha256 -cne $safe.hashes.firewall_after_sha256)) {throw 'result_shape'}
        if($state -ceq 'passed') {
            if($calls -ne 1 -or $null -eq $safe.process -or $safe.process.exit_code -ne 0 -or
                $safe.process.timed_out -or -not $safe.process.cleanup_ok -or $null -eq $safe.gradle_signals -or
                $null -eq $safe.offline_signals -or $safe.offline_signals.offline_cache_miss -ne 0 -or
                @($safe.checks.Keys | Where-Object {$_ -cne 'network_disconnected' -and -not $safe.checks[$_]}).Count -or
                ($phase -ceq 'certify' -and (-not $safe.checks.network_disconnected -or $null -eq $safe.cache -or $safe.cache.file_count -eq 0))) {throw 'result_shape'}
            foreach($key in @('wet_marker_sha256','context_sha256','java_executable_sha256','wrapper_properties_sha256',
                'wrapper_jar_sha256','sdk_configuration_sha256','sdk_build_tools_sha256','stdout_sha256','stderr_sha256',
                'records_metadata_before_sha256','records_metadata_after_sha256')) {
                if(-not $safe.hashes.ContainsKey($key)) {throw 'result_shape'}
            }
            if($safe.hashes.records_metadata_before_sha256 -cne $safe.hashes.records_metadata_after_sha256) {throw 'result_shape'}
            if($phase -ceq 'certify' -and (-not $safe.hashes.ContainsKey('demo_coverage_sha256') -or
                -not $safe.hashes.ContainsKey('prod_coverage_sha256'))) {throw 'result_shape'}
        }
        return $safe
    } catch {throw 'result_shape'}
}

function Write-E1CacheProvisionNew([string]$Path, $Value) {
    $null=Resolve-E1Path $Path
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try {Write-E1Record $stream $Value} finally {$stream.Dispose()}
}

function Assert-E1CacheProvisionLease($Config) {
    if(-not ('E1OfflineValidationLease' -as [type]) -or -not [E1OfflineValidationLease]::Owns($Config.LeaseToken)) {throw 'validation_overlap'}
}

function Get-E1CacheProvisionCoverage([string]$Source) {
    $hashes=@{}
    foreach($flavor in @('demo','prod')) {
        $reader=$null
        try {
            $path=Resolve-E1Path (Join-Path $Source ('core/domain/build/reports/coverage/test/'+$flavor+'/debug/report.xml'))
            $item=Get-Item -LiteralPath $path -ErrorAction Stop
            if($item.PSIsContainer -or $item.Length -eq 0 -or $item.Length -gt 8388608) {throw 'coverage_artifacts'}
            $settings=[Xml.XmlReaderSettings]::new()
            # JaCoCo emits a public DOCTYPE. Ignore it without resolving external resources.
            $settings.DtdProcessing=[Xml.DtdProcessing]::Ignore;$settings.XmlResolver=$null
            $settings.MaxCharactersInDocument=8388608
            $reader=[Xml.XmlReader]::Create($path,$settings)
            $null=$reader.MoveToContent()
            if($reader.LocalName -cne 'report' -or $reader.NamespaceURI -cne '') {throw 'coverage_artifacts'}
            while($reader.Read()) { }
            $hashes[$flavor+'_coverage_sha256']=Get-E1SourceFileHash $path 8388608
        } catch {throw 'coverage_artifacts'} finally {if($reader){$reader.Dispose()}}
    }
    return $hashes
}

function Assert-E1CacheProvisionDonor([string]$Donor) {
    Assert-E1ToolPath $Donor
    foreach($name in @('init.gradle','init.gradle.kts','init.d')) {
        if(Test-Path -LiteralPath (Join-Path $Donor $name)) {throw 'donor_configuration'}
    }
    $distribution=Join-Path $Donor 'wrapper/dists/gradle-9.4.0-bin/lcvyxq3t37f6mx9miaydrrgs/gradle-9.4.0'
    Assert-E1ToolPath $distribution
    if(Test-Path -LiteralPath (Join-Path $distribution 'gradle.properties')) {throw 'donor_configuration'}
    $init=Join-Path $distribution 'init.d';Assert-E1ToolPath $init
    if(Test-Path -LiteralPath $init) {
        foreach($entry in Get-ChildItem -LiteralPath $init -Force) {
            Assert-E1ToolPath $entry.FullName
            if($entry.PSIsContainer -or $entry.Extension -in @('.gradle','.kts')) {throw 'donor_configuration'}
        }
    }
    if($env:GRADLE_RO_DEP_CACHE -or ($env:GRADLE_USER_HOME -and [IO.Path]::GetFullPath($env:GRADLE_USER_HOME) -ine [IO.Path]::GetFullPath($Donor))) {throw 'donor_configuration'}
    $path=Join-Path $Donor 'gradle.properties';Assert-E1ToolPath $path
    if(Test-Path -LiteralPath $path) {
        if((Get-Item -LiteralPath $path).Length -gt 16384) {throw 'donor_configuration'}
        $seen=@{}
        foreach($line in ([IO.File]::ReadAllLines($path))) {
            $line=$line.Trim();if(-not $line -or $line.StartsWith('#') -or $line.StartsWith('!')) {continue}
            if($line -cnotmatch '^(org\.gradle\.(?:daemon|java\.installations\.auto-download))\s*=\s*false$' -or $seen.ContainsKey($Matches[1])) {throw 'donor_configuration'}
            $seen[$Matches[1]]=$true
        }
    }
}

function Get-E1CacheProvisionRepositories {
    $rows=@();$total=0
    foreach($hostName in @('dl.google.com','repo.maven.apache.org','plugins.gradle.org','plugins-artifacts.gradle.org')) {
        $addresses=@()
        foreach($type in @('A','AAAA')) {
            try {$answers=@(Resolve-DnsName -Name $hostName -Type $type -DnsOnly -QuickTimeout -ErrorAction Stop)} catch {$answers=@()}
            foreach($answer in $answers) {
                $value=Get-E1Field $answer 'IPAddress';if(-not $value) {continue}
                $ip=$null;if(-not [Net.IPAddress]::TryParse([string]$value,[ref]$ip)) {throw 'repository_address'}
                $bytes=$ip.GetAddressBytes()
                if($bytes.Length -eq 4) {
                    if($bytes[0] -in @(0,10,127) -or $bytes[0] -ge 224 -or
                        ($bytes[0] -eq 169 -and $bytes[1] -eq 254) -or ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
                        ($bytes[0] -eq 192 -and $bytes[1] -eq 168) -or ($bytes[0] -eq 100 -and $bytes[1] -ge 64 -and $bytes[1] -le 127)) {throw 'repository_address'}
                } elseif(($bytes[0] -band 224) -ne 32 -or $ip.ScopeId -ne 0 -or $ip.ToString().StartsWith('2001:db8:')) {throw 'repository_address'}
                $addresses+=$ip.ToString()
                if($addresses.Count -gt 32) {throw 'repository_address'}
            }
        }
        $addresses=@($addresses | Sort-Object -Unique)
        if(-not $addresses.Count) {throw 'repository_dns'}
        $total+=$addresses.Count;if($total -gt 64) {throw 'repository_address'}
        $rows+=@{host_name=$hostName;addresses=$addresses}
    }
    return ,$rows
}

function Invoke-E1CacheProvisionGuest($Config) {
    $phase=Get-E1Field $Config 'Phase';$id=Get-E1Field $Config 'ProvisionId'
    $valid=($phase -is [string] -and $phase -cin @('warm','certify') -and $id -is [string] -and $id -cmatch '^[a-f0-9]{32}$')
    $result=New-E1CacheProvisionReceipt $(if($valid){$phase}else{'warm'}) $(if($valid){$id}else{'0'*32})
    $source='C:\kmp-eval\NowInAndroid-evidence1-coverage-threshold-windows-stageb-v1'
    $harness='C:\kmp-eval\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1'
    $sourceCommit='7d45eae4f8720a0c77f507712ba2437ff974b6ed'
    $saved=@{};$records=$null;$sourceBefore=$null;$marker=$null;$sdk=$null;$baseline=$null
    $reserved=$false;$transaction=@{armed=$false};$ruleNames=@();$directory=$null;$operation=$null
    try {
        if(-not $valid) {throw 'config_invalid'}
        Assert-E1CacheProvisionLease $Config
        $identity=Get-CimInstance Win32_ComputerSystem
        $vmId=Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters' -Name VirtualMachineId
        Assert-E1GuestIdentity $env:COMPUTERNAME $Config.HostComputerName 'Evidence1Runner' $vmId $Config.VMId $identity.Manufacturer $identity.Model $env:USERNAME $Config.GuestUser
        $result.checks.guest_identity=$true
        Assert-E1ForensicSubject $Config.Report $Config.Commit $Config.Tree;Assert-E1Fields $Config.Report @{state='failed'}
        $markerPath='C:\kmp-eval\scratch\evidence1-validation-ops\wet-v2-'+$Config.Commit+'.json'
        $marker=Read-E1ForensicArtifact $markerPath '';Assert-E1ForensicMarker $marker.value $Config.Report
        $result.hashes.wet_marker_sha256=$marker.sha256
        Assert-E1OfflineQuiescent $source
        $operation=Resolve-E1Path ('C:\kmp-eval\scratch\gradle-cache-provision-'+$id)
        $directory=Join-Path $operation $phase
        if(Test-Path -LiteralPath $directory) {throw 'attempt_exists'}
        if($phase -ceq 'warm' -and (Test-Path -LiteralPath $operation)) {throw 'attempt_exists'}
        if($phase -ceq 'certify' -and -not (Test-Path -LiteralPath (Join-Path $operation 'warm.result.json'))) {throw 'warm_required'}
        if(Test-Path -LiteralPath (Join-Path $operation ($phase+'.started.json'))) {throw 'attempt_exists'}
        $null=New-Item -ItemType Directory -Path $directory
        $records=Get-E1RecordsSnapshot $harness
        $result.hashes.records_metadata_before_sha256=$records.sha256
        $null=Assert-E1Repo $harness $Config.Commit $Config.Tree $directory
        $sourceBefore=Get-E1SourceSnapshot $source $sourceCommit '' $directory
        $sdk=Get-E1OfflineSdk $source
        $result.hashes.sdk_configuration_sha256=$sdk.configuration_sha256;$result.hashes.sdk_build_tools_sha256=$sdk.build_tools_sha256
        $donor=Join-Path $env:USERPROFILE '.gradle';Assert-E1CacheProvisionDonor $donor
        $baseline=if($phase -ceq 'certify'){Get-E1OfflineDisconnectedHash}else{Get-E1OfflineFirewallHash}
        $result.hashes.firewall_before_sha256=$baseline
        $result.checks.network_disconnected=($phase -ceq 'certify')
        $binding=[ordered]@{provision_id=$id;commit=$Config.Commit;tree=$Config.Tree;vm_id=([guid]$Config.VMId).ToString();
            host_name=$Config.HostComputerName;guest_user=$Config.GuestUser;wet_marker_sha256=$marker.sha256;
            source_tree=$sourceBefore.tree;source_tracked_sha256=$sourceBefore.tracked_sha256;source_index_sha256=$sourceBefore.index_sha256;
            sdk_configuration_sha256=$sdk.configuration_sha256;sdk_build_tools_sha256=$sdk.build_tools_sha256;
            records_sha256=$records.sha256;firewall_sha256=$baseline}
        $bindingHash=Get-E1Sha256 ([Text.Encoding]::UTF8.GetBytes(($binding | ConvertTo-Json -Compress)))
        $result.hashes.context_sha256=$bindingHash
        if($phase -ceq 'certify') {
            $warm=ConvertTo-E1CacheProvisionReceipt (Read-E1Json (Join-Path $operation 'warm.result.json')).value
            if($warm.phase -cne 'warm' -or $warm.provision_id -cne $id -or $warm.state -cne 'passed') {throw 'warm_required'}
            $context=(Read-E1Json (Join-Path $operation 'warm.started.json')).value
            if($warm.hashes.context_sha256 -cne $bindingHash -or $context.context_sha256 -cne $bindingHash) {throw 'context_mismatch'}
        }
        foreach($name in @('GRADLE_USER_HOME','GRADLE_OPTS','ANDROID_HOME','ANDROID_SDK_ROOT','TEMP','TMP','GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM')) {
            $saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process')
        }
        $env:ANDROID_HOME=$sdk.root;$env:ANDROID_SDK_ROOT=$sdk.root;$env:TEMP=$directory;$env:TMP=$directory
        $env:GIT_CONFIG_NOSYSTEM='1';$env:GIT_CONFIG_GLOBAL=Join-Path $directory 'empty-git-config'
        [IO.File]::WriteAllText($env:GIT_CONFIG_GLOBAL,'',[Text.UTF8Encoding]::new($false))
        $copy=Join-Path $directory 'source'
        $null=Invoke-E1Git $source @('-c','core.hooksPath=NUL','clone','--no-local','--no-checkout','--',$source,$copy) $directory
        $null=Invoke-E1Git $copy @('-c','core.hooksPath=NUL','checkout','--detach',$sourceCommit) $directory
        $null=Assert-E1Repo $copy $sourceCommit $sourceBefore.tree $directory
        [IO.File]::WriteAllText((Join-Path $copy 'local.properties'),('sdk.dir='+$sdk.root.Replace('\','/')+"`n"),[Text.UTF8Encoding]::new($false))
        $wrapper=Join-Path $copy 'gradle/wrapper/gradle-wrapper.properties';$wrapperJar=Join-Path $copy 'gradle/wrapper/gradle-wrapper.jar'
        $wrapperText=[IO.File]::ReadAllText($wrapper)
        if($wrapperText -cnotmatch '(?m)^distributionUrl=https\\://services\.gradle\.org/distributions/gradle-9\.4\.0-bin\.zip\s*$' -or
            $wrapperText -cnotmatch '(?m)^distributionSha256Sum=60ea723356d81263e8002fec0fcf9e2b0eee0c0850c7a3d7ab0a63f2ccc601f3\s*$') {throw 'wrapper_identity'}
        $result.hashes.wrapper_properties_sha256=Get-E1SourceFileHash $wrapper 16384
        $result.hashes.wrapper_jar_sha256=Get-E1SourceFileHash $wrapperJar 1048576
        # The operation marker is immutable. Only separate terminal files are written later.
        $repositories=if($phase -ceq 'warm'){Get-E1CacheProvisionRepositories}else{@()}
        if($phase -ceq 'warm') {
            $ruleNames=@(0..3 | ForEach-Object {'E1CacheProvision-'+$id+'-'+$_})
            foreach($name in $ruleNames) {if(Get-NetFirewallRule -Name $name -PolicyStore ActiveStore -ErrorAction SilentlyContinue) {throw 'attempt_exists'}}
        }
        Write-E1CacheProvisionNew (Join-Path $operation ($phase+'.started.json')) @{schema=1;phase=$phase;context_sha256=$bindingHash;binding=$binding;rule_names=$ruleNames;repositories=$repositories}
        $reserved=$true
        $home=$donor
        if($phase -ceq 'certify') {
            $home=Join-Path $directory 'gradle-home';$result.cache=Copy-E1OfflineCache $donor $home
            Assert-E1OfflineQuiescent $source
        }
        Assert-E1OfflineWrapper $home
        $env:GRADLE_USER_HOME=$home;$env:GRADLE_OPTS='-Dorg.gradle.daemon=false'
        Invoke-E1Java21Environment $directory {
            param($java)
            $result.hashes.java_executable_sha256=Get-E1SourceFileHash $java.executable 16777216
            Assert-E1CacheProvisionLease $Config;Assert-E1OfflineQuiescent $source
            if($phase -ceq 'certify') {
                if((Get-E1OfflineDisconnectedHash) -cne $baseline -or $warm.hashes.java_executable_sha256 -cne $result.hashes.java_executable_sha256) {throw 'context_mismatch'}
            } else {
                if((Get-E1OfflineFirewallHash) -cne $baseline) {throw 'evidence_changed'}
                # Arm cleanup before the first cmdlet: a throwing creation can still have side effects.
                $transaction.armed=$true
                for($i=0;$i -lt $ruleNames.Count;$i++) {
                    $null=New-NetFirewallRule -Name $ruleNames[$i] -DisplayName $ruleNames[$i] -Group ('E1CacheProvision-'+$id) -PolicyStore PersistentStore -Direction Outbound -Action Allow -Enabled True -Profile Any -Program $java.executable -Protocol TCP -RemotePort 443 -RemoteAddress $repositories[$i].addresses -ErrorAction Stop
                }
            }
            $arguments=@('-Dorg.gradle.daemon=false','-Dorg.gradle.java.installations.auto-download=false',
                '-classpath',$wrapperJar,'org.gradle.wrapper.GradleWrapperMain',':core:domain:test',
                ':core:domain:createDemoDebugUnitTestCoverageReport',':core:domain:createProdDebugUnitTestCoverageReport',
                '--no-daemon','--no-build-cache','--no-configuration-cache','--console=plain','--stacktrace')
            $timeout=600;if($phase -ceq 'certify') {$arguments+='--offline';$timeout=300}
            $stdout=Join-Path $directory 'gradle.stdout.txt';$stderr=Join-Path $directory 'gradle.stderr.txt'
            $result.gradle_invocations=1
            $p=Invoke-E1OwnedProcess $java.executable $arguments $copy $stdout $stderr $timeout
            $result.process=ConvertTo-E1ProcessObservation @{exit_code=$p.ExitCode;wall_seconds=$p.WallSeconds;timed_out=$p.TimedOut;cleanup_ok=$p.CleanupOk}
            $text=''
            foreach($log in @($stdout,$stderr)) {
                if((Get-Item -LiteralPath $log).Length -gt 1048576) {throw 'diagnostic_limit'}
                $text += [Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes($log))+"`n"
            }
            if($text.Length -gt 1048576) {throw 'diagnostic_limit'}
            $result.hashes.stdout_sha256=Get-E1SourceFileHash $stdout 1048576;$result.hashes.stderr_sha256=Get-E1SourceFileHash $stderr 1048576
            $result.gradle_signals=Get-E1ForensicGradleSummary $text;$result.offline_signals=Get-E1OfflineSignals $text
            if($p.TimedOut) {throw 'gradle_timeout'}
            if(-not $p.CleanupOk) {throw 'process_cleanup'}
            if($result.offline_signals.offline_cache_miss -gt 0) {throw 'offline_cache_miss'}
            if($p.ExitCode -ne 0) {throw 'gradle_failed'}
            if($phase -ceq 'certify') {
                $coverage=Get-E1CacheProvisionCoverage $copy
                foreach($key in $coverage.Keys) {$result.hashes[$key]=$coverage[$key]}
            }
            $result.state='passed';$result.failure_code='none'
        }
    } catch {
        $result.state='failed';$code=$_.Exception.Message
        $result.failure_code=if($code -cin $script:E1CacheProvisionFailures -and $code -cne 'none'){$code}else{Get-E1FailureCode $_ 'preflight_failed'}
        if($result.failure_code -cnotin $script:E1CacheProvisionFailures) {$result.failure_code='preflight_failed'}
    } finally {
        $cleanupFailed=$false
        if($transaction.armed) {
            foreach($name in $ruleNames) {
                try {
                    if(Get-NetFirewallRule -Name $name -PolicyStore PersistentStore -ErrorAction SilentlyContinue) {
                        Remove-NetFirewallRule -Name $name -PolicyStore PersistentStore -ErrorAction Stop | Out-Null
                    }
                } catch {$cleanupFailed=$true}
            }
        }
        if($baseline) {
            try {
                foreach($name in $ruleNames) {if($transaction.armed -and (Get-NetFirewallRule -Name $name -PolicyStore PersistentStore -ErrorAction SilentlyContinue)) {throw 'network_restore_failed'}}
                $after=if($phase -ceq 'certify'){Get-E1OfflineDisconnectedHash}else{Get-E1OfflineFirewallHash}
                $result.hashes.firewall_after_sha256=$after
                if($cleanupFailed -or $after -cne $baseline) {throw 'network_restore_failed'}
                $result.checks.network_restored=$true
            } catch {$result.state='failed';$result.failure_code='network_restore_failed'}
        }
        foreach($name in $saved.Keys) {[Environment]::SetEnvironmentVariable($name,$saved[$name],'Process')}
        if($records) {
            try {
                $afterRecords=Get-E1RecordsSnapshot $harness;$result.hashes.records_metadata_after_sha256=$afterRecords.sha256
                if($afterRecords.sha256 -cne $records.sha256) {throw 'records_changed'}
                $result.checks.records_unchanged=$true
                if($sourceBefore) {
                    Assert-E1SourcePostflight $source $sourceCommit $sourceBefore.tree $directory $sourceBefore -Operation 'dry-v3'
                    $result.checks.source_custody=$true
                }
                $null=Assert-E1Repo $harness $Config.Commit $Config.Tree $directory
                $null=Read-E1ForensicArtifact $markerPath $marker.sha256
                if($sdk) {
                    $sdkAfter=Get-E1OfflineSdk $source
                    if($sdkAfter.configuration_sha256 -cne $sdk.configuration_sha256 -or $sdkAfter.build_tools_sha256 -cne $sdk.build_tools_sha256) {throw 'evidence_changed'}
                }
                Assert-E1OfflineQuiescent $source;Assert-E1CacheProvisionLease $Config
                $result.checks.postflight=$result.checks.network_restored -and $result.checks.source_custody
            } catch {
                $result.state='failed'
                if($result.failure_code -cne 'network_restore_failed') {
                    $code=$_.Exception.Message
                    $result.failure_code=if($code -cin $script:E1CacheProvisionFailures -and $code -cne 'none'){$code}else{'postflight_failed'}
                }
            }
        }
        if($reserved) {
            try {Write-E1CacheProvisionNew (Join-Path $operation ($phase+'.result.json')) (ConvertTo-E1CacheProvisionReceipt $result)}
            catch {$result.state='failed';$result.failure_code='terminal_write_failed'}
        }
    }
    return ConvertTo-E1CacheProvisionReceipt $result
}

function Get-E1ProvisionConnectionSummary([string]$Text,$Repositories) {
    $result=@{socket_permission=0;connect_exception=0;ipv4_listed=0;ipv4_unlisted=0;ipv6_listed=0;ipv6_unlisted=0;
        google=0;maven=0;plugin_portal=0;plugin_artifacts=0;redirect_google=0;daemon_fork=0}
    $patterns=@{socket_permission='(?i)(?:SocketException|ConnectException): Permission denied';
        connect_exception='(?:HttpHostConnectException|ConnectException):';google='https://dl\.google\.com/';
        maven='https://repo\.maven\.apache\.org/';plugin_portal='https://plugins\.gradle\.org/';
        plugin_artifacts='https://plugins-artifacts\.gradle\.org/';redirect_google='https://(?:dl\.googleusercontent\.com|redirector\.gvt1\.com)/';
        daemon_fork='(?i)single-use Daemon process'}
    foreach($key in $patterns.Keys) {$result[$key]=[regex]::Matches($Text,$patterns[$key]).Count}
    $allowed=@($Repositories | ForEach-Object {$_.addresses} | ForEach-Object {[Net.IPAddress]::Parse($_).ToString()})
    # Only IP literals attached to a hostname by Java's InetAddress formatter are counted.
    foreach($match in [regex]::Matches($Text,'/[\[]?(?<ip>(?:[0-9]{1,3}\.){3}[0-9]{1,3}|[0-9a-fA-F]*:[0-9a-fA-F:]+)')) {
        $ip=$null;if(-not [Net.IPAddress]::TryParse($match.Groups['ip'].Value,[ref]$ip)){continue}
        $family=if($ip.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork){'ipv4'}else{'ipv6'}
        $relation=if($allowed -contains $ip.ToString()){'listed'}else{'unlisted'}
        $result[$family+'_'+$relation]++
    }
    return $result
}

function Read-E1CacheProvisionGuest($Config) {
    Assert-E1CacheProvisionLease $Config
    Assert-E1OfflineQuiescent 'C:\kmp-eval\NowInAndroid-evidence1-coverage-threshold-windows-stageb-v1'
    $root=Resolve-E1Path ('C:\kmp-eval\scratch\gradle-cache-provision-'+$Config.ProvisionId)
    $receipt=ConvertTo-E1CacheProvisionReceipt (Read-E1Json (Join-Path $root 'warm.result.json')).value
    if($receipt.phase -cne 'warm' -or $receipt.provision_id -cne $Config.ProvisionId -or
        $receipt.hashes.context_sha256 -cne $Config.Warm.hashes.context_sha256){throw 'context_mismatch'}
    $journal=(Read-E1Json (Join-Path $root 'warm.started.json')).value
    if($journal.context_sha256 -cne $receipt.hashes.context_sha256){throw 'context_mismatch'}
    $text=''
    foreach($stream in @('stdout','stderr')) {
        $hash=Get-E1Field $Config.Warm.hashes ($stream+'_sha256')
        if($hash -cne (Get-E1Field $receipt.hashes ($stream+'_sha256'))){throw 'context_mismatch'}
        $path=Resolve-E1Path (Join-Path $root ('warm/gradle.'+$stream+'.txt'))
        $file=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        try {
            if($file.Length -gt 1048576){throw 'diagnostic_limit'}
            $bytes=[byte[]]::new([int]$file.Length);$offset=0
            while($offset -lt $bytes.Length){$n=$file.Read($bytes,$offset,$bytes.Length-$offset);if($n -eq 0){throw 'evidence_changed'};$offset+=$n}
            if((Get-E1Sha256 $bytes) -cne $hash){throw 'evidence_changed'}
            $text+=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)+"`n"
        } finally {$file.Dispose()}
    }
    $summary=Get-E1ProvisionConnectionSummary $text $journal.repositories
    $summary.firewall_unchanged=((Get-E1OfflineFirewallHash) -ceq $receipt.hashes.firewall_after_sha256)
    $summary.recorded_addresses=@($journal.repositories | ForEach-Object {$_.addresses}).Count
    $summary.remaining_owned_rules=@(Get-NetFirewallRule -PolicyStore ActiveStore | Where-Object {$_.Name -like ('E1CacheProvision-'+$Config.ProvisionId+'-*')}).Count
    $summary.explicit_outbound_blocks=@(Get-NetFirewallRule -PolicyStore ActiveStore | Where-Object {$_.Enabled.ToString() -eq 'True' -and $_.Direction.ToString() -eq 'Outbound' -and $_.Action.ToString() -eq 'Block'}).Count
    Assert-E1OfflineQuiescent 'C:\kmp-eval\NowInAndroid-evidence1-coverage-threshold-windows-stageb-v1'
    return $summary
}

Export-ModuleMember -Function Invoke-E1CacheProvisionGuest,ConvertTo-E1CacheProvisionReceipt,Read-E1CacheProvisionGuest
