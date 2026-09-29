# Genuinely exercises Submit-E1BrokerCapabilityOperation end to end -- real
# Mutex acquire/release, real busy-check against real directories, real
# create-new JSON writes for both the capability request and the outer
# transport request, a real (fake-substituted) trigger call, and a real
# poll-and-parse loop. QueueRoot cannot be $TestDrive-scoped: Submit-E1BrokerCapabilityOperation
# hardcodes confinement to C:\kmp-eval\scratch\ (deliberately -- see
# evidence1-broker-capability-contract.psm1's own header on why this is not
# env-var- or caller-overridable), so this file uses real, uniquely-named
# subdirectories under that root instead, cleaned up in AfterAll -- the same
# choice tests/pester/Evidence1-Run-Full-Campaign-Integration.Tests.ps1's own
# $campaignRoot already made for the identical reason (see
# docs/audits/evidence1-phase3c-architecture-note.md section 14.2, "existing
# tests intentionally NOT converted to $TestDrive"). The one seam that stays
# a substitute is -TriggerTask itself: the REAL default
# (Invoke-E1BrokerCapabilityTriggerTask) calls schtasks.exe /Run, which this
# file never invokes, matching this engagement's standing boundary.
BeforeAll {
    $script:AuditsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\docs\audits')).Path
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-broker-capability-contract.psm1') -Force
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-broker-capability-client.psm1') -Force

    $script:PesterScratchRoot = 'C:\kmp-eval\scratch\pester-broker-capability-client-tests'
    function New-TestQueueRoot { return Join-Path $script:PesterScratchRoot ([guid]::NewGuid().ToString('N')) }

    # Simulates evidence1-host-broker-capability-dispatch.ps1 having already
    # run synchronously: reads the capability request the client just wrote,
    # writes a well-formed PASS response in its place, AND retires the outer
    # transport request (requests/ -> done/) exactly as
    # evidence1-host-elevated-runner.ps1's own real dispatch loop always does
    # for every request it processes -- so the client's own very first poll
    # iteration succeeds, with zero real Start-Sleep waiting anywhere in this
    # file, and the queue is left in the same POST-DISPATCH state a real
    # cycle would leave it in (not "response written but the outer request
    # never left requests/", which would make Submit-E1BrokerCapabilityOperation's
    # own busy-check correctly, but misleadingly, refuse a second call this
    # fake never earned).
    function New-FakePassTrigger {
        return {
            param($TaskName, $CapabilityRequestPath, $ResponsePath)
            $request = Get-Content -LiteralPath $CapabilityRequestPath -Raw | ConvertFrom-Json
            $response = New-E1BrokerCapabilityResponse -OperationId ([string]$request.operation_id) `
                -Capability ([string]$request.capability) -Verdict 'PASS' -Result ([ordered]@{ echoed = $true })
            Write-E1BrokerCapabilityCreateNewJson $ResponsePath $response
            # $CapabilityRequestPath = <queueRoot>\capability-requests\<opid>.request.json
            # -> two levels up is <queueRoot>, not three.
            $queueRoot = Split-Path -Parent (Split-Path -Parent $CapabilityRequestPath)
            $outerRequest = @(Get-ChildItem -LiteralPath (Join-Path $queueRoot 'requests') -Filter '*.request.json' -File -ErrorAction SilentlyContinue)
            foreach ($file in $outerRequest) {
                $doneDir = Join-Path $queueRoot 'done'
                New-Item -ItemType Directory -Force -Path $doneDir | Out-Null
                Move-Item -LiteralPath $file.FullName -Destination (Join-Path $doneDir $file.Name) -Force
            }
        }
    }

    function New-FakeNoOpTrigger { return { param($TaskName, $CapabilityRequestPath, $ResponsePath) } }

    # Simulates the runner claiming the outer request (Move-Item into
    # in-progress/, evidence1-host-elevated-runner.ps1:591) but dying/hanging
    # before it reaches its own log write (:625) -- the exact 2026-09-28
    # orphan shape. Writes neither the capability response nor logs/<id>.log.
    function New-FakeStalledAfterClaimTrigger {
        return {
            param($TaskName, $CapabilityRequestPath, $ResponsePath)
            $queueRoot = Split-Path -Parent (Split-Path -Parent $CapabilityRequestPath)
            $inProgressDir = Join-Path $queueRoot 'in-progress'
            New-Item -ItemType Directory -Force -Path $inProgressDir | Out-Null
            $outerRequest = @(Get-ChildItem -LiteralPath (Join-Path $queueRoot 'requests') -Filter '*.request.json' -File -ErrorAction SilentlyContinue)
            foreach ($file in $outerRequest) {
                Move-Item -LiteralPath $file.FullName -Destination (Join-Path $inProgressDir $file.Name) -Force
            }
        }
    }

    # Simulates the runner writing its log (proof of life,
    # evidence1-host-elevated-runner.ps1:625) BEFORE completing normally --
    # same completion shape as New-FakePassTrigger, with the log write added
    # first so a test can assert the pickup fast-fail never fires once proof
    # of life exists, even with an already-expired pickup deadline.
    function New-FakeLogThenPassTrigger {
        return {
            param($TaskName, $CapabilityRequestPath, $ResponsePath)
            $queueRoot = Split-Path -Parent (Split-Path -Parent $CapabilityRequestPath)
            $outerRequest = @(Get-ChildItem -LiteralPath (Join-Path $queueRoot 'requests') -Filter '*.request.json' -File -ErrorAction SilentlyContinue)
            $logsDir = Join-Path $queueRoot 'logs'
            New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
            foreach ($file in $outerRequest) {
                $outerId = $file.BaseName -replace '\.request$', ''
                'runner alive' | Set-Content -LiteralPath (Join-Path $logsDir "$outerId.log") -Encoding UTF8
            }
            $request = Get-Content -LiteralPath $CapabilityRequestPath -Raw | ConvertFrom-Json
            $response = New-E1BrokerCapabilityResponse -OperationId ([string]$request.operation_id) `
                -Capability ([string]$request.capability) -Verdict 'PASS' -Result ([ordered]@{ echoed = $true })
            Write-E1BrokerCapabilityCreateNewJson $ResponsePath $response
            $doneDir = Join-Path $queueRoot 'done'
            New-Item -ItemType Directory -Force -Path $doneDir | Out-Null
            foreach ($file in $outerRequest) {
                Move-Item -LiteralPath $file.FullName -Destination (Join-Path $doneDir $file.Name) -Force
            }
        }
    }

    # Advances by 1 minute on every call -- lets a small -TimeoutMinutes
    # deadline be reached after a handful of iterations with
    # -PollIntervalSeconds 0, no real wall-clock delay. Closes over a local
    # (NOT $script:-scoped) mutable container: GetNewClosure() reliably
    # captures a local variable's reference, but a $script:-qualified
    # variable inside a closure continues to resolve dynamically against
    # whatever "script" scope is active at INVOCATION time -- which, once
    # this scriptblock is invoked from inside a different module
    # (evidence1-broker-capability-client.psm1's own Submit-E1BrokerCapabilityOperation),
    # is not this test file's scope at all. Confirmed by hitting exactly
    # this failure mode empirically (a null-valued-expression error) before
    # switching to this pattern.
    function New-FakeAdvancingClock {
        $state = @{ Now = [DateTime]::new(2026, 9, 19, 12, 0, 0, [DateTimeKind]::Utc) }
        return { $state.Now = $state.Now.AddMinutes(1); return $state.Now }.GetNewClosure()
    }

    # 2026-09-29 wedge fix (WO-A2 H-flake investigation) fixtures.
    #
    # Counts invocations and, starting on the $ClaimOnAttempt'th call, claims
    # exactly like New-FakeLogThenPassTrigger (log write + outer request
    # retired to done/ + PASS response) -- calls before that are a genuine
    # no-op, reproducing a /Run that reported success but never actually
    # started the runner. $ClaimOnAttempt 1 reproduces "claims immediately."
    # Returns Trigger (for -TriggerTask) and State (a live hashtable so the
    # test can read .Calls after the fact -- GetNewClosure() captures the
    # hashtable by reference, the same pattern this file's own counting-clock
    # test above already relies on).
    function New-FakeCountingClaimTrigger([int]$ClaimOnAttempt) {
        $state = @{ Calls = 0 }
        $trigger = {
            param($TaskName, $CapabilityRequestPath, $ResponsePath)
            $state.Calls++
            if ($state.Calls -lt $ClaimOnAttempt) { return }
            $queueRoot = Split-Path -Parent (Split-Path -Parent $CapabilityRequestPath)
            $outerRequest = @(Get-ChildItem -LiteralPath (Join-Path $queueRoot 'requests') -Filter '*.request.json' -File -ErrorAction SilentlyContinue)
            $logsDir = Join-Path $queueRoot 'logs'
            New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
            foreach ($file in $outerRequest) {
                $outerId = $file.BaseName -replace '\.request$', ''
                'runner alive' | Set-Content -LiteralPath (Join-Path $logsDir "$outerId.log") -Encoding UTF8
            }
            $request = Get-Content -LiteralPath $CapabilityRequestPath -Raw | ConvertFrom-Json
            $response = New-E1BrokerCapabilityResponse -OperationId ([string]$request.operation_id) `
                -Capability ([string]$request.capability) -Verdict 'PASS' -Result ([ordered]@{ echoed = $true })
            Write-E1BrokerCapabilityCreateNewJson $ResponsePath $response
            $doneDir = Join-Path $queueRoot 'done'
            New-Item -ItemType Directory -Force -Path $doneDir | Out-Null
            foreach ($file in $outerRequest) {
                Move-Item -LiteralPath $file.FullName -Destination (Join-Path $doneDir $file.Name) -Force
            }
        }.GetNewClosure()
        return [ordered]@{ Trigger = $trigger; State = $state }
    }

    # A counting wrapper around the existing no-op trigger, so a test can
    # assert exactly how many times a permanently-dropped trigger was called.
    function New-FakeCountingNoOpTrigger {
        $state = @{ Calls = 0 }
        $trigger = { param($TaskName, $CapabilityRequestPath, $ResponsePath) $state.Calls++ }.GetNewClosure()
        return [ordered]@{ Trigger = $trigger; State = $state }
    }

    function New-FakeTaskStateAlways([string]$StateValue) {
        return { param($tn) $StateValue }.GetNewClosure()
    }
}

Describe 'Get-E1BrokerCapabilityClientMutexName' {
    It 'matches evidence1-host-elevated-runner-client.ps1''s own derivation for the real queue root' {
        $queueRoot = 'C:\kmp-eval\scratch\host-elevated-runner-codex'
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            $expectedHash = [BitConverter]::ToString($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($queueRoot.ToLowerInvariant()))).Replace('-', '').Substring(0, 24)
        } finally { $sha256.Dispose() }
        Get-E1BrokerCapabilityClientMutexName $queueRoot | Should -BeExactly "Local\Evidence1RunnerClient-$expectedHash"
    }
}

Describe 'Submit-E1BrokerCapabilityOperation: happy path' {
    It 'writes both the capability request and the outer transport request, triggers, and returns the parsed response' {
        $queueRoot = New-TestQueueRoot
        $response = Submit-E1BrokerCapabilityOperation -Capability 'vm.inspect' `
            -Arguments ([ordered]@{ VMName = 'x'; ExpectedVMId = '' }) `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask (New-FakePassTrigger)

        $response.verdict | Should -BeExactly 'PASS'
        $response.capability | Should -BeExactly 'vm.inspect'
        $response.result.echoed | Should -BeTrue

        $queuePaths = Get-E1BrokerCapabilityQueuePaths $queueRoot
        @(Get-ChildItem -LiteralPath $queuePaths.requests_dir -Filter '*.request.json').Count | Should -Be 1
        @(Get-ChildItem -LiteralPath $queuePaths.responses_dir -Filter '*.response.json').Count | Should -Be 1
        # The fake trigger retires the outer request to done/, matching the
        # real elevated runner's own lifecycle (see New-FakePassTrigger's own
        # comment) -- it is no longer in requests/ by the time this
        # assertion runs, exactly as it would not be after a real dispatch.
        $outerRequests = @(Get-ChildItem -LiteralPath (Join-Path $queueRoot 'done') -Filter '*.request.json')
        $outerRequests.Count | Should -Be 1
        $outerJson = Get-Content -LiteralPath $outerRequests[0].FullName -Raw | ConvertFrom-Json
        $outerJson.script_path | Should -BeExactly (Join-Path $TestDrive 'evidence1-host-broker-capability-dispatch.ps1')
        $outerJson.arguments[0] | Should -BeExactly '-CapabilityRequestPath'
    }

    It 'releases the mutex after a successful call, so an immediate second call also succeeds' {
        $queueRoot = New-TestQueueRoot
        Submit-E1BrokerCapabilityOperation -Capability 'vm.inspect' -Arguments ([ordered]@{ VMName = 'x'; ExpectedVMId = '' }) `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask (New-FakePassTrigger) | Out-Null
        { Submit-E1BrokerCapabilityOperation -Capability 'vm.inspect' -Arguments ([ordered]@{ VMName = 'y'; ExpectedVMId = '' }) `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask (New-FakePassTrigger) } | Should -Not -Throw
    }

    It 'rejects a queue-root outside C:\kmp-eval\scratch\ before ever touching the mutex' {
        { Submit-E1BrokerCapabilityOperation -Capability 'vm.inspect' -Arguments ([ordered]@{ VMName = 'x'; ExpectedVMId = '' }) `
            -QueueRoot 'C:\Windows\Temp\evil-queue' -TriggerTask (New-FakePassTrigger) } |
            Should -Throw '*broker_capability_path_argument_outside_root*'
    }
}

Describe 'Submit-E1BrokerCapabilityOperation: busy queue' {
    It 'refuses to submit while a stray outer request already sits in requests/' {
        $queueRoot = New-TestQueueRoot
        New-Item -ItemType Directory -Force -Path (Join-Path $queueRoot 'requests') | Out-Null
        'stray' | Set-Content -LiteralPath (Join-Path $queueRoot 'requests\stray.request.json') -Encoding UTF8
        { Submit-E1BrokerCapabilityOperation -Capability 'vm.inspect' -Arguments ([ordered]@{ VMName = 'x'; ExpectedVMId = '' }) `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask (New-FakePassTrigger) } |
            Should -Throw '*broker_capability_queue_busy*'
    }

    It 'never wrote a capability request when the busy check rejects the call' {
        $queueRoot = New-TestQueueRoot
        New-Item -ItemType Directory -Force -Path (Join-Path $queueRoot 'in-progress') | Out-Null
        'stray' | Set-Content -LiteralPath (Join-Path $queueRoot 'in-progress\stray.request.json') -Encoding UTF8
        try { Submit-E1BrokerCapabilityOperation -Capability 'vm.inspect' -Arguments ([ordered]@{ VMName = 'x'; ExpectedVMId = '' }) `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask (New-FakePassTrigger) } catch { }
        $queuePaths = Get-E1BrokerCapabilityQueuePaths $queueRoot
        @(Get-ChildItem -LiteralPath $queuePaths.requests_dir -Filter '*.request.json' -ErrorAction SilentlyContinue).Count | Should -Be 0
    }
}

Describe 'Submit-E1BrokerElevatedScript: allowlisted harness preparation transport' {
    It 'writes the deployment script and exact arguments through an injected trigger only' {
        $queueRoot = New-TestQueueRoot; $captured = @{}
        $trigger = { param($TaskName,$RequestPath,$ResponsePath)
            $captured.task=$TaskName; $captured.request=(Get-Content -LiteralPath $RequestPath -Raw|ConvertFrom-Json)
            Write-E1BrokerCapabilityCreateNewJson $ResponsePath ([ordered]@{exit_code=0;log_path=$null})
        }.GetNewClosure()
        $deployment = Join-Path $TestDrive 'deployment'; New-Item -ItemType Directory -Force -Path $deployment | Out-Null
        $scriptPath=Join-Path $deployment 'evidence1-hyperv-update-harness-from-bundle.ps1'
        $response=Submit-E1BrokerElevatedScript -ScriptPath $scriptPath -ScriptArguments @('-TargetCommit',('a'*40),'-SkipFetch') -QueueRoot $queueRoot -AllowedRoot $deployment -TriggerTask $trigger
        $response.exit_code|Should -Be 0; $captured.task|Should -BeExactly 'Evidence1CodexElevatedRunner'
        $captured.request.script_path|Should -BeExactly $scriptPath
        @($captured.request.arguments)|Should -Be @('-TargetCommit',('a'*40),'-SkipFetch')
    }
}

Describe 'Ensure-E1BrokerSessionBundle: one-time non-UAC migration' {
    It 'isolates the default installer invocation from the caller module scope' {
        $body = (Get-Command Ensure-E1BrokerSessionBundle).ScriptBlock.ToString()
        $body | Should -Match 'Get-Process -Id \$PID'
        $body | Should -Match '-NonInteractive -File \$Path -UpdateBroker'
        $body | Should -Not -Match '(?m)^\s*& \$Path -UpdateBroker'
    }

    It 'is a no-op when the deployed stable session bundle already exists' {
        $state = [ordered]@{ update_calls = 0; probe_calls = 0 }
        $status = { [ordered]@{ readable=$true; deployment_root='C:\deployed-a'; self_update_capable=$true } }
        $probe = { param($Root) $state.probe_calls++; @('run-agentic-eval-session', 'prepare-agentic-eval-isolation-attestations') }.GetNewClosure()
        $update = { param($Installer,$Receipt) $state.update_calls++ }.GetNewClosure()

        $result = Ensure-E1BrokerSessionBundle -UseRealBackends $true -CampaignRoot $TestDrive `
            -InstallerPath (Join-Path $TestDrive 'evidence1-install.ps1') -GetBrokerStatus $status `
            -GetDeployedBundleNames $probe -InvokeBrokerUpdate $update

        $result.migrated | Should -BeFalse
        $state.update_calls | Should -Be 0
        $state.probe_calls | Should -Be 1
    }

    It 'performs exactly one update when absent and accepts only the post-update capability' {
        $state = [ordered]@{ update_calls = 0; probe_calls = 0 }
        $status = { [ordered]@{ readable=$true; deployment_root='C:\deployed-b'; self_update_capable=$true } }
        $probe = {
            param($Root)
            $state.probe_calls++
            if ($state.update_calls -eq 0) { @('get-cli-version') } else { @('get-cli-version','run-agentic-eval-session','prepare-agentic-eval-isolation-attestations') }
        }.GetNewClosure()
        $update = {
            param($Installer,$Receipt)
            $state.update_calls++
            ([ordered]@{ verdict='PASS'; uac_count=0 } | ConvertTo-Json) | Set-Content -LiteralPath $Receipt -Encoding UTF8
        }.GetNewClosure()

        $result = Ensure-E1BrokerSessionBundle -UseRealBackends $true -CampaignRoot $TestDrive `
            -InstallerPath (Join-Path $TestDrive 'evidence1-install.ps1') -GetBrokerStatus $status `
            -GetDeployedBundleNames $probe -InvokeBrokerUpdate $update

        $result.migrated | Should -BeTrue
        $state.update_calls | Should -Be 1
        $state.probe_calls | Should -Be 2
    }

    It 'rejects a migration receipt that reports any UAC' {
        $status = { [ordered]@{ readable=$true; deployment_root='C:\deployed-c'; self_update_capable=$true } }
        $probe = { param($Root) @('get-cli-version') }
        $update = {
            param($Installer,$Receipt)
            ([ordered]@{ verdict='PASS'; uac_count=1 } | ConvertTo-Json) | Set-Content -LiteralPath $Receipt -Encoding UTF8
        }

        { Ensure-E1BrokerSessionBundle -UseRealBackends $true -CampaignRoot $TestDrive `
            -InstallerPath (Join-Path $TestDrive 'evidence1-install.ps1') -GetBrokerStatus $status `
            -GetDeployedBundleNames $probe -InvokeBrokerUpdate $update } |
            Should -Throw '*broker_session_bundle_migration_receipt_invalid*'
    }

    It 'rejects a PASS update that still does not expose the stable session bundle' {
        $status = { [ordered]@{ readable=$true; deployment_root='C:\deployed-d'; self_update_capable=$true } }
        $probe = { param($Root) @('get-cli-version') }
        $update = {
            param($Installer,$Receipt)
            ([ordered]@{ verdict='PASS'; uac_count=0 } | ConvertTo-Json) | Set-Content -LiteralPath $Receipt -Encoding UTF8
        }

        { Ensure-E1BrokerSessionBundle -UseRealBackends $true -CampaignRoot $TestDrive `
            -InstallerPath (Join-Path $TestDrive 'evidence1-install.ps1') -GetBrokerStatus $status `
            -GetDeployedBundleNames $probe -InvokeBrokerUpdate $update } |
            Should -Throw '*broker_session_bundle_missing_after_migration*'
    }

    It 'inspects a deployed contract without replacing the checkout contract already loaded' {
        $checkoutContract = Join-Path $script:AuditsRoot 'evidence1-guest-bundle-contract.psm1'
        Import-Module $checkoutContract -Force
        $before = @(Get-E1GuestBundleNames)
        $deployment = Join-Path $TestDrive 'isolated-deployment'
        New-Item -ItemType Directory -Force -Path $deployment | Out-Null
        @'
function Get-E1GuestBundleNames { @('deployed-only') }
Export-ModuleMember -Function Get-E1GuestBundleNames
'@ | Set-Content -LiteralPath (Join-Path $deployment 'evidence1-guest-bundle-contract.psm1') -Encoding UTF8

        @(Get-E1BrokerDeployedGuestBundleNames -DeploymentRoot $deployment) | Should -Be @('deployed-only')
        @(Get-E1GuestBundleNames) | Should -Be $before
    }
}

Describe 'Submit-E1BrokerCapabilityOperation: timeout and integrity checks' {
    It 'times out (no real waiting) when the trigger never produces a response' {
        $queueRoot = New-TestQueueRoot
        $clock = New-FakeAdvancingClock
        # -PickupTimeoutSeconds set well past this test's own -TimeoutMinutes window: this test's
        # own purpose is the OUTER -TimeoutMinutes ceiling specifically, not the pickup fast-fail
        # (covered on its own in the "pickup fast-fail" Describe below) -- without this override a
        # never-picked-up request now legitimately fails faster, on broker_request_not_picked_up,
        # before -TimeoutMinutes is ever reached, which is the new, correct, more specific behavior,
        # not a regression of this one.
        { Submit-E1BrokerCapabilityOperation -Capability 'vm.inspect' -Arguments ([ordered]@{ VMName = 'x'; ExpectedVMId = '' }) `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask (New-FakeNoOpTrigger) `
            -TimeoutMinutes 3 -PickupTimeoutSeconds 99999 -PollIntervalSeconds 0 -GetUtcNow $clock } | Should -Throw '*broker_capability_await_timeout*'
    }

    It 'rejects a response whose operation_id does not match the request it answers' {
        $queueRoot = New-TestQueueRoot
        $mismatchTrigger = {
            param($TaskName, $CapabilityRequestPath, $ResponsePath)
            $response = New-E1BrokerCapabilityResponse -OperationId ([guid]::NewGuid().ToString('D')) -Capability 'vm.inspect' -Verdict 'PASS' -Result ([ordered]@{ a = 1 })
            Write-E1BrokerCapabilityCreateNewJson $ResponsePath $response
        }
        { Submit-E1BrokerCapabilityOperation -Capability 'vm.inspect' -Arguments ([ordered]@{ VMName = 'x'; ExpectedVMId = '' }) `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask $mismatchTrigger } |
            Should -Throw '*broker_capability_response_operation_id_mismatch*'
    }
}

Describe 'Submit-E1BrokerCapabilityOperation: pickup fast-fail (2026-09-28 orphan-runner incident)' {
    It 'throws broker_request_not_picked_up when the outer request is still in requests/ past the pickup deadline' {
        $queueRoot = New-TestQueueRoot
        $clock = New-FakeAdvancingClock
        { Submit-E1BrokerCapabilityOperation -Capability 'vm.inspect' -Arguments ([ordered]@{ VMName = 'x'; ExpectedVMId = '' }) `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask (New-FakeNoOpTrigger) `
            -TimeoutMinutes 5 -PickupTimeoutSeconds 30 -PollIntervalSeconds 0 -GetUtcNow $clock } |
            Should -Throw '*broker_request_not_picked_up*'
    }

    It 'never wrote a real -TimeoutMinutes-length wait when it fails fast on pickup -- the clock never reaches the outer deadline' {
        $queueRoot = New-TestQueueRoot
        $clock = New-FakeAdvancingClock
        $callsBefore = 0
        $countingClock = { $callsBefore++; & $clock }.GetNewClosure()
        try {
            Submit-E1BrokerCapabilityOperation -Capability 'vm.inspect' -Arguments ([ordered]@{ VMName = 'x'; ExpectedVMId = '' }) `
                -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask (New-FakeNoOpTrigger) `
                -TimeoutMinutes 120 -PickupTimeoutSeconds 30 -PollIntervalSeconds 0 -GetUtcNow $countingClock
        } catch { }
        # The fake clock advances 60s/call; a 120-MINUTE outer deadline would take ~120 calls to
        # reach. Failing fast on a 30s pickup deadline should take a small, single-digit number.
        $callsBefore | Should -BeLessThan 10
    }

    It 'throws broker_request_stalled when the request was claimed (moved to in-progress/) but no log ever appeared' {
        $queueRoot = New-TestQueueRoot
        $clock = New-FakeAdvancingClock
        { Submit-E1BrokerCapabilityOperation -Capability 'vm.inspect' -Arguments ([ordered]@{ VMName = 'x'; ExpectedVMId = '' }) `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask (New-FakeStalledAfterClaimTrigger) `
            -TimeoutMinutes 5 -PickupTimeoutSeconds 30 -PollIntervalSeconds 0 -GetUtcNow $clock } |
            Should -Throw '*broker_request_stalled*'
    }

    It 'does not fast-fail once the log exists, even past an already-expired pickup deadline -- proceeds to the normal response wait' {
        $queueRoot = New-TestQueueRoot
        $response = Submit-E1BrokerCapabilityOperation -Capability 'vm.inspect' -Arguments ([ordered]@{ VMName = 'x'; ExpectedVMId = '' }) `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask (New-FakeLogThenPassTrigger) -PickupTimeoutSeconds 0
        $response.verdict | Should -BeExactly 'PASS'
        $response.result.echoed | Should -BeTrue
    }

    It 'defaults -PickupTimeoutSeconds to 120 when not specified' {
        (Get-Command Submit-E1BrokerCapabilityOperation).Parameters['PickupTimeoutSeconds'].Attributes |
            Where-Object { $_ -is [System.Management.Automation.ParameterAttribute] } | Out-Null
        $default = (Get-Command Submit-E1BrokerCapabilityOperation).ScriptBlock.Ast.Body.ParamBlock.Parameters |
            Where-Object { $_.Name.VariablePath.UserPath -eq 'PickupTimeoutSeconds' } |
            ForEach-Object { $_.DefaultValue.Extent.Text }
        $default | Should -Be '120'
    }
}

Describe 'Submit-E1BrokerCapabilityOperation: trigger-until-claimed retry (2026-09-29 wedge fix)' {
    # Live-diagnosed root cause (WO-A2 H-flake investigation): schtasks /Run
    # exited 0 but the real broker's own RUNNER-TRACE.log shows the dispatcher
    # never even logged "processing request" for the next submission -- the
    # trigger raced the previous -Once instance's own teardown and was
    # silently dropped. A single trigger with no retry orphaned the request
    # in requests/ forever, and every later caller correctly, but
    # unhelpfully, refused with broker_capability_queue_busy. A manual
    # `schtasks.exe /Run` re-trigger claimed it within 8s. These tests prove
    # the client now does that re-trigger itself, bounded, instead of a human
    # having to notice and intervene.

    It 'recovers when the first two attempts are silently dropped and the third claims' {
        $queueRoot = New-TestQueueRoot
        $clock = New-FakeAdvancingClock
        $fake = New-FakeCountingClaimTrigger -ClaimOnAttempt 3

        $response = Submit-E1BrokerCapabilityOperation -Capability 'vm.inspect' -Arguments ([ordered]@{ VMName = 'x'; ExpectedVMId = '' }) `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask $fake.Trigger `
            -TimeoutMinutes 30 -PickupTimeoutSeconds 500 -RetriggerIntervalSeconds 0 -PollIntervalSeconds 0 `
            -GetTaskState (New-FakeTaskStateAlways 'Ready') -GetUtcNow $clock

        $response.verdict | Should -BeExactly 'PASS'
        $fake.State.Calls | Should -Be 3
    }

    It 'never retriggers while the scheduled task itself reports Running' {
        $queueRoot = New-TestQueueRoot
        $clock = New-FakeAdvancingClock
        $fake = New-FakeCountingNoOpTrigger

        { Submit-E1BrokerCapabilityOperation -Capability 'vm.inspect' -Arguments ([ordered]@{ VMName = 'x'; ExpectedVMId = '' }) `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask $fake.Trigger `
            -TimeoutMinutes 30 -PickupTimeoutSeconds 200 -RetriggerIntervalSeconds 0 -PollIntervalSeconds 0 `
            -GetTaskState (New-FakeTaskStateAlways 'Running') -GetUtcNow $clock } |
            Should -Throw '*broker_request_not_picked_up*'

        # The initial trigger always fires; Running suppresses every re-trigger.
        $fake.State.Calls | Should -Be 1
    }

    It 'fails closed with broker_request_not_picked_up after exactly MaxTriggerAttempts, never exceeding the bound' {
        $queueRoot = New-TestQueueRoot
        $clock = New-FakeAdvancingClock
        $fake = New-FakeCountingNoOpTrigger

        { Submit-E1BrokerCapabilityOperation -Capability 'vm.inspect' -Arguments ([ordered]@{ VMName = 'x'; ExpectedVMId = '' }) `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask $fake.Trigger `
            -TimeoutMinutes 30 -PickupTimeoutSeconds 500 -MaxTriggerAttempts 3 -RetriggerIntervalSeconds 0 -PollIntervalSeconds 0 `
            -GetTaskState (New-FakeTaskStateAlways 'Ready') -GetUtcNow $clock } |
            Should -Throw '*broker_request_not_picked_up*'

        $fake.State.Calls | Should -Be 3
    }

    It 'sees exactly 1 trigger call when the first attempt claims immediately' {
        $queueRoot = New-TestQueueRoot
        $clock = New-FakeAdvancingClock
        $fake = New-FakeCountingClaimTrigger -ClaimOnAttempt 1

        $response = Submit-E1BrokerCapabilityOperation -Capability 'vm.inspect' -Arguments ([ordered]@{ VMName = 'x'; ExpectedVMId = '' }) `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask $fake.Trigger `
            -TimeoutMinutes 30 -PickupTimeoutSeconds 300 -RetriggerIntervalSeconds 0 -PollIntervalSeconds 0 `
            -GetTaskState (New-FakeTaskStateAlways 'Ready') -GetUtcNow $clock

        $response.verdict | Should -BeExactly 'PASS'
        $fake.State.Calls | Should -Be 1
    }

    It 'respects -RetriggerIntervalSeconds: does not retrigger before the interval has elapsed' {
        $queueRoot = New-TestQueueRoot
        $clock = New-FakeAdvancingClock
        $fake = New-FakeCountingNoOpTrigger

        # 90s < the 1-real-minute-per-tick clock's own granularity is awkward to
        # straddle deterministically; instead prove the OTHER direction, which
        # is exactly as discriminating: a huge interval (longer than the whole
        # pickup window) means the initial trigger fires and NOTHING ever
        # re-triggers before the pickup deadline throws.
        { Submit-E1BrokerCapabilityOperation -Capability 'vm.inspect' -Arguments ([ordered]@{ VMName = 'x'; ExpectedVMId = '' }) `
            -QueueRoot $queueRoot -AllowedRoot $TestDrive -TriggerTask $fake.Trigger `
            -TimeoutMinutes 30 -PickupTimeoutSeconds 200 -RetriggerIntervalSeconds 100000 -PollIntervalSeconds 0 `
            -GetTaskState (New-FakeTaskStateAlways 'Ready') -GetUtcNow $clock } |
            Should -Throw '*broker_request_not_picked_up*'

        $fake.State.Calls | Should -Be 1
    }
}

Describe 'Structural safety: schtasks.exe is reachable only through the Trigger and End seams' {
    BeforeAll {
        # Comment-stripped: this file's own header and per-function doc
        # comments mention "schtasks.exe" several times in prose -- only the
        # LIVE-CODE occurrence count matters for this structural proof.
        function Remove-E1PowerShellLineComments([string]$Source) {
            $lines = $Source -split "`r?`n"
            $stripped = foreach ($line in $lines) {
                $hashIndex = $line.IndexOf('#')
                if ($hashIndex -ge 0) { $line.Substring(0, $hashIndex) } else { $line }
            }
            return ($stripped -join "`n")
        }
    }
    It 'schtasks.exe appears exactly twice in live code: once inside Invoke-E1BrokerCapabilityTriggerTask, once inside Invoke-E1BrokerCapabilityEndTask' {
        $source = Remove-E1PowerShellLineComments (Get-Content -LiteralPath (Join-Path $script:AuditsRoot 'evidence1-broker-capability-client.psm1') -Raw)
        $matches = [regex]::Matches($source, 'schtasks\.exe')
        $matches.Count | Should -Be 2
        $triggerStart = $source.IndexOf('function Invoke-E1BrokerCapabilityTriggerTask')
        $endStart = $source.IndexOf('function Invoke-E1BrokerCapabilityEndTask')
        $submitStart = $source.IndexOf('function Submit-E1BrokerCapabilityOperation')
        $triggerStart | Should -BeGreaterThan 0
        $endStart | Should -BeGreaterThan $triggerStart
        $submitStart | Should -BeGreaterThan $endStart
        $matches[0].Index | Should -BeGreaterThan $triggerStart
        $matches[0].Index | Should -BeLessThan $endStart
        $matches[1].Index | Should -BeGreaterThan $endStart
        $matches[1].Index | Should -BeLessThan $submitStart
    }
    It 'Submit-E1BrokerCapabilityOperation''s own body never references schtasks.exe directly' {
        $source = Remove-E1PowerShellLineComments (Get-Content -LiteralPath (Join-Path $script:AuditsRoot 'evidence1-broker-capability-client.psm1') -Raw)
        $functionStart = $source.IndexOf('function Submit-E1BrokerCapabilityOperation')
        $body = $source.Substring($functionStart)
        $body | Should -Not -Match 'schtasks\.exe'
    }
}

AfterAll {
    if (Test-Path -LiteralPath $script:PesterScratchRoot) {
        Remove-Item -LiteralPath $script:PesterScratchRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
