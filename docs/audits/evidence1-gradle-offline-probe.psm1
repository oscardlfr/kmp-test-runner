Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:E1OfflineNetworkFailures = @('network_profile_count','network_profile_disabled','network_outbound_default',
    'network_seal_contract','network_endpoint_missing','network_endpoint_invalid','network_rule_tcp','network_rule_udp','network_rule_any',
    'network_rule_proximity_apps','network_rule_proximity_sharing','network_rule_wifi_printing','network_rule_wifi_display','network_rule_wifi_devices','network_rule_dynamic_unknown')
$script:E1OfflineNetworkFailures += @('network_rule_any_loopback','network_rule_any_all_addresses','network_rule_any_scoped_addresses')

function Get-E1OfflineSignals([string]$Text) {
    return @{ offline_cache_miss = [regex]::Matches($Text, '(?m)^.*No cached (?:version of |resource )[^\r\n]+ available for offline mode').Count }
}

function Test-E1OfflineCacheRelativePath([string]$RelativePath) {
    if ($RelativePath -cmatch '[\\:]|//|/$|(?:^|/)\.{1,2}(?:/|$)' -or
        $RelativePath -cnotmatch '^(?:caches/modules-2|wrapper/dists/gradle-9\.4\.0-bin)/[^/].*' -or
        $RelativePath -imatch '(?:\.lock|\.lck|/gc\.properties)$|/init\.d/.*\.gradle(?:\.kts)?$') { return $false }
    return $true
}

function Get-E1OfflineCacheFiles([string]$Source) {
    Assert-E1ToolPath $Source
    $sourceFull = [IO.Path]::GetFullPath($Source).TrimEnd('\','/')
    $rows = [Collections.Generic.List[object]]::new()
    $bytes = 0L
    foreach ($relative in @('caches/modules-2','wrapper/dists/gradle-9.4.0-bin')) {
        $path = Join-Path $sourceFull $relative
        Assert-E1ToolPath $path
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $pending = [Collections.Generic.Queue[string]]::new(); $pending.Enqueue($path)
        while ($pending.Count) {
            foreach ($entry in Get-ChildItem -LiteralPath $pending.Dequeue() -Force) {
                Assert-E1ToolPath $entry.FullName
                if ($entry.PSIsContainer) { $pending.Enqueue($entry.FullName); continue }
                $name = $entry.FullName.Substring($sourceFull.Length + 1).Replace('\','/')
                if (-not (Test-E1OfflineCacheRelativePath $name)) { continue }
                $bytes += $entry.Length
                if ($rows.Count -ge 200000 -or $bytes -gt 17179869184L) { throw 'cache_limit' }
                $rows.Add(@{ name=$name; path=$entry.FullName; bytes=$entry.Length; modified=$entry.LastWriteTimeUtc.Ticks })
            }
        }
    }
    return ,@($rows | Sort-Object { $_.name } -CaseSensitive)
}

function Copy-E1OfflineCache([string]$Source, [string]$Destination) {
    Assert-E1ToolPath $Destination
    $sourceFull = [IO.Path]::GetFullPath($Source).TrimEnd('\','/')
    $destinationFull = [IO.Path]::GetFullPath($Destination).TrimEnd('\','/')
    if ($destinationFull -ieq $sourceFull -or $destinationFull.StartsWith($sourceFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
        (Test-Path -LiteralPath $Destination)) { throw 'cache_destination' }
    $rows = Get-E1OfflineCacheFiles $Source
    if ($rows.Count -eq 0) { throw 'cache_empty' }
    New-Item -ItemType Directory -Path $Destination | Out-Null
    $hashRows = [Collections.Generic.List[string]]::new(); $bytes = 0L
    foreach ($row in $rows) {
        $target = Join-Path $Destination $row.name
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Assert-E1ToolPath $row.path
        $inputStream = [IO.File]::Open($row.path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $outputStream = $null; $hash = [Security.Cryptography.SHA256]::Create()
        try {
            if ($inputStream.Length -ne $row.bytes) { throw 'cache_changed' }
            $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $inputStream.CopyTo($outputStream); $outputStream.Dispose(); $outputStream = $null
            $inputStream.Position = 0
            $digest = -join ($hash.ComputeHash($inputStream) | ForEach-Object { $_.ToString('x2') })
            if ((Get-E1SourceFileHash $target 17179869184L) -cne $digest) { throw 'cache_changed' }
            $hashRows.Add($row.name + '|' + $row.bytes + '|' + $digest); $bytes += $row.bytes
        } finally { if ($outputStream) { $outputStream.Dispose() }; $inputStream.Dispose(); $hash.Dispose() }
    }
    $after = Get-E1OfflineCacheFiles $Source
    if ($after.Count -ne $rows.Count) { throw 'cache_changed' }
    for ($i=0; $i -lt $rows.Count; $i++) {
        foreach ($key in @('name','bytes','modified')) { if ($rows[$i][$key] -cne $after[$i][$key]) { throw 'cache_changed' } }
    }
    return @{ file_count=$rows.Count; bytes=$bytes; sha256=(Get-E1Sha256 ([Text.Encoding]::UTF8.GetBytes(($hashRows -join "`n")))) }
}

function Get-E1OfflineSealHash {
    $profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore | Sort-Object Name)
    if ($profiles.Count -ne 3) {throw 'network_profile_count'}
    if (@($profiles | Where-Object { $_.Enabled.ToString() -ne 'True' }).Count) {throw 'network_profile_disabled'}
    if (@($profiles | Where-Object { $_.DefaultOutboundAction.ToString() -ne 'Block' }).Count) {throw 'network_outbound_default'}
    $rules = @(Get-NetFirewallRule -PolicyStore ActiveStore | Where-Object { $_.Enabled.ToString() -eq 'True' -and $_.Direction.ToString() -eq 'Outbound' } | Sort-Object Name)
    $seal=Read-E1Json 'C:\kmp-eval\scratch\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1\NETWORK-SEAL.json'
    try {Assert-E1Fields $seal.value @{verdict='PASS';network_mode='restricted'}} catch {throw 'network_seal_contract'}
    $allowedAddresses=@()
    foreach($hostName in @('api.anthropic.com','platform.claude.com','claude.ai','claude.com')) {
        $addresses=Get-E1Field (Get-E1Field $seal.value 'allowed_resolved_ips_by_host') $hostName
        if(-not $addresses) {throw 'network_endpoint_missing'}
        foreach($address in $addresses) {
            $ip=$null
            if(-not [Net.IPAddress]::TryParse([string]$address,[ref]$ip)) {throw 'network_endpoint_invalid'}
            $allowedAddresses += $ip.ToString()
        }
    }
    $ruleRows=@()
    foreach($rule in $rules) {
        $app=$rule | Get-NetFirewallApplicationFilter
        $port=$rule | Get-NetFirewallPortFilter
        $address=$rule | Get-NetFirewallAddressFilter
        $service=$rule | Get-NetFirewallServiceFilter
        # Other application-specific Windows service rules do not authorize this
        # Java process. Broad or Java rules must stay inside DNS/Claude endpoints.
        $unpackaged=([string]::IsNullOrEmpty([string]$app.Package) -or $app.Package -eq 'Any')
        $nonService=([string]::IsNullOrEmpty([string]$service.Service) -or $service.Service -eq 'Any')
        if($rule.Action.ToString() -eq 'Allow' -and $unpackaged -and $nonService -and ($app.Program -eq 'Any' -or $app.Program -imatch '(?:^|[\\/])javaw?\.exe$')) {
            $protocol=[string]$port.Protocol
            if($protocol -in @('Any','TCP','6','UDP','17')) {
                $ports=@($port.RemotePort)
                $dns=($protocol -ne 'Any' -and $ports.Count -eq 1 -and $ports[0] -eq '53')
                $claude=($protocol -in @('TCP','6') -and $ports.Count -eq 1 -and $ports[0] -eq '443' -and @($address.RemoteAddress).Count -gt 0)
                foreach($remote in @($address.RemoteAddress)) {
                    $ip=$null
                    if(-not [Net.IPAddress]::TryParse([string]$remote,[ref]$ip) -or $ip.ToString() -notin $allowedAddresses) {$claude=$false}
                }
                if(-not $dns -and -not $claude) {
                    $dynamic=[string](Get-E1Field $port 'DynamicTarget')
                    if($dynamic -and $dynamic -ne 'Any') {
                        switch -CaseSensitive ($dynamic) {
                            'ProximityApps' {throw 'network_rule_proximity_apps'}
                            'ProximitySharing' {throw 'network_rule_proximity_sharing'}
                            'WifiDirectPrinting' {throw 'network_rule_wifi_printing'}
                            'WifiDirectDisplay' {throw 'network_rule_wifi_display'}
                            'WifiDirectDevices' {throw 'network_rule_wifi_devices'}
                            default {throw 'network_rule_dynamic_unknown'}
                        }
                    }
                    if($protocol -in @('TCP','6')) {throw 'network_rule_tcp'}
                    if($protocol -in @('UDP','17')) {throw 'network_rule_udp'}
                    $remotes=@($address.RemoteAddress)
                    if($remotes.Count -eq 1 -and $remotes[0] -eq 'Any') {throw 'network_rule_any_all_addresses'}
                    $loopback=($remotes.Count -gt 0)
                    foreach($remote in $remotes) {
                        $ip=$null
                        if(-not [Net.IPAddress]::TryParse([string]$remote,[ref]$ip) -or -not [Net.IPAddress]::IsLoopback($ip)) {$loopback=$false}
                    }
                    if($loopback) {throw 'network_rule_any_loopback'}
                    throw 'network_rule_any_scoped_addresses'
                }
            }
        }
        $ruleRows+=@{name=$rule.Name;action=[string]$rule.Action;profile=[string]$rule.Profile;program=$app.Program;package=$app.Package;
            protocol=[string]$port.Protocol;dynamic_target=(Get-E1Field $port 'DynamicTarget');local_port=@($port.LocalPort);remote_port=@($port.RemotePort);
            local_address=@($address.LocalAddress);remote_address=@($address.RemoteAddress);service=$service.Service}
    }
    $snapshot = @{ profiles=@($profiles | Select-Object Name,Enabled,DefaultOutboundAction); rules=$ruleRows; seal_sha256=$seal.sha256 }
    return Get-E1Sha256 ([Text.Encoding]::UTF8.GetBytes(($snapshot | ConvertTo-Json -Depth 6 -Compress)))
}

function Get-E1OfflineScopeCategory($Value) {
    $values=@($Value)
    if($values.Count -eq 0 -or ($values.Count -eq 1 -and [string]::IsNullOrEmpty([string]$values[0]))) {return 'unknown'}
    if($values.Count -eq 1 -and [string]$values[0] -ieq 'Any') {return 'any'}
    $loopback=$true
    foreach($item in $values) {
        $ip=$null
        if(-not [Net.IPAddress]::TryParse([string]$item,[ref]$ip) -or -not [Net.IPAddress]::IsLoopback($ip)) {$loopback=$false}
    }
    if($loopback) {return 'loopback'}
    return 'scoped'
}

function Get-E1OfflineScopeEnums {
    $scope=@('any','scoped','loopback','unknown')
    return @{
        action=@('allow','block'); program=@('any','java','javaw'); profile_match=@('active','inactive','unknown')
        enforcement=@('full','other','unknown','multiple','notapplicable','invalid','firewalloffinprofile','categoryoff','disabledobject',
            'inactiveprofile','localaddressresolutionempty','remoteaddressresolutionempty','localportresolutionempty','remoteportresolutionempty',
            'interfaceresolutionempty','applicationresolutionempty','remotemachineempty','remoteuserempty','localglobalopenportsdisallowed',
            'localauthorizedapplicationsdisallowed','localfirewallrulesdisallowed','localconsecrulesdisallowed','nottargetplatform','optimizedout',
            'localuserempty','transportmachinesempty','tunnelmachinesempty','tupleresolutionempty') + @(0..23 | ForEach-Object {"native-$_"})
        dynamic_target=@('any','scoped','unknown')
        local_address=$scope; remote_address=$scope; local_port=$scope; remote_port=$scope
        interface_alias=$scope; interface_type=@('any','wired','wireless','remoteaccess','unknown')
        authentication=@('notrequired','required','noencap','unknown'); encryption=@('notrequired','required','dynamic','unknown')
        override_block_rules=@('true','false','unknown'); local_user=$scope; remote_user=$scope; remote_machine=$scope
        local_user_owner=$scope; policy_app_id=$scope
    }
}

function Get-E1OfflineEnforcementKind($Value) {
    $values=@($Value)
    if($values.Count -eq 0) {return 'unknown'}
    if($values.Count -ne 1) {return 'multiple'}
    $valueText=([string]$values[0]).ToLowerInvariant()
    if($valueText -cmatch '^(?:[0-9]|1[0-9]|2[0-3])$') {return "native-$valueText"}
    if($valueText -cin (Get-E1OfflineScopeEnums).enforcement) {return $valueText}
    return 'unknown'
}

function ConvertTo-E1OfflineRuleScope($Raw) {
    Assert-E1Keys $Raw @('rules')
    $rules=Get-E1Field $Raw 'rules'
    if($rules -isnot [System.Collections.IList] -or $rules.Count -gt 128) {throw 'result_shape'}
    $enums=Get-E1OfflineScopeEnums; $safe=@{rules=@()}
    foreach($rule in $rules) {
        Assert-E1Keys $rule (@($enums.Keys) + @('enforcement_states')); $row=@{}
        foreach($key in $enums.Keys) {
            $value=Get-E1Field $rule $key
            if($value -isnot [string] -or $value -cnotin $enums[$key]) {throw 'result_shape'}
            $row[$key]=$value
        }
        $states=Get-E1Field $rule 'enforcement_states'
        if($states -isnot [System.Collections.IList] -or $states.Count -gt 24) {throw 'result_shape'}
        $row.enforcement_states=@()
        foreach($state in $states) {
            if($state -isnot [string] -or $state -cnotin $enums.enforcement) {throw 'result_shape'}
            $row.enforcement_states+=,$state
        }
        $safe.rules+=,$row
    }
    return $safe
}

function Get-E1OfflineNetworkRuleScope {
    $active=@(Get-NetConnectionProfile | ForEach-Object {
        switch([string]$_.NetworkCategory) {'DomainAuthenticated' {'Domain'} 'Private' {'Private'} 'Public' {'Public'}}
    })
    $rules=@(Get-NetFirewallRule -PolicyStore ActiveStore | Where-Object {
        $_.Enabled.ToString() -eq 'True' -and $_.Direction.ToString() -eq 'Outbound' -and $_.Action.ToString() -in @('Allow','Block')
    } | Sort-Object Name)
    $rows=@(); $enums=Get-E1OfflineScopeEnums
    foreach($rule in $rules) {
        $app=$rule | Get-NetFirewallApplicationFilter
        $service=$rule | Get-NetFirewallServiceFilter
        if(-not ([string]::IsNullOrEmpty([string]$app.Package) -or $app.Package -eq 'Any') -or
            -not ([string]::IsNullOrEmpty([string]$service.Service) -or $service.Service -eq 'Any')) {continue}
        $program=switch -Regex ([string]$app.Program) {'^Any$' {'any'} '(?:^|[\\/])java\.exe$' {'java'} '(?:^|[\\/])javaw\.exe$' {'javaw'}}
        if(-not $program) {continue}
        $port=$rule | Get-NetFirewallPortFilter
        if([string]$port.Protocol -ne 'Any') {continue}
        $address=$rule | Get-NetFirewallAddressFilter
        $iface=$rule | Get-NetFirewallInterfaceFilter
        $ifaceType=$rule | Get-NetFirewallInterfaceTypeFilter
        $security=$rule | Get-NetFirewallSecurityFilter
        $profiles=@(([string]$rule.Profile).Split(',') | ForEach-Object {$_.Trim()})
        $profileMatch='unknown'
        if($active.Count -gt 0 -and @($profiles | Where-Object {$_ -notin @('Any','Domain','Private','Public')}).Count -eq 0) {
            $profileMatch='inactive'
            if('Any' -in $profiles -or @($profiles | Where-Object {$_ -in $active}).Count -gt 0) {$profileMatch='active'}
        }
        $row=@{action=([string]$rule.Action).ToLowerInvariant();program=$program;profile_match=$profileMatch;enforcement='unknown'}
        $nativeStates=Get-E1Field $rule 'EnforcementStatus'
        $row.enforcement=Get-E1OfflineEnforcementKind $nativeStates
        $row.enforcement_states=@(foreach($state in $nativeStates) {Get-E1OfflineEnforcementKind $state})
        foreach($mapping in @(@('local_address',$address.LocalAddress),@('remote_address',$address.RemoteAddress),
            @('local_port',$port.LocalPort),@('remote_port',$port.RemotePort),@('interface_alias',$iface.InterfaceAlias),
            @('local_user',$security.LocalUser),@('remote_user',$security.RemoteUser),@('remote_machine',$security.RemoteMachine),
            @('local_user_owner',(Get-E1Field $rule 'Owner')),@('policy_app_id',(Get-E1Field $rule 'PolicyAppId')),
            @('dynamic_target',(Get-E1Field $port 'DynamicTarget')))) {
            $row[$mapping[0]]=Get-E1OfflineScopeCategory $mapping[1]
        }
        foreach($mapping in @(@('interface_type',$ifaceType.InterfaceType),@('authentication',$security.Authentication),
            @('encryption',$security.Encryption),@('override_block_rules',$security.OverrideBlockRules))) {
            $value=([string]$mapping[1]).ToLowerInvariant()
            $row[$mapping[0]]=if($value -cin $enums[$mapping[0]]) {$value} else {'unknown'}
        }
        $rows+=,$row
        if($rows.Count -gt 128) {throw 'diagnostic_limit'}
    }
    return ConvertTo-E1OfflineRuleScope @{rules=$rows}
}

function New-E1OfflineReceipt {
    return @{ schema=1; operation='gradle-offline-cache-probe'; state='failed'; failure_code='probe_failed'
        stage='preflight'; conclusion='inconclusive'; agent_calls=0; product_invocations=0; gradle_invocations=0
        live_records_created=$null; validation_pass=$false; firewall_modified=$false; original_home_used_for_gradle=$false
        process=$null; cache=$null; offline_signals=$null; gradle_signals=$null; hashes=@{}
        checks=@{ guest_identity=$false; network_sealed=$false; source_custody=$false; postflight=$false } }
}

function Invoke-E1OfflineNetworkAuditGuest($Config) {
    $result=New-E1OfflineReceipt
    $result.operation='gradle-offline-network-audit'
    $result.schema=2; $result.network_rule_scope=$null
    try {
        $identity=Get-CimInstance Win32_ComputerSystem
        $vmId=Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters' -Name VirtualMachineId
        Assert-E1GuestIdentity $env:COMPUTERNAME $Config.HostComputerName 'Evidence1Runner' $vmId $Config.VMId $identity.Manufacturer $identity.Model $env:USERNAME $Config.GuestUser
        $result.checks.guest_identity=$true
        Assert-E1ForensicSubject $Config.Report $Config.Commit $Config.Tree
        Assert-E1Fields $Config.Report @{state='failed'}
        $path='C:\kmp-eval\scratch\evidence1-validation-ops\wet-v2-' + $Config.Commit + '.json'
        $marker=Read-E1ForensicArtifact $path ''
        Assert-E1ForensicMarker $marker.value $Config.Report
        $result.hashes.wet_marker_sha256=$marker.sha256
        $result.network_rule_scope=Get-E1OfflineNetworkRuleScope
        $result.hashes.network_seal_sha256=Get-E1OfflineSealHash
        $result.checks.network_sealed=$true
        $null=Read-E1ForensicArtifact $path $marker.sha256
        if((Get-E1OfflineSealHash) -cne $result.hashes.network_seal_sha256) {throw 'evidence_changed'}
        $result.checks.postflight=$true
        $result.state='passed'; $result.failure_code='none'
    } catch {
        $result.failure_code=Get-E1FailureCode $_ 'preflight_failed'
        if($_.Exception.Message -cin $script:E1OfflineNetworkFailures) {$result.failure_code=$_.Exception.Message}
    }
    return $result
}

function Assert-E1OfflineQuiescent([string]$Source) {
    Assert-E1NoGuestLive $Source
    if (@(Get-Process | Where-Object { $_.ProcessName -imatch '^java(w)?$' }).Count) { throw 'cache_busy' }
}

function Assert-E1OfflineWrapper([string]$ProbeGradleHome) {
    # Gradle 9.4 PathAssembler: unsigned MD5(URL), base36. This is the exact
    # pinned services.gradle.org URL, not an arbitrary installed distribution.
    $root=Join-Path $ProbeGradleHome 'wrapper\dists\gradle-9.4.0-bin\lcvyxq3t37f6mx9miaydrrgs'
    Assert-E1ToolPath $root
    $marker=Join-Path $root 'gradle-9.4.0-bin.zip.ok'
    if(-not (Test-Path -LiteralPath $root -PathType Container) -or -not (Test-Path -LiteralPath $marker -PathType Leaf)) {throw 'wrapper_cache_missing'}
    $dirs=@(Get-ChildItem -LiteralPath $root -Directory)
    if($dirs.Count -ne 1 -or $dirs[0].Name -cne 'gradle-9.4.0') {throw 'wrapper_cache_missing'}
    $lib=Join-Path $dirs[0].FullName 'lib'
    $launchers=@(Get-ChildItem -LiteralPath $lib -Filter 'gradle-launcher-*.jar' -File)
    if($launchers.Count -ne 1 -or $launchers[0].Name -cne 'gradle-launcher-9.4.0.jar') {throw 'wrapper_cache_missing'}
}

function Get-E1OfflineSdk([string]$Source) {
    $path=Resolve-E1Path (Join-Path $Source 'local.properties')
    if(-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -gt 16384) {throw 'sdk_configuration'}
    $bytes=[IO.File]::ReadAllBytes($path)
    $text=[Text.UTF8Encoding]::new($false,$true).GetString($bytes).TrimStart([char]0xfeff)
    # The existing VM bootstrap writes this literal sdk.dir form. Do not copy
    # arbitrary local.properties content or interpret additional properties.
    $lines=@($text.Split("`n") | Where-Object {$_ -match '^\s*sdk\.dir\s*='})
    if($lines.Count -ne 1 -or $lines[0].Trim() -cnotmatch '^sdk\.dir=(C:/[A-Za-z0-9 _./-]+)$') {throw 'sdk_configuration'}
    $sdkRoot=Resolve-E1Path $Matches[1]
    $platform=Resolve-E1Path (Join-Path $sdkRoot 'platforms/android-36/android.jar')
    $tools=Resolve-E1Path (Join-Path $sdkRoot 'build-tools/36.0.0/source.properties')
    if(-not (Test-Path -LiteralPath $platform -PathType Leaf) -or -not (Test-Path -LiteralPath $tools -PathType Leaf)) {throw 'sdk_configuration'}
    return @{root=$sdkRoot;configuration_sha256=(Get-E1Sha256 $bytes);build_tools_sha256=(Get-E1SourceFileHash $tools 16384)}
}

function Invoke-E1OfflineGuest($Config) {
    $result = New-E1OfflineReceipt
    $mutex=$null; $locked=$false; $stream=$null; $before=$null; $saved=@{}; $sourceBefore=$null
    $source = 'C:\kmp-eval\NowInAndroid-evidence1-coverage-threshold-windows-stageb-v1'
    $harness = 'C:\kmp-eval\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1'
    $sourceCommit = '7d45eae4f8720a0c77f507712ba2437ff974b6ed'
    try {
        $identity=Get-CimInstance Win32_ComputerSystem
        $vmId=Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters' -Name VirtualMachineId
        Assert-E1GuestIdentity $env:COMPUTERNAME $Config.HostComputerName 'Evidence1Runner' $vmId $Config.VMId $identity.Manufacturer $identity.Model $env:USERNAME $Config.GuestUser
        $result.checks.guest_identity=$true
        Assert-E1ForensicSubject $Config.Report $Config.Commit $Config.Tree
        Assert-E1Fields $Config.Report @{ state='failed' }
        $markerPath='C:\kmp-eval\scratch\evidence1-validation-ops\wet-v2-' + $Config.Commit + '.json'
        $marker=Read-E1ForensicArtifact $markerPath ''
        Assert-E1ForensicMarker $marker.value $Config.Report
        $result.hashes.wet_marker_sha256=$marker.sha256
        $result.hashes.network_seal_sha256=Get-E1OfflineSealHash
        $result.checks.network_sealed=$true
        Assert-E1OfflineQuiescent $source
        $mutex=[Threading.Mutex]::new($false,'Global\Evidence1ValidationOps'); $locked=$mutex.WaitOne(0)
        if (-not $locked) { throw 'validation_overlap' }
        $directory=Resolve-E1Path ('C:\kmp-eval\scratch\gradle-offline-probe-' + $Config.Commit)
        if (Test-Path -LiteralPath $directory) { throw 'attempt_exists' }
        New-Item -ItemType Directory -Path $directory | Out-Null
        $stream=[IO.File]::Open((Join-Path $directory 'PROBE.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
        Write-E1Record $stream $result
        $before=Get-E1RecordsSnapshot $harness
        $null=Assert-E1Repo $harness $Config.Commit $Config.Tree $directory
        $sourceBefore=Get-E1SourceSnapshot $source $sourceCommit '' $directory
        $sdk=Get-E1OfflineSdk $source
        $result.hashes.sdk_configuration_sha256=$sdk.configuration_sha256
        $result.hashes.sdk_build_tools_sha256=$sdk.build_tools_sha256
        foreach($name in @('GRADLE_USER_HOME','GRADLE_OPTS','ANDROID_HOME','ANDROID_SDK_ROOT','TEMP','TMP','GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM')) { $saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process') }
        $env:ANDROID_HOME=$sdk.root; $env:ANDROID_SDK_ROOT=$sdk.root
        $env:TEMP=$directory; $env:TMP=$directory; $env:GIT_CONFIG_NOSYSTEM='1'
        $env:GIT_CONFIG_GLOBAL=Join-Path $directory 'empty-git-config'
        [IO.File]::WriteAllText($env:GIT_CONFIG_GLOBAL,'',[Text.UTF8Encoding]::new($false))
        $copy=Join-Path $directory 'source'; $probeGradleHome=Join-Path $directory 'gradle-home'
        $result.stage='copy_cache'; Write-E1Record $stream $result
        $donor=Join-Path $env:USERPROFILE '.gradle'
        $result.cache=Copy-E1OfflineCache $donor $probeGradleHome
        Assert-E1OfflineQuiescent $source
        $result.stage='clone_source'; Write-E1Record $stream $result
        $null=Invoke-E1Git $source @('-c','core.hooksPath=NUL','clone','--no-local','--no-checkout','--',$source,$copy) $directory
        $null=Invoke-E1Git $copy @('-c','core.hooksPath=NUL','checkout','--detach',$sourceCommit) $directory
        $null=Assert-E1Repo $copy $sourceCommit $sourceBefore.tree $directory
        $wrapper=Join-Path $copy 'gradle\wrapper\gradle-wrapper.properties'
        $wrapperText=[IO.File]::ReadAllText($wrapper)
        if ($wrapperText -cnotmatch '(?m)^distributionUrl=https\\://services\.gradle\.org/distributions/gradle-9\.4\.0-bin\.zip\s*$' -or
            $wrapperText -cnotmatch '(?m)^distributionSha256Sum=60ea723356d81263e8002fec0fcf9e2b0eee0c0850c7a3d7ab0a63f2ccc601f3\s*$') { throw 'wrapper_identity' }
        $result.hashes.wrapper_properties_sha256=Get-E1SourceFileHash $wrapper 16384
        $wrapperJar=Join-Path $copy 'gradle\wrapper\gradle-wrapper.jar'
        $result.hashes.wrapper_jar_sha256=Get-E1SourceFileHash $wrapperJar 1048576
        Assert-E1OfflineWrapper $probeGradleHome
        $env:GRADLE_USER_HOME=$probeGradleHome; $env:GRADLE_OPTS='-Dorg.gradle.daemon=false'
        [IO.File]::WriteAllText((Join-Path $probeGradleHome 'gradle.properties'),"org.gradle.daemon=false`norg.gradle.java.installations.auto-download=false`n",[Text.UTF8Encoding]::new($false))
        $result.stage='offline_gradle'; Write-E1Record $stream $result
        $probeStdout=Join-Path $directory 'gradle.stdout.txt'; $probeStderr=Join-Path $directory 'gradle.stderr.txt'
        Invoke-E1Java21Environment $directory {
            param($java)
            $result.hashes.java_executable_sha256=Get-E1SourceFileHash $java.executable 16777216
            $result.gradle_invocations=1; Write-E1Record $stream $result
            $p=Invoke-E1OwnedProcess $java.executable @('-classpath',$wrapperJar,'org.gradle.wrapper.GradleWrapperMain',
                ':core:domain:test',':core:domain:createDemoDebugUnitTestCoverageReport',':core:domain:createProdDebugUnitTestCoverageReport',
                '--offline','--no-daemon','--no-build-cache','--console=plain','--stacktrace') $copy $probeStdout $probeStderr 300
            $result.process=ConvertTo-E1ProcessObservation @{exit_code=$p.ExitCode;wall_seconds=$p.WallSeconds;timed_out=$p.TimedOut;cleanup_ok=$p.CleanupOk}
        }
        $text=''
        foreach($log in @($probeStdout,$probeStderr)) {
            if ((Get-Item -LiteralPath $log).Length -gt 8388608) { throw 'diagnostic_limit' }
            $text += [Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes($log)) + "`n"
        }
        $result.hashes.stdout_sha256=Get-E1SourceFileHash $probeStdout 8388608
        $result.hashes.stderr_sha256=Get-E1SourceFileHash $probeStderr 8388608
        $result.offline_signals=Get-E1OfflineSignals $text; $result.gradle_signals=Get-E1ForensicGradleSummary $text
        if ($result.process.timed_out) { $result.failure_code='gradle_timeout' }
        elseif (-not $result.process.cleanup_ok) { $result.failure_code='process_cleanup' }
        elseif ($result.offline_signals.offline_cache_miss -gt 0) { $result.conclusion='offline_cache_incomplete'; $result.failure_code='offline_cache_miss' }
        elseif ($result.process.exit_code -eq 0) { $result.conclusion='offline_tasks_completed'; $result.failure_code='none'; $result.state='passed' }
        else { $result.failure_code='gradle_failed' }
    } catch {
        $allowed=@('attempt_exists','network_unsealed','cache_busy','cache_limit','cache_destination','cache_empty','cache_changed','wrapper_identity','wrapper_cache_missing','diagnostic_limit','sdk_configuration')
        $result.state='failed'; $result.failure_code=Get-E1FailureCode $_ 'preflight_failed'
        if ($_.Exception.Message -cin ($allowed + $script:E1OfflineNetworkFailures)) { $result.failure_code=$_.Exception.Message }
    } finally {
        foreach($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
        if ($before) {
            try {
                Set-E1RecordsCheck $result $before (Get-E1RecordsSnapshot $harness)
                if ($sourceBefore) { Assert-E1SourcePostflight $source $sourceCommit $sourceBefore.tree $directory $sourceBefore -Operation 'dry-v3'; $result.checks.source_custody=$true }
                $null=Read-E1ForensicArtifact $markerPath $marker.sha256
                if($result.hashes.ContainsKey('sdk_configuration_sha256')) {
                    $sdkAfter=Get-E1OfflineSdk $source
                    if($sdkAfter.configuration_sha256 -cne $result.hashes.sdk_configuration_sha256 -or $sdkAfter.build_tools_sha256 -cne $result.hashes.sdk_build_tools_sha256) {throw 'evidence_changed'}
                }
                if ((Get-E1OfflineSealHash) -cne $result.hashes.network_seal_sha256) { throw 'evidence_changed' }
                Assert-E1OfflineQuiescent $source
                $result.checks.postflight=$true
            } catch { $result.state='failed'; $result.failure_code=Get-E1FailureCode $_ 'postflight_failed'; $result.conclusion='inconclusive' }
        }
        if ($stream) { try { if($result.state -ceq 'passed') {$result.stage='complete'}; Write-E1Record $stream $result } finally { $stream.Dispose() } }
        if ($locked) { $mutex.ReleaseMutex() }; if ($mutex) { $mutex.Dispose() }
    }
    return $result
}

function ConvertTo-E1OfflineReceipt($Raw) {
    $safe=New-E1OfflineReceipt
    $schema=Get-E1Field $Raw 'schema'
    if(Test-E1Exact $schema 2) {
        if((Get-E1Field $Raw 'operation') -cne 'gradle-offline-network-audit') {throw 'result_shape'}
        $safe.schema=2; $safe.network_rule_scope=$null
    }
    $keys=@(Get-E1ObjectKeys $Raw | Where-Object { $_ -cnotin @('PSComputerName','RunspaceId','PSShowComputerName') })
    if (@($keys | Where-Object { $_ -cnotin @($safe.Keys) }).Count -or $keys.Count -ne $safe.Count) { throw 'result_shape' }
    $operation=Get-E1Field $Raw 'operation'
    if($operation -cnotin @('gradle-offline-cache-probe','gradle-offline-network-audit')) {throw 'result_shape'}
    $audit=($operation -ceq 'gradle-offline-network-audit')
    $safe.operation=$operation
    $fixed=@{schema=$safe.schema;operation=$operation;agent_calls=0;product_invocations=0;validation_pass=$false;firewall_modified=$false;original_home_used_for_gradle=$false}
    foreach($key in $fixed.Keys) { if(-not (Test-E1Exact (Get-E1Field $Raw $key) $fixed[$key])) {throw 'result_shape'} }
    if($safe.schema -eq 2) {
        $scope=Get-E1Field $Raw 'network_rule_scope'
        if($null -ne $scope) {$safe.network_rule_scope=ConvertTo-E1OfflineRuleScope $scope}
    }
    foreach($name in @('state','stage','conclusion','failure_code')) {
        $value=Get-E1Field $Raw $name
        $allowed=switch($name) {
            state { @('passed','failed') }
            stage { @('preflight','copy_cache','clone_source','offline_gradle','complete') }
            conclusion { @('inconclusive','offline_cache_incomplete','offline_tasks_completed') }
            failure_code { @('none','probe_failed','preflight_failed','postflight_failed','attempt_exists','network_unsealed','cache_busy','cache_limit','cache_destination','cache_empty','cache_changed','wrapper_identity','wrapper_cache_missing','diagnostic_limit','sdk_configuration','gradle_timeout','process_cleanup','offline_cache_miss','gradle_failed','guest_identity','validation_overlap','live_overlap','ambient_credentials','environment_override','repo_commit','repo_tree','repo_root','repo_dirty','source_artifacts','source_artifact_limit','source_tracked_changed','source_index_changed','records_changed','evidence_changed','path_invalid','path_link','path_outside_root','git_failed','git_output_size','java_toolchain','result_shape') }
        }
        if($name -ceq 'failure_code') {$allowed += $script:E1OfflineNetworkFailures + @('evidence_mismatch','json_size')}
        if ($value -isnot [string] -or $value -cnotin $allowed) { throw 'result_shape' }; $safe[$name]=$value
    }
    $calls=Get-E1Field $Raw 'gradle_invocations'
    if (-not (Test-E1Exact $calls 0) -and -not (Test-E1Exact $calls 1)) { throw 'result_shape' }; $safe.gradle_invocations=$calls
    $live=Get-E1Field $Raw 'live_records_created'
    if ($null -ne $live -and -not (Test-E1Exact $live 0)) { throw 'result_shape' }; $safe.live_records_created=$live
    $checks=Get-E1Field $Raw 'checks'; Assert-E1Keys $checks @($safe.checks.Keys)
    foreach($key in @($safe.checks.Keys)) { $value=Get-E1Field $checks $key; if($value -isnot [bool]) {throw 'result_shape'}; $safe.checks[$key]=$value }
    $process=Get-E1Field $Raw 'process'; if($null -ne $process) { $safe.process=ConvertTo-E1ProcessObservation $process }
    $cache=Get-E1Field $Raw 'cache'
    if($null -ne $cache) {
        Assert-E1Keys $cache @('file_count','bytes','sha256'); $safe.cache=@{}
        foreach($name in @('file_count','bytes')) {
            $value=Get-E1Field $cache $name
            if(($value -isnot [int] -and $value -isnot [long]) -or $value -lt 0 -or $value -gt 17179869184L) {throw 'result_shape'}
            $safe.cache[$name]=$value
        }
        $digest=Get-E1Field $cache 'sha256'; if($digest -isnot [string] -or $digest -cnotmatch '^[a-f0-9]{64}$') {throw 'result_shape'}; $safe.cache.sha256=$digest
    }
    $offline=Get-E1Field $Raw 'offline_signals'
    if($null -ne $offline) {
        Assert-E1Keys $offline @('offline_cache_miss'); $n=Get-E1Field $offline 'offline_cache_miss'
        if(($n -isnot [int] -and $n -isnot [long]) -or $n -lt 0 -or $n -gt 100000) {throw 'result_shape'}
        $safe.offline_signals=@{offline_cache_miss=$n}
    }
    $gradle=Get-E1Field $Raw 'gradle_signals'
    if($null -ne $gradle) { Assert-E1ForensicGradleSummary $gradle; $safe.gradle_signals=$gradle }
    $hashes=Get-E1Field $Raw 'hashes'
    foreach($key in Get-E1ObjectKeys $hashes) {
        if($key -cnotin @('wet_marker_sha256','network_seal_sha256','wrapper_properties_sha256','wrapper_jar_sha256','java_executable_sha256','sdk_configuration_sha256','sdk_build_tools_sha256','stdout_sha256','stderr_sha256','records_metadata_before_sha256','records_metadata_after_sha256')) {throw 'result_shape'}
        $value=Get-E1Field $hashes $key
        if($value -isnot [string] -or $value -cnotmatch '^[a-f0-9]{64}$') {throw 'result_shape'}; $safe.hashes[$key]=$value
    }
    if($audit) {
        if($safe.gradle_invocations -ne 0 -or $null -ne $safe.process -or $null -ne $safe.cache -or
            $null -ne $safe.offline_signals -or $null -ne $safe.gradle_signals -or $null -ne $safe.live_records_created -or
            $safe.stage -cne 'preflight' -or $safe.conclusion -cne 'inconclusive' -or $safe.checks.source_custody) {throw 'result_shape'}
        if($safe.state -ceq 'passed' -and ($safe.failure_code -cne 'none' -or -not $safe.checks.guest_identity -or
            -not $safe.checks.network_sealed -or -not $safe.checks.postflight)) {throw 'result_shape'}
    }
    elseif($safe.state -ceq 'passed' -and ($safe.failure_code -cne 'none' -or $safe.conclusion -cne 'offline_tasks_completed' -or
        $safe.gradle_invocations -ne 1 -or $safe.live_records_created -ne 0 -or @($safe.checks.Values | Where-Object {$_ -ne $true}).Count -or
        $null -eq $safe.process -or $safe.process.exit_code -ne 0 -or $safe.process.timed_out -or -not $safe.process.cleanup_ok)) {throw 'result_shape'}
    return $safe
}

function Invoke-E1OfflineDirect([string]$TargetCommit,[string]$TargetTree,[string]$ExpectedReportSha256,[switch]$AuditNetwork) {
    $result=@{schema=1;operation='gradle-offline-cache-probe';state='failed';failure_code='host_preflight';receipt=$null;subject=$null;module_sha256=$null}
    if($AuditNetwork) {$result.operation='gradle-offline-network-audit'}
    $session=$null; $job=$null
    try {
        $path='C:\kmp-eval\scratch\hyperv-verify-wet-gate-v2-direct\HYPERV-VERIFY-WET-GATE-V2-DIRECT.json'
        if($ExpectedReportSha256 -cnotmatch '^[a-f0-9]{64}$') {throw 'forensic_hash'}
        $report=Read-E1ForensicArtifact $path $ExpectedReportSha256
        Assert-E1ForensicSubject $report.value $TargetCommit $TargetTree
        Assert-E1Fields $report.value @{state='failed'}
        $result.subject=@{target_commit=$TargetCommit;target_tree=$TargetTree;host_wet_report_sha256=$report.sha256}
        if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {throw 'host_privilege'}
        $vm=Get-VM -Name 'Evidence1-Runner' -ErrorAction Stop
        if($vm.State.ToString() -cne 'Running') {throw 'vm_not_running'}
        $credentialPath=Resolve-E1Path 'C:\kmp-eval\scratch\hyperv-create-runner\Evidence1-Runner.guest-credential.clixml'
        $stored=Import-Clixml -LiteralPath $credentialPath
        if($stored -isnot [pscredential] -or $stored.UserName -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$') {throw 'credential_shape'}
        $credential=[pscredential]::new("Evidence1Runner\$($stored.UserName)",$stored.Password)
        $text=''
        foreach($name in @('evidence1-validation-ops.psm1','evidence1-validation-forensics.psm1','evidence1-gradle-offline-probe.psm1')) {
            $modulePath=Resolve-E1Path (Join-Path $PSScriptRoot $name)
            $text += [Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes($modulePath)) + "`n"
        }
        $result.module_sha256=Get-E1Sha256 ([Text.Encoding]::UTF8.GetBytes($text))
        $config=@{Commit=$TargetCommit;Tree=$TargetTree;Report=$report.value;VMId=$vm.Id.ToString();HostComputerName=$env:COMPUTERNAME;GuestUser=$stored.UserName;AuditNetwork=[bool]$AuditNetwork}
        $session=New-PSSession -VMName 'Evidence1-Runner' -Credential $credential -ErrorAction Stop
        $result.failure_code='transport_failed'
        $job=Invoke-Command -Session $session -AsJob -ScriptBlock {
            param($Text,$Hash,$Config)
            $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
            $sha=[Security.Cryptography.SHA256]::Create()
            try {$actual=-join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)) | ForEach-Object {$_.ToString('x2')})} finally {$sha.Dispose()}
            if($Hash -cnotmatch '^[a-f0-9]{64}$' -or $actual -cne $Hash) {throw 'module_hash_mismatch'}
            Import-Module (New-Module -Name Evidence1OfflineProbeRuntime -ScriptBlock ([scriptblock]::Create($Text))) -DisableNameChecking
            if($Config.AuditNetwork) {Invoke-E1OfflineNetworkAuditGuest $Config}
            else {Invoke-E1OfflineGuest $Config}
        } -ArgumentList $text,$result.module_sha256,$config
        if(-not (Wait-Job $job -Timeout 900)) {throw 'transport_timeout'}
        $raw=@(Receive-Job $job -ErrorAction Stop 3>$null 4>$null 5>$null 6>$null)
        if($raw.Count -ne 1) {throw 'result_shape'}
        $result.receipt=ConvertTo-E1OfflineReceipt $raw[0]
        if($result.receipt.operation -cne $result.operation) {throw 'result_shape'}
        $null=Read-E1ForensicArtifact $path $report.sha256
        $result.state=$result.receipt.state; $result.failure_code=$result.receipt.failure_code
    } catch {
        $code=Get-E1FailureCode $_ 'transport_failed'
        if($_.Exception.Message -cin @('forensic_hash','forensic_subject','forensic_marker','credential_shape','host_privilege','vm_not_running')) {$code=$_.Exception.Message}
        $result.state='failed'; $result.failure_code=$code
    } finally {
        if($job) {Stop-Job $job -ErrorAction SilentlyContinue 2>$null; Remove-Job $job -Force -ErrorAction SilentlyContinue 2>$null}
        if($session) {Remove-PSSession $session -ErrorAction SilentlyContinue 2>$null}
    }
    return $result
}

Export-ModuleMember -Function *-E1*
