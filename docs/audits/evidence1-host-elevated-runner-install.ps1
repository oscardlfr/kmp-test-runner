#Requires -RunAsAdministrator

param(
  [string]$TaskName = 'Evidence1HostElevatedRunner',
  [string]$RunnerPath = '',
  [string]$QueueRoot = 'C:\kmp-eval\scratch\host-elevated-runner',
  [string]$AllowedRoot = '',
  [ValidateSet('System','InteractiveUser')]
  [string]$ExecutionIdentity = 'System',
  [string]$ReportPath = 'C:\kmp-eval\scratch\host-elevated-runner\INSTALL.json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail($Message) {
  Write-Error "HARD STOP: $Message"
  exit 1
}

function Resolve-FullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

function Get-E1InstallSha256([string]$Path) {
  $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try{$hasher=[Security.Cryptography.SHA256]::Create();try{return([BitConverter]::ToString($hasher.ComputeHash($stream))-replace'-','').ToLowerInvariant()}finally{$hasher.Dispose()}}finally{$stream.Dispose()}
}

function Start-E1InstallGitBlobProcess([string]$GitPath,[string]$RepositoryRoot,[string]$BlobOid) {
  if($BlobOid-cnotmatch'^[0-9a-f]{40,64}$'){Fail 'canonical source blob identity invalid'}
  $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$GitPath
  $start.Arguments='-C "'+$RepositoryRoot.Replace('"','\"')+'" cat-file blob '+$BlobOid
  $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  $process=[Diagnostics.Process]::new();$process.StartInfo=$start
  if(-not$process.Start()){Fail 'canonical source blob process failed to start'}
  return $process
}

function Get-E1InstallGitBlobSha256([string]$GitPath,[string]$RepositoryRoot,[string]$BlobOid) {
  $process=Start-E1InstallGitBlobProcess $GitPath $RepositoryRoot $BlobOid
  try{
    $hash=[Security.Cryptography.SHA256]::Create();try{$value=([BitConverter]::ToString($hash.ComputeHash($process.StandardOutput.BaseStream))-replace'-','').ToLowerInvariant()}finally{$hash.Dispose()}
    $stderr=$process.StandardError.ReadToEnd();$process.WaitForExit()
    if($process.ExitCode-ne 0){Fail 'canonical source blob unavailable'}
    return $value
  }finally{$process.Dispose()}
}

function Get-E1InstallGitBlobText([string]$GitPath,[string]$RepositoryRoot,[string]$BlobOid) {
  $process=Start-E1InstallGitBlobProcess $GitPath $RepositoryRoot $BlobOid
  try{
    $memory=[IO.MemoryStream]::new();try{$buffer=New-Object byte[] 65536;$tooLarge=$false;while(($read=$process.StandardOutput.BaseStream.Read($buffer,0,$buffer.Length))-gt 0){if($memory.Length+$read-gt 1048576){$tooLarge=$true;break};$memory.Write($buffer,0,$read)};if($tooLarge){try{$process.StandardOutput.Close()}catch{};if(-not$process.WaitForExit(1000)){try{$process.Kill()}catch{};if(-not$process.WaitForExit(1000)){Fail 'canonical runner blob producer could not be reaped'}};Fail 'canonical runner blob exceeds parse bound'};$bytes=$memory.ToArray()}finally{$memory.Dispose()}
    $stderr=$process.StandardError.ReadToEnd();$process.WaitForExit()
    if($process.ExitCode-ne 0){Fail 'canonical runner blob unavailable'}
    try{return [Text.UTF8Encoding]::new($false,$true).GetString($bytes)}catch{Fail 'canonical runner blob is not strict UTF-8'}
  }finally{try{if(-not$process.HasExited){$process.Kill();$process.WaitForExit()}}catch{};$process.Dispose()}
}

function Write-E1InstallGitBlob([string]$GitPath,[string]$RepositoryRoot,[string]$BlobOid,[string]$Destination) {
  $process=Start-E1InstallGitBlobProcess $GitPath $RepositoryRoot $BlobOid
  try{
    $stream=[IO.FileStream]::new($Destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read,4096,[IO.FileOptions]::WriteThrough)
    try{$process.StandardOutput.BaseStream.CopyTo($stream);$stream.Flush($true)}finally{$stream.Dispose()}
    $stderr=$process.StandardError.ReadToEnd();$process.WaitForExit()
    if($process.ExitCode-ne 0){Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue;Fail 'canonical source blob materialization failed'}
  }finally{$process.Dispose()}
}

function Assert-E1InstallNoReparse([string]$Path) {
  $cursor=Resolve-FullPath $Path
  while($cursor){if(Test-Path -LiteralPath $cursor){$item=Get-Item -LiteralPath $cursor -Force;if(($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){Fail 'install source or deployment reparse rejected'}};$parent=Split-Path -Parent $cursor;if(-not$parent-or$parent-ceq$cursor){break};$cursor=$parent}
}

function Assert-E1InstallDirectFile([string]$Path,[string]$Root,[string]$Leaf) {
  $full=Resolve-FullPath $Path;$expected=Resolve-FullPath (Join-Path $Root $Leaf)
  if(-not$full.Equals($expected,[StringComparison]::OrdinalIgnoreCase)){Fail "file must be the exact direct child: $Leaf"}
  Assert-E1InstallNoReparse $Root;Assert-E1InstallNoReparse $full
  if(-not(Test-Path -LiteralPath $full -PathType Leaf)-or(Get-Item -LiteralPath $full -Force).PSIsContainer){Fail "regular file required: $Leaf"}
  return $full
}

function Convert-E1InstallNodeRelativePath([string]$RelativePath) {
  if([string]::IsNullOrWhiteSpace($RelativePath)-or$RelativePath.Contains('\')-or$RelativePath.StartsWith('/')-or$RelativePath-cmatch'(^|/)(\.|\.\.)(/|$)'-or$RelativePath-cmatch':'){Fail 'runner node entry invalid'}
  return $RelativePath.Replace('/',[IO.Path]::DirectorySeparatorChar)
}

function Assert-E1InstallRepoFile([string]$RepoRoot,[string]$RelativePath) {
  $native=Convert-E1InstallNodeRelativePath $RelativePath;$full=Resolve-FullPath (Join-Path $RepoRoot $native);$prefix=(Resolve-FullPath $RepoRoot).TrimEnd('\')+'\'
  if(-not$full.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){Fail 'runner node entry escaped repository'}
  Assert-E1InstallNoReparse $RepoRoot;Assert-E1InstallNoReparse $full
  if(-not(Test-Path -LiteralPath $full -PathType Leaf)-or(Get-Item -LiteralPath $full -Force).PSIsContainer){Fail 'runner node source is not a regular file'}
  return $full
}

function Write-E1InstallCreateNew([string]$Path,[byte[]]$Bytes) {
  $stream=[IO.FileStream]::new($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read,4096,[IO.FileOptions]::WriteThrough)
  try{$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}

function Import-E1InstallSecurityModule {
  $modulePath=Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
  if(-not(Test-Path -LiteralPath $modulePath -PathType Leaf)){Fail 'matching PowerShell Security module is unavailable'}
  try{Import-Module -Name $modulePath -Force -ErrorAction Stop}
  catch{Fail 'matching PowerShell Security module could not be loaded'}
}

function Set-E1InstallProtectedAcl([string]$Path,[string]$PrincipalSid,[bool]$Directory) {
  $security=if($Directory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
  $security.SetAccessRuleProtection($true,$false);$admin=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544');$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18');$principal=[Security.Principal.SecurityIdentifier]::new($PrincipalSid);$security.SetOwner($admin)
  $inherit=if($Directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
  foreach($rule in @(
    [Security.AccessControl.FileSystemAccessRule]::new($system,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow),
    [Security.AccessControl.FileSystemAccessRule]::new($admin,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow),
    [Security.AccessControl.FileSystemAccessRule]::new($principal,[Security.AccessControl.FileSystemRights]::ReadAndExecute,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  )){$security.AddAccessRule($rule)|Out-Null}
  Set-Acl -LiteralPath $Path -AclObject $security
}

function Assert-E1InstallProtectedAcl([string]$Path,[string]$PrincipalSid,[bool]$Directory) {
  $acl=Get-Acl -LiteralPath $Path;$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if($owner-cne'S-1-5-32-544'-or-not$acl.AreAccessRulesProtected){Fail 'elevated runner deployment owner or inheritance invalid'}
  $rules=@($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]));if($rules.Count-ne 3){Fail 'elevated runner deployment DACL is not closed'}
  $readExecute=[int]([Security.AccessControl.FileSystemRights]::ReadAndExecute-bor[Security.AccessControl.FileSystemRights]::Synchronize)
  $expected=@{'S-1-5-18'=[int][Security.AccessControl.FileSystemRights]::FullControl;'S-1-5-32-544'=[int][Security.AccessControl.FileSystemRights]::FullControl;$PrincipalSid=$readExecute}
  foreach($rule in $rules){$sid=$rule.IdentityReference.Value;if(-not$expected.ContainsKey($sid)-or$rule.AccessControlType-ne[Security.AccessControl.AccessControlType]::Allow-or[int]$rule.FileSystemRights-ne$expected[$sid]-or$rule.PropagationFlags-ne[Security.AccessControl.PropagationFlags]::None){Fail 'elevated runner deployment DACL is not closed'};$wanted=if($Directory){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None};if($rule.InheritanceFlags-ne$wanted){Fail 'elevated runner deployment DACL inheritance invalid'}}
}

function Assert-E1InstallClosedSet([string]$Root,[string[]]$ExpectedLeaves,[string[]]$ExpectedNodeFiles) {
  $actualTopDirs=@(Get-ChildItem -LiteralPath $Root -Directory -Force|ForEach-Object{$_.Name}|Sort-Object)
  if(@(Compare-Object $actualTopDirs @('node-runtime')).Count-ne 0){Fail 'elevated runner deployment directory set mismatch'}
  $actual=@(Get-ChildItem -LiteralPath $Root -File -Force|ForEach-Object{$_.Name}|Sort-Object);$expected=@($ExpectedLeaves|Sort-Object)
  if(@(Compare-Object $actual $expected).Count-ne 0){Fail 'elevated runner deployment file set mismatch'}
  $nodeRoot=Resolve-FullPath (Join-Path $Root 'node-runtime');Assert-E1InstallNoReparse $nodeRoot
  $actualNode=@(Get-ChildItem -LiteralPath $nodeRoot -File -Force -Recurse|ForEach-Object{$_.FullName.Substring($nodeRoot.Length+1).Replace('\','/')}|Sort-Object)
  $expectedDirs=@{};foreach($name in $ExpectedNodeFiles){$parent=Split-Path -Parent (Convert-E1InstallNodeRelativePath $name);while($parent){$expectedDirs[$parent.Replace('\','/')]=$true;$next=Split-Path -Parent $parent;if($next-ceq$parent){break};$parent=$next}}
  $actualDirs=@(Get-ChildItem -LiteralPath $nodeRoot -Directory -Force -Recurse|ForEach-Object{if(($_.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne 0){Fail 'elevated runner node deployment set mismatch'};$_.FullName.Substring($nodeRoot.Length+1).Replace('\','/')}|Sort-Object)
  if(@(Compare-Object $actualNode @($ExpectedNodeFiles|Sort-Object)).Count-ne 0-or@(Compare-Object $actualDirs @($expectedDirs.Keys|Sort-Object)).Count-ne 0){Fail 'elevated runner node deployment set mismatch'}
}

function New-E1InstallDeploymentRoot([string]$Base,[string]$Name,[string]$ManifestSha256) {
  if($ManifestSha256-cnotmatch'^[0-9a-f]{64}$'){Fail 'deployment manifest identity invalid'}
  return Join-Path $Base ($Name+'-'+$ManifestSha256+'-'+[guid]::NewGuid().ToString('N'))
}

function Read-E1InstallLiteralStringArray($Assignment) {
  $right=$Assignment.Right
  if($right-isnot[Management.Automation.Language.CommandExpressionAst]-or$right.Expression-isnot[Management.Automation.Language.ArrayExpressionAst]){Fail 'runner trust assignment is not a literal array'}
  $statements=@($right.Expression.SubExpression.Statements)
  if($statements.Count-ne 1-or$statements[0]-isnot[Management.Automation.Language.PipelineAst]-or@($statements[0].PipelineElements).Count-ne 1){Fail 'runner trust assignment is not a literal array'}
  $command=$statements[0].PipelineElements[0]
  if($command-isnot[Management.Automation.Language.CommandExpressionAst]-or$command.Expression-isnot[Management.Automation.Language.ArrayLiteralAst]){Fail 'runner trust assignment is not a literal array'}
  $values=@();foreach($element in @($command.Expression.Elements)){if($element-isnot[Management.Automation.Language.StringConstantExpressionAst]-or$element.StringConstantType-ne[Management.Automation.Language.StringConstantType]::SingleQuoted){Fail 'runner trust assignment contains non-literal data'};$values+=[string]$element.Value}
  if($values.Count-eq 0){Fail 'runner trust assignment is empty'}
  return $values
}

function Assert-PathInside([string]$Candidate, [string]$Root, [string]$Label) {
  $candidateFull = Resolve-FullPath $Candidate
  $rootFull = (Resolve-FullPath $Root).TrimEnd('\') + '\'
  if (-not $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "$Label path is outside expected root: $candidateFull"
  }
}

function Test-E1InstallTaskRunAccessMask([long]$AccessMask) {
  $mask=[uint32]$AccessMask
  # The Task Scheduler maps GENERIC_EXECUTE to task-specific rights before the
  # descriptor is read back. TASK_RUN is 0x8; 0x4 is TASK_STATE (read-only).
  return (($mask-band[uint32]0x20000000)-ne 0-or($mask-band[uint32]0x00000008)-ne 0)
}

function Set-E1InstallTaskRunAcl([string]$Name,[string]$PrincipalSid) {
  $service=New-Object -ComObject 'Schedule.Service';$service.Connect();$folder=$service.GetFolder('\');$registered=$folder.GetTask($Name)
  $sddl="O:BAG:SYD:(A;;FA;;;SY)(A;;FA;;;BA)(A;;GRGX;;;$PrincipalSid)"
  # TASK_DONT_ADD_PRINCIPAL_ACE keeps the DACL exact instead of implicitly
  # granting the SYSTEM task principal another redundant entry.
  $registered.SetSecurityDescriptor($sddl,0x10)
  $observed=$registered.GetSecurityDescriptor(15);$raw=[Security.AccessControl.RawSecurityDescriptor]::new($observed)
  $runAllowed=$false
  foreach($ace in $raw.DiscretionaryAcl){
    if($ace.SecurityIdentifier.Value-cne$PrincipalSid-or$ace.AceQualifier-ne[Security.AccessControl.AceQualifier]::AccessAllowed){continue}
    if(Test-E1InstallTaskRunAccessMask $ace.AccessMask){$runAllowed=$true}
  }
  if(-not$runAllowed){Fail 'installed task does not grant the requestor on-demand run access'}
}

$AllowedRoot = if ([string]::IsNullOrWhiteSpace($AllowedRoot)) {
  Resolve-FullPath $PSScriptRoot
} else {
  Resolve-FullPath $AllowedRoot
}
$sourceAllowedRoot=$AllowedRoot
$sourceRepoRoot=Resolve-FullPath (Join-Path $AllowedRoot '..\..')
if(-not$AllowedRoot.Equals((Resolve-FullPath (Join-Path $sourceRepoRoot 'docs\audits')),[StringComparison]::OrdinalIgnoreCase)){Fail 'allowed root is not the canonical audits directory'}
Assert-E1InstallNoReparse $sourceRepoRoot
$RunnerPath = if ([string]::IsNullOrWhiteSpace($RunnerPath)) {
  Resolve-FullPath (Join-Path $AllowedRoot 'evidence1-host-elevated-runner.ps1')
} else {
  Resolve-FullPath $RunnerPath
}
$QueueRoot = Resolve-FullPath $QueueRoot
$ReportPath = Resolve-FullPath $ReportPath
Assert-PathInside $QueueRoot 'C:\kmp-eval\scratch\' 'queue'
Assert-PathInside $ReportPath 'C:\kmp-eval\scratch\' 'report'
$RunnerPath=Assert-E1InstallDirectFile $RunnerPath $AllowedRoot 'evidence1-host-elevated-runner.ps1'
$processModulePath=Assert-E1InstallDirectFile (Join-Path $AllowedRoot 'evidence1-validation-ops.psm1') $AllowedRoot 'evidence1-validation-ops.psm1'
if($TaskName-cnotmatch'^[A-Za-z0-9_.-]+$'){Fail 'task name is not safe for deployment identity'}
$git=Get-Command git.exe -ErrorAction SilentlyContinue;if(-not$git){$git=Get-Command git -ErrorAction SilentlyContinue};if(-not$git){Fail 'canonical source git unavailable'}
$headOutput=@(& $git.Source -C $sourceRepoRoot rev-parse HEAD 2>$null);if($LASTEXITCODE-ne 0-or$headOutput.Count-ne 1-or[string]$headOutput[0]-cnotmatch'^[0-9a-f]{40,64}$'){Fail 'canonical source commit unavailable'};$sourceGitCommit=[string]$headOutput[0]
$runnerRelativePath='docs/audits/evidence1-host-elevated-runner.ps1';$runnerBlobOutput=@(& $git.Source -C $sourceRepoRoot rev-parse "${sourceGitCommit}:$runnerRelativePath" 2>$null)
if($LASTEXITCODE-ne 0-or$runnerBlobOutput.Count-ne 1-or[string]$runnerBlobOutput[0]-cnotmatch'^[0-9a-f]{40,64}$'){Fail 'canonical runner blob unavailable'};$runnerSourceBlob=[string]$runnerBlobOutput[0]
$runnerSourceText=Get-E1InstallGitBlobText $git.Source $sourceRepoRoot $runnerSourceBlob

# Read only the literal AllowedScripts assignment from the reviewed runner AST;
# do not execute source code to derive the privileged allowlist.
$tokens=$null;$parseErrors=$null;$runnerAst=[Management.Automation.Language.Parser]::ParseInput($runnerSourceText,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count-ne 0){Fail 'runner source does not parse'}
$assignments=@($runnerAst.FindAll({param($node)$node-is[Management.Automation.Language.AssignmentStatementAst]-and$node.Left-is[Management.Automation.Language.VariableExpressionAst]-and$node.Left.VariablePath.UserPath-ceq'AllowedScripts'},$true))
$supportAssignments=@($runnerAst.FindAll({param($node)$node-is[Management.Automation.Language.AssignmentStatementAst]-and$node.Left-is[Management.Automation.Language.VariableExpressionAst]-and$node.Left.VariablePath.UserPath-ceq'TrustedSupportFiles'},$true))
$nodeAssignments=@($runnerAst.FindAll({param($node)$node-is[Management.Automation.Language.AssignmentStatementAst]-and$node.Left-is[Management.Automation.Language.VariableExpressionAst]-and$node.Left.VariablePath.UserPath-ceq'TrustedNodeFiles'},$true))
if($assignments.Count-ne 1-or$supportAssignments.Count-ne 1-or$nodeAssignments.Count-ne 1){Fail 'runner trust assignments missing or ambiguous'}
$allowedScripts=@(Read-E1InstallLiteralStringArray $assignments[0]);$trustedSupportFiles=@(Read-E1InstallLiteralStringArray $supportAssignments[0]);$trustedNodeFiles=@(Read-E1InstallLiteralStringArray $nodeAssignments[0])
$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach($name in $allowedScripts){if([string]$name-cnotmatch'^[A-Za-z0-9_.-]+\.ps1$'-or-not$seen.Add([string]$name)){Fail 'runner allowlist entry invalid or duplicate'};$null=Assert-E1InstallDirectFile (Join-Path $AllowedRoot $name) $AllowedRoot $name}
foreach($name in $trustedSupportFiles){if([string]$name-cnotmatch'^[A-Za-z0-9_.-]+\.(ps1|psm1|mjs)$'-or-not$seen.Add([string]$name)){Fail 'runner support entry invalid or duplicate'};$null=Assert-E1InstallDirectFile (Join-Path $AllowedRoot $name) $AllowedRoot $name}
$nodeSources=@{};foreach($name in $trustedNodeFiles){$null=Convert-E1InstallNodeRelativePath $name;if(-not$seen.Add('node-runtime/'+[string]$name)){Fail 'runner node entry invalid or duplicate'};$nodeSources[[string]$name]=Assert-E1InstallRepoFile $sourceRepoRoot $name}
$trustedRepoPaths=@('docs/audits/evidence1-host-elevated-runner.ps1','docs/audits/evidence1-validation-ops.psm1')+@($allowedScripts|ForEach-Object{'docs/audits/'+$_})+@($trustedSupportFiles|ForEach-Object{'docs/audits/'+$_})+@($trustedNodeFiles)
$trustedBlobMap=@{};foreach($relative in $trustedRepoPaths){$blobOutput=@(& $git.Source -C $sourceRepoRoot rev-parse "${sourceGitCommit}:$relative" 2>$null);if($LASTEXITCODE-ne 0-or$blobOutput.Count-ne 1-or[string]$blobOutput[0]-cnotmatch'^[0-9a-f]{40,64}$'){Fail 'canonical source trusted file untracked'};$trustedBlobMap[[string]$relative]=[string]$blobOutput[0]}
& $git.Source -C $sourceRepoRoot diff --quiet $sourceGitCommit -- @trustedRepoPaths;if($LASTEXITCODE-ne 0){Fail 'canonical source trusted file dirty'}
$entries=@();foreach($name in $allowedScripts){$relative='docs/audits/'+$name;$entries+=[ordered]@{name=[string]$name;sha256=Get-E1InstallGitBlobSha256 $git.Source $sourceRepoRoot $trustedBlobMap[$relative]}}
if($entries.Count-eq 0){Fail 'runner allowlist is empty'}
$supportEntries=@();foreach($name in $trustedSupportFiles){$relative='docs/audits/'+$name;$supportEntries+=[ordered]@{name=[string]$name;sha256=Get-E1InstallGitBlobSha256 $git.Source $sourceRepoRoot $trustedBlobMap[$relative]}}
if($supportEntries.Count-eq 0){Fail 'runner support set is empty'}
$nodeEntries=@();foreach($name in $trustedNodeFiles){$nodeEntries+=[ordered]@{name=[string]$name;sha256=Get-E1InstallGitBlobSha256 $git.Source $sourceRepoRoot $trustedBlobMap[$name];blob_oid=$trustedBlobMap[$name]}}
if($nodeEntries.Count-eq 0){Fail 'runner node set is empty'}
Import-E1InstallSecurityModule
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principalSid=$identity.User.Value
$manifest=[ordered]@{schema=2;kind='evidence1-host-elevated-runner-manifest';principal_sid=$principalSid;source_git_commit=$sourceGitCommit;runner_sha256=Get-E1InstallGitBlobSha256 $git.Source $sourceRepoRoot $trustedBlobMap['docs/audits/evidence1-host-elevated-runner.ps1'];process_module_sha256=Get-E1InstallGitBlobSha256 $git.Source $sourceRepoRoot $trustedBlobMap['docs/audits/evidence1-validation-ops.psm1'];scripts=$entries;support_files=$supportEntries;node_files=$nodeEntries}
$manifestBytes=[Text.UTF8Encoding]::new($false).GetBytes(($manifest|ConvertTo-Json -Depth 6 -Compress)+"`n")
$manifestHasher=[Security.Cryptography.SHA256]::Create();try{$manifestSha=([BitConverter]::ToString($manifestHasher.ComputeHash($manifestBytes))-replace'-','').ToLowerInvariant()}finally{$manifestHasher.Dispose()}
$deploymentBase=Resolve-FullPath (Join-Path $env:ProgramData 'KmpEval\Evidence1ElevatedRunner');New-Item -ItemType Directory -Force -Path $deploymentBase|Out-Null;Assert-E1InstallNoReparse $deploymentBase;Set-E1InstallProtectedAcl $deploymentBase $principalSid $true;Assert-E1InstallProtectedAcl $deploymentBase $principalSid $true
$deploymentRoot=New-E1InstallDeploymentRoot $deploymentBase $TaskName $manifestSha;$stagingRoot=$deploymentRoot+'.staging'
if((Test-Path -LiteralPath $deploymentRoot)-or(Test-Path -LiteralPath $stagingRoot)){Fail 'unpredictable deployment collision'}
New-Item -ItemType Directory -Path $stagingRoot -ErrorAction Stop|Out-Null
try{
    Set-E1InstallProtectedAcl $stagingRoot $principalSid $true;Assert-E1InstallProtectedAcl $stagingRoot $principalSid $true
    foreach($relative in @('docs/audits/evidence1-host-elevated-runner.ps1','docs/audits/evidence1-validation-ops.psm1')+@($allowedScripts|ForEach-Object{'docs/audits/'+$_})+@($trustedSupportFiles|ForEach-Object{'docs/audits/'+$_})){Write-E1InstallGitBlob $git.Source $sourceRepoRoot $trustedBlobMap[$relative] (Join-Path $stagingRoot (Split-Path -Leaf $relative))}
    $nodeRoot=Join-Path $stagingRoot 'node-runtime';New-Item -ItemType Directory -Path $nodeRoot -ErrorAction Stop|Out-Null
    foreach($name in $trustedNodeFiles){$destination=Join-Path $nodeRoot (Convert-E1InstallNodeRelativePath $name);$parent=Split-Path -Parent $destination;if(-not(Test-Path -LiteralPath $parent)){New-Item -ItemType Directory -Path $parent -Force -ErrorAction Stop|Out-Null};Write-E1InstallGitBlob $git.Source $sourceRepoRoot $trustedBlobMap[$name] $destination}
    Write-E1InstallCreateNew (Join-Path $stagingRoot 'evidence1-host-elevated-runner-manifest.json') $manifestBytes
    $expectedLeaves=@('evidence1-host-elevated-runner.ps1','evidence1-validation-ops.psm1','evidence1-host-elevated-runner-manifest.json')+@($allowedScripts)+@($trustedSupportFiles);Assert-E1InstallClosedSet $stagingRoot $expectedLeaves $trustedNodeFiles
    foreach($directory in @(Get-ChildItem -LiteralPath $stagingRoot -Directory -Force -Recurse|Sort-Object{$_.FullName.Length})){Set-E1InstallProtectedAcl $directory.FullName $principalSid $true;Assert-E1InstallProtectedAcl $directory.FullName $principalSid $true}
    foreach($file in @(Get-ChildItem -LiteralPath $stagingRoot -File -Force -Recurse)){Set-E1InstallProtectedAcl $file.FullName $principalSid $false;Assert-E1InstallProtectedAcl $file.FullName $principalSid $false}
    if((Get-E1InstallSha256 (Join-Path $stagingRoot 'evidence1-host-elevated-runner.ps1'))-cne$manifest.runner_sha256-or(Get-E1InstallSha256 (Join-Path $stagingRoot 'evidence1-validation-ops.psm1'))-cne$manifest.process_module_sha256){Fail 'deployed runner identity mismatch'}
    foreach($entry in $entries){if((Get-E1InstallSha256 (Join-Path $stagingRoot $entry.name))-cne$entry.sha256){Fail 'deployed allowlist identity mismatch'}}
    foreach($entry in $supportEntries){if((Get-E1InstallSha256 (Join-Path $stagingRoot $entry.name))-cne$entry.sha256){Fail 'deployed support identity mismatch'}}
    foreach($entry in $nodeEntries){if((Get-E1InstallSha256 (Join-Path $nodeRoot (Convert-E1InstallNodeRelativePath $entry.name)))-cne$entry.sha256){Fail 'deployed node identity mismatch'}}
    Assert-E1InstallClosedSet $stagingRoot $expectedLeaves $trustedNodeFiles;Assert-E1InstallProtectedAcl $stagingRoot $principalSid $true
    [IO.Directory]::Move($stagingRoot,$deploymentRoot)
}finally{if(Test-Path -LiteralPath $stagingRoot){Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue}}
Assert-E1InstallNoReparse $deploymentRoot;Assert-E1InstallClosedSet $deploymentRoot $expectedLeaves $trustedNodeFiles;Assert-E1InstallProtectedAcl $deploymentRoot $principalSid $true
foreach($directory in @(Get-ChildItem -LiteralPath $deploymentRoot -Directory -Force -Recurse)){Assert-E1InstallProtectedAcl $directory.FullName $principalSid $true};foreach($file in @(Get-ChildItem -LiteralPath $deploymentRoot -File -Force -Recurse)){Assert-E1InstallProtectedAcl $file.FullName $principalSid $false}
$deployedManifestPath=Join-Path $deploymentRoot 'evidence1-host-elevated-runner-manifest.json';if((Get-E1InstallSha256 $deployedManifestPath)-cne$manifestSha){Fail 'deployed manifest changed after rename'}
if((Get-E1InstallSha256 (Join-Path $deploymentRoot 'evidence1-host-elevated-runner.ps1'))-cne$manifest.runner_sha256-or(Get-E1InstallSha256 (Join-Path $deploymentRoot 'evidence1-validation-ops.psm1'))-cne$manifest.process_module_sha256){Fail 'deployed runner changed after rename'}
foreach($entry in $entries){if((Get-E1InstallSha256 (Join-Path $deploymentRoot $entry.name))-cne$entry.sha256){Fail 'deployed allowlist changed after rename'}}
foreach($entry in $supportEntries){if((Get-E1InstallSha256 (Join-Path $deploymentRoot $entry.name))-cne$entry.sha256){Fail 'deployed support changed after rename'}}
foreach($entry in $nodeEntries){if((Get-E1InstallSha256 (Join-Path (Join-Path $deploymentRoot 'node-runtime') (Convert-E1InstallNodeRelativePath $entry.name)))-cne$entry.sha256){Fail 'deployed node changed after rename'}}
$RunnerPath=Assert-E1InstallDirectFile (Join-Path $deploymentRoot 'evidence1-host-elevated-runner.ps1') $deploymentRoot 'evidence1-host-elevated-runner.ps1'
$AllowedRoot=$deploymentRoot

New-Item -ItemType Directory -Force -Path $QueueRoot,(Split-Path -Parent $ReportPath) | Out-Null

$taskLogonType = 'ServiceAccount'
$taskRunAs = 'SYSTEM'
$actionArgs = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RunnerPath`" -QueueRoot `"$QueueRoot`" -AllowedRoot `"$AllowedRoot`" -Once"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $actionArgs
if($ExecutionIdentity-ceq'InteractiveUser'){
  $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Highest
  $taskLogonType = 'InteractiveToken'
  $taskRunAs = $identity.Name
}else{
  $principal = New-ScheduledTaskPrincipal `
    -UserId 'SYSTEM' `
    -LogonType ServiceAccount `
    -RunLevel Highest
}
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -Hidden `
  -ExecutionTimeLimit (New-TimeSpan -Hours 8) `
  -MultipleInstances IgnoreNew

$task = New-ScheduledTask -Action $action -Principal $principal -Settings $settings
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
Set-E1InstallTaskRunAcl $TaskName $principalSid

$report = [ordered]@{
  verdict = 'PASS'
  generated_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  task_name = $TaskName
  runner_path = $RunnerPath
  allowed_root = $AllowedRoot
  source_allowed_root = $sourceAllowedRoot
  allowlist_manifest_sha256 = $manifestSha
  queue_root = $QueueRoot
  execution_identity = $ExecutionIdentity
  run_level = 'Highest'
  logon_type = $taskLogonType
  run_as = $taskRunAs
  non_interactive = $true
  window_hidden = $true
  requestor_on_demand_run = $true
}

($report | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $ReportPath -Encoding UTF8
Write-Host "[host-elevated-runner-install] PASS: $TaskName"
