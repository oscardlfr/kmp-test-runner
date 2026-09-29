param(
    [ValidateSet('DryRun', 'Live')]
    [string]$Mode = 'DryRun',
    [Parameter(Mandatory)]
    [string]$HarnessDir,
    [Parameter(Mandatory)]
    [string]$SourceDir,
    [Parameter(Mandatory)]
    [string]$AttestationFile,
    [Parameter(Mandatory)]
    [string]$CustodyDir,
    [string]$PublicDir = '',
    [string]$PrivatePatternsFile = '',
    [string]$MeasurementScopeFile = '',
    [string]$Model = 'gpt-5.6-terra',
    [string]$Scenario = 'coverage-threshold-failure-v2',
    [int]$Seed = 20260910,
    [string]$RemoteAuthCanaryOperationId = '',
    [string]$ReadinessPath = 'C:\kmp-eval\scratch\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1\READINESS.json',
    [string]$CampaignBindingPath = '',
    [string]$CampaignBindingSha256 = '',
    [string]$AuthorizationClaimPath = '',
    [string]$AuthorizationClaimSha256 = '',
    [string]$GlobalAuthorizationClaimPath = '',
    [string]$GlobalAuthorizationClaimSha256 = '',
    [string]$RemoteAuthCanaryPath = '',
    [string]$RemoteAuthCanarySha256 = '',
    [string]$NodeRuntimeManifestPath = '',
    [string]$NodeRuntimeManifestSha256 = '',
    [string]$Authorization = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Runtime = 'codex-cli'
$CampaignDesign = 'codex-product-vs-free-baseline-v1'
$RequiredAuthorization = 'AUTORIZO EXACTAMENTE 6 SESIONES CODEX: 3 PRODUCT Y 3 FREE-BASELINE; SIN REINTENTOS, REEMPLAZOS NI RESPAWNS.'
$ExpectedOrder = @('A', 'B', 'B', 'A', 'A', 'B')
$ExpectedConditions = @('current-skill', 'no-skill', 'no-skill', 'current-skill', 'current-skill', 'no-skill')
$ExpectedClaudeVersion = '2.1.238'
$ExpectedCodexVersion = '0.154.0'
$GradleUserHomeSeedDir = Join-Path $env:USERPROFILE '.gradle'
$GradleCacheCertificationPath = 'C:\Evidence1RuntimeState\gradle-cache-certification.json'
$ExpectedGradleCacheTasks = @(':core:domain:test', ':core:domain:createDemoDebugUnitTestCoverageReport', ':core:domain:createProdDebugUnitTestCoverageReport')
if ($Model -cne 'gpt-5.6-terra') { throw 'Codex model must remain pinned to gpt-5.6-terra' }

function Resolve-ExistingPath([string]$Path, [string]$Label, [switch]$Leaf) {
    if (-not (Test-Path -LiteralPath $Path -PathType $(if ($Leaf) { 'Leaf' } else { 'Container' }))) {
        throw "$Label is missing"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Test-IsDescendant([string]$Candidate, [string]$Parent) {
    $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $candidateFull = [IO.Path]::GetFullPath($Candidate).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    return $candidateFull.StartsWith($parentFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function ConvertTo-NativeArgumentLine([string[]]$ArgumentList) {
    $parts = foreach ($argument in $ArgumentList) {
        $value = [string]$argument
        if ($value -notmatch '[\s"]') { $value; continue }
        $value = $value -replace '(\\*)"', '$1$1\"'
        $value = $value -replace '(\\+)$', '$1$1'
        '"' + $value + '"'
    }
    return [string]::Join(' ', $parts)
}

function Invoke-CapturedProcess(
    [string]$Executable,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory,
    [string]$StdoutPath,
    [string]$StderrPath,
    [hashtable]$Environment = @{},
    [ValidateRange(1,14400)][int]$TimeoutSeconds = 900
) {
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Executable
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($entry in $Environment.GetEnumerator()) { $startInfo.Environment[$entry.Key] = [string]$entry.Value }
    $argumentListProperty = $startInfo.GetType().GetProperty('ArgumentList')
    if ($null -ne $argumentListProperty) {
        foreach ($argument in $ArgumentList) { [void]$startInfo.ArgumentList.Add($argument) }
    } else {
        $startInfo.Arguments = ConvertTo-NativeArgumentLine $ArgumentList
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $stdout = [IO.File]::Open($StdoutPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $stderr = [IO.File]::Open($StderrPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
        if (-not $process.Start()) { throw 'process_start_failed' }
        $stdoutCopy = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
        $stderrCopy = $process.StandardError.BaseStream.CopyToAsync($stderr)
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F | Out-Null
            throw 'process_timeout_tree_terminated'
        }
        [Threading.Tasks.Task]::WaitAll(@($stdoutCopy, $stderrCopy))
        return [int]$process.ExitCode
    } finally {
        $stdout.Dispose()
        $stderr.Dispose()
        $process.Dispose()
    }
}

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Assert-GuestRuntimeReadOnlyAcl([string]$Path,[bool]$Directory) {
    $acl=Get-Acl -LiteralPath $Path;if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value-cne'S-1-5-32-544'-or-not$acl.AreAccessRulesProtected){throw 'guest_runtime_acl_invalid'}
    $rules=@($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]));if($rules.Count-ne 3){throw 'guest_runtime_acl_invalid'}
    $readExecute=[int]([Security.AccessControl.FileSystemRights]::ReadAndExecute-bor[Security.AccessControl.FileSystemRights]::Synchronize);$expected=@{'S-1-5-18'=[int][Security.AccessControl.FileSystemRights]::FullControl;'S-1-5-32-544'=[int][Security.AccessControl.FileSystemRights]::FullControl;'S-1-5-32-545'=$readExecute}
    foreach($rule in $rules){$sid=$rule.IdentityReference.Value;$inherit=if($Directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None};if(-not$expected.ContainsKey($sid)-or$rule.AccessControlType-ne[Security.AccessControl.AccessControlType]::Allow-or[int]$rule.FileSystemRights-ne$expected[$sid]-or$rule.InheritanceFlags-ne$inherit-or$rule.PropagationFlags-ne[Security.AccessControl.PropagationFlags]::None){throw 'guest_runtime_acl_invalid'}}
}

function Assert-NodeRuntimeSnapshot([string]$ManifestPath,[string]$ManifestSha256,[string]$ExpectedSourceCommit='') {
    $expectedManifest=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'node-runtime.manifest.json'))
    if([string]::IsNullOrWhiteSpace($ManifestPath)-or-not([IO.Path]::GetFullPath($ManifestPath).Equals($expectedManifest,[StringComparison]::OrdinalIgnoreCase))-or$ManifestSha256-cnotmatch'^[0-9a-f]{64}$'-or-not(Test-Path -LiteralPath $expectedManifest -PathType Leaf)-or((Get-Item -LiteralPath $expectedManifest -Force).Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0-or(Get-Sha256 $expectedManifest)-cne$ManifestSha256){throw 'node_runtime_manifest_invalid'}
    $manifest=Get-Content -LiteralPath $expectedManifest -Raw|ConvertFrom-Json -ErrorAction Stop
    $manifestKeys=if($manifest.schema-eq 2){@('kind','node_files','principal_sid','process_module_sha256','runner_sha256','schema','scripts','source_git_commit','support_files')}else{@('kind','node_files','principal_sid','process_module_sha256','runner_sha256','schema','scripts','support_files')}
    if($manifest.schema-notin@(1,2)-or@($manifest.PSObject.Properties.Name).Count-ne$manifestKeys.Count-or@(Compare-Object @($manifest.PSObject.Properties.Name|Sort-Object) @($manifestKeys|Sort-Object)).Count-ne 0-or$manifest.kind-cne'evidence1-host-elevated-runner-manifest'-or($manifest.schema-eq 2-and[string]$manifest.source_git_commit-cnotmatch'^[0-9a-f]{40,64}$')-or@($manifest.node_files).Count-eq 0){throw 'node_runtime_manifest_invalid'}
    if(-not[string]::IsNullOrWhiteSpace($ExpectedSourceCommit)-and($ExpectedSourceCommit-cnotmatch'^[0-9a-f]{40,64}$'-or$manifest.schema-ne 2-or[string]$manifest.source_git_commit-cne$ExpectedSourceCommit)){throw 'node_runtime_source_commit_mismatch'}
    $runtimeRoot=[IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\');$runtimeBase=Split-Path -Parent $runtimeRoot;$nodeRoot=[IO.Path]::GetFullPath((Join-Path $runtimeRoot 'node-runtime')).TrimEnd('\');if(-not(Test-Path -LiteralPath $nodeRoot -PathType Container)-or((Get-Item -LiteralPath $nodeRoot -Force).Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'node_runtime_reparse_rejected'};Assert-GuestRuntimeReadOnlyAcl $runtimeBase $true;Assert-GuestRuntimeReadOnlyAcl $runtimeRoot $true;Assert-GuestRuntimeReadOnlyAcl $nodeRoot $true;Assert-GuestRuntimeReadOnlyAcl $expectedManifest $false;$expected=@{};$expectedDirs=@{}
    foreach($entry in @($manifest.node_files)){
        $entryKeys=if($manifest.schema-eq 2){@('blob_oid','name','sha256')}else{@('name','sha256')}
        if(@(Compare-Object @($entry.PSObject.Properties.Name|Sort-Object) @($entryKeys|Sort-Object)).Count-ne 0-or[string]$entry.name-cnotmatch'^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*$'-or[string]$entry.sha256-cnotmatch'^[0-9a-f]{64}$'-or($manifest.schema-eq 2-and[string]$entry.blob_oid-cnotmatch'^[0-9a-f]{40,64}$')-or$expected.ContainsKey([string]$entry.name)){throw 'node_runtime_manifest_invalid'}
        $relative=[string]$entry.name;$path=[IO.Path]::GetFullPath((Join-Path $nodeRoot $relative.Replace('/','\')));if(-not$path.StartsWith($nodeRoot+'\',[StringComparison]::OrdinalIgnoreCase)-or-not(Test-Path -LiteralPath $path -PathType Leaf)-or(Get-Sha256 $path)-cne[string]$entry.sha256){throw 'node_runtime_hash_mismatch'}
        $cursor=$path;while($cursor.StartsWith($nodeRoot+'\',[StringComparison]::OrdinalIgnoreCase)){$item=Get-Item -LiteralPath $cursor -Force;if(($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'node_runtime_reparse_rejected'};Assert-GuestRuntimeReadOnlyAcl $cursor ([bool]$item.PSIsContainer);$cursor=Split-Path -Parent $cursor}
        $expected[$relative]=$true;$parent=Split-Path -Parent $relative.Replace('/','\');while($parent){$expectedDirs[$parent.Replace('\','/')]=$true;$next=Split-Path -Parent $parent;if($next-ceq$parent){break};$parent=$next}
    }
    $actual=@(Get-ChildItem -LiteralPath $nodeRoot -File -Force -Recurse|ForEach-Object{$_.FullName.Substring($nodeRoot.Length+1).Replace('\','/')}|Sort-Object);if(@(Compare-Object $actual @($expected.Keys|Sort-Object)).Count-ne 0){throw 'node_runtime_closed_set_invalid'}
    $actualDirs=@(Get-ChildItem -LiteralPath $nodeRoot -Directory -Force -Recurse|ForEach-Object{if(($_.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'node_runtime_reparse_rejected'};$_.FullName.Substring($nodeRoot.Length+1).Replace('\','/')}|Sort-Object);if(@(Compare-Object $actualDirs @($expectedDirs.Keys|Sort-Object)).Count-ne 0){throw 'node_runtime_closed_set_invalid'}
    return $true
}

function Get-TextSha256([string]$Text) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))) -replace '-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}

function Write-JsonCreateNew([string]$Path, $Value) {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 20) + "`n")
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

function Get-InstalledTreeIdentity([string]$Root) {
    $files = @(Get-ChildItem -LiteralPath $Root -Recurse -Force -File | Where-Object Name -ne '.evidence1-artifact.json' | Sort-Object FullName)
    $builder = [Text.StringBuilder]::new()
    [int64]$bytes = 0
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($Root.Length).TrimStart('\').Replace('\','/')
        $null = $builder.Append($relative).Append("`0").Append($file.Length).Append("`0").Append((Get-Sha256 $file.FullName)).Append("`n")
        $bytes += $file.Length
    }
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $digest = $algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($builder.ToString())) }
    finally { $algorithm.Dispose() }
    return [ordered]@{ sha256 = ([BitConverter]::ToString($digest) -replace '-', '').ToLowerInvariant(); file_count = $files.Count; bytes = $bytes }
}

function Assert-CanonicalRuntime([string]$Id, [string]$Version, [string]$CommandRelative) {
    $root = "C:\Evidence1Toolchain\$Id\$Version"
    $markerPath = Join-Path $root '.evidence1-artifact.json'
    $commandPath = Join-Path $root $CommandRelative
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or -not (Test-Path -LiteralPath $commandPath -PathType Leaf)) {
        throw "canonical runtime missing: $Id"
    }
    $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json -ErrorAction Stop
    if ($marker.id -cne $Id -or $marker.version -cne $Version -or [string]$marker.installed_tree_sha256 -notmatch '^[0-9a-f]{64}$') {
        throw "canonical runtime marker invalid: $Id"
    }
    $tree = Get-InstalledTreeIdentity $root
    if ($tree.sha256 -cne $marker.installed_tree_sha256 -or $tree.file_count -ne $marker.installed_file_count -or $tree.bytes -ne $marker.installed_bytes) {
        throw "canonical runtime tree drift: $Id"
    }
    return [ordered]@{ root = $root; command = $commandPath; tree_sha256 = $tree.sha256 }
}

function Assert-CanonicalCodexToolchain {
    $specs = @(
        @('git','2.55.0.windows.5','cmd\git.exe'),
        @('git-bash','2.55.0.windows.5','bin\bash.exe'),
        @('node','24.19.0','node.exe'),
        @('jdk','21.0.12.1+1','bin\java.exe'),
        @('android-sdk','platform-36-build-tools-36.0.0','platform-tools\adb.exe'),
        @('claude-code','2.1.238','claude.cmd'),
        @('codex-cli','0.154.0','bin\codex.exe')
    )
    $resolved = @{}
    foreach ($spec in $specs) { $resolved[$spec[0]] = Assert-CanonicalRuntime $spec[0] $spec[1] $spec[2] }
    $version = (& $resolved['codex-cli'].command --version 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or [string]$version -cne 'codex-cli 0.154.0') { throw 'canonical Codex version mismatch' }
    $signature = Get-AuthenticodeSignature -LiteralPath $resolved['codex-cli'].command -ErrorAction Stop
    if ([string]$signature.Status -cne 'Valid' -or -not $signature.SignerCertificate -or
        [string]$signature.SignerCertificate.Subject -cne 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US') {
        throw 'canonical Codex publisher mismatch'
    }
    if ($env:CODEX_HOME -cne 'C:\Evidence1RuntimeState\codex') { throw 'canonical CODEX_HOME mismatch' }
    return $resolved
}

$HarnessDir = Resolve-ExistingPath $HarnessDir 'HarnessDir'
$SourceDir = Resolve-ExistingPath $SourceDir 'SourceDir'
$AttestationFile = Resolve-ExistingPath $AttestationFile 'AttestationFile' -Leaf
if ($PrivatePatternsFile) { $PrivatePatternsFile = Resolve-ExistingPath $PrivatePatternsFile 'PrivatePatternsFile' -Leaf }
if ($MeasurementScopeFile) { $MeasurementScopeFile = Resolve-ExistingPath $MeasurementScopeFile 'MeasurementScopeFile' -Leaf }

$custodyFull = [IO.Path]::GetFullPath($CustodyDir)
if ((Test-IsDescendant $custodyFull $HarnessDir) -or (Test-IsDescendant $HarnessDir $custodyFull) -or
    $custodyFull.TrimEnd('\', '/') -ieq $HarnessDir.TrimEnd('\', '/')) {
    throw 'CustodyDir must be outside and must not contain the harness repository'
}
if (Test-Path -LiteralPath $custodyFull) { throw 'CustodyDir must not already exist' }
New-Item -ItemType Directory -Path $custodyFull | Out-Null
if ($Mode -eq 'Live') {
    if (-not $PublicDir) { throw 'PublicDir is required for Live mode' }
    $publicFull = [IO.Path]::GetFullPath($PublicDir)
    $publicRoot = Join-Path $HarnessDir 'tools\runs'
    if (-not (Test-IsDescendant $publicFull $publicRoot) -or $publicFull.TrimEnd('\', '/') -ieq $publicRoot.TrimEnd('\', '/')) {
        throw 'PublicDir must be a new child of the harness tools/runs directory'
    }
    if (Test-Path -LiteralPath $publicFull) { throw 'PublicDir must not already exist' }
    $CampaignBindingPath = Resolve-ExistingPath $CampaignBindingPath 'CampaignBindingPath' -Leaf
    $AuthorizationClaimPath = Resolve-ExistingPath $AuthorizationClaimPath 'AuthorizationClaimPath' -Leaf
    $GlobalAuthorizationClaimPath = Resolve-ExistingPath $GlobalAuthorizationClaimPath 'GlobalAuthorizationClaimPath' -Leaf
    if ((Get-Sha256 $CampaignBindingPath) -cne $CampaignBindingSha256 -or
        (Get-Sha256 $AuthorizationClaimPath) -cne $AuthorizationClaimSha256 -or
        (Get-Sha256 $GlobalAuthorizationClaimPath) -cne $GlobalAuthorizationClaimSha256) {
        throw 'final campaign binding or authorization claim hash mismatch'
    }
}

$canonicalToolchain = Assert-CanonicalCodexToolchain
$toolchainProjection = @($canonicalToolchain.Keys | Sort-Object | ForEach-Object { "$_=$($canonicalToolchain[$_].tree_sha256)" }) -join "`n"
$toolchainSha = Get-TextSha256 $toolchainProjection
$bash = $canonicalToolchain['git-bash'].command
$codexRuntimeRoot = 'C:\Evidence1RuntimeState'
$codexHome = 'C:\Evidence1RuntimeState\codex'
$codexRuntimeRoot = Resolve-ExistingPath $codexRuntimeRoot 'Codex runtime root'
$codexHome = Resolve-ExistingPath $codexHome 'Codex home'
if (-not (Test-IsDescendant $codexHome $codexRuntimeRoot)) { throw 'Codex home must remain inside the attested runtime root' }
$codexIsolationEnv = @{
    KMP_EVAL_BASH_PATH = $bash
    KMP_EVAL_CODEX_HOME = $codexHome
    KMP_EVAL_CODEX_RUNTIME_ROOT = $codexRuntimeRoot
}
$env:JAVA_HOME = $canonicalToolchain['jdk'].root
$env:ANDROID_HOME = $canonicalToolchain['android-sdk'].root
$env:ANDROID_SDK_ROOT = $canonicalToolchain['android-sdk'].root
$env:KMP_EVAL_BASH_PATH = $bash
$env:Path = @(
    (Join-Path $canonicalToolchain['git'].root 'cmd'),
    (Join-Path $canonicalToolchain['git-bash'].root 'cmd'),
    (Join-Path $canonicalToolchain['git-bash'].root 'bin'),
    $canonicalToolchain['node'].root,
    (Join-Path $canonicalToolchain['jdk'].root 'bin'),
    (Join-Path $canonicalToolchain['android-sdk'].root 'platform-tools'),
    $canonicalToolchain['claude-code'].root,
    $canonicalToolchain['codex-cli'].root,
    'C:\Windows\System32'
) -join ';'
$node = $canonicalToolchain['node'].command
$git = $canonicalToolchain['git'].command
$cliPath = Join-Path $HarnessDir 'tools\agentic-eval\cli.mjs'
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) { throw 'agentic-eval CLI is missing' }
$remoteAuthCanary = $null
if ($Mode -eq 'Live') {
    $operationGuid = [guid]::Empty
    if (-not [guid]::TryParseExact($RemoteAuthCanaryOperationId, 'D', [ref]$operationGuid) -or
        $operationGuid -eq [guid]::Empty -or $RemoteAuthCanaryOperationId -cne $operationGuid.ToString('D')) {
        throw 'RemoteAuthCanaryOperationId must be a canonical non-empty GUID for Live mode'
    }
    $ReadinessPath = Resolve-ExistingPath $ReadinessPath 'ReadinessPath' -Leaf
    $readiness = Get-Content -LiteralPath $ReadinessPath -Raw | ConvertFrom-Json -ErrorAction Stop
    $readinessAt = [DateTime]::MinValue
    if (-not $readiness.PSObject.Properties['generated_at_utc'] -or
        -not [DateTime]::TryParse([string]$readiness.generated_at_utc, [ref]$readinessAt)) {
        throw 'readiness timestamp is invalid for Live mode'
    }
    $readinessSha256 = (Get-FileHash -LiteralPath $ReadinessPath -Algorithm SHA256).Hash.ToLowerInvariant()
    # ReadinessPath is the guest ledger in Live mode. Its hash is bound into the
    # remote-auth canary, but the ledger intentionally carries no host VM name.
    # The campaign binding is already hash-verified above and is the canonical
    # source for the VM identity that is independently checked against Hyper-V's
    # guest registry projection below.
    $liveBinding = Get-Content -LiteralPath $CampaignBindingPath -Raw | ConvertFrom-Json -ErrorAction Stop
    $boundVmName = [string]$liveBinding.vm_name
    $boundVmId = ([string]$liveBinding.vm_id).ToLowerInvariant()
    if([string]::IsNullOrWhiteSpace($boundVmName)-or$boundVmId-cnotmatch'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$'){throw 'Codex Live mode VM binding is invalid'}
    $actualVmId = [string](Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters' -Name VirtualMachineId)
    if ($actualVmId.ToLowerInvariant() -cne $boundVmId) {
        throw 'Codex Live mode requires the pinned Evidence1 E2E VM'
    }
    $RemoteAuthCanaryPath = Resolve-ExistingPath $RemoteAuthCanaryPath 'RemoteAuthCanaryPath' -Leaf
    if ((Get-Sha256 $RemoteAuthCanaryPath) -cne $RemoteAuthCanarySha256) { throw 'remote auth guest blob hash mismatch' }
    try {
        $remoteAuthCanaryRecord = Get-Content -LiteralPath $RemoteAuthCanaryPath -Raw | ConvertFrom-Json -ErrorAction Stop
        Import-Module (Join-Path $PSScriptRoot 'evidence1-live-handoff-contract.psm1') -Force
        $remoteAuthCanary = Assert-Evidence1DualRemoteAuthCanary `
            -Canary $remoteAuthCanaryRecord `
            -ExpectedClaudeVersion $ExpectedClaudeVersion `
            -ExpectedCodexVersion $ExpectedCodexVersion `
            -ExpectedVMName $boundVmName `
            -ExpectedVMId $boundVmId `
            -ExpectedCodexModel 'gpt-5.6-terra' `
            -ExpectedGuestReadinessSha256 $readinessSha256 `
            -NotBeforeUtc $readinessAt `
            -MaxAgeMinutes 30
    } catch {
        throw 'fresh passing dual-runtime remote-auth canary is required for Live mode'
    }
}

Push-Location $HarnessDir
try {
    & $git diff --quiet --exit-code
    if ($LASTEXITCODE -ne 0) { throw 'harness tracked worktree is dirty' }
    & $git diff --cached --quiet --exit-code
    if ($LASTEXITCODE -ne 0) { throw 'harness index is dirty' }
    $untracked = @(& $git ls-files --others --exclude-standard)
    if ($LASTEXITCODE -ne 0 -or $untracked.Count -ne 0) { throw 'harness contains untracked files' }
    $harnessSha = (& $git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $harnessSha -notmatch '^[a-f0-9]{40}$') { throw 'harness commit could not be resolved' }
    $harnessTree = (& $git rev-parse 'HEAD^{tree}').Trim()
    if ($LASTEXITCODE -ne 0 -or $harnessTree -notmatch '^[a-f0-9]{40}$') { throw 'harness tree could not be resolved' }
    $sourceSha = (& $git -C $SourceDir rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $sourceSha -notmatch '^[a-f0-9]{40}$') { throw 'source commit could not be resolved' }

    $offlineStdout = Join-Path $custodyFull 'offline-runtime-preflight.json'
    $offlineStderr = Join-Path $custodyFull 'offline-runtime-preflight.stderr.log'
    $offlinePreflightPath = Join-Path $HarnessDir 'tools\agentic-eval\codex-offline-preflight.mjs'
    $offlineExit = Invoke-CapturedProcess $node @($offlinePreflightPath) $HarnessDir $offlineStdout $offlineStderr $codexIsolationEnv 120
    if ($offlineExit -ne 0) { throw "Codex offline runtime preflight failed with exit code $offlineExit" }
    $offline = Get-Content -LiteralPath $offlineStdout -Raw | ConvertFrom-Json
    if (-not $offline.ok -or $offline.runtime_id -cne $Runtime -or $offline.model_requested -cne $Model -or
        -not $offline.product_skill_available -or -not $offline.product_snapshot_bound -or
        $offline.baseline_skill_available -or -not $offline.ambient_equivalent -or
        [int]$offline.inference_sessions_consumed -ne 0) {
        throw 'Codex offline runtime preflight contract mismatch'
    }

    $commonArgs = @(
        $cliPath, 'run', '--scenario', $Scenario, '--source-repo-dir', $SourceDir,
        '--seed', [string]$Seed, '--runtime', $Runtime, '--model', $Model,
        '--campaign-design', $CampaignDesign, '--isolation-attestation-file', $AttestationFile
    )
    if ($PrivatePatternsFile) { $commonArgs += @('--private-patterns-file', $PrivatePatternsFile) }
    if ($MeasurementScopeFile) { $commonArgs += @('--measurement-scope-file', $MeasurementScopeFile) }

    $dryStdout = Join-Path $custodyFull 'dry-run.stdout.json'
    $dryStderr = Join-Path $custodyFull 'dry-run.stderr.log'
    $dryExit = Invoke-CapturedProcess $node ($commonArgs + '--dry-run') $HarnessDir $dryStdout $dryStderr $codexIsolationEnv 300
    if ($dryExit -ne 0) { throw "Codex campaign dry-run failed with exit code $dryExit" }
    $plan = Get-Content -LiteralPath $dryStdout -Raw | ConvertFrom-Json
    if (-not $plan.dry_run -or $plan.runtime_id -cne $Runtime -or $plan.model_id -cne $Model -or
        $plan.campaign_design_id -cne $CampaignDesign -or [int]$plan.planned_sessions -ne 6 -or
        $null -ne $plan.max_budget_usd -or $plan.max_budget_reason -cne 'runtime_does_not_support_session_budget') {
        throw 'Codex dry-run plan identity or accounting mismatch'
    }
    $actualOrder = @($plan.plan | ForEach-Object { $_.campaign_cell_label })
    $actualConditions = @($plan.plan | ForEach-Object { $_.condition })
    if ([string]::Join(',', $actualOrder) -cne [string]::Join(',', $ExpectedOrder) -or
        [string]::Join(',', $actualConditions) -cne [string]::Join(',', $ExpectedConditions)) {
        throw 'Codex dry-run counterbalancing mismatch'
    }
    if ($Mode -eq 'Live') {
        $bindingPreflight = Get-Content -LiteralPath $CampaignBindingPath -Raw | ConvertFrom-Json -ErrorAction Stop
        $canonicalHarness='C:\kmp-eval\agentic-eval-codex-runtime'
        if(-not([IO.Path]::GetFullPath($HarnessDir).TrimEnd('\').Equals($canonicalHarness,[StringComparison]::OrdinalIgnoreCase))-or-not(Test-Path -LiteralPath (Join-Path $canonicalHarness '.git'))){throw 'canonical_main_worktree_required'}
        $boundScripts=[ordered]@{launcher=$PSCommandPath;wrapper=(Join-Path $PSScriptRoot 'evidence1-final-codex-guest-wrapper.ps1');validation_helper=(Join-Path $PSScriptRoot 'evidence1-validation-ops.psm1');campaign_control=(Join-Path $HarnessDir 'tools\agentic-eval\final-campaign-control.mjs');pilot_describe=(Join-Path $PSScriptRoot 'node-runtime\docs\audits\evidence1-codex-pilot-describe.mjs');publication_scan=(Join-Path $PSScriptRoot 'node-runtime\docs\audits\evidence1-codex-publication-scan.mjs')}
        if(@($bindingPreflight.script_sha256.PSObject.Properties.Name).Count-ne 6){throw 'bound_script_map_invalid'}
        foreach($name in $boundScripts.Keys){if(-not($bindingPreflight.script_sha256.PSObject.Properties.Name-ccontains$name)-or(Get-Sha256 $boundScripts[$name])-cne$bindingPreflight.script_sha256.$name){throw 'bound_script_hash_mismatch'}}
        $null=Assert-NodeRuntimeSnapshot $NodeRuntimeManifestPath $NodeRuntimeManifestSha256 $harnessSha
        $expectedPublicDir = [IO.Path]::GetFullPath((Join-Path $HarnessDir "tools\runs\evidence1-codex-pilot-$($bindingPreflight.campaign_id)"))
        $expectedCustodyDir = [IO.Path]::GetFullPath("C:\Evidence1Custody\$($bindingPreflight.campaign_id)")
        if ($publicFull -cne $expectedPublicDir -or $custodyFull -cne $expectedCustodyDir) {
            throw 'final campaign public/private destinations are not canonical for binding campaign_id'
        }
        $profileHashes = @($plan.plan | ForEach-Object { [string]$_.execution_profile_sha256 } | Select-Object -Unique)
        if ($bindingPreflight.harness_commit -cne $harnessSha -or $bindingPreflight.harness_tree -cne $harnessTree -or $bindingPreflight.source_commit -cne $sourceSha -or
            $bindingPreflight.isolation_attestation_sha256 -cne (Get-Sha256 $AttestationFile) -or
            $bindingPreflight.guest_readiness_sha256 -cne $readinessSha256 -or
            $bindingPreflight.remote_auth_sha256 -cne (Get-Sha256 $RemoteAuthCanaryPath) -or
            $bindingPreflight.remote_auth_operation_id -cne $RemoteAuthCanaryOperationId -or
            $bindingPreflight.global_authorization_claim_sha256 -cne $GlobalAuthorizationClaimSha256 -or
            $profileHashes.Count -ne 1 -or $bindingPreflight.execution_profile_sha256 -cne $profileHashes[0] -or
            $bindingPreflight.toolchain_sha256 -cne $toolchainSha -or $bindingPreflight.scenario_id -cne $Scenario -or
            [int]$bindingPreflight.seed -ne $Seed -or $bindingPreflight.model_requested -cne $Model) {
            throw 'final campaign binding does not match resolved harness/source/attestation/profile/toolchain axes'
        }
    }

    $preflight = [ordered]@{
        schema = 1
        runtime_id = $Runtime
        cli_version = $offline.cli_version
        auth_preflight = 'pass'
        model_requested = $Model
        harness_commit = $harnessSha
        campaign_design_id = $CampaignDesign
        scenario_id = $Scenario
        planned_sessions = 6
        product_sessions = 3
        free_baseline_sessions = 3
        order = $actualOrder
        session_budget_usd = $null
        session_budget_reason = 'runtime_does_not_support_session_budget'
        raw_custody = 'external'
        retries = 'forbidden'
        skill_isolation_preflight = 'pass'
        toolchain_sha256 = $toolchainSha
        inference_sessions_consumed_by_preflight = 0
        remote_auth_canary = if ($Mode -eq 'Live') {
            [ordered]@{
                schema = $remoteAuthCanary.schema
                completed_at_utc = $remoteAuthCanary.completed_at_utc
                authorized_sessions = $remoteAuthCanary.authorized_sessions
                dispatched_sessions = $remoteAuthCanary.dispatched_sessions
                providers = @($remoteAuthCanary.providers)
            }
        } else { 'not_required_for_dry_run' }
    }
    $preflight | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $custodyFull 'preflight-summary.json') -Encoding UTF8
    if ($Mode -eq 'DryRun') {
        $preflight | ConvertTo-Json -Depth 5
        exit 0
    }

    if (-not (Test-Path -LiteralPath $GradleUserHomeSeedDir -PathType Container)) {
        throw 'prewarmed Gradle user-home seed directory missing'
    }
    try {
        $gradleCertification = Get-Content -LiteralPath $GradleCacheCertificationPath -Raw | ConvertFrom-Json -ErrorAction Stop
        $gradleTasks = @($gradleCertification.tasks)
        $gradleTasksMatch = $gradleTasks.Count -eq $ExpectedGradleCacheTasks.Count
        for ($index = 0; $gradleTasksMatch -and $index -lt $ExpectedGradleCacheTasks.Count; $index++) {
            $gradleTasksMatch = [string]$gradleTasks[$index] -ceq $ExpectedGradleCacheTasks[$index]
        }
        if ($gradleCertification.schema -ne 1 -or
            $gradleCertification.kind -cne 'evidence1-gradle-cache-certification' -or
            $gradleCertification.source_commit -cne '7d45eae4f8720a0c77f507712ba2437ff974b6ed' -or
            $gradleCertification.offline_certified -ne $true -or -not $gradleTasksMatch) {
            throw 'mismatch'
        }
    } catch {
        throw 'Gradle cache certification mismatch'
    }

    if ($Authorization -cne $RequiredAuthorization) { throw 'exact six-session authorization phrase is required' }

    $liveStdout = Join-Path $custodyFull 'campaign.stdout.json'
    $liveStderr = Join-Path $custodyFull 'campaign.stderr.log'
    $liveEnvironment = $codexIsolationEnv.Clone()
    $liveEnvironment['KMP_EVAL_RUNS_ROOT'] = $custodyFull
    $liveEnvironment['KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_BINDING'] = $CampaignBindingPath
    $liveEnvironment['KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_BINDING_SHA256'] = $CampaignBindingSha256
    $liveEnvironment['KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_AUTH_CLAIM'] = $AuthorizationClaimPath
    $liveEnvironment['KMP_AGENTIC_EVAL_FINAL_CAMPAIGN_AUTH_CLAIM_SHA256'] = $AuthorizationClaimSha256
    $liveEnvironment['KMP_AGENTIC_EVAL_FINAL_GLOBAL_AUTH_CLAIM'] = $GlobalAuthorizationClaimPath
    $liveEnvironment['KMP_AGENTIC_EVAL_FINAL_GLOBAL_AUTH_CLAIM_SHA256'] = $GlobalAuthorizationClaimSha256
    $liveEnvironment['KMP_AGENTIC_EVAL_GRADLE_USER_HOME_SEED_DIR'] = $GradleUserHomeSeedDir
    # This is the only live campaign dispatch in this script. There is intentionally no loop,
    # retry, replacement, or respawn path.
    $liveExit = Invoke-CapturedProcess $node $commonArgs $HarnessDir $liveStdout $liveStderr $liveEnvironment 7200
    if ($liveExit -ne 0) { throw "Codex campaign failed with exit code $liveExit; no retry is authorized" }

    $campaignOutput = Get-Content -LiteralPath $liveStdout -Raw | ConvertFrom-Json -ErrorAction Stop
    if (@($campaignOutput.records).Count -ne 6) { throw 'campaign stdout must name exactly six records' }
    $records = @()
    $artifacts = @()
    $runIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($index in 0..5) {
        $recordValue = $campaignOutput.records[$index]
        if (-not $runIds.Add([string]$recordValue.run_id) -or [int]$recordValue.order_index -ne $index -or
            [string]$recordValue.condition -cne $ExpectedConditions[$index]) { throw 'campaign stdout record identity mismatch' }
        $recordPath = Join-Path ([string]$campaignOutput.evidenceDir) (([string]$recordValue.run_id) + '.json')
        $sidecarPath = Join-Path ([string]$campaignOutput.evidenceDir) ([string]$recordValue.accepted_audit.relative_path -replace '/', '\')
        $recordPath = Resolve-ExistingPath $recordPath "record[$index]" -Leaf
        $sidecarPath = Resolve-ExistingPath $sidecarPath "sidecar[$index]" -Leaf
        $validateStdout = Join-Path $custodyFull "validate-$index.stdout.json"
        $validateStderr = Join-Path $custodyFull "validate-$index.stderr.log"
        if ((Invoke-CapturedProcess $node @($cliPath, 'validate', '--run', $recordPath) $HarnessDir $validateStdout $validateStderr @{} 120) -ne 0) {
            throw "record validation failed for slot $index"
        }
        $records += $recordPath
        $artifacts += [ordered]@{ order_index = $index; record_path = $recordPath; record_sha256 = Get-Sha256 $recordPath; sidecar_path = $sidecarPath; sidecar_sha256 = Get-Sha256 $sidecarPath }
    }

    $binding = Get-Content -LiteralPath $CampaignBindingPath -Raw | ConvertFrom-Json -ErrorAction Stop
    $claimHashes = @()
    foreach ($index in 0..5) {
        foreach ($name in @('slot.claim.json', 'plan.claim.json')) {
            $claim = Resolve-ExistingPath (Join-Path (Split-Path -Parent $CampaignBindingPath) "slots\$index\$name") "claim[$index/$name]" -Leaf
            $claimHashes += [ordered]@{ order_index = $index; name = $name; sha256 = Get-Sha256 $claim }
        }
    }
    $groupClaim = Resolve-ExistingPath (Join-Path (Split-Path -Parent $CampaignBindingPath) 'group.claim.json') 'group claim' -Leaf
    $custodyIdentity = [ordered]@{ schema = 1; campaign_id = $binding.campaign_id; campaign_design_id = $CampaignDesign; sessions_executed = 6; retry_count = 0; slot_order = $ExpectedOrder }
    $campaignCustody = [ordered]@{
        schema = 1; kind = 'evidence1-final-codex-campaign-custody'; identity = $custodyIdentity
        binding_sha256 = $CampaignBindingSha256; authorization_claim_sha256 = $AuthorizationClaimSha256
        global_authorization_claim_sha256 = $GlobalAuthorizationClaimSha256; remote_auth_sha256 = $RemoteAuthCanarySha256
        group_claim_sha256 = Get-Sha256 $groupClaim; slot_and_plan_claims = $claimHashes; artifacts = $artifacts
        exact_session_count_evidence = 'six durable pre-spawn slot claims and six unique accepted records'
        retry_count = 0; replacement_or_respawn_used = $false; benchmark_eligible = $false
    }
    $custodyPath = Join-Path $custodyFull 'campaign-custody.json'
    Write-JsonCreateNew $custodyPath $campaignCustody
    $custodySha = Get-Sha256 $custodyPath
    $manifest = [ordered]@{
        schema = 1
        expected = [ordered]@{
            runtime_id = 'codex-cli'; cli_version = '0.154.0'; model_requested = 'gpt-5.6-terra'; model_resolved = 'gpt-5.6-terra'
            scenario_id = $Scenario; seed = $Seed; execution_profile_id = $binding.execution_profile_id
            execution_profile_sha256 = $binding.execution_profile_sha256; source_commit = $binding.source_commit
            harness_commit = $harnessSha; isolation_attestation_sha256 = $binding.isolation_attestation_sha256
            skill_source_commit = $binding.skill_source_commit; skill_snapshot_sha256 = $binding.skill_snapshot_sha256
            platform = 'windows'; binding_sha256 = $CampaignBindingSha256; campaign_custody_sha256 = $custodySha; campaign_custody_identity = $custodyIdentity
        }
        artifacts = $artifacts
    }
    $manifestPath = Join-Path $custodyFull 'pilot-describe-manifest.json'
    Write-JsonCreateNew $manifestPath $manifest
    $summaryPath = Join-Path $custodyFull 'summary.json'
    if($Mode-eq'Live'){$null=Assert-NodeRuntimeSnapshot $NodeRuntimeManifestPath $NodeRuntimeManifestSha256}
    $describePath = Join-Path $PSScriptRoot 'node-runtime\docs\audits\evidence1-codex-pilot-describe.mjs'
    $describeStdout = Join-Path $custodyFull 'describe.stdout.log'
    $describeStderr = Join-Path $custodyFull 'describe.stderr.log'
    if ((Invoke-CapturedProcess $node @($describePath, '--manifest', $manifestPath, '--output', $summaryPath) $HarnessDir $describeStdout $describeStderr @{} 120) -ne 0) {
        throw 'descriptive reducer failed'
    }
    $publicationManifest = [ordered]@{
        schema = 1; kind = 'evidence1-final-codex-publication-manifest'; campaign_id = $binding.campaign_id; binding_sha256 = $CampaignBindingSha256
        campaign_custody_sha256 = $custodySha; summary_sha256 = Get-Sha256 $summaryPath
        records = @($artifacts | ForEach-Object { [ordered]@{ order_index = $_.order_index; name = Split-Path -Leaf $_.record_path; sha256 = $_.record_sha256 } })
        public_file_count = 8; sidecars_published = $false; raw_published = $false
    }
    Write-JsonCreateNew (Join-Path $custodyFull 'publication-manifest.json') $publicationManifest

    $completion = [ordered]@{
        schema = 1
        status = 'complete'
        sessions_executed = 6
        records_validated = 6
        sidecars_validated = 6
        aggregate = 'not-applicable:benchmark_ineligible_records_are_rejected_by_publishable_aggregate'
        analysis = 'not-applicable:benchmark_ineligible_records_are_excluded_from_publishable_analysis'
        retry_count = 0
        benchmark_eligible = $false
    }

    $stage = $publicFull + '.staging-' + [guid]::NewGuid().ToString('N')
    try {
        New-Item -ItemType Directory -Path $stage | Out-Null
        foreach ($record in $records) { Copy-Item -LiteralPath $record -Destination (Join-Path $stage (Split-Path -Leaf $record)) }
        Copy-Item -LiteralPath $summaryPath -Destination (Join-Path $stage 'summary.json')
        Copy-Item -LiteralPath (Join-Path $custodyFull 'publication-manifest.json') -Destination (Join-Path $stage 'manifest.json')
        if ((Get-ChildItem -LiteralPath $stage -File).Count -ne 8) { throw 'atomic publication closed-set mismatch' }
        foreach ($entry in $publicationManifest.records) {
            if ((Get-Sha256 (Join-Path $stage $entry.name)) -cne $entry.sha256) { throw 'staged publication record hash mismatch' }
        }
        if ((Get-Sha256 (Join-Path $stage 'summary.json')) -cne $publicationManifest.summary_sha256) { throw 'staged publication summary hash mismatch' }
        if($Mode-eq'Live'){$null=Assert-NodeRuntimeSnapshot $NodeRuntimeManifestPath $NodeRuntimeManifestSha256}
        $scanArgs = @((Join-Path $PSScriptRoot 'node-runtime\docs\audits\evidence1-codex-publication-scan.mjs'))
        foreach ($file in @(Get-ChildItem -LiteralPath $stage -File | Sort-Object Name)) { $scanArgs += @('--file', $file.FullName) }
        if ($PrivatePatternsFile) { $scanArgs += @('--private-patterns-file', $PrivatePatternsFile) }
        $scanStdout = Join-Path $custodyFull 'publication-scan.stdout.json'
        $scanStderr = Join-Path $custodyFull 'publication-scan.stderr.log'
        if ((Invoke-CapturedProcess $node $scanArgs $HarnessDir $scanStdout $scanStderr @{} 120) -ne 0) { throw 'publication privacy scan failed' }
        Move-Item -LiteralPath $stage -Destination $publicFull
        $stage = $null
    } finally {
        if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force }
    }
    $completion | ConvertTo-Json -Depth 4
} finally {
    Pop-Location
}
