BeforeAll {
    # Import inside BeforeAll, not bare top-level -- see
    # Evidence1-Network-Backend-Contract.Tests.ps1's BeforeAll comment for why.
    $script:ModulePath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/audits/evidence1-network-backend-hyperv.psm1'
    Import-Module $script:ModulePath -Force
}

# Maintainer-answered open question 4 (Phase 3c): NetworkBackend's guest-transport
# helper (Invoke-E1NetworkHyperVGuestCommand, private) needed its own timeout,
# cancellation, and a stable error code -- brought up to parity with
# evidence1-guest-bundle-hyperv.psm1's Invoke-E1GuestBundle, which already had
# all three.
#
# Testing-limitation addendum (Phase 3c fix-forward round): the original
# version of this file tried to verify the timeout-then-cancel path and the
# success path by mocking New-PSSession to return a plain [pscustomobject]
# standing in for a session. That does not work, and cannot be made to work
# with this technique: System.Management.Automation.Runspaces.PSSession has
# NO public constructor (confirmed via reflection -- [PSSession].GetConstructors()
# returns nothing), so no fake object can ever satisfy the -Session parameter's
# [PSSession[]] type on Invoke-Command OR Remove-PSSession -- both throw a
# parameter-binding ArgumentTransformationException for a non-PSSession value,
# and Pester's Mock preserves the original cmdlet's parameter types even when
# the mock body itself is replaced, so mocking does not route around this.
# $null fails a DIFFERENT way (Invoke-Command -Session has
# [ValidateNotNullOrEmpty()]). This was root-caused empirically (isolated
# repro scripts, not guessed) before concluding it is a genuine tooling limit,
# not a fixable test bug.
#
# What IS reliably testable without a real PSSession: the out-of-range guard
# (never opens a session) and the "every candidate fails to even connect"
# path (New-PSSession itself throws, so $session stays $null for every
# iteration and neither Invoke-Command nor Remove-PSSession -- the two calls
# that need a real session -- are ever reached). Both are exercised below.
# The Wait-Job-times-out branch and the success/Receive-Job branch were
# manually traced against evidence1-guest-bundle-hyperv.psm1's identical,
# already-established Invoke-Command -AsJob/Wait-Job -Timeout/cleanup shape
# rather than left unverified; see the architecture note for this being
# flagged as an open question rather than silently claimed as tested.
Describe 'Evidence1 NetworkBackend guest-transport timeout, cancellation and stable error code' {
    It 'rejects an out-of-range timeout before opening any session' {
        InModuleScope evidence1-network-backend-hyperv {
            Mock New-PSSession { }
            $credPath = Join-Path $TestDrive 'guest-cred-range.xml'
            ([pscredential]::new('vmuser', (ConvertTo-SecureString 'placeholder' -AsPlainText -Force))) | Export-Clixml -Path $credPath
            $vm = [pscustomobject]@{ Name = 'FakeVM' }
            { Invoke-E1NetworkHyperVGuestCommand $vm $credPath { 'unused' } @() -TimeoutSeconds 1 } | Should -Throw '*network_backend_guest_transport_timeout_out_of_range*'
            { Invoke-E1NetworkHyperVGuestCommand $vm $credPath { 'unused' } @() -TimeoutSeconds 1000 } | Should -Throw '*network_backend_guest_transport_timeout_out_of_range*'
            Should -Invoke New-PSSession -Times 0 -Exactly
        }
    }

    It 'tries every candidate logon name, keeps the dynamic "failed: <detail>" shape, and never attempts cleanup that needs a session' {
        InModuleScope evidence1-network-backend-hyperv {
            Mock New-PSSession { throw 'simulated connection failure' }
            # Also mocked (never expected to be called) purely so Should
            # -Invoke below can assert zero calls -- Pester requires a
            # command to have been Mock-ed, even trivially, before it can
            # be asserted on at all.
            Mock Invoke-Command { }
            Mock Remove-PSSession { }
            Mock Stop-Job { }
            Mock Remove-Job { }
            $credPath = Join-Path $TestDrive 'guest-cred-connectfail.xml'
            ([pscredential]::new('vmuser', (ConvertTo-SecureString 'placeholder' -AsPlainText -Force))) | Export-Clixml -Path $credPath
            $vm = [pscustomobject]@{ Name = 'FakeVM' }

            { Invoke-E1NetworkHyperVGuestCommand $vm $credPath { 'unused' } @() -TimeoutSeconds 5 } |
              Should -Throw '*network_backend_guest_transport_failed: simulated connection failure*'

            # Four candidate logon names: "$VMName\$user", ".\$user", "$user",
            # "localhost\$user" -- see the function's own header.
            Should -Invoke New-PSSession -Times 4 -Exactly
            Should -Invoke Invoke-Command -Times 0 -Exactly
            Should -Invoke Remove-PSSession -Times 0 -Exactly
            Should -Invoke Stop-Job -Times 0 -Exactly
            Should -Invoke Remove-Job -Times 0 -Exactly
        }
    }
}

Describe 'Evidence1 NetworkBackend stopped-VM offline convergence' {
    It 'disconnects an Off VM adapter and reports offline without invoking the guest' {
        InModuleScope evidence1-network-backend-hyperv {
            $vmId = [guid]::NewGuid().ToString()
            Mock Assert-E1NetworkGuestCredentialPath { param($Path) $Path }
            Mock Get-VM { [pscustomobject]@{ Name = 'FakeVM'; Id = $vmId; State = 'Off' } }
            Mock Set-E1NetworkHyperVAdapterConnected { }
            Mock Get-E1NetworkState {
                New-E1NetworkModeResult -Mode 'offline' -VMName 'FakeVM' -VMId $vmId `
                    -AdapterConnected $false -SwitchName $null -FirewallDefaultOutbound 'Block' `
                    -PinnedHosts @() -WatchdogArmed $false -WatchdogExpiresAtUtc $null
            }
            Mock Invoke-E1NetworkHyperVGuestSealOffline { }

            $result = Invoke-E1NetworkEnsureMode -VMName 'FakeVM' -GuestCredentialPath 'ignored.xml' -TargetMode 'offline'

            $result.verdict | Should -BeExactly 'PASS'
            $result.mode | Should -BeExactly 'offline'
            Should -Invoke Set-E1NetworkHyperVAdapterConnected -Times 1 -Exactly -ParameterFilter { $Connected -eq $false }
            Should -Invoke Invoke-E1NetworkHyperVGuestSealOffline -Times 0 -Exactly
        }
    }
}
