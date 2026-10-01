Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-E1VmIdentitySha256([string]$Path) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
    } finally { $stream.Dispose() }
}

function Assert-E1VmIdentityNoReparseAncestors([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'vm_identity_reparse_rejected'
            }
        }
        $parent = Split-Path -Parent $cursor
        if (-not $parent -or $parent -ceq $cursor) { break }
        $cursor = $parent
    }
}

function Read-E1VmIdentityJson([string]$Path, [string]$Code) {
    $full = [IO.Path]::GetFullPath($Path)
    Assert-E1VmIdentityNoReparseAncestors $full
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw $Code }
    $item = Get-Item -LiteralPath $full -Force
    if ($item.Length -gt 1MB) { throw $Code }
    try {
        $bytes = [IO.File]::ReadAllBytes($full)
        $json = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
        # PowerShell 7.5+ otherwise materializes ISO-8601 JSON strings as DateTime.
        # Identity checks compare the original wire value and parse it explicitly below.
        $convert = Get-Command ConvertFrom-Json -ErrorAction Stop
        $value = if ($convert.Parameters.ContainsKey('DateKind')) {
            $json | ConvertFrom-Json -DateKind String -ErrorAction Stop
        } else {
            $json | ConvertFrom-Json -ErrorAction Stop
        }
    } catch { throw $Code }
    if ($null -eq $value -or $value -is [array]) { throw $Code }
    return [ordered]@{ path = $full; sha256 = Get-E1VmIdentitySha256 $full; value = $value }
}

function Assert-E1VmIdentityExactKeys($Value, [string[]]$Expected, [string]$Code) {
    if ($null -eq $Value) { throw $Code }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    if (@(Compare-Object $actual @($Expected | Sort-Object)).Count -ne 0) { throw $Code }
}

function Assert-E1VmIdentityPathInside([string]$Path, [string]$Root, [string]$Code) {
    $full = [IO.Path]::GetFullPath($Path)
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    if (-not $full.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)) { throw $Code }
    return $full
}

function Get-E1VmIdentityCanonicalProfilePath {
    # Elevated-runner deployments preserve reviewed repo files below node-runtime.
    # The source-tree fallback keeps read-only validation usable before deployment;
    # neither location is selected by the request author.
    $deployed = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'node-runtime\tools\evidence1\provisioning\evidence1-windows-hyperv-e2e-v1.json'))
    $source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\tools\evidence1\provisioning\evidence1-windows-hyperv-e2e-v1.json'))
    if (Test-Path -LiteralPath $deployed -PathType Leaf) { return $deployed }
    return $source
}

# Audited profile amendments (plan-author amendment WO-10a).
#
# The created-inspection receipt and the custody marker of the canonical E2E VM were sealed on 2026-09-14 against the
# sha256 of the profile as it was then (startup_memory_bytes 8589934592, 8 GiB). The profile's memory setting was changed
# afterwards, outside the sealed chain: to 16 GiB in 91cb129, then locked to the validated 12 GiB (12884901888) in 07e5d1f.
# The profile hash is now c8330a3f..., and startup_memory_bytes is the ONLY difference between the sealed profile and the
# current one (git diff of the sealed version, commit 990223f, against develop). Memory is not part of the VM's identity:
# vm_id is still contrasted with Hyper-V below, and the input lock, the receipt, the marker and the guest credential stay bound.
# The table is closed: ONE entry, from the sealed hash to the current hash. Any other pair fails closed, as before.
$script:E1VmIdentityProfileAmendments = @(
    [pscustomobject]@{ from_sha256 = '2d9bbe2b31b363197bdcc1e89292d21e7ad44a0f71ccc7627406d218cb7140b9'; to_sha256 = 'c8330a3f68d2df456ce8b32a953942897edf8451d8f556c7eb3bb3de41d8f81f' }
)

function Test-E1VmIdentityProfileBound([string]$RecordedSha256, [string]$CurrentSha256) {
    if ($RecordedSha256 -ceq $CurrentSha256) { return $true }
    foreach ($amendment in $script:E1VmIdentityProfileAmendments) {
        if ($RecordedSha256 -ceq $amendment.from_sha256 -and $CurrentSha256 -ceq $amendment.to_sha256) { return $true }
    }
    return $false
}

function Get-Evidence1CanonicalE2EVmIdentity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ProfilePath,
        [Parameter(Mandatory)][string]$CreatedInspectionReceiptPath,
        [Parameter(Mandatory)][string]$GuestCredentialPath
    )

    $canonicalProfilePath = Get-E1VmIdentityCanonicalProfilePath
    if (-not ([IO.Path]::GetFullPath($ProfilePath).Equals($canonicalProfilePath, [StringComparison]::OrdinalIgnoreCase))) {
        throw 'vm_identity_profile_path_not_canonical'
    }
    $profileReceipt = Read-E1VmIdentityJson $canonicalProfilePath 'vm_identity_profile_invalid'
    $profile = $profileReceipt.value
    if ($profile.schema_version -ne 2 -or $profile.profile_id -cne 'evidence1-windows-hyperv-e2e-v1' -or
        $profile.platform -cne 'windows' -or $profile.hypervisor -cne 'hyper-v' -or
        $null -eq $profile.vm -or $null -eq $profile.guest -or $null -eq $profile.network -or $null -eq $profile.os -or
        $profile.vm.name -cne 'Evidence1-Runner-E2E' -or
        -not ([IO.Path]::GetFullPath([string]$profile.vm.root).TrimEnd('\').Equals('C:\kmp-eval\hyperv-e2e', [StringComparison]::OrdinalIgnoreCase)) -or
        $profile.guest.computer_name -cne 'Evidence1E2E' -or $profile.guest.local_user -cne 'Evidence1E2E' -or
        $profile.os.installation_boundary -cne 'offline-apply' -or
        $profile.network.create_state -cne 'disconnected' -or
        $profile.network.bootstrap_state -cne 'disconnected' -or
        $profile.network.checkpoint_state -cne 'disconnected') { throw 'vm_identity_profile_invalid' }
    $vmName = [string]$profile.vm.name
    $vmRoot = [IO.Path]::GetFullPath([string]$profile.vm.root).TrimEnd('\')
    $guestComputerName = [string]$profile.guest.computer_name
    $guestUser = [string]$profile.guest.local_user
    if ([string]::IsNullOrWhiteSpace($vmName) -or [string]::IsNullOrWhiteSpace($guestComputerName) -or
        [string]::IsNullOrWhiteSpace($guestUser) -or -not [IO.Path]::IsPathRooted($vmRoot)) {
        throw 'vm_identity_profile_invalid'
    }

    $inspectionFull = Assert-E1VmIdentityPathInside $CreatedInspectionReceiptPath 'C:\kmp-eval\scratch' 'vm_identity_inspection_path_invalid'
    $inspectionReceipt = Read-E1VmIdentityJson $inspectionFull 'vm_identity_inspection_invalid'
    $inspection = $inspectionReceipt.value
    Assert-E1VmIdentityExactKeys $inspection @(
        'schema','verdict','mode','profile_id','generated_at_utc','profile_sha256','input_lock_sha256','vm_id',
        'vm_state','vhd_partition_style','network_state','original_iso_is_only_dvd','drift_fields',
        'mutation_performed','inputs','inference_sessions_consumed'
    ) 'vm_identity_inspection_invalid'
    $vmId = ([string]$inspection.vm_id).ToLowerInvariant()
    if ($inspection.schema -ne 1 -or $inspection.verdict -cne 'PASS' -or $inspection.mode -cne 'InspectCreated' -or
        $inspection.profile_id -cne $profile.profile_id -or -not (Test-E1VmIdentityProfileBound ([string]$inspection.profile_sha256) ([string]$profileReceipt.sha256)) -or
        [string]$inspection.input_lock_sha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $vmId -cnotmatch '^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$' -or
        $inspection.vm_state -cne 'Off' -or $inspection.vhd_partition_style -cne 'RAW' -or
        $inspection.network_state -cne 'disconnected' -or $inspection.original_iso_is_only_dvd -ne $true -or
        @($inspection.drift_fields).Count -ne 0 -or $inspection.mutation_performed -ne $false -or
        [int]$inspection.inference_sessions_consumed -ne 0 -or
        [string]$inspection.inputs.input_lock_sha256 -cne [string]$inspection.input_lock_sha256) {
        throw 'vm_identity_inspection_invalid'
    }

    $markerPath = Join-Path (Join-Path (Join-Path $vmRoot $vmName) 'custody') 'windows-offline-apply-1.consumed.json'
    $markerReceipt = Read-E1VmIdentityJson $markerPath 'vm_identity_custody_invalid'
    $marker = $markerReceipt.value
    Assert-E1VmIdentityExactKeys $marker @(
        'schema','profile_id','vm_id','profile_sha256','input_lock_sha256','created_inspection_receipt_sha256',
        'guest_credential_sha256','consumed_at_utc','authorized_start_count'
    ) 'vm_identity_custody_invalid'
    if ($marker.schema -ne 1 -or $marker.profile_id -cne $profile.profile_id -or
        ([string]$marker.vm_id).ToLowerInvariant() -cne $vmId -or
        -not (Test-E1VmIdentityProfileBound ([string]$marker.profile_sha256) ([string]$profileReceipt.sha256)) -or
        $marker.input_lock_sha256 -cne $inspection.input_lock_sha256 -or
        $marker.created_inspection_receipt_sha256 -cne $inspectionReceipt.sha256 -or
        [string]$marker.guest_credential_sha256 -cnotmatch '^[0-9a-f]{64}$' -or
        [int]$marker.authorized_start_count -ne 1) { throw 'vm_identity_custody_invalid' }
    $consumedAt = [DateTime]::MinValue
    if (-not [DateTime]::TryParse([string]$marker.consumed_at_utc, [ref]$consumedAt)) { throw 'vm_identity_custody_invalid' }

    # The hash chain establishes provenance; Hyper-V is the final authority that
    # prevents a caller from presenting a different, internally consistent VM.
    try { $hostVm = @(Get-VM -Name $vmName -ErrorAction Stop) } catch { throw 'vm_identity_hyperv_authority_unavailable' }
    if ($hostVm.Count -ne 1 -or ([string]$hostVm[0].Id).ToLowerInvariant() -cne $vmId) {
        throw 'vm_identity_hyperv_mismatch'
    }

    $credentialFull = Assert-E1VmIdentityPathInside $GuestCredentialPath 'C:\kmp-eval\scratch' 'vm_identity_guest_credential_path_invalid'
    Assert-E1VmIdentityNoReparseAncestors $credentialFull
    if (-not (Test-Path -LiteralPath $credentialFull -PathType Leaf) -or
        (Get-E1VmIdentitySha256 $credentialFull) -cne $marker.guest_credential_sha256) {
        throw 'vm_identity_guest_credential_mismatch'
    }

    return [pscustomobject][ordered]@{
        profile_id = [string]$profile.profile_id
        profile_path = $profileReceipt.path
        profile_sha256 = $profileReceipt.sha256
        created_inspection_receipt_path = $inspectionReceipt.path
        created_inspection_receipt_sha256 = $inspectionReceipt.sha256
        input_lock_sha256 = [string]$inspection.input_lock_sha256
        custody_marker_path = $markerReceipt.path
        custody_marker_sha256 = $markerReceipt.sha256
        guest_credential_path = $credentialFull
        guest_credential_sha256 = [string]$marker.guest_credential_sha256
        vm_name = $vmName
        vm_id = $vmId
        vm_root = $vmRoot
        guest_computer_name = $guestComputerName
        guest_user = $guestUser
    }
}

Export-ModuleMember -Function Get-Evidence1CanonicalE2EVmIdentity
