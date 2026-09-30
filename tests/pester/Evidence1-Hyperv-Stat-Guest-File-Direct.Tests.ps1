# evidence1-hyperv-stat-guest-file-direct.ps1 has no injectable seam and #Requires
# -RunAsAdministrator -- same extraction/shadowed-cmdlet discipline as its siblings.
BeforeAll {
    $script:AuditsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\docs\audits')).Path
    $scriptSource = Get-Content -LiteralPath (Join-Path $script:AuditsRoot 'evidence1-hyperv-stat-guest-file-direct.ps1') -Raw
    $start = $scriptSource.IndexOf('$reportFull = [IO.Path]::GetFullPath($ReportPath)')
    if ($start -lt 0) { throw 'extraction anchor not found -- evidence1-hyperv-stat-guest-file-direct.ps1 changed shape' }
    $script:BodySource = $scriptSource.Substring($start)
    $script:ScratchRoot = Join-Path 'C:\kmp-eval\scratch\evidence1-guest-file-stat' ([guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $script:ScratchRoot | Out-Null
    $script:ExpectedVMId = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14'
}

AfterAll {
    if (Test-Path -LiteralPath $script:ScratchRoot) {
        Remove-Item -LiteralPath $script:ScratchRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Describe 'evidence1-hyperv-stat-guest-file-direct: safety checks (never touches Hyper-V, never reads content)' {
    BeforeEach {
        function Get-VM { param($Name) throw 'unexpected_get_vm_call' }
        $VMName = 'Evidence1-Runner-E2E'
        $ExpectedVMId = $script:ExpectedVMId
        $ReportPath = Join-Path $script:ScratchRoot "$([guid]::NewGuid().ToString('N')).json"
    }

    It 'rejects a report path outside the canonical scratch root before ever calling Get-VM' {
        $ReportPath = Join-Path $env:TEMP "$([guid]::NewGuid().ToString('N')).json"
        { Invoke-Expression $script:BodySource } | Should -Throw 'guest_file_stat_report_outside_canonical_root'
    }

    It 'rejects an existing report path (create-new only)' {
        Set-Content -LiteralPath $ReportPath -Value '{}' -Encoding UTF8
        { Invoke-Expression $script:BodySource } | Should -Throw 'guest_file_stat_report_must_be_create_new'
    }

    It 'rejects a VMName other than the E2E profile before ever calling Get-VM' {
        $VMName = 'SomeOtherVm'
        { Invoke-Expression $script:BodySource } | Should -Throw 'guest_file_stat_vm_name_not_e2e_profile'
    }

    It 'fails closed when the VM is not Off' {
        function Get-VM { param($Name) [pscustomobject]@{ Name = $Name; Id = $script:ExpectedVMId; State = 'Running' } }
        { Invoke-Expression $script:BodySource } | Should -Throw 'guest_file_stat_requires_exact_vm_off'
    }
}
