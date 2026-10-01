# WO-10a: the sealed VM identity chain (created-inspection receipt and custody marker) was sealed against an earlier
# version of the canonical E2E VM profile. The profile's memory setting changed afterwards (8 GiB, then 16 GiB, then the
# validated 12 GiB), so the sealed profile hash no longer equals the current one. The identity contract accepts the sealed
# hash through ONE audited amendment (sealed hash -> current hash); every other pair still fails closed.
# The helper is tested directly, and the whole function is driven with fixtures for the inspection receipt, the profile
# and the custody marker (no Hyper-V, no real files: the module's readers are replaced inside the module scope).
BeforeAll {
    $script:RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $script:ModulePath = Join-Path $script:RepoRoot 'docs/audits/evidence1-vm-identity-contract.psm1'
    Import-Module $script:ModulePath -Force
    $script:ModuleName = 'evidence1-vm-identity-contract'

    $script:SealedHash = '2d9bbe2b31b363197bdcc1e89292d21e7ad44a0f71ccc7627406d218cb7140b9'
    $script:CurrentHash = 'c8330a3f68d2df456ce8b32a953942897edf8451d8f556c7eb3bb3de41d8f81f'
    $script:OtherHash = ('ab' * 32)
    $script:VmId = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14'
    $script:InputLock = ('cd' * 32)
    $script:InspectionSha = ('ef' * 32)
    $script:CredentialSha = ('01' * 32)
    $script:ProfilePath = 'C:\kmp-eval\fixture-profile\evidence1-windows-hyperv-e2e-v1.json'
    $script:InspectionPath = 'C:\kmp-eval\scratch\fixture-inspection\INSPECT-CREATED.receipt.json'
    $script:CredentialPath = 'C:\kmp-eval\scratch\fixture-credential\guest-credential.clixml'

    function script:New-Fixture([string]$InspectionHash, [string]$MarkerHash, [string]$ProfileHash) {
        $profile = [pscustomobject]@{
            schema_version = 2; profile_id = 'evidence1-windows-hyperv-e2e-v1'; platform = 'windows'; hypervisor = 'hyper-v'
            vm = [pscustomobject]@{ name = 'Evidence1-Runner-E2E'; root = 'C:\kmp-eval\hyperv-e2e' }
            guest = [pscustomobject]@{ computer_name = 'Evidence1E2E'; local_user = 'Evidence1E2E' }
            network = [pscustomobject]@{ create_state = 'disconnected'; bootstrap_state = 'disconnected'; checkpoint_state = 'disconnected' }
            os = [pscustomobject]@{ installation_boundary = 'offline-apply' }
        }
        $inspection = [pscustomobject]@{
            schema = 1; verdict = 'PASS'; mode = 'InspectCreated'; profile_id = 'evidence1-windows-hyperv-e2e-v1'
            generated_at_utc = '2026-09-14T05:14:03.078Z'; profile_sha256 = $InspectionHash; input_lock_sha256 = $script:InputLock
            vm_id = $script:VmId; vm_state = 'Off'; vhd_partition_style = 'RAW'; network_state = 'disconnected'
            original_iso_is_only_dvd = $true; drift_fields = @(); mutation_performed = $false
            inputs = [pscustomobject]@{ input_lock_sha256 = $script:InputLock }; inference_sessions_consumed = 0
        }
        $marker = [pscustomobject]@{
            schema = 1; profile_id = 'evidence1-windows-hyperv-e2e-v1'; vm_id = $script:VmId; profile_sha256 = $MarkerHash
            input_lock_sha256 = $script:InputLock; created_inspection_receipt_sha256 = $script:InspectionSha
            guest_credential_sha256 = $script:CredentialSha; consumed_at_utc = '2026-09-14T05:20:04.891Z'; authorized_start_count = 1
        }
        return @{ Profile = $profile; Inspection = $inspection; Marker = $marker; ProfileHash = $ProfileHash }
    }

    # Replaces the module's file, Hyper-V and path readers with fixture-backed versions, inside the module scope.
    function script:Use-Fixture($Fixture) {
        $script:CurrentFixture = $Fixture
        InModuleScope $script:ModuleName -Parameters @{ F = $Fixture; Inspection = $script:InspectionSha; VmId = $script:VmId; CredentialSha = $script:CredentialSha; ProfilePath = $script:ProfilePath } {
            param($F, $Inspection, $VmId, $CredentialSha, $ProfilePath)
            $script:FixtureData = $F; $script:FixtureInspectionSha = $Inspection; $script:FixtureVmId = $VmId
            $script:FixtureCredentialSha = $CredentialSha; $script:FixtureProfilePath = $ProfilePath
            function script:Get-E1VmIdentityCanonicalProfilePath { return $script:FixtureProfilePath }
            function script:Read-E1VmIdentityJson([string]$Path, [string]$Code) {
                $full = [IO.Path]::GetFullPath($Path)
                if ($full -ceq $script:FixtureProfilePath) { return [ordered]@{ path = $full; sha256 = $script:FixtureData.ProfileHash; value = $script:FixtureData.Profile } }
                if ($full -like '*INSPECT-CREATED*') { return [ordered]@{ path = $full; sha256 = $script:FixtureInspectionSha; value = $script:FixtureData.Inspection } }
                if ($full -like '*windows-offline-apply-1.consumed.json') { return [ordered]@{ path = $full; sha256 = ('23' * 32); value = $script:FixtureData.Marker } }
                throw $Code
            }
            function script:Assert-E1VmIdentityNoReparseAncestors([string]$Path) { }
            function script:Get-E1VmIdentitySha256([string]$Path) { return $script:FixtureCredentialSha }
            function script:Get-VM { param($Name, $ErrorAction) return [pscustomobject]@{ Id = [guid]$script:FixtureVmId } }
            function script:Test-Path { param($LiteralPath, $PathType) return $true }
        }
    }

    function script:Invoke-Identity {
        return Get-Evidence1CanonicalE2EVmIdentity -ProfilePath $script:ProfilePath -CreatedInspectionReceiptPath $script:InspectionPath -GuestCredentialPath $script:CredentialPath
    }
    function script:Get-ThrownCode([scriptblock]$Body) {
        try { & $Body | Out-Null; return $null } catch { return [string]$_.Exception.Message }
    }
}

AfterAll {
    Remove-Module $script:ModuleName -Force -ErrorAction SilentlyContinue
}

Describe 'the profile amendment helper' {
    It 'binds a recorded hash that equals the current one' {
        InModuleScope $script:ModuleName -Parameters @{ C = $script:CurrentHash } { param($C) Test-E1VmIdentityProfileBound $C $C } | Should -BeTrue
    }

    It 'binds the sealed hash to the current profile hash (the one audited amendment)' {
        InModuleScope $script:ModuleName -Parameters @{ S = $script:SealedHash; C = $script:CurrentHash } { param($S, $C) Test-E1VmIdentityProfileBound $S $C } | Should -BeTrue
    }

    It 'fails closed for an unknown recorded hash' {
        InModuleScope $script:ModuleName -Parameters @{ O = $script:OtherHash; C = $script:CurrentHash } { param($O, $C) Test-E1VmIdentityProfileBound $O $C } | Should -BeFalse
    }

    It 'fails closed when the sealed hash is presented with any profile other than the audited current one' {
        InModuleScope $script:ModuleName -Parameters @{ S = $script:SealedHash; O = $script:OtherHash } { param($S, $O) Test-E1VmIdentityProfileBound $S $O } | Should -BeFalse
    }

    It 'is directional: the current hash is not a sealed hash for the earlier profile' {
        InModuleScope $script:ModuleName -Parameters @{ S = $script:SealedHash; C = $script:CurrentHash } { param($S, $C) Test-E1VmIdentityProfileBound $C $S } | Should -BeFalse
    }

    It 'compares exactly: an upper-case spelling of the sealed hash is not the sealed hash' {
        InModuleScope $script:ModuleName -Parameters @{ S = $script:SealedHash; C = $script:CurrentHash } { param($S, $C) Test-E1VmIdentityProfileBound $S.ToUpperInvariant() $C } | Should -BeFalse
    }

    It 'keeps a closed table of exactly one amendment, from the sealed hash to the current hash' {
        $table = @(InModuleScope $script:ModuleName { @($script:E1VmIdentityProfileAmendments | ForEach-Object { "$($_.from_sha256)>$($_.to_sha256)" }) })
        $table.Count | Should -Be 1
        $table[0] | Should -BeExactly ($script:SealedHash + '>' + $script:CurrentHash)
    }
}

Describe 'Get-Evidence1CanonicalE2EVmIdentity with the amended profile binding' {
    It 'passes when the inspection receipt and the marker carry the sealed hash and the profile is the audited current one' {
        Use-Fixture (New-Fixture -InspectionHash $script:SealedHash -MarkerHash $script:SealedHash -ProfileHash $script:CurrentHash)
        $identity = Invoke-Identity
        $identity.profile_sha256 | Should -BeExactly $script:CurrentHash
        $identity.vm_id | Should -BeExactly $script:VmId
    }

    It 'passes, with no regression, when both carry the current hash directly' {
        Use-Fixture (New-Fixture -InspectionHash $script:CurrentHash -MarkerHash $script:CurrentHash -ProfileHash $script:CurrentHash)
        (Invoke-Identity).profile_sha256 | Should -BeExactly $script:CurrentHash
    }

    It 'fails closed with vm_identity_inspection_invalid for an unknown hash in the inspection receipt' {
        Use-Fixture (New-Fixture -InspectionHash $script:OtherHash -MarkerHash $script:SealedHash -ProfileHash $script:CurrentHash)
        Get-ThrownCode { Invoke-Identity } | Should -BeExactly 'vm_identity_inspection_invalid'
    }

    It 'fails closed for the sealed hash when the current profile is not the audited one' {
        Use-Fixture (New-Fixture -InspectionHash $script:SealedHash -MarkerHash $script:SealedHash -ProfileHash $script:OtherHash)
        Get-ThrownCode { Invoke-Identity } | Should -BeExactly 'vm_identity_inspection_invalid'
    }

    It 'fails closed with vm_identity_custody_invalid for an unknown hash in the marker even when the inspection is valid' {
        Use-Fixture (New-Fixture -InspectionHash $script:SealedHash -MarkerHash $script:OtherHash -ProfileHash $script:CurrentHash)
        Get-ThrownCode { Invoke-Identity } | Should -BeExactly 'vm_identity_custody_invalid'
    }

    It 'still rejects a marker bound to another VM, whatever the profile hash' {
        $fixture = New-Fixture -InspectionHash $script:SealedHash -MarkerHash $script:SealedHash -ProfileHash $script:CurrentHash
        $fixture.Marker.vm_id = '11111111-1111-4111-8111-111111111111'
        Use-Fixture $fixture
        Get-ThrownCode { Invoke-Identity } | Should -BeExactly 'vm_identity_custody_invalid'
    }
}
