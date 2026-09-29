BeforeAll {
    # Import inside BeforeAll, not bare top-level -- see
    # Evidence1-Network-Backend-Contract.Tests.ps1's BeforeAll comment for
    # why. This is the first dedicated Pester coverage for
    # evidence1-artifact-copy-fake.psm1 itself -- prior coverage
    # (Evidence1-Artifact-Copy-Contract.Tests.ps1) only exercises the
    # shared contract module's Assert-E1ArtifactCopyResultShape, never this
    # fake's own Copy-E1ArtifactsReadOnly/Assert-E1FakeArtifactCopyDestination.
    $script:RepoDocsRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/audits'
    Import-Module (Join-Path $script:RepoDocsRoot 'evidence1-artifact-copy-contract.psm1') -Force
    Import-Module (Join-Path $script:RepoDocsRoot 'evidence1-artifact-copy-fake.psm1') -Force

    # C:\kmp-eval\scratch\ is required (not $TestDrive) for the DEFAULT-root
    # cases specifically -- Assert-E1FakeArtifactCopyDestination's own
    # default trust root is the literal C:\kmp-eval\scratch\, matching every
    # other filesystem-touching module in this repo (see
    # Evidence1-Artifact-Store-Fake.Tests.ps1's own BeforeAll for the
    # identical rationale). A dedicated, GUID-named subdirectory keeps this
    # test run isolated; AfterAll removes it. Tests proving the NEW injected
    # -TrustedRoot behavior use $TestDrive instead -- that is the actual,
    # load-bearing demonstration of portability.
    $script:ScratchTestRoot = Join-Path 'C:\kmp-eval\scratch\pester-artifact-copy-tests' ([guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $script:ScratchTestRoot | Out-Null

    # A fake "mounted VHD root" seeded with the one file the
    # 'final-codex-attestation' spec requires -- mirrors
    # Evidence1-Run-Full-Campaign-Integration.Tests.ps1's own seeding
    # exactly. The mount root itself is never confined by
    # Assert-E1FakeArtifactCopyDestination (only -DestinationDir is), so it
    # is safe to put under $TestDrive even when the destination under test
    # is scratch-rooted.
    function New-TestArtifactCopyMountRoot([string]$VMName) {
        $mountRoot = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $attestationDir = Join-Path $mountRoot 'kmp-eval\measurement-scopes'
        New-Item -ItemType Directory -Force -Path $attestationDir | Out-Null
        '{"schema":1,"fake":true}' | Set-Content -LiteralPath (Join-Path $attestationDir 'evidence1-claude-windows-isolation-attestation-stageb-v1.json') -Encoding UTF8
        Set-E1FakeArtifactCopyMountRoot -VMName $VMName -MountRootPath $mountRoot
    }
}

AfterAll {
    if (Test-Path -LiteralPath $script:ScratchTestRoot) {
        Remove-Item -LiteralPath $script:ScratchTestRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# No root-level AfterEach here: Pester 5 does not support a Teardown
# (BeforeEach/AfterEach) directly in the root block container -- only inside
# a Describe/Context (confirmed by running: "Each test Teardown is not
# supported in root (directly in the block container)"). Not needed anyway
# -- every test below uses its own distinct VM name
# (Set-E1FakeArtifactCopyMountRoot keys by VMName and simply overwrites any
# existing entry), so there is no cross-test state to reset between them.

Describe 'Evidence1 ArtifactCopy fake: default trust root unchanged (regression)' {
    It 'accepts a destination under the historical default C:\kmp-eval\scratch\ with no -TrustedRoot supplied' {
        $destination = Join-Path $script:ScratchTestRoot ([guid]::NewGuid().ToString('N'))
        { Assert-E1FakeArtifactCopyDestination $destination } | Should -Not -Throw
    }

    It 'rejects a destination outside C:\kmp-eval\scratch\ with no -TrustedRoot supplied' {
        $destination = Join-Path $TestDrive 'outside-scratch'
        { Assert-E1FakeArtifactCopyDestination $destination } | Should -Throw '*artifact_copy_destination_outside_scratch*'
    }
}

Describe 'Evidence1 ArtifactCopy fake: output_roots trust-root portability' {
    # Same class of gap evidence1-run-manifest-contract.psm1's
    # Assert-E1RunManifestOutputRootsConfined already had fixed: the trust
    # root was a hardcoded module-level literal with no way to inject a
    # different one. These tests prove the NEW -TrustedRoot parameter is
    # genuinely pluggable, not vacuously accepting everything, and that the
    # security properties (confinement, traversal/escape rejection) are
    # preserved under an injected non-default root, not just the default.

    It 'accepts an injected trust root different from the historical hardcoded default' {
        $customRoot = Join-Path $TestDrive 'custom-trusted-root'
        $destination = Join-Path $customRoot 'dest'
        { Assert-E1FakeArtifactCopyDestination $destination -TrustedRoot $customRoot } | Should -Not -Throw
    }

    It 'the SAME destination is rejected under the historical default when no trust root is injected -- proving the check is genuinely responsive, not vacuously accepting everything now' {
        $customRoot = Join-Path $TestDrive 'custom-trusted-root'
        $destination = Join-Path $customRoot 'dest'
        { Assert-E1FakeArtifactCopyDestination $destination } | Should -Throw '*artifact_copy_destination_outside_scratch*'
    }

    It 'traversal/escape rejection is preserved under an injected custom trust root (regression pin, not just the default)' {
        $customRoot = Join-Path $TestDrive 'custom-trusted-root'
        $escaping = Join-Path $customRoot '..\..\Windows\System32'
        { Assert-E1FakeArtifactCopyDestination $escaping -TrustedRoot $customRoot } | Should -Throw '*artifact_copy_destination_outside_scratch*'
    }

    It 'the create-new (destination must not already exist) rule is preserved under an injected custom trust root' {
        $customRoot = Join-Path $TestDrive 'custom-trusted-root'
        $existing = Join-Path $customRoot 'already-here'
        New-Item -ItemType Directory -Force -Path $existing | Out-Null
        { Assert-E1FakeArtifactCopyDestination $existing -TrustedRoot $customRoot } | Should -Throw '*artifact_copy_destination_must_be_create_new*'
    }

    It 'Get-E1ArtifactCopyDefaultTrustedRoot genuinely delegates to the shared evidence1-trusted-root-config.psm1 implementation, not a second independent copy' {
        Import-Module (Join-Path $script:RepoDocsRoot 'evidence1-trusted-root-config.psm1') -Force
        $original = $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT
        try {
            $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT = 'D:\another-installation\scratch\'
            (Get-E1ArtifactCopyDefaultTrustedRoot) | Should -BeExactly (Get-E1DefaultTrustedRoot)
            (Get-E1ArtifactCopyDefaultTrustedRoot) | Should -BeExactly 'D:\another-installation\scratch\'
        } finally {
            $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT = $original
        }
    }

    It 'Copy-E1ArtifactsReadOnly has no manifest-shaped parameter through which manifest content could influence the trust root' {
        $paramNames = @((Get-Command Copy-E1ArtifactsReadOnly).Parameters.Keys)
        $paramNames | Should -Not -Contain 'Manifest'
        $paramNames | Should -Not -Contain 'OutputRoots'
        $paramNames | Should -Contain 'TrustedRoot' -Because 'the trust root must be an explicit, independent parameter, never derived from manifest content'
    }

    It 'end to end: Copy-E1ArtifactsReadOnly succeeds against an injected custom -TrustedRoot outside the historical default' {
        $vmName = 'Evidence1FakeVM-ArtifactCopyTrustRoot'
        New-TestArtifactCopyMountRoot $vmName
        $customRoot = Join-Path $TestDrive 'e2e-custom-trusted-root'
        $destination = Join-Path $customRoot 'private-evidence'

        $result = Copy-E1ArtifactsReadOnly -VMName $vmName -ExpectedVMId ([guid]::NewGuid().ToString()) `
            -SpecName 'final-codex-attestation' -Arguments @{} -DestinationDir $destination -TrustedRoot $customRoot
        @($result.files_copied).Count | Should -Be 1
        Test-Path -LiteralPath (Join-Path $destination 'evidence1-claude-windows-isolation-attestation-stageb-v1.json') | Should -BeTrue
    }

    It 'end to end: Copy-E1ArtifactsReadOnly still rejects a destination outside the injected custom -TrustedRoot' {
        $vmName = 'Evidence1FakeVM-ArtifactCopyTrustRootReject'
        New-TestArtifactCopyMountRoot $vmName
        $customRoot = Join-Path $TestDrive 'e2e-custom-trusted-root-2'
        $outsideDestination = Join-Path $TestDrive 'not-under-custom-root'

        { Copy-E1ArtifactsReadOnly -VMName $vmName -ExpectedVMId ([guid]::NewGuid().ToString()) `
            -SpecName 'final-codex-attestation' -Arguments @{} -DestinationDir $outsideDestination -TrustedRoot $customRoot } |
            Should -Throw '*artifact_copy_destination_outside_scratch*'
    }
}
