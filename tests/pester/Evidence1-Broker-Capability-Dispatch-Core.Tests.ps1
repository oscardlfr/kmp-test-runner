# Genuinely exercises Invoke-E1BrokerCapabilityRoute -- the routing logic
# evidence1-host-broker-capability-dispatch.ps1 calls inside the elevated
# broker -- against the REAL *-fake.psm1 siblings (never the *-hyperv.psm1
# ones; those require Hyper-V and stay untouched by this engagement). This
# works because *-fake.psm1 and *-hyperv.psm1 export IDENTICALLY-named,
# identically-shaped functions (an already-verified parity property, see
# docs/audits/evidence1-phase3c-architecture-note.md section 13.3).
#
# UPDATED (incident fix -- see
# docs/audits/evidence1-incident-2026-09-19-real-queue-trigger.md):
# Invoke-E1BrokerCapabilityRoute no longer resolves its target purely by
# NAME against whatever is imported -- that ambiguity is what let a
# same-named real queue-client function win over an intended fake when both
# were loaded, which is what caused the incident. It now resolves by name
# AND an explicit module of provenance, defaulting to the registry's own
# real/hyperv module_file (the production profile) unless a caller passes
# -ModuleNameOverrides. This file imports ONLY the *-fake.psm1 siblings, so
# every call below passes $script:FakeModuleNameOverrides explicitly --
# this is now the routing layer's own required, explicit "simulator/test
# profile" declaration, not an implicit consequence of what happens to be
# imported.
BeforeAll {
    $script:AuditsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\docs\audits')).Path
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-broker-capability-contract.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-broker-capability-dispatch-core.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-broker-status-fake.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-vm-state-fake.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-network-backend-fake.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-guest-bundle-fake.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-artifact-copy-fake.psm1') -Force

    $script:FakeModuleNameOverrides = @{
        'broker.status'            = 'evidence1-broker-status-fake'
        'vm.inspect'               = 'evidence1-vm-state-fake'
        'vm.ensure_state'          = 'evidence1-vm-state-fake'
        'network.inspect'          = 'evidence1-network-backend-fake'
        'network.ensure_mode'      = 'evidence1-network-backend-fake'
        'guest.invoke_bundle'      = 'evidence1-guest-bundle-fake'
        'artifacts.copy_read_only' = 'evidence1-artifact-copy-fake'
    }

    function New-TestCapabilityRequest([string]$Capability, $Arguments) {
        return New-E1BrokerCapabilityRequest -Capability $Capability -OperationId ([guid]::NewGuid().ToString('D')) `
            -RequestedAtUtc ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) -Arguments $Arguments
    }

    function Invoke-TestRoute($Request, [string]$ArtifactCopyTrustedRoot = '') {
        return Invoke-E1BrokerCapabilityRoute -Request $Request -ArtifactCopyTrustedRoot $ArtifactCopyTrustedRoot -ModuleNameOverrides $script:FakeModuleNameOverrides
    }
}

Describe 'Invoke-E1BrokerCapabilityRoute: broker.status (no verdict field on the underlying result)' {
    It 'defaults the outer envelope to PASS and carries the raw result through, unmodified' {
        Reset-E1FakeBrokerStatusState
        $request = New-TestCapabilityRequest 'broker.status' @{}
        $response = Invoke-TestRoute $request
        { Assert-E1BrokerCapabilityResponseShape $response } | Should -Not -Throw
        $response.verdict | Should -BeExactly 'PASS'
        $response.reason_code | Should -BeNullOrEmpty
        $response.result.self_update_capable | Should -BeTrue
        $response.capability | Should -BeExactly 'broker.status'
        $response.operation_id | Should -BeExactly $request.operation_id
    }
}

Describe 'Invoke-E1BrokerCapabilityRoute: vm.inspect / vm.ensure_state' {
    It 'vm.inspect routes to Get-E1VmState and returns its real result' {
        $vmName = 'Evidence1E2E-DispatchCore'
        $vmId = [guid]::NewGuid().ToString()
        Set-E1FakeVmInitialState -VMName $vmName -VMId $vmId -State 'Off' | Out-Null
        $request = New-TestCapabilityRequest 'vm.inspect' ([ordered]@{ VMName = $vmName; ExpectedVMId = '' })
        $response = Invoke-TestRoute $request
        $response.verdict | Should -BeExactly 'PASS'
        $response.result.state | Should -BeExactly 'Off'
    }

    It 'vm.inspect: an underlying THROW (identity mismatch) becomes a dispatch-level FAIL with a null result' {
        $vmName = 'Evidence1E2E-DispatchCore2'
        $vmId = [guid]::NewGuid().ToString()
        Set-E1FakeVmInitialState -VMName $vmName -VMId $vmId -State 'Off' | Out-Null
        $request = New-TestCapabilityRequest 'vm.inspect' ([ordered]@{ VMName = $vmName; ExpectedVMId = [guid]::NewGuid().ToString() })
        $response = Invoke-TestRoute $request
        $response.verdict | Should -BeExactly 'FAIL'
        $response.reason_code | Should -BeExactly 'vm_state_identity_mismatch'
        $response.result | Should -BeNullOrEmpty
    }

    It 'vm.ensure_state routes to Invoke-E1VmEnsureState and actually transitions the fake VM' {
        $vmName = 'Evidence1E2E-DispatchCore3'
        $vmId = [guid]::NewGuid().ToString()
        Set-E1FakeVmInitialState -VMName $vmName -VMId $vmId -State 'Off' | Out-Null
        $request = New-TestCapabilityRequest 'vm.ensure_state' ([ordered]@{
            VMName = $vmName; ExpectedVMId = $vmId; TargetState = 'Running'; StopTimeoutSeconds = 180; StartTimeoutSeconds = 120
        })
        $response = Invoke-TestRoute $request
        $response.verdict | Should -BeExactly 'PASS'
        $response.result.state | Should -BeExactly 'Running'
        # Prove it actually mutated the fake's own state, not just echoed the request.
        (Get-E1VmState -VMName $vmName -ExpectedVMId $vmId).state | Should -BeExactly 'Running'
    }
}

Describe 'Invoke-E1BrokerCapabilityRoute: network.ensure_mode' {
    It 'routes to Invoke-E1NetworkEnsureMode and actually transitions the fake network mode' {
        $vmName = 'Evidence1E2E-Network1'
        $vmId = [guid]::NewGuid().ToString()
        Set-E1FakeNetworkInitialMode -VMName $vmName -VMId $vmId -Mode 'offline' | Out-Null
        # GuestCredentialPath must be non-empty and path-shaped: this
        # capability's own argument_schema requires it (matching the real,
        # -UseRealBackends-only path this dispatch route serves -- fake mode
        # never goes through the capability protocol at all, so there is no
        # "empty means fake mode" convention to honor here, unlike
        # evidence1-network-backend-fake.psm1's own -GuestCredentialPath).
        $request = New-TestCapabilityRequest 'network.ensure_mode' ([ordered]@{
            VMName = $vmName; GuestCredentialPath = 'C:\kmp-eval\scratch\pester-dispatch-core\cred.xml'; TargetMode = 'restricted'
        })
        $response = Invoke-TestRoute $request
        $response.verdict | Should -BeExactly 'PASS'
        $response.result.mode | Should -BeExactly 'restricted'
    }
}

Describe 'Invoke-E1BrokerCapabilityRoute: guest.invoke_bundle' {
    It 'routes to Invoke-E1GuestBundle, correctly threading a nested string-array argument through a JSON round trip' {
        Reset-E1FakeGuestBundleState
        $vmName = 'Evidence1E2E-Guest1'
        Set-E1FakeGuestBundleResult -VMName $vmName -BundleName 'get-cli-version-and-login-status' -Verdict 'PASS' `
            -Output ([ordered]@{ command_found = $true; version_text = 'codex 0.154.0'; login_status_exit_code = 0 }) | Out-Null
        $bundleArguments = [ordered]@{ CommandPath = 'C:\Evidence1Toolchain\codex-cli\0.154.0\bin\codex.exe'; LoginStatusArgs = [string[]]@('login', 'status') }
        $request = New-TestCapabilityRequest 'guest.invoke_bundle' ([ordered]@{
            VMName = $vmName; GuestCredentialPath = 'C:\kmp-eval\scratch\pester-dispatch-core\cred.xml'; BundleName = 'get-cli-version-and-login-status'
            Arguments = $bundleArguments; TimeoutSeconds = 60
        })
        # Real JSON round trip -- LoginStatusArgs becomes a plain object[] here,
        # exactly as it would after evidence1-host-broker-capability-dispatch.ps1
        # parses the request file off disk.
        $roundTripped = ($request | ConvertTo-Json -Depth 10 | ConvertFrom-Json)
        $response = Invoke-TestRoute $roundTripped
        $response.verdict | Should -BeExactly 'PASS'
        $response.result.output.command_found | Should -BeTrue

        # @()-wrapped at the call site -- Get-E1FakeGuestBundleInvocations
        # (like every "return @(...)" function in this codebase) enumerates
        # its array return value onto the pipeline; with exactly one
        # recorded invocation, an UNWRAPPED call here would silently
        # collapse to that one invocation's own hashtable, and .Count would
        # report its KEY count (4) instead of the invocation COUNT (1) --
        # confirmed empirically before adding this wrapping, not assumed.
        $invocations = @(Get-E1FakeGuestBundleInvocations)
        $invocations.Count | Should -Be 1
        $invocations[0].bundle_name | Should -BeExactly 'get-cli-version-and-login-status'
        # If the [string[]] cast had not happened, Assert-E1GuestBundleArguments's
        # own -is [string[]] validator (evidence1-guest-bundle-contract.psm1)
        # would have thrown guest_bundle_argument_invalid before ever recording
        # this invocation -- reaching this assertion at all is part of the proof.
        $invocations[0].arguments['LoginStatusArgs'] | Should -Be @('login', 'status')
    }

    It 'a malformed bundle argument is rejected before the fake ever records an invocation' {
        Reset-E1FakeGuestBundleState
        $request = New-TestCapabilityRequest 'guest.invoke_bundle' ([ordered]@{
            VMName = 'x'; GuestCredentialPath = 'C:\kmp-eval\scratch\pester-dispatch-core\cred.xml'; BundleName = 'get-cli-version-and-login-status'
            Arguments = [ordered]@{ CommandPath = 'C:\NotEvidence1Toolchain\evil.cmd'; LoginStatusArgs = [string[]]@('login', 'status') }
            TimeoutSeconds = 60
        })
        $response = Invoke-TestRoute $request
        $response.verdict | Should -BeExactly 'FAIL'
        @(Get-E1FakeGuestBundleInvocations).Count | Should -Be 0
    }
}

Describe 'Invoke-E1BrokerCapabilityRoute: artifacts.copy_read_only (Task 3 -- TrustedRoot never from the request)' {
    It 'refuses to dispatch without -ArtifactCopyTrustedRoot, and never calls the underlying copy function' {
        Reset-E1FakeArtifactCopyState
        $request = New-TestCapabilityRequest 'artifacts.copy_read_only' ([ordered]@{
            VMName = 'x'; ExpectedVMId = [guid]::NewGuid().ToString(); SpecName = 'final-codex-attestation'
            Arguments = @{}; DestinationDir = "C:\kmp-eval\scratch\pester-dispatch-core\$([guid]::NewGuid().ToString('N'))"
        })
        $response = Invoke-TestRoute $request
        $response.verdict | Should -BeExactly 'FAIL'
        $response.reason_code | Should -BeExactly 'broker_capability_trusted_root_required'
        $response.result | Should -BeNullOrEmpty
    }

    It 'a request-supplied TrustedRoot-shaped argument is structurally impossible -- confirmed by construction, not by probing the router' {
        # Assert-E1BrokerCapabilityArguments (contract module, already covered by
        # its own dedicated test) rejects TrustedRoot as an undeclared argument
        # before Invoke-E1BrokerCapabilityRoute is ever reached -- there is no
        # value of $Arguments a caller can construct that carries it through.
        $args = [ordered]@{ VMName = 'x'; ExpectedVMId = [guid]::NewGuid().ToString(); SpecName = 'final-codex-attestation'; Arguments = @{}; DestinationDir = 'C:\kmp-eval\scratch\x'; TrustedRoot = 'C:\kmp-eval\scratch\' }
        { New-E1BrokerCapabilityRequest -Capability 'artifacts.copy_read_only' -OperationId ([guid]::NewGuid().ToString('D')) `
            -RequestedAtUtc ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) -Arguments $args } | Should -Throw '*broker_capability_arguments_shape_invalid*'
    }

    It 'with a broker-supplied TrustedRoot, routes to Copy-E1ArtifactsReadOnly and actually copies the seeded file' {
        Reset-E1FakeArtifactCopyState
        $vmName = 'Evidence1E2E-ArtifactCopy1'
        $mountRoot = Join-Path $TestDrive 'fake-mount'
        $attestationDir = Join-Path $mountRoot 'kmp-eval\measurement-scopes'
        New-Item -ItemType Directory -Force -Path $attestationDir | Out-Null
        'fake-attestation' | Set-Content -LiteralPath (Join-Path $attestationDir 'evidence1-claude-windows-isolation-attestation-stageb-v1.json') -Encoding UTF8
        Set-E1FakeArtifactCopyMountRoot -VMName $vmName -MountRootPath $mountRoot

        $destination = "C:\kmp-eval\scratch\pester-dispatch-core\$([guid]::NewGuid().ToString('N'))"
        $request = New-TestCapabilityRequest 'artifacts.copy_read_only' ([ordered]@{
            VMName = $vmName; ExpectedVMId = [guid]::NewGuid().ToString(); SpecName = 'final-codex-attestation'
            Arguments = @{}; DestinationDir = $destination
        })
        try {
            $response = Invoke-TestRoute $request -ArtifactCopyTrustedRoot 'C:\kmp-eval\scratch\'
            $response.verdict | Should -BeExactly 'PASS'
            @($response.result.files_copied).Count | Should -Be 1
            Test-Path -LiteralPath (Join-Path $destination 'evidence1-claude-windows-isolation-attestation-stageb-v1.json') | Should -BeTrue
        } finally {
            if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }
}

Describe 'Get-E1BrokerCapabilityFunction' {
    # UPDATED (incident fix): now takes an explicit -ExpectedModuleName, not
    # by-name-alone -- see this module's own header for why.
    It 'throws a clear, distinct error when the module name is omitted entirely' {
        { Get-E1BrokerCapabilityFunction 'Get-E1BrokerStatus' '' } |
            Should -Throw '*broker_capability_function_module_name_required*'
    }
    It 'throws a clear, distinct error when nothing in the named module exports the requested name' {
        { Get-E1BrokerCapabilityFunction 'Get-ThisFunctionDefinitelyDoesNotExistAnywhereEver12345' 'evidence1-broker-status-fake' } |
            Should -Throw '*broker_capability_function_not_available*'
    }
    It 'throws when the named module itself is not loaded, even for a function name that exists elsewhere' {
        { Get-E1BrokerCapabilityFunction 'Get-E1BrokerStatus' 'evidence1-module-not-actually-loaded' } |
            Should -Throw '*broker_capability_function_not_available*'
    }
    It 'resolves a function that IS loaded, in the module actually named' {
        (Get-E1BrokerCapabilityFunction 'Get-E1BrokerStatus' 'evidence1-broker-status-fake') | Should -Not -BeNullOrEmpty
    }
    It 'the exact incident scenario: resolves to the FAKE, never the queue-client, even when both export the identical function name in the same session' {
        Import-Module (Join-Path $script:AuditsRoot 'evidence1-vm-state-queue-client.psm1') -Force -Global
        try {
            $resolved = Get-E1BrokerCapabilityFunction 'Get-E1VmState' 'evidence1-vm-state-fake'
            $resolved.ModuleName | Should -BeExactly 'evidence1-vm-state-fake'
        } finally {
            Remove-Module 'evidence1-vm-state-queue-client' -Force -ErrorAction SilentlyContinue
        }
    }
}

Describe 'Test-E1BrokerCapabilityResultCarriesVerdict' {
    It 'is true for a VmState result (has its own verdict field)' {
        Test-E1BrokerCapabilityResultCarriesVerdict (New-E1VmStateResult -VMName 'x' -VMId 'y' -State 'Off') | Should -BeTrue
    }
    It 'is false for a bare BrokerStatus-shaped hashtable (no verdict field)' {
        Test-E1BrokerCapabilityResultCarriesVerdict ([ordered]@{ files_copied = @('a.json') }) | Should -BeFalse
    }
    It 'is false for $null' {
        Test-E1BrokerCapabilityResultCarriesVerdict $null | Should -BeFalse
    }
}
