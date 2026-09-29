#Requires -RunAsAdministrator
param(
 [string]$VMName='Evidence1-Runner-E2E',[string]$ExpectedVMId='fd7c0298-186f-4a8e-9ae8-0a8af6969d14',
 [string]$SourceAttestationPath='C:\kmp-eval\measurement-scopes\evidence1-claude-windows-isolation-attestation-stageb-v1.json',
 [string]$OutPath='C:\kmp-eval\measurement-scopes\evidence1-codex-windows-isolation-attestation.json',
 [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedHarnessCommit,
 [Parameter(Mandatory)][string]$ReportPath
)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-final-codex-host-contract.psm1') -Force -DisableNameChecking
if([IO.Path]::GetFullPath($SourceAttestationPath)-cne'C:\kmp-eval\measurement-scopes\evidence1-claude-windows-isolation-attestation-stageb-v1.json'-or[IO.Path]::GetFullPath($OutPath)-cne'C:\kmp-eval\measurement-scopes\evidence1-codex-windows-isolation-attestation.json'){throw 'attestation_paths_not_canonical'}
if((Test-Path -LiteralPath $OutPath)-or(Test-Path -LiteralPath $ReportPath)){throw 'attestation_destination_must_be_create_new'}
$source=Get-Content -LiteralPath $SourceAttestationPath -Raw|ConvertFrom-Json -ErrorAction Stop
if($source.schema-ne 1-or$source.profile_id-cne'sandboxed-unrestricted-v1'-or$source.runtime_id-cne'claude-code'-or$source.platform-cne'windows'-or$source.network_mode-cne'restricted'-or$source.harness_sha-cne$ExpectedHarnessCommit){throw 'source_attestation_invalid'}
$now=[datetime]::UtcNow;$value=[ordered]@{schema=1;profile_id='sandboxed-unrestricted-v1';runtime_id='codex-cli';campaign_id='evidence1-codex-product-free-final';platform='windows';boundary_kind=[string]$source.boundary_kind;network_mode='restricted';workspace_scope=[string]$source.workspace_scope;runtime_credential_scope=[string]$source.runtime_credential_scope;normal_maintainer_home_mounted=$false;ambient_secrets_present=$false;disposable_home=$true;rollback_or_destroy_required=$true;harness_sha=[string]$source.harness_sha;created_at=$now.ToString('yyyy-MM-ddTHH:mm:ssZ');expires_at=$now.AddHours(23).ToString('yyyy-MM-ddTHH:mm:ssZ')}
$json=$value|ConvertTo-Json -Depth 5;$bytes=[Text.UTF8Encoding]::new($false).GetBytes($json)
$vm=Get-VM -Name $VMName -ErrorAction Stop;if(([string]$vm.Id).ToLowerInvariant()-cne$ExpectedVMId.ToLowerInvariant()-or[string]$vm.State-cne'Off'){throw 'exact_vm_must_be_off'}
$disk=(Get-VMHardDiskDrive -VMName $VMName|Select-Object -First 1).Path;$mount=$null
try{$mount=Mount-VHD -Path $disk -Passthru -ErrorAction Stop;$root=Get-E1FinalMountedWindowsRoot $mount;$guest=Join-Path $root 'kmp-eval\measurement-scopes\evidence1-codex-windows-isolation-attestation.json';if(Test-Path -LiteralPath $guest){throw 'guest_attestation_must_be_create_new'};$s=[IO.File]::Open($guest,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);try{$s.Write($bytes,0,$bytes.Length);$s.Flush($true)}finally{$s.Dispose()}}finally{if($mount){Dismount-VHD -Path $disk -ErrorAction SilentlyContinue}}
$s=[IO.File]::Open($OutPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read);try{$s.Write($bytes,0,$bytes.Length);$s.Flush($true)}finally{$s.Dispose()}
$hash=(Get-FileHash -LiteralPath $OutPath -Algorithm SHA256).Hash.ToLowerInvariant();New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReportPath)|Out-Null
[IO.File]::WriteAllText($ReportPath,([ordered]@{schema=1;verdict='PASS';runtime_id='codex-cli';attestation_sha256=$hash;host_guest_exact_bytes=$true;vm_state='Off';generated_at_utc=[datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false));Write-Host "[evidence1-create-final-codex-attestation] PASS: $ReportPath"
