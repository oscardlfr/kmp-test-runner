BeforeAll {
    $script:RepoDocsRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/audits'
    Import-Module (Join-Path $script:RepoDocsRoot 'evidence1-artifact-store-contract.psm1') -Force
    Import-Module (Join-Path $script:RepoDocsRoot 'evidence1-artifact-store-fake.psm1') -Force

    # C:\kmp-eval\scratch\ is required (not $TestDrive, which lives elsewhere)
    # because Assert-E1ArtifactStoreScratchScoped enforces it, matching every
    # other filesystem-touching module in this repo. A dedicated,
    # GUID-named subdirectory keeps this test run isolated from anything
    # else under scratch, and AfterAll removes it.
    $script:ScratchTestRoot = Join-Path 'C:\kmp-eval\scratch\pester-artifact-store-tests' ([guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $script:ScratchTestRoot | Out-Null
}

AfterAll {
    if (Test-Path -LiteralPath $script:ScratchTestRoot) {
        Remove-Item -LiteralPath $script:ScratchTestRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Describe 'Evidence1 ArtifactStore fake: atomic private-to-public publication' {
    It 'publishes every private file into the public root and is idempotent on a second call' {
        $case = Join-Path $script:ScratchTestRoot ([guid]::NewGuid().ToString('N'))
        $private = Join-Path $case 'private'; $public = Join-Path $case 'public'
        New-Item -ItemType Directory -Force -Path (Join-Path $private 'nested') | Out-Null
        Set-Content -LiteralPath (Join-Path $private 'record.json') -Value '{"a":1}' -Encoding UTF8
        Set-Content -LiteralPath (Join-Path $private 'nested/sidecar.json') -Value '{"b":2}' -Encoding UTF8

        $first = Publish-E1ArtifactStoreSet -PrivateRoot $private -PublicRoot $public
        $first.state | Should -BeExactly 'committed'
        $first.artifact_count | Should -Be 2
        $first.recovered_torn_state | Should -BeFalse
        Test-Path -LiteralPath "$public.staging" | Should -BeFalse
        # .Trim(): Set-Content appends a trailing newline; content fidelity,
        # not exact byte-for-byte whitespace, is what this asserts.
        (Get-Content -LiteralPath (Join-Path $public 'record.json') -Raw).Trim() | Should -BeExactly '{"a":1}'
        (Get-Content -LiteralPath (Join-Path $public 'nested/sidecar.json') -Raw).Trim() | Should -BeExactly '{"b":2}'

        $second = Publish-E1ArtifactStoreSet -PrivateRoot $private -PublicRoot $public
        $second.state | Should -BeExactly 'already-committed'
        { Assert-E1ArtifactStorePublicationResult $second } | Should -Not -Throw
    }

    It 'requires both roots to resolve under C:\kmp-eval\scratch\' {
        { Publish-E1ArtifactStoreSet -PrivateRoot 'C:\Temp\private' -PublicRoot (Join-Path $script:ScratchTestRoot 'x/public') } | Should -Throw '*artifact_store_private_root_outside_scratch*'
    }
}

Describe 'Evidence1 ArtifactStore fake: crash between private/public publication and recovery' {
    # Plan section 7 Phase 4 rehearsal #7, built the way a crash is
    # genuinely simulated elsewhere in this repo when a real child process
    # isn't warranted for it: construct the exact torn on-disk state a real
    # crash would leave (a leftover .staging directory, or a transaction
    # record with no matching ready marker), then prove the NEXT call
    # detects and recovers it rather than either failing forever or silently
    # serving a half-written public root.

    It 'recovers a leftover .staging directory from a crash before the atomic rename' {
        $case = Join-Path $script:ScratchTestRoot ([guid]::NewGuid().ToString('N'))
        $private = Join-Path $case 'private'; $public = Join-Path $case 'public'
        New-Item -ItemType Directory -Force -Path $private | Out-Null
        Set-Content -LiteralPath (Join-Path $private 'record.json') -Value '{"a":1}' -Encoding UTF8

        # Simulate the crash: a torn .staging left behind, partially written,
        # with no transaction or ready marker at all -- the earliest possible
        # crash point in the protocol.
        New-Item -ItemType Directory -Force -Path "$public.staging" | Out-Null
        Set-Content -LiteralPath (Join-Path "$public.staging" 'partial.json') -Value '{"torn":true}' -Encoding UTF8
        Test-Path -LiteralPath $public | Should -BeFalse

        $result = Publish-E1ArtifactStoreSet -PrivateRoot $private -PublicRoot $public
        $result.state | Should -BeExactly 'committed'
        $result.recovered_torn_state | Should -BeTrue
        Test-Path -LiteralPath "$public.staging" | Should -BeFalse
        (Get-Content -LiteralPath (Join-Path $public 'record.json') -Raw).Trim() | Should -BeExactly '{"a":1}'
        Test-Path -LiteralPath (Join-Path $public 'partial.json') | Should -BeFalse
    }

    It 'recovers a transaction record with no ready marker from a crash after the atomic rename started but before it finished recording' {
        $case = Join-Path $script:ScratchTestRoot ([guid]::NewGuid().ToString('N'))
        $private = Join-Path $case 'private'; $public = Join-Path $case 'public'
        New-Item -ItemType Directory -Force -Path $private | Out-Null
        Set-Content -LiteralPath (Join-Path $private 'record.json') -Value '{"a":1}' -Encoding UTF8

        # Simulate a later crash point: the transaction record was written,
        # but the process died before the ready marker -- $public itself may
        # or may not exist yet depending on exactly when it died; this
        # simulates the more conservative case where it does not.
        ([ordered]@{ schema = 1; artifact_count = 0 } | ConvertTo-Json) | Set-Content -LiteralPath "$public.publication.transaction.json" -Encoding UTF8
        Test-Path -LiteralPath "$public.publication.ready.json" | Should -BeFalse

        $result = Publish-E1ArtifactStoreSet -PrivateRoot $private -PublicRoot $public
        $result.state | Should -BeExactly 'committed'
        $result.recovered_torn_state | Should -BeTrue
        (Get-Content -LiteralPath (Join-Path $public 'record.json') -Raw).Trim() | Should -BeExactly '{"a":1}'
        Test-Path -LiteralPath "$public.publication.ready.json" | Should -BeTrue
    }
}

Describe 'Evidence1 ArtifactStore fake: output_roots trust-root portability' {
    # Same class of gap evidence1-run-manifest-contract.psm1's
    # Assert-E1RunManifestOutputRootsConfined already had fixed: the trust
    # root was a hardcoded module-level literal (C:\kmp-eval\scratch\
    # baked directly into Assert-E1ArtifactStoreScratchScoped) with no way
    # to inject a different one. These tests prove the NEW -TrustedRoot
    # parameter is genuinely pluggable, not vacuously accepting everything,
    # and that confinement + traversal/escape rejection are preserved under
    # an injected non-default root, not just the default. $TestDrive is
    # used here (unlike the Describes above, which intentionally stay on
    # real C:\kmp-eval\scratch\ paths per this file's own established
    # convention) precisely because these are the tests that demonstrate
    # portability away from that hardcoded default.

    It 'accepts an injected trust root different from the historical hardcoded default' {
        $customRoot = Join-Path $TestDrive 'custom-trusted-root'
        $destination = Join-Path $customRoot 'private'
        { Assert-E1ArtifactStoreScratchScoped $destination 'private_root' -TrustedRoot $customRoot } | Should -Not -Throw
    }

    It 'the SAME path is rejected under the historical default when no trust root is injected -- proving the check is genuinely responsive, not vacuously accepting everything now' {
        $customRoot = Join-Path $TestDrive 'custom-trusted-root'
        $destination = Join-Path $customRoot 'private'
        { Assert-E1ArtifactStoreScratchScoped $destination 'private_root' } | Should -Throw '*artifact_store_private_root_outside_scratch*'
    }

    It 'traversal/escape rejection is preserved under an injected custom trust root (regression pin, not just the default)' {
        $customRoot = Join-Path $TestDrive 'custom-trusted-root'
        $escaping = Join-Path $customRoot '..\..\Windows\System32'
        { Assert-E1ArtifactStoreScratchScoped $escaping 'public_root' -TrustedRoot $customRoot } | Should -Throw '*artifact_store_public_root_outside_scratch*'
    }

    It 'Get-E1ArtifactStoreDefaultTrustedRoot genuinely delegates to the shared evidence1-trusted-root-config.psm1 implementation, not a second independent copy' {
        Import-Module (Join-Path $script:RepoDocsRoot 'evidence1-trusted-root-config.psm1') -Force
        $original = $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT
        try {
            $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT = 'D:\another-installation\scratch\'
            (Get-E1ArtifactStoreDefaultTrustedRoot) | Should -BeExactly (Get-E1DefaultTrustedRoot)
            (Get-E1ArtifactStoreDefaultTrustedRoot) | Should -BeExactly 'D:\another-installation\scratch\'
        } finally {
            $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT = $original
        }
    }

    It 'Publish-E1ArtifactStoreSet has no manifest-shaped parameter through which manifest content could influence the trust root' {
        $paramNames = @((Get-Command Publish-E1ArtifactStoreSet).Parameters.Keys)
        $paramNames | Should -Not -Contain 'Manifest'
        $paramNames | Should -Not -Contain 'OutputRoots'
        $paramNames | Should -Contain 'TrustedRoot' -Because 'the trust root must be an explicit, independent parameter, never derived from manifest content'
    }

    It 'end to end: Publish-E1ArtifactStoreSet succeeds against an injected custom -TrustedRoot outside the historical default, for BOTH private and public roots' {
        $customRoot = Join-Path $TestDrive 'e2e-custom-trusted-root'
        $private = Join-Path $customRoot 'private'; $public = Join-Path $customRoot 'public'
        New-Item -ItemType Directory -Force -Path $private | Out-Null
        Set-Content -LiteralPath (Join-Path $private 'record.json') -Value '{"a":1}' -Encoding UTF8

        $result = Publish-E1ArtifactStoreSet -PrivateRoot $private -PublicRoot $public -TrustedRoot $customRoot
        $result.state | Should -BeExactly 'committed'
        $result.artifact_count | Should -Be 1
        (Get-Content -LiteralPath (Join-Path $public 'record.json') -Raw).Trim() | Should -BeExactly '{"a":1}'
    }

    It 'end to end: Publish-E1ArtifactStoreSet still rejects a public root outside the injected custom -TrustedRoot even though private root is inside it' {
        $customRoot = Join-Path $TestDrive 'e2e-custom-trusted-root-2'
        $private = Join-Path $customRoot 'private'
        $outsidePublic = Join-Path $TestDrive 'not-under-custom-root\public'
        New-Item -ItemType Directory -Force -Path $private | Out-Null
        Set-Content -LiteralPath (Join-Path $private 'record.json') -Value '{"a":1}' -Encoding UTF8

        { Publish-E1ArtifactStoreSet -PrivateRoot $private -PublicRoot $outsidePublic -TrustedRoot $customRoot } |
            Should -Throw '*artifact_store_public_root_outside_scratch*'
    }
}
