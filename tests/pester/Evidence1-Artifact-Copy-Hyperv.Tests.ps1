BeforeAll {
    # Import inside BeforeAll, not bare top-level -- see
    # Evidence1-Network-Backend-Contract.Tests.ps1's BeforeAll comment for why
    # (Pester 5 runs every file's bare top-level code during a single shared
    # DISCOVERY pass across all files, so a same-named-export sibling module
    # imported bare at top level can win globally for every file in the run).
    # This is the first dedicated Pester coverage for
    # evidence1-artifact-copy-hyperv.psm1 -- prior coverage
    # (Evidence1-Artifact-Copy-Contract.Tests.ps1, Evidence1-Artifact-Copy-Fake.Tests.ps1)
    # never touches this, the REAL backend module.
    $script:RepoDocsRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/audits'
    Import-Module (Join-Path $script:RepoDocsRoot 'evidence1-artifact-copy-contract.psm1') -Force
    Import-Module (Join-Path $script:RepoDocsRoot 'evidence1-broker-status-contract.psm1') -Force
    Import-Module (Join-Path $script:RepoDocsRoot 'evidence1-trusted-root-config.psm1') -Force
    Import-Module (Join-Path $script:RepoDocsRoot 'evidence1-artifact-copy-hyperv.psm1') -Force

    function New-TestBrokerStatus([hashtable]$Override = @{}) {
        $defaults = @{
            TaskExists = $true; Readable = $true; DeploymentRoot = 'C:\ProgramData\KmpEval\Evidence1ElevatedRunner\deployed'
            ManifestSchema = 2; SourceGitCommit = ('a' * 40); PrincipalSid = 'S-1-5-21-1-2-3-1001'
            ScriptCount = 70; HashesValid = $true; AclValid = $true; SelfUpdateCapable = $true
        }
        foreach ($key in $Override.Keys) { $defaults[$key] = $Override[$key] }
        return New-E1BrokerStatusResult @defaults
    }
}

Describe 'Evidence1 ArtifactCopy hyperv: Get-E1ArtifactCopyRealTrustedRoot is the ONE sealed real-path resolver' {
    # Task 1's real security distinction from the fake-path fix: this
    # function must be genuinely GATED by a positively re-verified broker
    # deployment, not merely a cosmetic call that ignores its own input.

    It 'throws when no BrokerStatus is supplied at all' {
        { Get-E1ArtifactCopyRealTrustedRoot $null } | Should -Throw '*artifact_copy_real_trusted_root_broker_status_required*'
    }

    It 'returns the historical scratch root when the broker deployment is fully sealed (task present, readable, hashes valid, ACL valid)' {
        (Get-E1ArtifactCopyRealTrustedRoot (New-TestBrokerStatus)) | Should -BeExactly 'C:\kmp-eval\scratch\'
    }

    It 'delegates to the SAME shared literal evidence1-trusted-root-config.psm1 owns, not an independent copy' {
        (Get-E1ArtifactCopyRealTrustedRoot (New-TestBrokerStatus)) | Should -BeExactly (Get-E1HistoricalScratchRootLiteral)
    }

    It 'refuses when the broker task does not exist' {
        $status = New-TestBrokerStatus @{ TaskExists = $false; Readable = $false; HashesValid = $false; AclValid = $false; SelfUpdateCapable = $false }
        { Get-E1ArtifactCopyRealTrustedRoot $status } | Should -Throw '*artifact_copy_real_trusted_root_broker_not_sealed*'
    }

    It 'refuses when the deployment is not readable' -ForEach @('Readable') {
        $status = New-TestBrokerStatus @{ $_ = $false }
        { Get-E1ArtifactCopyRealTrustedRoot $status } | Should -Throw '*artifact_copy_real_trusted_root_broker_not_sealed*'
    }

    It 'refuses when a single integrity field is false -- proving this is a real AND-gate, not vacuously true' -ForEach @('HashesValid', 'AclValid') {
        $status = New-TestBrokerStatus @{ $_ = $false }
        { Get-E1ArtifactCopyRealTrustedRoot $status } | Should -Throw '*artifact_copy_real_trusted_root_broker_not_sealed*'
    }

    It 'is completely unaffected by EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT -- an unprivileged environment variable can never widen or redirect the real trusted root' {
        $original = $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT
        try {
            $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT = 'D:\attacker-controlled\widen-me\'
            (Get-E1ArtifactCopyRealTrustedRoot (New-TestBrokerStatus)) | Should -BeExactly 'C:\kmp-eval\scratch\'
        } finally {
            $env:EVIDENCE1_OUTPUT_ROOTS_TRUSTED_ROOT = $original
        }
    }

    It 'has no parameter through which a caller-supplied override string could reach the returned value at all -- the only input is a BrokerStatus object' {
        $paramNames = @((Get-Command Get-E1ArtifactCopyRealTrustedRoot).Parameters.Keys |
            Where-Object { $_ -notin @('Verbose', 'Debug', 'ErrorAction', 'WarningAction', 'InformationAction', 'ErrorVariable', 'WarningVariable', 'InformationVariable', 'OutVariable', 'OutBuffer', 'PipelineVariable') })
        @($paramNames) | Should -Be @('BrokerStatus')
    }

    It 'source text never reads $env: anywhere -- confirmed by grep, not just by this one env-var test case' {
        $source = Get-Content -LiteralPath (Join-Path $script:RepoDocsRoot 'evidence1-artifact-copy-hyperv.psm1') -Raw
        $bodyStart = $source.IndexOf('function Get-E1ArtifactCopyRealTrustedRoot')
        $bodyEnd = $source.IndexOf('function Resolve-E1ArtifactCopyFullPath')
        $bodyStart | Should -BeGreaterThan 0
        $bodyEnd | Should -BeGreaterThan $bodyStart
        $source.Substring($bodyStart, $bodyEnd - $bodyStart) | Should -Not -Match '\$env:'
    }
}

Describe 'Evidence1 ArtifactCopy hyperv: Assert-E1ArtifactCopyDestination -- hardcoded literal removed, caller-injected TrustedRoot required' {
    It 'TrustedRoot is Mandatory -- calling without it fails parameter binding, it does not silently fall back to any default' {
        { Assert-E1ArtifactCopyDestination 'C:\kmp-eval\scratch\some-dest' } | Should -Throw
    }

    It 'accepts a destination under an injected custom trust root, unrelated to the historical default' {
        $customRoot = Join-Path $TestDrive 'sealed-custom-root'
        $destination = Join-Path $customRoot 'dest'
        { Assert-E1ArtifactCopyDestination $destination -TrustedRoot $customRoot } | Should -Not -Throw
    }

    It 'rejects a destination outside the injected custom trust root' {
        $customRoot = Join-Path $TestDrive 'sealed-custom-root-2'
        $outside = Join-Path $TestDrive 'not-under-custom-root'
        { Assert-E1ArtifactCopyDestination $outside -TrustedRoot $customRoot } | Should -Throw '*artifact_copy_destination_outside_scratch*'
    }

    It 'rejects a traversal-escape destination under an injected custom trust root' {
        $customRoot = Join-Path $TestDrive 'sealed-custom-root-3'
        $escaping = Join-Path $customRoot '..\..\Windows\System32'
        { Assert-E1ArtifactCopyDestination $escaping -TrustedRoot $customRoot } | Should -Throw '*artifact_copy_destination_outside_scratch*'
    }

    It 'rejects a sibling-prefix false positive -- a root that merely shares a string prefix is not "inside" the trusted root' {
        # e.g. trusted root C:\kmp-eval\scratch\ must not treat
        # C:\kmp-eval\scratch-evil\dest as confined, even though the raw
        # string starts with the same characters up to the trailing
        # backslash. Same class of check evidence1-run-manifest-contract.psm1's
        # own nested/sibling-prefix test already pins for output_roots.
        $customRoot = Join-Path $TestDrive 'sealed-root'
        $siblingEscape = ($customRoot.TrimEnd('\')) + '-evil\dest'
        { Assert-E1ArtifactCopyDestination $siblingEscape -TrustedRoot $customRoot } | Should -Throw '*artifact_copy_destination_outside_scratch*'
    }

    It 'still enforces create-new (destination must not already exist) under an injected custom trust root' {
        $customRoot = Join-Path $TestDrive 'sealed-custom-root-4'
        $existing = Join-Path $customRoot 'already-here'
        New-Item -ItemType Directory -Force -Path $existing | Out-Null
        { Assert-E1ArtifactCopyDestination $existing -TrustedRoot $customRoot } | Should -Throw '*artifact_copy_destination_must_be_create_new*'
    }

    It 'accepts a destination resolved through the real, sealed Get-E1ArtifactCopyRealTrustedRoot path end to end' {
        $sealedRoot = Get-E1ArtifactCopyRealTrustedRoot (New-TestBrokerStatus)
        $destination = Join-Path $TestDrive 'ignored'
        # Confinement is enforced against the SEALED root, not $TestDrive --
        # a $TestDrive-rooted destination must be rejected here, proving the
        # sealed root genuinely drives the check rather than being ignored.
        { Assert-E1ArtifactCopyDestination $destination -TrustedRoot $sealedRoot } | Should -Throw '*artifact_copy_destination_outside_scratch*'
    }

    It 'the confinement logic itself no longer contains the hardcoded scratch literal -- it lives in exactly one place, evidence1-trusted-root-config.psm1' {
        $source = Get-Content -LiteralPath (Join-Path $script:RepoDocsRoot 'evidence1-artifact-copy-hyperv.psm1') -Raw
        $bodyStart = $source.IndexOf('function Assert-E1ArtifactCopyDestination')
        $bodyEnd = $source.IndexOf('function Get-E1ArtifactCopyMountedWindowsRoot')
        $bodyStart | Should -BeGreaterThan 0
        $bodyEnd | Should -BeGreaterThan $bodyStart
        $source.Substring($bodyStart, $bodyEnd - $bodyStart) | Should -Not -Match ([regex]::Escape('C:\kmp-eval\scratch\'))
    }
}

Describe 'Evidence1 ArtifactCopy hyperv: Copy-E1ArtifactsReadOnly -- TrustedRoot threads through the real, exported function without touching Hyper-V' {
    # Confinement (Assert-E1ArtifactCopyDestination) runs BEFORE Get-VM in
    # Copy-E1ArtifactsReadOnly's own body (confirmed by reading the function:
    # $sources/$destinationFull are resolved first, Get-VM comes after). An
    # out-of-trust-root destination therefore throws the confinement error
    # and returns control to the caller before any Hyper-V cmdlet is ever
    # reached -- this proves TrustedRoot genuinely reaches the confinement
    # check inside the REAL exported function (not a replica) while staying
    # inside this task's standing zero-Hyper-V-execution boundary. If Get-VM
    # had been reached instead, the VM ('does-not-exist-on-this-host') would
    # produce a DIFFERENT (ObjectNotFound / Hyper-V-management) error, so the
    # exact expected error is itself part of the proof that Get-VM was never
    # called.

    It 'TrustedRoot is Mandatory on the real Copy-E1ArtifactsReadOnly, matching Assert-E1ArtifactCopyDestination' {
        $paramNames = @((Get-Command Copy-E1ArtifactsReadOnly).Parameters.Keys)
        $paramNames | Should -Contain 'TrustedRoot'
        (Get-Command Copy-E1ArtifactsReadOnly).Parameters['TrustedRoot'].Attributes.Mandatory | Should -Contain $true
    }

    It 'Copy-E1ArtifactsReadOnly has no manifest-shaped parameter through which manifest content could influence the trusted root' {
        $paramNames = @((Get-Command Copy-E1ArtifactsReadOnly).Parameters.Keys)
        $paramNames | Should -Not -Contain 'Manifest'
        $paramNames | Should -Not -Contain 'OutputRoots'
    }

    It 'rejects an out-of-trust-root DestinationDir before ever reaching Get-VM (zero Hyper-V cmdlets touched)' {
        $customRoot = Join-Path $TestDrive 'copy-sealed-root'
        $outsideDestination = Join-Path $TestDrive 'copy-outside-root'
        { Copy-E1ArtifactsReadOnly -VMName 'does-not-exist-on-this-host' -ExpectedVMId ([guid]::NewGuid().ToString()) `
            -SpecName 'final-codex-attestation' -Arguments @{} -DestinationDir $outsideDestination -TrustedRoot $customRoot } |
            Should -Throw '*artifact_copy_destination_outside_scratch*'
    }

    It 'rejects the same call under the REAL sealed trusted root exactly the same way' {
        $sealedRoot = Get-E1ArtifactCopyRealTrustedRoot (New-TestBrokerStatus)
        $outsideDestination = Join-Path $TestDrive 'copy-outside-sealed-root'
        { Copy-E1ArtifactsReadOnly -VMName 'does-not-exist-on-this-host' -ExpectedVMId ([guid]::NewGuid().ToString()) `
            -SpecName 'final-codex-attestation' -Arguments @{} -DestinationDir $outsideDestination -TrustedRoot $sealedRoot } |
            Should -Throw '*artifact_copy_destination_outside_scratch*'
    }
}

Describe 'Evidence1 ArtifactCopy hyperv: mounted Windows volume discovery' {
    It 'resolves a Windows partition exposed only through its volume access path' {
        InModuleScope 'evidence1-artifact-copy-hyperv' {
            $volumeRoot = '\\?\Volume{11111111-2222-3333-4444-555555555555}\'
            $partitionProvider = {
                param($MountedVhd)
                [pscustomobject]@{
                    DriveLetter = $null
                    AccessPaths = @($volumeRoot)
                }
            }
            Mock Test-Path {
                param($LiteralPath, $PathType)
                return $LiteralPath -ceq ($volumeRoot + 'Windows\System32\Config\SYSTEM')
            }

            Get-E1ArtifactCopyMountedWindowsRoot ([pscustomobject]@{}) -PartitionProvider $partitionProvider |
                Should -BeExactly $volumeRoot
        }
    }
}
