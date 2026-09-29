BeforeAll {
    # Import inside BeforeAll, not bare top-level -- see
    # Evidence1-Network-Backend-Contract.Tests.ps1's BeforeAll comment for why
    # (Pester 5 runs every file's top-level code during discovery, before any
    # file's It blocks; this module has no identically-named sibling so the
    # cross-file shadowing risk does not apply here, but BeforeAll is used
    # uniformly across all Evidence1 test files for consistency).
    $script:ModulePath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/audits/evidence1-vm-state-contract.psm1'
    Import-Module $script:ModulePath -Force
}

Describe 'Evidence1 VmState result shape accepts raw hashtables, not only PSCustomObject' {
    # Regression for the same bug class caught the first time evidence1-run.ps1
    # was actually run: New-E1VmStateResult returns a raw [ordered]@{} result,
    # and every fake-mode Get-E1VmState/Invoke-E1VmEnsureState result is exactly
    # that, never JSON-round-tripped, before Assert-E1VmStateResult sees it.

    It 'accepts a result exactly as New-E1VmStateResult returns it' {
        $result = New-E1VmStateResult -VMName 'FakeVM' -VMId ([guid]::NewGuid().ToString()) -State 'Off'
        { Assert-E1VmStateResult $result } | Should -Not -Throw
    }

    It 'accepts a hand-built hashtable literal for both Off and Running' {
        # [ordered]@{} is an OrderedDictionary, which has no .Clone() method
        # (unlike Hashtable) -- confirmed empirically (RuntimeException:
        # "no contiene ningun metodo llamado 'Clone'"). Built as two
        # independent literals instead of copy-and-mutate.
        $off = [ordered]@{
            schema = 1; vm_name = 'FakeVM'; vm_id = ([guid]::NewGuid().ToString()); state = 'Off'
            status = 'Operating normally'; uptime_seconds = 0; memory_assigned_bytes = 0
            processor_load_percent = 0; vhd_attached = $false; integration_services = @()
            verdict = 'PASS'; reason_code = $null; generated_at_utc = '2026-01-01T00:00:00.000Z'
        }
        { Assert-E1VmStateResult $off } | Should -Not -Throw

        $running = [ordered]@{
            schema = 1; vm_name = 'FakeVM'; vm_id = $off.vm_id; state = 'Running'
            status = 'Operating normally'; uptime_seconds = 1.0; memory_assigned_bytes = 0
            processor_load_percent = 0; vhd_attached = $true; integration_services = @()
            verdict = 'PASS'; reason_code = $null; generated_at_utc = '2026-01-01T00:00:00.000Z'
        }
        { Assert-E1VmStateResult $running } | Should -Not -Throw
    }

    It 'still accepts the same shape as a PSCustomObject' {
        $result = New-E1VmStateResult -VMName 'FakeVM' -VMId ([guid]::NewGuid().ToString()) -State 'Running'
        $roundTripped = ($result | ConvertTo-Json -Depth 5) | ConvertFrom-Json
        { Assert-E1VmStateResult $roundTripped } | Should -Not -Throw
    }

    It 'still rejects a genuinely wrong shape and an unrecognized state' {
        { Assert-E1VmStateResult ([ordered]@{ schema = 1; state = 'Off' }) } | Should -Throw '*vm_state_result_shape_invalid*'
        { New-E1VmStateResult -VMName 'FakeVM' -VMId ([guid]::NewGuid().ToString()) -State 'Paused' } | Should -Throw
    }
}
