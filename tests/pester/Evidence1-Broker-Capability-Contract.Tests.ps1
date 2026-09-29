BeforeAll {
    $script:AuditsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\docs\audits')).Path
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-broker-capability-contract.psm1') -Force
}

Describe 'Evidence1 broker capability registry' {
    It 'contains exactly the 7 registered capabilities, and excludes broker.update' {
        (Get-E1BrokerCapabilityNames) | Should -Be @(
            'artifacts.copy_read_only', 'broker.status', 'guest.invoke_bundle',
            'network.ensure_mode', 'network.inspect', 'vm.ensure_state', 'vm.inspect'
        )
        (Get-E1BrokerCapabilityNames) | Should -Not -Contain 'broker.update'
    }

    It 'maps each capability to the already-built module/function this round names' {
        $registry = Get-E1BrokerCapabilityRegistry
        $registry.'broker.status'.module_file | Should -BeExactly 'evidence1-broker-status-real.psm1'
        $registry.'broker.status'.function_name | Should -BeExactly 'Get-E1BrokerStatus'
        $registry.'vm.inspect'.function_name | Should -BeExactly 'Get-E1VmState'
        $registry.'vm.ensure_state'.function_name | Should -BeExactly 'Invoke-E1VmEnsureState'
        $registry.'network.inspect'.function_name | Should -BeExactly 'Get-E1NetworkState'
        $registry.'network.ensure_mode'.function_name | Should -BeExactly 'Invoke-E1NetworkEnsureMode'
        $registry.'guest.invoke_bundle'.function_name | Should -BeExactly 'Invoke-E1GuestBundle'
        $registry.'artifacts.copy_read_only'.function_name | Should -BeExactly 'Copy-E1ArtifactsReadOnly'
        foreach ($name in $registry.Keys) { $registry[$name].module_file | Should -Not -BeNullOrEmpty }
    }

    It 'declares no TrustedRoot argument anywhere in the registry (structural, not conventional)' {
        $registry = Get-E1BrokerCapabilityRegistry
        foreach ($name in $registry.Keys) {
            $registry[$name].argument_schema.Keys | Should -Not -Contain 'TrustedRoot'
        }
    }

    It 'marks only artifacts.copy_read_only as requiring the broker-resolved trusted root' {
        $registry = Get-E1BrokerCapabilityRegistry
        foreach ($name in $registry.Keys) {
            if ($name -ceq 'artifacts.copy_read_only') { $registry[$name].requires_broker_trusted_root | Should -BeTrue }
            else { $registry[$name].requires_broker_trusted_root | Should -BeFalse }
        }
    }

    It 'never declares a ScriptBlock- or script-path-shaped argument anywhere in the registry' {
        $registry = Get-E1BrokerCapabilityRegistry
        foreach ($name in $registry.Keys) {
            $registry[$name].argument_schema.Keys | Should -Not -Contain 'ScriptBlock'
            $registry[$name].argument_schema.Keys | Should -Not -Contain 'ScriptPath'
            $registry[$name].argument_schema.Keys | Should -Not -Contain 'Command'
        }
    }
}

Describe 'Assert-E1BrokerCapabilityName' {
    It 'accepts every registered name' {
        foreach ($name in Get-E1BrokerCapabilityNames) { { Assert-E1BrokerCapabilityName $name } | Should -Not -Throw }
    }
    It 'rejects an unregistered name' {
        { Assert-E1BrokerCapabilityName 'vm.delete' } | Should -Throw '*broker_capability_name_invalid*'
    }
    It 'rejects broker.update explicitly (not part of this registry)' {
        { Assert-E1BrokerCapabilityName 'broker.update' } | Should -Throw '*broker_capability_name_invalid*'
    }
}

Describe 'Assert-E1BrokerCapabilityArguments' {
    It 'accepts vm.ensure_state with all five declared arguments, exactly' {
        $callArguments = [ordered]@{ VMName = 'Evidence1E2E'; ExpectedVMId = [guid]::NewGuid().ToString(); TargetState = 'Running'; StopTimeoutSeconds = 180; StartTimeoutSeconds = 120 }
        { Assert-E1BrokerCapabilityArguments 'vm.ensure_state' $callArguments } | Should -Not -Throw
    }
    It 'rejects a missing declared argument' {
        $callArguments = [ordered]@{ VMName = 'Evidence1E2E'; TargetState = 'Running'; StopTimeoutSeconds = 180; StartTimeoutSeconds = 120 }
        { Assert-E1BrokerCapabilityArguments 'vm.ensure_state' $callArguments } | Should -Throw '*broker_capability_arguments_shape_invalid*'
    }
    It 'rejects an undeclared extra argument' {
        $callArguments = [ordered]@{ VMName = 'Evidence1E2E'; ExpectedVMId = [guid]::NewGuid().ToString(); TargetState = 'Running'; StopTimeoutSeconds = 180; StartTimeoutSeconds = 120; Extra = 'nope' }
        { Assert-E1BrokerCapabilityArguments 'vm.ensure_state' $callArguments } | Should -Throw '*broker_capability_arguments_shape_invalid*'
    }
    It 'rejects TrustedRoot as an undeclared argument for artifacts.copy_read_only (structural proof)' {
        $callArguments = [ordered]@{ VMName = 'x'; ExpectedVMId = [guid]::NewGuid().ToString(); SpecName = 'final-codex-attestation'; Arguments = @{}; DestinationDir = 'C:\kmp-eval\scratch\out'; TrustedRoot = 'C:\kmp-eval\scratch\' }
        { Assert-E1BrokerCapabilityArguments 'artifacts.copy_read_only' $callArguments } | Should -Throw '*broker_capability_arguments_shape_invalid*'
    }
    It 'rejects an out-of-range TargetState value' {
        $callArguments = [ordered]@{ VMName = 'x'; ExpectedVMId = [guid]::NewGuid().ToString(); TargetState = 'Paused'; StopTimeoutSeconds = 180; StartTimeoutSeconds = 120 }
        { Assert-E1BrokerCapabilityArguments 'vm.ensure_state' $callArguments } | Should -Throw '*broker_capability_argument_invalid*'
    }
    It 'rejects a numeric-looking STRING for an int-typed argument (a malformed request, not an equivalent one)' {
        $callArguments = [ordered]@{ VMName = 'x'; ExpectedVMId = [guid]::NewGuid().ToString(); TargetState = 'Running'; StopTimeoutSeconds = '180'; StartTimeoutSeconds = 120 }
        { Assert-E1BrokerCapabilityArguments 'vm.ensure_state' $callArguments } | Should -Throw '*broker_capability_argument_invalid*'
    }
    It 'accepts an empty broker.status argument set and rejects a non-empty one' {
        { Assert-E1BrokerCapabilityArguments 'broker.status' @{} } | Should -Not -Throw
        { Assert-E1BrokerCapabilityArguments 'broker.status' @{ Unexpected = 1 } } | Should -Throw '*broker_capability_arguments_shape_invalid*'
    }
    It 'validates identically whether Arguments is a raw ordered dictionary or a PSCustomObject (JSON round trip)' {
        $callArguments = [ordered]@{ VMName = 'x'; GuestCredentialPath = 'C:\kmp-eval\scratch\cred.xml'; TargetMode = 'restricted' }
        { Assert-E1BrokerCapabilityArguments 'network.ensure_mode' $callArguments } | Should -Not -Throw
        $roundTripped = ($callArguments | ConvertTo-Json | ConvertFrom-Json)
        { Assert-E1BrokerCapabilityArguments 'network.ensure_mode' $roundTripped } | Should -Not -Throw
    }
}

Describe 'ConvertTo-E1BrokerCapabilityHashtable' {
    It 'converts a PSCustomObject into a real ordered dictionary' {
        $obj = [pscustomobject]@{ CommandPath = 'C:\Evidence1Toolchain\codex-cli\0.154.0\bin\codex.exe'; LoginStatusArgs = @('login', 'status') }
        $result = ConvertTo-E1BrokerCapabilityHashtable $obj
        $result | Should -BeOfType [Collections.IDictionary]
        $result['CommandPath'] | Should -BeExactly 'C:\Evidence1Toolchain\codex-cli\0.154.0\bin\codex.exe'
    }
    It 'casts an all-string JSON-round-tripped array to [string[]] -- the exact LoginStatusArgs bug class this round pre-empts' {
        $obj = [pscustomobject]@{ LoginStatusArgs = @('login', 'status') } | ConvertTo-Json | ConvertFrom-Json
        # Before conversion, confirm the JSON round trip really does produce a
        # plain object[] -- the same empirically-confirmed fact
        # docs/audits/evidence1-phase3c-architecture-note.md section 10.5 relies
        # on, re-verified here rather than assumed.
        ($obj.LoginStatusArgs -is [string[]]) | Should -BeFalse
        $result = ConvertTo-E1BrokerCapabilityHashtable $obj
        ($result['LoginStatusArgs'] -is [string[]]) | Should -BeTrue
        $result['LoginStatusArgs'] | Should -Be @('login', 'status')
    }
    It 'leaves a non-all-string array untouched (never guesses at other coercions)' {
        $obj = [ordered]@{ Mixed = @('a', 1, $true) }
        $result = ConvertTo-E1BrokerCapabilityHashtable $obj
        ($result['Mixed'] -is [string[]]) | Should -BeFalse
    }
    It 'returns an empty ordered dictionary for $null' {
        (ConvertTo-E1BrokerCapabilityHashtable $null).Count | Should -Be 0
    }
}

Describe 'Assert-E1BrokerCapabilityOperationId' {
    It 'accepts a canonical D-format GUID' {
        { Assert-E1BrokerCapabilityOperationId ([guid]::NewGuid().ToString('D')) } | Should -Not -Throw
    }
    It 'rejects Guid.Empty' {
        { Assert-E1BrokerCapabilityOperationId ([guid]::Empty.ToString('D')) } | Should -Throw '*broker_capability_operation_id_invalid*'
    }
    It 'rejects a non-canonical (braced) GUID shape' {
        { Assert-E1BrokerCapabilityOperationId ('{' + [guid]::NewGuid().ToString('D') + '}') } | Should -Throw '*broker_capability_operation_id_invalid*'
    }
    It 'rejects an empty string' {
        { Assert-E1BrokerCapabilityOperationId '' } | Should -Throw '*broker_capability_operation_id_invalid*'
    }
    It 'rejects wrong-case hex (round-trip mismatch)' {
        $upper = [guid]::NewGuid().ToString('D').ToUpperInvariant()
        { Assert-E1BrokerCapabilityOperationId $upper } | Should -Throw '*broker_capability_operation_id_invalid*'
    }
}

Describe 'New-E1BrokerCapabilityRequest / Assert-E1BrokerCapabilityRequestShape' {
    It 'constructs a well-formed request and the shape assert accepts it' {
        $request = New-E1BrokerCapabilityRequest -Capability 'vm.inspect' -OperationId ([guid]::NewGuid().ToString('D')) `
            -RequestedAtUtc ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) -Arguments ([ordered]@{ VMName = 'x'; ExpectedVMId = '' })
        { Assert-E1BrokerCapabilityRequestShape $request } | Should -Not -Throw
        (Get-E1BrokerCapabilityPropertyNames $request | Sort-Object) | Should -Be (Get-E1BrokerCapabilityRequestRequiredKeys | Sort-Object)
    }
    It 'accepts the same request after a real JSON round trip (PSCustomObject shape)' {
        $request = New-E1BrokerCapabilityRequest -Capability 'network.inspect' -OperationId ([guid]::NewGuid().ToString('D')) `
            -RequestedAtUtc ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) -Arguments ([ordered]@{ VMName = 'x'; GuestCredentialPath = 'C:\kmp-eval\scratch\cred.xml' })
        $roundTripped = ($request | ConvertTo-Json -Depth 10 | ConvertFrom-Json)
        { Assert-E1BrokerCapabilityRequestShape $roundTripped } | Should -Not -Throw
    }
    It 'rejects an extra top-level key' {
        $request = New-E1BrokerCapabilityRequest -Capability 'vm.inspect' -OperationId ([guid]::NewGuid().ToString('D')) `
            -RequestedAtUtc ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) -Arguments ([ordered]@{ VMName = 'x'; ExpectedVMId = '' })
        $request['extra'] = 'nope'
        { Assert-E1BrokerCapabilityRequestShape $request } | Should -Throw '*broker_capability_request_shape_invalid*'
    }
    It 'rejects a wrong schema version' {
        $request = New-E1BrokerCapabilityRequest -Capability 'vm.inspect' -OperationId ([guid]::NewGuid().ToString('D')) `
            -RequestedAtUtc ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) -Arguments ([ordered]@{ VMName = 'x'; ExpectedVMId = '' })
        $request['schema'] = 2
        { Assert-E1BrokerCapabilityRequestShape $request } | Should -Throw '*broker_capability_request_schema_invalid*'
    }
    It 'rejects an unrecognized capability name' {
        { New-E1BrokerCapabilityRequest -Capability 'vm.delete' -OperationId ([guid]::NewGuid().ToString('D')) `
            -RequestedAtUtc ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) -Arguments @{} } | Should -Throw '*broker_capability_name_invalid*'
    }
    It 'rejects a malformed requested_at_utc' {
        { New-E1BrokerCapabilityRequest -Capability 'vm.inspect' -OperationId ([guid]::NewGuid().ToString('D')) `
            -RequestedAtUtc '2026-09-19' -Arguments ([ordered]@{ VMName = 'x'; ExpectedVMId = '' }) } | Should -Throw '*broker_capability_requested_at_utc_invalid*'
    }
}

Describe 'Assert-E1BrokerCapabilityRequestFresh' {
    It 'accepts a request well inside the expiry window' {
        $now = [DateTime]::new(2026, 9, 19, 12, 0, 0, [DateTimeKind]::Utc)
        $request = [ordered]@{ requested_at_utc = $now.AddSeconds(-100).ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
        { Assert-E1BrokerCapabilityRequestFresh $request $now } | Should -Not -Throw
    }
    It 'accepts a request exactly at the expiry boundary' {
        $now = [DateTime]::new(2026, 9, 19, 12, 0, 0, [DateTimeKind]::Utc)
        $expiry = Get-E1BrokerCapabilityRequestExpirySeconds
        $request = [ordered]@{ requested_at_utc = $now.AddSeconds(-1 * $expiry).ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
        { Assert-E1BrokerCapabilityRequestFresh $request $now } | Should -Not -Throw
    }
    It 'rejects a request one second past the expiry window' {
        $now = [DateTime]::new(2026, 9, 19, 12, 0, 0, [DateTimeKind]::Utc)
        $expiry = Get-E1BrokerCapabilityRequestExpirySeconds
        $request = [ordered]@{ requested_at_utc = $now.AddSeconds(-1 * ($expiry + 1)).ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
        { Assert-E1BrokerCapabilityRequestFresh $request $now } | Should -Throw '*broker_capability_request_expired*'
    }
    It 'rejects a request timestamped after NowUtc (a corrupted/backdated-forward clock, not benign skew)' {
        $now = [DateTime]::new(2026, 9, 19, 12, 0, 0, [DateTimeKind]::Utc)
        $request = [ordered]@{ requested_at_utc = $now.AddSeconds(5).ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
        { Assert-E1BrokerCapabilityRequestFresh $request $now } | Should -Throw '*broker_capability_request_expired*'
    }
    It 'rejects a non-UTC-kind NowUtc argument (DI discipline, matching this codebase''s Clock boundary)' {
        $request = [ordered]@{ requested_at_utc = '2026-09-19T12:00:00.000Z' }
        { Assert-E1BrokerCapabilityRequestFresh $request ([DateTime]::new(2026, 9, 19, 12, 0, 0, [DateTimeKind]::Local)) } |
            Should -Throw '*broker_capability_now_utc_must_be_utc_kind*'
    }
}

Describe 'New-E1BrokerCapabilityResponse / Assert-E1BrokerCapabilityResponseShape' {
    It 'constructs a PASS response with a null reason_code' {
        $response = New-E1BrokerCapabilityResponse -OperationId ([guid]::NewGuid().ToString('D')) -Capability 'vm.inspect' -Verdict 'PASS' -Result ([ordered]@{ a = 1 })
        { Assert-E1BrokerCapabilityResponseShape $response } | Should -Not -Throw
        $response.reason_code | Should -BeNullOrEmpty
    }
    It 'requires a reason_code on FAIL' {
        { New-E1BrokerCapabilityResponse -OperationId ([guid]::NewGuid().ToString('D')) -Capability 'vm.inspect' -Verdict 'FAIL' } |
            Should -Throw '*broker_capability_response_fail_missing_reason*'
    }
    It 'round trips through JSON and still validates' {
        $response = New-E1BrokerCapabilityResponse -OperationId ([guid]::NewGuid().ToString('D')) -Capability 'guest.invoke_bundle' -Verdict 'PASS' -Result ([ordered]@{ sealed = $true })
        $roundTripped = ($response | ConvertTo-Json -Depth 10 | ConvertFrom-Json)
        { Assert-E1BrokerCapabilityResponseShape $roundTripped } | Should -Not -Throw
    }
}

Describe 'Assert-E1BrokerCapabilityPathArgument / path confinement' {
    It 'accepts a path under the trusted root' {
        { Assert-E1BrokerCapabilityPathArgument 'C:\kmp-eval\scratch\cred.xml' } | Should -Not -Throw
    }
    It 'rejects a path outside the trusted root' {
        { Assert-E1BrokerCapabilityPathArgument 'C:\Windows\System32\cred.xml' } | Should -Throw '*broker_capability_path_argument_outside_root*'
    }
    It 'rejects a traversal escape that resolves outside the root' {
        { Assert-E1BrokerCapabilityPathArgument 'C:\kmp-eval\scratch\..\..\Windows\System32\cred.xml' } | Should -Throw '*broker_capability_path_argument_outside_root*'
    }
    It 'Assert-E1BrokerCapabilityPathArguments confines every declared path argument for a capability, and no others' {
        $callArguments = [ordered]@{ VMName = 'x'; GuestCredentialPath = 'C:\Windows\bad.xml'; BundleName = 'get-firewall-sealed-state'; Arguments = @{}; TimeoutSeconds = 60 }
        { Assert-E1BrokerCapabilityPathArguments 'guest.invoke_bundle' $callArguments } | Should -Throw '*broker_capability_path_argument_outside_root*'
        $args2 = [ordered]@{ VMName = 'C:\Windows\not-a-real-vm-name-but-not-path-checked'; GuestCredentialPath = 'C:\kmp-eval\scratch\cred.xml'; BundleName = 'get-firewall-sealed-state'; Arguments = @{}; TimeoutSeconds = 60 }
        { Assert-E1BrokerCapabilityPathArguments 'guest.invoke_bundle' $args2 } | Should -Not -Throw
    }
}

Describe 'Get-E1BrokerCapabilityQueuePaths' {
    It 'derives requests/responses/operations as true siblings under one QueueRoot' {
        $paths = Get-E1BrokerCapabilityQueuePaths 'C:\kmp-eval\scratch\host-elevated-runner-codex'
        $paths.requests_dir | Should -BeExactly 'C:\kmp-eval\scratch\host-elevated-runner-codex\capability-requests'
        $paths.responses_dir | Should -BeExactly 'C:\kmp-eval\scratch\host-elevated-runner-codex\capability-responses'
        $paths.operations_dir | Should -BeExactly 'C:\kmp-eval\scratch\host-elevated-runner-codex\capability-operations'
    }
}

Describe 'Get-E1BrokerCapabilityReasonCodePrefix' {
    It 'splits a stable_identifier: dynamic detail message on the first colon' {
        Get-E1BrokerCapabilityReasonCodePrefix 'vm_state_hop_verification_failed: expected Running observed Off' | Should -BeExactly 'vm_state_hop_verification_failed'
    }
    It 'returns the whole trimmed message when there is no colon' {
        Get-E1BrokerCapabilityReasonCodePrefix 'vm_state_start_timeout' | Should -BeExactly 'vm_state_start_timeout'
    }
    It 'falls back to a generic code for an empty message' {
        Get-E1BrokerCapabilityReasonCodePrefix '' | Should -BeExactly 'broker_capability_function_failed'
    }
}
