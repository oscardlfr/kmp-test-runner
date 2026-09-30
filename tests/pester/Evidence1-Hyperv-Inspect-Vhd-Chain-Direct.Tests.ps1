# evidence1-hyperv-inspect-vhd-chain-direct.ps1 has no injectable seam (real
# Get-VM/Get-VMHardDiskDrive/Get-VHD) and #Requires -RunAsAdministrator, so it
# cannot be invoked directly by a non-elevated test runner. Same "extract the
# script body, shadow the real cmdlets with local functions, Invoke-Expression
# in isolation" discipline as
# tests/pester/Evidence1-Hyperv-Set-Vm-Memory-Direct.Tests.ps1. The extraction
# starts after the param block (never executed here -- $VMName/$ExpectedVMId/
# $ReportPath are set directly as script-scoped variables per test instead).
#
# 2026-09-30 (auditor-directed revert): reverted alongside the script itself -- see that file's own
# header. This is the pre-P0#4 version, testing the script's own independent inline walk directly.
BeforeAll {
    $script:AuditsRoot = 'C:\kmp-eval\agentic-eval-codex-runtime\docs\audits'
    $scriptSource = Get-Content -LiteralPath (Join-Path $script:AuditsRoot 'evidence1-hyperv-inspect-vhd-chain-direct.ps1') -Raw
    $start = $scriptSource.IndexOf('$reportFull = [IO.Path]::GetFullPath($ReportPath)')
    if ($start -lt 0) { throw 'extraction anchor not found -- evidence1-hyperv-inspect-vhd-chain-direct.ps1 changed shape' }
    $script:BodySource = $scriptSource.Substring($start)

    $script:ScratchRoot = Join-Path 'C:\kmp-eval\scratch\evidence1-vhd-chain' ([guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $script:ScratchRoot | Out-Null
    $script:ExpectedVMId = 'fd7c0298-186f-4a8e-9ae8-0a8af6969d14'
}

AfterAll {
    if (Test-Path -LiteralPath $script:ScratchRoot) {
        Remove-Item -LiteralPath $script:ScratchRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Describe 'evidence1-hyperv-inspect-vhd-chain-direct: argument and report-path rejection (never touches Hyper-V)' {
    BeforeEach {
        function Get-VM { param($Name) throw 'unexpected_get_vm_call' }
        function Get-VMHardDiskDrive { param($VMName) throw 'unexpected_get_vmharddiskdrive_call' }
        function Get-VHD { param($Path) throw 'unexpected_get_vhd_call' }

        $VMName = 'Evidence1-Runner-E2E'
        $ExpectedVMId = $script:ExpectedVMId
        $ReportPath = Join-Path $script:ScratchRoot "$([guid]::NewGuid().ToString('N')).json"
    }

    It 'rejects a report path outside the canonical scratch root before ever calling Get-VM' {
        $ReportPath = Join-Path $env:TEMP "$([guid]::NewGuid().ToString('N')).json"
        { Invoke-Expression $script:BodySource } | Should -Throw 'vhd_chain_report_outside_canonical_root'
    }

    It 'rejects an existing report path (create-new only)' {
        Set-Content -LiteralPath $ReportPath -Value '{}' -Encoding UTF8
        { Invoke-Expression $script:BodySource } | Should -Throw 'vhd_chain_report_must_be_create_new'
    }

    It 'rejects a VMName other than the E2E profile before ever calling Get-VM' {
        $VMName = 'SomeOtherVm'
        { Invoke-Expression $script:BodySource } | Should -Throw 'vhd_chain_vm_name_not_e2e_profile'
    }
}

Describe 'evidence1-hyperv-inspect-vhd-chain-direct: VM-identity fail-closed check' {
    BeforeEach {
        $VMName = 'Evidence1-Runner-E2E'
        $ExpectedVMId = $script:ExpectedVMId
        $ReportPath = Join-Path $script:ScratchRoot "$([guid]::NewGuid().ToString('N')).json"
    }

    It 'fails closed when the observed VM Id does not match ExpectedVMId' {
        function Get-VM { param($Name) [pscustomobject]@{ Name = $Name; Id = [guid]::NewGuid() } }
        function Get-VMHardDiskDrive { param($VMName) throw 'unexpected_get_vmharddiskdrive_call' }
        function Get-VHD { param($Path) throw 'unexpected_get_vhd_call' }

        { Invoke-Expression $script:BodySource } | Should -Throw 'vhd_chain_vm_identity_mismatch'
    }
}

Describe 'evidence1-hyperv-inspect-vhd-chain-direct: chain walk and report content' {
    BeforeEach {
        $VMName = 'Evidence1-Runner-E2E'
        $ExpectedVMId = $script:ExpectedVMId
        $ReportPath = Join-Path $script:ScratchRoot "$([guid]::NewGuid().ToString('N')).json"

        function Get-VM { param($Name) [pscustomobject]@{ Name = $Name; Id = $script:ExpectedVMId; State = 'Running'; AutomaticStopAction = 'Save'; MemoryStartup = 12884901888 } }
        function Get-CimInstance {
            param($ClassName)
            @(
                [pscustomobject]@{ DeviceID = 'C:'; FreeSpace = 12866293760; Size = 1999063384064 },
                [pscustomobject]@{ DeviceID = 'D:'; FreeSpace = 1757538877440; Size = 4001710866432 },
                [pscustomobject]@{ DeviceID = 'E:'; FreeSpace = 1; Size = 1 }
            )
        }
    }

    It 'walks a two-link differencing chain (leaf diff -> base) and reports both in order, plus VM/disk/host detail' {
        function Get-VMHardDiskDrive { param($VMName) @([pscustomobject]@{ Path = 'C:\fake\leaf.avhdx' }) }
        function Get-VHD {
            param($Path)
            if ($Path -ceq 'C:\fake\leaf.avhdx') {
                return [pscustomobject]@{ Path = 'C:\fake\leaf.avhdx'; VhdType = 'Differencing'; Size = 137438953472; FileSize = 121815171072; ParentPath = 'C:\fake\base.vhdx'; BlockSize = 33554432; LogicalSectorSize = 512 }
            }
            if ($Path -ceq 'C:\fake\base.vhdx') {
                return [pscustomobject]@{ Path = 'C:\fake\base.vhdx'; VhdType = 'Dynamic'; Size = 137438953472; FileSize = 20640169984; ParentPath = $null; BlockSize = 33554432; LogicalSectorSize = 512 }
            }
            throw "unexpected_get_vhd_path: $Path"
        }

        { Invoke-Expression $script:BodySource } | Should -Not -Throw

        $report = Get-Content -LiteralPath $ReportPath -Raw | ConvertFrom-Json
        $report.verdict | Should -BeExactly 'PASS'
        $report.vm_id | Should -BeExactly $script:ExpectedVMId
        $report.vm_state | Should -BeExactly 'Running'
        $report.automatic_stop_action | Should -BeExactly 'Save'
        $report.memory_startup_bytes | Should -Be 12884901888
        $report.hard_disk_drive_paths | Should -BeExactly @('C:\fake\leaf.avhdx')
        $report.chain.Count | Should -Be 2
        $report.chain[0].vhd_type | Should -BeExactly 'Differencing'
        $report.chain[0].virtual_size | Should -Be 137438953472
        $report.chain[0].file_size | Should -Be 121815171072
        $report.chain[0].block_size | Should -Be 33554432
        $report.chain[0].logical_sector_size | Should -Be 512
        $report.chain[1].vhd_type | Should -BeExactly 'Dynamic'
        $report.chain[1].parent_path | Should -BeNullOrEmpty
        $report.host_volumes.Count | Should -Be 2
        ($report.host_volumes | Where-Object { $_.device_id -ceq 'C:' }).free_bytes | Should -Be 12866293760
        ($report.host_volumes | Where-Object { $_.device_id -ceq 'D:' }).free_bytes | Should -Be 1757538877440
    }

    It 'walks a single-link chain (no checkpoint) without error' {
        function Get-VMHardDiskDrive { param($VMName) @([pscustomobject]@{ Path = 'C:\fake\onlybase.vhdx' }) }
        function Get-VHD {
            param($Path)
            [pscustomobject]@{ Path = 'C:\fake\onlybase.vhdx'; VhdType = 'Dynamic'; Size = 137438953472; FileSize = 20640169984; ParentPath = $null; BlockSize = 33554432; LogicalSectorSize = 512 }
        }

        { Invoke-Expression $script:BodySource } | Should -Not -Throw
        $report = Get-Content -LiteralPath $ReportPath -Raw | ConvertFrom-Json
        $report.chain.Count | Should -Be 1
    }

    It 'fails closed on a circular ParentPath instead of looping forever' {
        function Get-VMHardDiskDrive { param($VMName) @([pscustomobject]@{ Path = 'C:\fake\a.avhdx' }) }
        function Get-VHD {
            param($Path)
            if ($Path -ceq 'C:\fake\a.avhdx') {
                return [pscustomobject]@{ Path = 'C:\fake\a.avhdx'; VhdType = 'Differencing'; Size = 1; FileSize = 1; ParentPath = 'C:\fake\b.avhdx'; BlockSize = 33554432; LogicalSectorSize = 512 }
            }
            [pscustomobject]@{ Path = 'C:\fake\b.avhdx'; VhdType = 'Differencing'; Size = 1; FileSize = 1; ParentPath = 'C:\fake\a.avhdx'; BlockSize = 33554432; LogicalSectorSize = 512 }
        }

        { Invoke-Expression $script:BodySource } | Should -Throw 'vhd_chain_depth_exceeded'
    }
}
