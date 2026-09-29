# Invoke-E1GuestBundle's logon-candidate loop calls real, strictly-typed
# cmdlets (New-PSSession, Invoke-Command -AsJob, Wait-Job, Receive-Job) with
# no injectable seam -- unlike this codebase's other broker-adjacent
# modules, which all take an explicit -TriggerTask or -GetUtcNow
# scriptblock. Pester's own -ModuleName Mock was tried first and rejected:
# confirmed empirically (not assumed) that Pester's mock proxy for
# Invoke-Command still enforces the real -Session parameter's
# [PSSession[]] type, which cannot be satisfied by a fake object (PSSession
# has no public constructor) -- a plain Mock -CommandName Invoke-Command
# still throws a parameter-binding error before the mock body ever runs.
# Instead, this file uses the same "extract the function source, evaluate
# it in isolation" discipline every other evidence1-run.ps1-adjacent test
# in this repo already uses, and shadows New-PSSession/Invoke-Command/
# Wait-Job/Receive-Job/Stop-Job/Remove-Job/Remove-PSSession/Get-VM with
# ordinary LOCAL functions -- confirmed empirically that a same-scope
# function always wins command resolution over a same-named cmdlet, so a
# local function has no type constraint from the real cmdlet at all.
BeforeAll {
    $script:AuditsRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\docs\audits')).Path
    Import-Module (Join-Path $script:AuditsRoot 'evidence1-guest-bundle-contract.psm1') -Force

    $hypervSource = Get-Content -LiteralPath (Join-Path $script:AuditsRoot 'evidence1-guest-bundle-hyperv.psm1') -Raw
    $start = $hypervSource.IndexOf('function Resolve-E1GuestBundleFullPath')
    if ($start -lt 0) { throw 'Resolve-E1GuestBundleFullPath not found -- evidence1-guest-bundle-hyperv.psm1 changed shape' }
    $end = $hypervSource.IndexOf('Export-ModuleMember')
    if ($end -lt 0) { throw 'Export-ModuleMember not found -- could not isolate the end of the local-function block' }
    $script:HypervFixSource = $hypervSource.Substring($start, $end - $start)

    # Assert-E1GuestBundleCredentialPath confines this to C:\kmp-eval\scratch\.
    $script:CredScratchRoot = Join-Path 'C:\kmp-eval\scratch\pester-guest-bundle-hyperv-tests' ([guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $script:CredScratchRoot | Out-Null
    $script:CredPath = Join-Path $script:CredScratchRoot 'guest-credential.clixml'
    $securePassword = ConvertTo-SecureString 'not-a-real-password-test-fixture-only' -AsPlainText -Force
    [pscredential]::new('TestGuestUser', $securePassword) | Export-Clixml -LiteralPath $script:CredPath

    # 'get-firewall-sealed-state': the one registered bundle with an empty
    # argument_schema, so a test needs no CurrentCampaignInputsJson/CellJson
    # construction -- the loop mechanics under test don't depend on which
    # bundle is being invoked.
    $script:BundleName = 'get-firewall-sealed-state'
}

AfterAll {
    if (Test-Path -LiteralPath $script:CredScratchRoot) {
        Remove-Item -LiteralPath $script:CredScratchRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Describe 'Invoke-E1GuestBundle: logon-candidate fallback boundary (2026-09-28 incident, F1)' {
    BeforeEach {
        # Real per-test shadowing functions, re-defined fresh each It so one test's
        # behavior can never leak into the next. Get-VM is shadowed unconditionally:
        # the real function's own top-level code calls it before the loop starts.
        # Get-E1BrokerCapabilityDefaultTimeoutMinutes: the -TimeoutSeconds upper-bound
        # check calls it; stubbed rather than relying on transitive-import behavior.
        # $script:E1GuestBundleDefaultTimeoutSeconds (the real module's own line 39)
        # is outside this extraction's range, so every call below passes -TimeoutSeconds
        # explicitly rather than relying on that default.
        function Get-VM { param($Name) [pscustomobject]@{ Id = [guid]::NewGuid(); State = 'Running' } }
        function Get-E1BrokerCapabilityDefaultTimeoutMinutes { 120 }
        Invoke-Expression $script:HypervFixSource
    }

    It 'falls back to the next candidate when New-PSSession itself fails (auth/connection, before any job is issued)' {
        $script:sessionCalls = 0
        function New-PSSession {
            param($VMId, $Credential, [switch]$ErrorAction)
            $script:sessionCalls++
            if ($script:sessionCalls -eq 1) { throw 'auth_denied_candidate_1' }
            return [pscustomobject]@{ Id = [guid]::NewGuid() }
        }
        function Invoke-Command { param($Session, $ScriptBlock, $ArgumentList, [switch]$AsJob) [pscustomobject]@{ Id = 999 } }
        function Wait-Job { param($Job, $Timeout) $true }
        function Receive-Job { param($Job, [switch]$ErrorAction) [ordered]@{ sealed = $true } }
        function Stop-Job { param($Job, [switch]$ErrorAction) }
        function Remove-Job { param($Job, [switch]$Force, [switch]$ErrorAction) }
        function Remove-PSSession { param($Session, [switch]$ErrorAction) }

        $result = Invoke-E1GuestBundle -VMName 'Evidence1-Runner-E2E' -GuestCredentialPath $script:CredPath -BundleName $script:BundleName -Arguments @{} -TimeoutSeconds 60

        $result.verdict | Should -BeExactly 'PASS'
        $script:sessionCalls | Should -Be 2
    }

    It 'FAILs immediately on a post-start error (Receive-Job) and never attempts a second candidate -- the real error is preserved, sanitized and truncated' {
        $script:sessionCalls = 0
        function New-PSSession { param($VMId, $Credential, [switch]$ErrorAction) $script:sessionCalls++; [pscustomobject]@{ Id = [guid]::NewGuid() } }
        $script:invokeCalls = 0
        function Invoke-Command { param($Session, $ScriptBlock, $ArgumentList, [switch]$AsJob) $script:invokeCalls++; [pscustomobject]@{ Id = 999 } }
        function Wait-Job { param($Job, $Timeout) $true }
        # Multi-line and long, to prove the reason_code embeds a sanitized (single-line,
        # length-capped) form -- not a raw, unbounded multi-line stack trace.
        function Receive-Job { param($Job, [switch]$ErrorAction) throw "guest_worker_crashed_mid_session_distinctive_marker`r`nat Some.Deep.Stack`n$('x' * 600)" }
        function Stop-Job { param($Job, [switch]$ErrorAction) }
        function Remove-Job { param($Job, [switch]$Force, [switch]$ErrorAction) }
        function Remove-PSSession { param($Session, [switch]$ErrorAction) }

        $result = Invoke-E1GuestBundle -VMName 'Evidence1-Runner-E2E' -GuestCredentialPath $script:CredPath -BundleName $script:BundleName -Arguments @{} -TimeoutSeconds 60

        $result.verdict | Should -BeExactly 'FAIL'
        $result.reason_code | Should -Match 'guest_worker_crashed_mid_session_distinctive_marker'
        $result.reason_code | Should -Not -Match '[\r\n]'
        $result.reason_code.Length | Should -BeLessOrEqual 560
        $script:sessionCalls | Should -Be 1
        $script:invokeCalls | Should -Be 1
    }

    It '(M2) FAILs immediately when Invoke-Command itself throws, and never attempts a second candidate -- cannot prove the remote scriptblock did not already start' {
        $script:sessionCalls = 0
        function New-PSSession { param($VMId, $Credential, [switch]$ErrorAction) $script:sessionCalls++; [pscustomobject]@{ Id = [guid]::NewGuid() } }
        function Invoke-Command { param($Session, $ScriptBlock, $ArgumentList, [switch]$AsJob) throw 'invoke_command_itself_threw_distinctive_marker' }
        function Stop-Job { param($Job, [switch]$ErrorAction) }
        function Remove-Job { param($Job, [switch]$Force, [switch]$ErrorAction) }
        function Remove-PSSession { param($Session, [switch]$ErrorAction) }

        $result = Invoke-E1GuestBundle -VMName 'Evidence1-Runner-E2E' -GuestCredentialPath $script:CredPath -BundleName $script:BundleName -Arguments @{} -TimeoutSeconds 60

        $result.verdict | Should -BeExactly 'FAIL'
        $result.reason_code | Should -Match 'invoke_command_itself_threw_distinctive_marker'
        $script:sessionCalls | Should -Be 1
    }

    It 'FAILs immediately on a Wait-Job timeout and never attempts a second candidate' {
        $script:sessionCalls = 0
        function New-PSSession { param($VMId, $Credential, [switch]$ErrorAction) $script:sessionCalls++; [pscustomobject]@{ Id = [guid]::NewGuid() } }
        function Invoke-Command { param($Session, $ScriptBlock, $ArgumentList, [switch]$AsJob) [pscustomobject]@{ Id = 999 } }
        function Wait-Job { param($Job, $Timeout) $false }
        function Stop-Job { param($Job, [switch]$ErrorAction) }
        function Remove-Job { param($Job, [switch]$Force, [switch]$ErrorAction) }
        function Remove-PSSession { param($Session, [switch]$ErrorAction) }

        $result = Invoke-E1GuestBundle -VMName 'Evidence1-Runner-E2E' -GuestCredentialPath $script:CredPath -BundleName $script:BundleName -Arguments @{} -TimeoutSeconds 60

        $result.verdict | Should -BeExactly 'FAIL'
        $result.reason_code | Should -Match 'guest_bundle_timed_out'
        $script:sessionCalls | Should -Be 1
    }

    It 'reports FAIL with no_candidate_logon_name_attempted only when every candidate fails at auth (pre-existing behavior, unaffected)' {
        $script:sessionCalls = 0
        function New-PSSession { param($VMId, $Credential, [switch]$ErrorAction) $script:sessionCalls++; throw 'auth_denied_every_candidate' }

        $result = Invoke-E1GuestBundle -VMName 'Evidence1-Runner-E2E' -GuestCredentialPath $script:CredPath -BundleName $script:BundleName -Arguments @{} -TimeoutSeconds 60

        $result.verdict | Should -BeExactly 'FAIL'
        $result.reason_code | Should -Match 'auth_denied_every_candidate'
        $script:sessionCalls | Should -Be 4
    }
}

