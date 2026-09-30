# P0 #3 (publication hardening, auditor-directed): documented limitation drift guard.
#
# The base provisioning profile's approved-inputs manifest is a versioned HISTORICAL record of how
# this VM was actually first provisioned (Codex CLI 0.153.4) and must not be rewritten to claim a
# later version was the original input -- see tools/evidence1/provisioning/README.md's own
# "Known base-vs-launch gap" note. The live campaign launch path separately pins a newer version
# (0.154.0), reached on the current VM only through a separate, already-executed, pinned in-place
# upgrade whose own required input has no committed builder script yet (tracked in BACKLOG.md).
#
# Neither the upgrade script nor the base profile has a single, structural source of truth this
# test could derive one value from the other with (the upgrade script takes its target version as a
# caller-supplied parameter, not a hardcoded constant) -- that gap IS the documented limitation.
# What this test CAN do, and must, is pin the three real, currently-true literals together so any
# future edit to ONE of them fails loudly here instead of silently drifting past the others: the
# base profile's own pinned version, the upgrade script's own hardcoded prior-version root, and the
# launch path's own expected version.
BeforeAll {
    $script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    $script:ApprovedInputsV1 = Get-Content -LiteralPath (Join-Path $script:RepoRoot 'tools\evidence1\provisioning\approved-inputs\evidence1-windows-25h2-en-gb-codex-01534-e2e-v1.json') -Raw | ConvertFrom-Json
    $script:ApprovedInputsV2 = Get-Content -LiteralPath (Join-Path $script:RepoRoot 'tools\evidence1\provisioning\approved-inputs\evidence1-windows-25h2-en-gb-codex-01534-e2e-v2.json') -Raw | ConvertFrom-Json
    $script:UpgradeScriptSource = Get-Content -LiteralPath (Join-Path $script:RepoRoot 'docs\audits\evidence1-hyperv-upgrade-canonical-codex-cli-direct.ps1') -Raw
    $script:LaunchScriptSource = Get-Content -LiteralPath (Join-Path $script:RepoRoot 'docs\audits\evidence1-dual-condition-canary-launch.ps1') -Raw
    $script:ReadmeSource = Get-Content -LiteralPath (Join-Path $script:RepoRoot 'tools\evidence1\provisioning\README.md') -Raw
}

Describe 'Codex provisioning base-vs-launch version pin, documented and pinned together' {
    It 'the base profile approved-inputs v1 codex-cli entry is pinned to 0.153.4' {
        (@($script:ApprovedInputsV1.artifacts | Where-Object id -eq 'codex-cli')[0]).version | Should -Be '0.153.4'
    }

    It 'the base profile approved-inputs v2 codex-cli entry is pinned to 0.153.4' {
        (@($script:ApprovedInputsV2.artifacts | Where-Object id -eq 'codex-cli')[0]).version | Should -Be '0.153.4'
    }

    It 'the upgrade script''s own hardcoded prior-version root still matches the base profile''s pinned version' {
        $script:UpgradeScriptSource | Should -Match ([regex]::Escape("`$priorRoot = 'C:\Evidence1Toolchain\codex-cli\0.153.4'"))
    }

    It 'the live campaign launch path still expects codex-cli 0.154.0' {
        $script:LaunchScriptSource | Should -Match ([regex]::Escape("`$ExpectedCodexVersion = '0.154.0'"))
    }

    It 'the README documents this exact gap, citing the real launch-pin line' {
        $script:ReadmeSource | Should -Match 'Known base-vs-launch gap'
        $script:ReadmeSource | Should -Match ([regex]::Escape('evidence1-dual-condition-canary-launch.ps1:330'))
        $script:ReadmeSource | Should -Match ([regex]::Escape('0.154.0'))
    }
}
