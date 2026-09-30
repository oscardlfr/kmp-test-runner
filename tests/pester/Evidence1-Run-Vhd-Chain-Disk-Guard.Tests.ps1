# P0 #4 (publication hardening, auditor-directed): the principled VmReady disk guard formula.
# Real extraction, not a hand replica -- Get-E1RunPropertyValue/Get-E1RunVmReadyRequiredDiskBytes
# (evidence1-run.ps1) are self-contained pure functions with no external dependency to inject away,
# so this file dot-extracts and runs the REAL functions directly (same "extract via IndexOf/
# Substring, Invoke-Expression into this scope" convention
# Evidence1-Run-Full-Campaign-Integration.Tests.ps1 already established for top-level-script
# functions -- evidence1-run.ps1 is a script, not an importable module).
BeforeAll {
    # $PSScriptRoot-relative rather than a hardcoded checkout path (2026-09-30, same fix as every
    # other file in this round) -- this always tests whichever checkout this copy of the file
    # itself lives in.
    $script:RunScriptSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\..\evidence1-run.ps1') -Raw
    foreach ($name in @('Get-E1RunPropertyValue', 'Get-E1RunRequiredPositiveInt64', 'Get-E1RunVmReadyRequiredDiskBytes')) {
        $start = $script:RunScriptSource.IndexOf("function $name")
        if ($start -lt 0) { throw "$name not found in evidence1-run.ps1 -- P0 #4 fix not applied" }
        $end = $script:RunScriptSource.IndexOf("`n}`n", $start)
        if ($end -lt 0) { throw "could not isolate the end of $name" }
        Invoke-Expression ($script:RunScriptSource.Substring($start, $end - $start + 2))
    }

    $FLOOR = 16106127360
    $THREE_GIB = 3221225472

    # A real Hashtable AND a real PSCustomObject (round-tripped through ConvertTo-Json/
    # ConvertFrom-Json, exactly how a real broker-capability response actually arrives -- never a
    # hand-built PSCustomObject, per the auditor's own .Keys-regression note) built from the SAME
    # logical inspection result, so every formula test below can run against both shapes.
    function script:New-TestChainInspection {
        param(
            [int64]$LeafVirtualSize, [int64]$LeafFileSize,
            [string]$AutomaticStopAction = 'ShutDown', [string]$VmState = 'Off',
            [int64]$MemoryStartupBytes = 2147483648,
            [switch]$AsPSCustomObject
        )
        $obj = [ordered]@{
            chain = @(
                [ordered]@{ virtual_size = $LeafVirtualSize; file_size = $LeafFileSize }
                [ordered]@{ virtual_size = 20000000000; file_size = 19000000000 }
            )
            automatic_stop_action = $AutomaticStopAction
            vm_state = $VmState
            memory_startup_bytes = $MemoryStartupBytes
        }
        if ($AsPSCustomObject) { return ($obj | ConvertTo-Json -Depth 5 | ConvertFrom-Json) }
        return $obj
    }
}

Describe 'Get-E1RunVmReadyRequiredDiskBytes formula' {
    It '(RED-proof-in-spirit) the flat 15 GiB floor alone is NOT what this returns for a small leaf -- it is exactly the 3-GiB-padded formula floor, 16106127360' {
        # A leaf with almost no slack (virtual_size == file_size, a nearly-full differencing disk)
        # still must not return less than the 16106127360-byte floor.
        $inspection = New-TestChainInspection -LeafVirtualSize 5000000000 -LeafFileSize 4999999999
        $required = Get-E1RunVmReadyRequiredDiskBytes $inspection
        $required | Should -Be $FLOOR
    }

    It 'the leaf slack wins once it exceeds the floor: (virtual_size - file_size) + 3 GiB' {
        $virtualSize = 50000000000
        $fileSize = 10000000000
        $inspection = New-TestChainInspection -LeafVirtualSize $virtualSize -LeafFileSize $fileSize
        $expected = ($virtualSize - $fileSize) + $THREE_GIB
        $expected | Should -BeGreaterThan $FLOOR
        (Get-E1RunVmReadyRequiredDiskBytes $inspection) | Should -Be $expected
    }

    It 'AutomaticStopAction Save AND not-Running adds memory_startup_bytes on top' {
        $inspection = New-TestChainInspection -LeafVirtualSize 5000000000 -LeafFileSize 4999999999 -AutomaticStopAction 'Save' -VmState 'Off' -MemoryStartupBytes 12884901888
        (Get-E1RunVmReadyRequiredDiskBytes $inspection) | Should -Be ($FLOOR + 12884901888)
    }

    It 'AutomaticStopAction Save but ALREADY Running does NOT add memory_startup_bytes -- a running VM''s own reservation, if any, is already reflected in current host free bytes' {
        $inspection = New-TestChainInspection -LeafVirtualSize 5000000000 -LeafFileSize 4999999999 -AutomaticStopAction 'Save' -VmState 'Running' -MemoryStartupBytes 12884901888
        (Get-E1RunVmReadyRequiredDiskBytes $inspection) | Should -Be $FLOOR
    }

    It 'AutomaticStopAction ShutDown never adds memory_startup_bytes, regardless of VM state' {
        $inspection = New-TestChainInspection -LeafVirtualSize 5000000000 -LeafFileSize 4999999999 -AutomaticStopAction 'ShutDown' -VmState 'Off' -MemoryStartupBytes 12884901888
        (Get-E1RunVmReadyRequiredDiskBytes $inspection) | Should -Be $FLOOR
    }

    It 'a real PSCustomObject (ConvertFrom-Json round trip, both the top-level result and each chain[] entry) computes identically to the Hashtable shape' {
        $hashtableResult = Get-E1RunVmReadyRequiredDiskBytes (New-TestChainInspection -LeafVirtualSize 50000000000 -LeafFileSize 10000000000 -AutomaticStopAction 'Save' -VmState 'Off' -MemoryStartupBytes 12884901888)
        $jsonResult = Get-E1RunVmReadyRequiredDiskBytes (New-TestChainInspection -LeafVirtualSize 50000000000 -LeafFileSize 10000000000 -AutomaticStopAction 'Save' -VmState 'Off' -MemoryStartupBytes 12884901888 -AsPSCustomObject)
        $jsonResult | Should -Be $hashtableResult
    }

    # 2026-09-30 (auditor-directed fix, found live during the first fake-mode GREEN run): PowerShell
    # unrolls a ONE-element array to its bare element crossing a function return or an if/else
    # EXPRESSION capture. Every OTHER test in this file uses New-TestChainInspection, which always
    # builds a 2-element chain -- a 2+-element array survives that round trip unchanged, which is
    # exactly why this went undetected until a real single-link chain (Get-E1RunVhdChainInspectionForContext's
    # own fake-mode literal, and any real VM with no checkpoint) exercised the 1-element case for
    # real. Hashtable AND PSCustomObject both covered -- the bug reproduced identically in both
    # shapes when it was live.
    It 'computes correctly for a single-link chain (no checkpoint) -- (<Shape>)' -ForEach @(
        @{ Shape = 'Hashtable'; AsPSCustomObject = $false }, @{ Shape = 'PSCustomObject'; AsPSCustomObject = $true }
    ) {
        $obj = [ordered]@{
            chain = @([ordered]@{ virtual_size = 137438953472; file_size = 1073741824 })
            automatic_stop_action = 'ShutDown'
            vm_state = 'Off'
            memory_startup_bytes = 0
        }
        $inspection = if ($AsPSCustomObject) { $obj | ConvertTo-Json -Depth 5 | ConvertFrom-Json } else { $obj }
        $expected = (137438953472 - 1073741824) + $THREE_GIB
        $expected | Should -BeGreaterThan $FLOOR
        (Get-E1RunVmReadyRequiredDiskBytes $inspection) | Should -Be $expected
    }

    It 'fails closed with vhd_chain_inspection_unavailable when the chain array is empty' {
        $inspection = [ordered]@{ chain = @(); automatic_stop_action = 'ShutDown'; vm_state = 'Off'; memory_startup_bytes = 0 }
        { Get-E1RunVmReadyRequiredDiskBytes $inspection } | Should -Throw '*vhd_chain_inspection_unavailable*'
    }

    It 'fails closed (throws, never returns a default) when chain is entirely missing from the result' {
        { Get-E1RunVmReadyRequiredDiskBytes ([ordered]@{ automatic_stop_action = 'ShutDown'; vm_state = 'Off'; memory_startup_bytes = 0 }) } | Should -Throw
    }
}

# Auditor fail-open fix, 2026-09-30: [int64]$null is 0 and [string]$null is '' -- both cast
# silently instead of failing, so a missing virtual_size made the leaf slack negative (the floor
# always "won", the check PASSED with no real chain data behind it) and a missing/garbled
# automatic_stop_action silently skipped the Save reservation instead of surfacing that the field
# was never read. Every field the formula reads is now validated strictly before any arithmetic
# runs, in the same order the formula itself reads them. RED-first: every case below was run
# against the pre-fix function and failed to throw (silently returned a number instead) before the
# strict validation was added; GREEN once it was.
Describe 'Get-E1RunVmReadyRequiredDiskBytes strict field validation (auditor fail-open fix)' {
    BeforeAll {
        # Builds a normally-valid inspection (same leaf/chain shape New-TestChainInspection above
        # uses) then applies overrides/removals -- separate from that helper because invalid cases
        # need to OMIT a key entirely, which a normal-case constructor has no reason to support.
        function script:New-TestChainInspectionInvalid {
            param([hashtable]$LeafOverrides = @{}, [string[]]$LeafRemoveKeys = @(), [hashtable]$Overrides = @{}, [string[]]$RemoveKeys = @(), [switch]$AsPSCustomObject)
            $leaf = [ordered]@{ virtual_size = 50000000000; file_size = 10000000000 }
            foreach ($key in $LeafOverrides.Keys) { $leaf[$key] = $LeafOverrides[$key] }
            foreach ($key in $LeafRemoveKeys) { $leaf.Remove($key) }
            $obj = [ordered]@{
                chain = @($leaf, [ordered]@{ virtual_size = 20000000000; file_size = 19000000000 })
                automatic_stop_action = 'ShutDown'
                vm_state = 'Off'
                memory_startup_bytes = 2147483648
            }
            foreach ($key in $Overrides.Keys) { $obj[$key] = $Overrides[$key] }
            foreach ($key in $RemoveKeys) { $obj.Remove($key) }
            if ($AsPSCustomObject) { return ($obj | ConvertTo-Json -Depth 5 | ConvertFrom-Json) }
            return $obj
        }
    }

    # Bare (discovery-phase) code, deliberately NOT inside BeforeAll -- Pester's -ForEach below
    # needs this array at DISCOVERY time, before any BeforeAll has run; building it inside BeforeAll
    # produced zero tests from this whole block (confirmed empirically: an earlier version of this
    # file that did that ran only the 8 pre-existing tests above, silently discovering none of these
    # -ForEach cases at all). One entry per missing-or-invalid field; expanded below into a
    # Hashtable AND a ConvertFrom-Json PSCustomObject variant of each (the auditor's own explicit
    # ask).
    $script:BaseInvalidCases = @(
        @{ Description = 'leaf virtual_size missing entirely'; LeafRemoveKeys = @('virtual_size'); MessagePattern = '*vhd_chain_inspection_unavailable*virtual_size*' }
        @{ Description = 'leaf virtual_size is zero'; LeafOverrides = @{ virtual_size = 0 }; MessagePattern = '*vhd_chain_inspection_unavailable*virtual_size*' }
        @{ Description = 'leaf virtual_size is a non-numeric string'; LeafOverrides = @{ virtual_size = 'not-a-number' }; MessagePattern = '*vhd_chain_inspection_unavailable*virtual_size*' }
        @{ Description = 'leaf file_size missing entirely'; LeafRemoveKeys = @('file_size'); MessagePattern = '*vhd_chain_inspection_unavailable*file_size*' }
        @{ Description = 'leaf file_size is zero'; LeafOverrides = @{ file_size = 0 }; MessagePattern = '*vhd_chain_inspection_unavailable*file_size*' }
        @{ Description = 'leaf file_size exceeds virtual_size plus the 1 GiB metadata allowance'; LeafOverrides = @{ virtual_size = 5000000000; file_size = 6500000000 }; MessagePattern = '*vhd_chain_inspection_unavailable*file_size*' }
        @{ Description = 'automatic_stop_action missing entirely'; RemoveKeys = @('automatic_stop_action'); MessagePattern = '*vhd_chain_inspection_unavailable*automatic_stop_action*' }
        @{ Description = 'automatic_stop_action is not a recognized value'; Overrides = @{ automatic_stop_action = 'Paused' }; MessagePattern = '*vhd_chain_inspection_unavailable*automatic_stop_action*' }
        @{ Description = 'vm_state missing entirely'; RemoveKeys = @('vm_state'); MessagePattern = '*vhd_chain_inspection_unavailable*vm_state*' }
        @{ Description = 'memory_startup_bytes missing when the Save reservation applies'; Overrides = @{ automatic_stop_action = 'Save'; vm_state = 'Off' }; RemoveKeys = @('memory_startup_bytes'); MessagePattern = '*vhd_chain_inspection_unavailable*memory_startup_bytes*' }
        @{ Description = 'memory_startup_bytes is zero when the Save reservation applies'; Overrides = @{ automatic_stop_action = 'Save'; vm_state = 'Off'; memory_startup_bytes = 0 }; MessagePattern = '*vhd_chain_inspection_unavailable*memory_startup_bytes*' }
    )
    $script:InvalidCases = @($script:BaseInvalidCases | ForEach-Object {
        $case = $_
        [ordered]@{ Description = "$($case.Description) (Hashtable)"; Case = $case; AsPSCustomObject = $false }
        [ordered]@{ Description = "$($case.Description) (PSCustomObject via ConvertFrom-Json)"; Case = $case; AsPSCustomObject = $true }
    })

    It 'throws: <Description>' -ForEach $script:InvalidCases {
        $params = @{ AsPSCustomObject = $AsPSCustomObject }
        foreach ($key in @('LeafOverrides', 'LeafRemoveKeys', 'Overrides', 'RemoveKeys')) {
            if ($Case.ContainsKey($key)) { $params[$key] = $Case[$key] }
        }
        $inspection = New-TestChainInspectionInvalid @params
        { Get-E1RunVmReadyRequiredDiskBytes $inspection } | Should -Throw $Case.MessagePattern
    }

    It 'memory_startup_bytes is NOT validated (missing does not throw) when the Save reservation does not apply -- ShutDown never needs it (<Shape>)' -ForEach @(
        @{ Shape = 'Hashtable'; AsPSCustomObject = $false }, @{ Shape = 'PSCustomObject'; AsPSCustomObject = $true }
    ) {
        $inspection = New-TestChainInspectionInvalid -Overrides @{ automatic_stop_action = 'ShutDown' } -RemoveKeys @('memory_startup_bytes') -AsPSCustomObject:$AsPSCustomObject
        { Get-E1RunVmReadyRequiredDiskBytes $inspection } | Should -Not -Throw
    }
}
