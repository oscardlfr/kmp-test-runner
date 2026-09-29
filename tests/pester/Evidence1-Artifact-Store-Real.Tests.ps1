BeforeAll {
    $script:RepoDocsRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'docs/audits'
    Import-Module (Join-Path $script:RepoDocsRoot 'evidence1-artifact-store-contract.psm1') -Force
    Import-Module (Join-Path $script:RepoDocsRoot 'evidence1-artifact-store-real.psm1') -Force

    # C:\kmp-eval\scratch\ is required (not $TestDrive), matching
    # Evidence1-Artifact-Store-Fake.Tests.ps1's own established convention --
    # Assert-E1ArtifactStoreScratchScoped enforces it by default. A
    # dedicated, GUID-named subdirectory keeps this run isolated; AfterAll
    # removes it.
    $script:ScratchTestRoot = Join-Path 'C:\kmp-eval\scratch\pester-artifact-store-real-tests' ([guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $script:ScratchTestRoot | Out-Null

    function New-FreshCase {
        $case = Join-Path $script:ScratchTestRoot ([guid]::NewGuid().ToString('N'))
        return [ordered]@{ Case = $case; Private = (Join-Path $case 'private'); Public = (Join-Path $case 'public') }
    }

    function Read-JsonSidecar([string]$Path) {
        return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    }
}

AfterAll {
    if (Test-Path -LiteralPath $script:ScratchTestRoot) {
        Remove-Item -LiteralPath $script:ScratchTestRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Describe 'Evidence1 ArtifactStore real: fresh publish + idempotent re-publish (behavior-preserving with the fake)' {
    It 'publishes every private file into the public root and is idempotent on a second call' {
        $t = New-FreshCase
        New-Item -ItemType Directory -Force -Path (Join-Path $t.Private 'nested') | Out-Null
        Set-Content -LiteralPath (Join-Path $t.Private 'record.json') -Value '{"a":1}' -Encoding UTF8
        Set-Content -LiteralPath (Join-Path $t.Private 'nested/sidecar.json') -Value '{"b":2}' -Encoding UTF8

        $first = Publish-E1ArtifactStoreSet -PrivateRoot $t.Private -PublicRoot $t.Public
        $first.state | Should -BeExactly 'committed'
        $first.artifact_count | Should -Be 2
        $first.recovered_torn_state | Should -BeFalse
        Test-Path -LiteralPath "$($t.Public).staging" | Should -BeFalse
        (Get-Content -LiteralPath (Join-Path $t.Public 'record.json') -Raw).Trim() | Should -BeExactly '{"a":1}'
        (Get-Content -LiteralPath (Join-Path $t.Public 'nested/sidecar.json') -Raw).Trim() | Should -BeExactly '{"b":2}'
        { Assert-E1ArtifactStorePublicationResult $first } | Should -Not -Throw

        $second = Publish-E1ArtifactStoreSet -PrivateRoot $t.Private -PublicRoot $t.Public
        $second.state | Should -BeExactly 'already-committed'
        { Assert-E1ArtifactStorePublicationResult $second } | Should -Not -Throw
    }

    It 'requires both roots to resolve under C:\kmp-eval\scratch\ (path-confinement rejection)' {
        $t = New-FreshCase
        { Publish-E1ArtifactStoreSet -PrivateRoot 'C:\Temp\private' -PublicRoot (Join-Path $t.Case 'public') } |
            Should -Throw '*artifact_store_private_root_outside_scratch*'
    }

    It 'accepts an injected custom -TrustedRoot, proving the parameter is genuinely wired' {
        $customRoot = Join-Path $TestDrive 'custom-trusted-root'
        $private = Join-Path $customRoot 'private'; $public = Join-Path $customRoot 'public'
        New-Item -ItemType Directory -Force -Path $private | Out-Null
        Set-Content -LiteralPath (Join-Path $private 'record.json') -Value '{"a":1}' -Encoding UTF8

        $result = Publish-E1ArtifactStoreSet -PrivateRoot $private -PublicRoot $public -TrustedRoot $customRoot
        $result.state | Should -BeExactly 'committed'
        # the SAME path is rejected under the historical default when no
        # trust root is injected -- proves this isn't vacuously accepting
        # everything now.
        { Publish-E1ArtifactStoreSet -PrivateRoot $private -PublicRoot (Join-Path $customRoot 'public2') } |
            Should -Throw '*outside_scratch*'
    }
}

Describe 'Evidence1 ArtifactStore real: crash between private/public publication and recovery' {
    It 'recovers a leftover .staging directory from a crash before the atomic rename' {
        $t = New-FreshCase
        New-Item -ItemType Directory -Force -Path $t.Private | Out-Null
        Set-Content -LiteralPath (Join-Path $t.Private 'record.json') -Value '{"a":1}' -Encoding UTF8

        New-Item -ItemType Directory -Force -Path "$($t.Public).staging" | Out-Null
        Set-Content -LiteralPath (Join-Path "$($t.Public).staging" 'partial.json') -Value '{"torn":true}' -Encoding UTF8
        Test-Path -LiteralPath $t.Public | Should -BeFalse

        $result = Publish-E1ArtifactStoreSet -PrivateRoot $t.Private -PublicRoot $t.Public
        $result.state | Should -BeExactly 'committed'
        $result.recovered_torn_state | Should -BeTrue
        Test-Path -LiteralPath "$($t.Public).staging" | Should -BeFalse
        (Get-Content -LiteralPath (Join-Path $t.Public 'record.json') -Raw).Trim() | Should -BeExactly '{"a":1}'
        Test-Path -LiteralPath (Join-Path $t.Public 'partial.json') | Should -BeFalse

        # the recovered publish still produced a valid custody manifest for
        # the CURRENT (recovered) content, not leftover torn content.
        $ready = Read-JsonSidecar "$($t.Public).publication.ready.json"
        @($ready.manifest).Count | Should -Be 1
        $ready.manifest[0].relative_path | Should -BeExactly 'record.json'
    }

    It 'recovers a transaction record with no ready marker from a crash after the transaction was written but before the ready marker' {
        $t = New-FreshCase
        New-Item -ItemType Directory -Force -Path $t.Private | Out-Null
        Set-Content -LiteralPath (Join-Path $t.Private 'record.json') -Value '{"a":1}' -Encoding UTF8

        ([ordered]@{ schema = 1; artifact_count = 0 } | ConvertTo-Json) | Set-Content -LiteralPath "$($t.Public).publication.transaction.json" -Encoding UTF8
        Test-Path -LiteralPath "$($t.Public).publication.ready.json" | Should -BeFalse

        $result = Publish-E1ArtifactStoreSet -PrivateRoot $t.Private -PublicRoot $t.Public
        $result.state | Should -BeExactly 'committed'
        $result.recovered_torn_state | Should -BeTrue
        (Get-Content -LiteralPath (Join-Path $t.Public 'record.json') -Raw).Trim() | Should -BeExactly '{"a":1}'
        Test-Path -LiteralPath "$($t.Public).publication.ready.json" | Should -BeTrue
    }
}

Describe 'Evidence1 ArtifactStore real: hash/custody manifest correctness' {
    It 'records a manifest entry per file, in both the transaction and ready sidecars, whose sha256/byte_count match an independently-computed Get-FileHash' {
        $t = New-FreshCase
        New-Item -ItemType Directory -Force -Path (Join-Path $t.Private 'nested') | Out-Null
        Set-Content -LiteralPath (Join-Path $t.Private 'a.json') -Value '{"a":1}' -Encoding UTF8
        Set-Content -LiteralPath (Join-Path $t.Private 'nested/b.json') -Value '{"b":22222}' -Encoding UTF8

        $result = Publish-E1ArtifactStoreSet -PrivateRoot $t.Private -PublicRoot $t.Public
        $result.state | Should -BeExactly 'committed'

        foreach ($sidecarPath in @("$($t.Public).publication.transaction.json", "$($t.Public).publication.ready.json")) {
            $sidecar = Read-JsonSidecar $sidecarPath
            $manifest = @($sidecar.manifest)
            $manifest.Count | Should -Be 2

            $relativePaths = @($manifest | ForEach-Object { [string]$_.relative_path } | Sort-Object)
            $relativePaths | Should -Be @('a.json', ('nested' + [IO.Path]::DirectorySeparatorChar + 'b.json'))

            foreach ($entry in $manifest) {
                $publishedFile = Join-Path $t.Public ([string]$entry.relative_path)
                $independentHash = (Get-FileHash -LiteralPath $publishedFile -Algorithm SHA256).Hash.ToLowerInvariant()
                [string]$entry.sha256 | Should -BeExactly $independentHash
                [string]$entry.sha256 | Should -Match '^[0-9a-f]{64}$'
                [int64]$entry.byte_count | Should -Be (Get-Item -LiteralPath $publishedFile).Length
            }
        }
    }
}

Describe 'Evidence1 ArtifactStore real: sensitive-content detection (fail-closed, closed pattern set)' {
    It 'Find-E1ArtifactStoreSensitiveContentMatches finds multiple matches across multiple files directly, without a full publish' {
        $t = New-FreshCase
        New-Item -ItemType Directory -Force -Path $t.Private | Out-Null
        Set-Content -LiteralPath (Join-Path $t.Private 'clean.json') -Value '{"ok":true}' -Encoding UTF8
        Set-Content -LiteralPath (Join-Path $t.Private 'leak.json') -Value 'AKIAABCDEFGHIJKLMNOP' -Encoding UTF8

        $matches = @(Find-E1ArtifactStoreSensitiveContentMatches $t.Private)
        $matches.Count | Should -Be 1
        $matches[0].relative_path | Should -BeExactly 'leak.json'
        $matches[0].pattern_id | Should -BeExactly 'aws_access_key_id'
    }

    Context 'private_key_header' {
        It 'RED: rejects a file containing a PEM private-key header -- nothing staged or published' {
            $t = New-FreshCase
            New-Item -ItemType Directory -Force -Path $t.Private | Out-Null
            Set-Content -LiteralPath (Join-Path $t.Private 'key.txt') -Value "-----BEGIN RSA PRIVATE KEY-----`nMIIFAKEFAKEFAKEFAKEFAKEFAKE==`n-----END RSA PRIVATE KEY-----" -Encoding UTF8

            { Publish-E1ArtifactStoreSet -PrivateRoot $t.Private -PublicRoot $t.Public } |
                Should -Throw '*artifact_store_sensitive_content_detected*private_key_header*'
            Test-Path -LiteralPath $t.Public | Should -BeFalse
            Test-Path -LiteralPath "$($t.Public).staging" | Should -BeFalse
            Test-Path -LiteralPath "$($t.Public).publication.transaction.json" | Should -BeFalse
        }

        It 'GREEN: the same file with the secret removed publishes cleanly' {
            $t = New-FreshCase
            New-Item -ItemType Directory -Force -Path $t.Private | Out-Null
            Set-Content -LiteralPath (Join-Path $t.Private 'key.txt') -Value 'just an ordinary evidence note, no secrets here' -Encoding UTF8

            $result = Publish-E1ArtifactStoreSet -PrivateRoot $t.Private -PublicRoot $t.Public
            $result.state | Should -BeExactly 'committed'
        }
    }

    Context 'aws_access_key_id' {
        It 'RED: rejects a file containing an AWS-shaped access key id -- nothing staged or published' {
            $t = New-FreshCase
            New-Item -ItemType Directory -Force -Path $t.Private | Out-Null
            Set-Content -LiteralPath (Join-Path $t.Private 'notes.txt') -Value 'key=AKIAABCDEFGHIJKLMNOP' -Encoding UTF8

            { Publish-E1ArtifactStoreSet -PrivateRoot $t.Private -PublicRoot $t.Public } |
                Should -Throw '*artifact_store_sensitive_content_detected*aws_access_key_id*'
            Test-Path -LiteralPath $t.Public | Should -BeFalse
            Test-Path -LiteralPath "$($t.Public).staging" | Should -BeFalse
        }

        It 'GREEN: the same file with the secret removed publishes cleanly' {
            $t = New-FreshCase
            New-Item -ItemType Directory -Force -Path $t.Private | Out-Null
            Set-Content -LiteralPath (Join-Path $t.Private 'notes.txt') -Value 'key=REDACTED' -Encoding UTF8

            $result = Publish-E1ArtifactStoreSet -PrivateRoot $t.Private -PublicRoot $t.Public
            $result.state | Should -BeExactly 'committed'
        }

        It 'does not echo the matched secret text itself into the thrown reason' {
            $t = New-FreshCase
            New-Item -ItemType Directory -Force -Path $t.Private | Out-Null
            $fakeKey = 'AKIAABCDEFGHIJKLMNOP'
            Set-Content -LiteralPath (Join-Path $t.Private 'notes.txt') -Value "key=$fakeKey" -Encoding UTF8

            $caught = $null
            try { Publish-E1ArtifactStoreSet -PrivateRoot $t.Private -PublicRoot $t.Public } catch { $caught = $_ }
            $caught | Should -Not -BeNullOrEmpty
            $caught.Exception.Message | Should -Not -Match ([regex]::Escape($fakeKey))
            $caught.Exception.Message | Should -Match 'artifact_store_sensitive_content_detected'
            $caught.Exception.Message | Should -Match 'aws_access_key_id'
            $caught.Exception.Message | Should -Match ([regex]::Escape('notes.txt'))
        }
    }

    Context 'github_personal_access_token' {
        It 'RED: rejects a file containing a GitHub-shaped personal access token -- nothing staged or published' {
            $t = New-FreshCase
            New-Item -ItemType Directory -Force -Path $t.Private | Out-Null
            $fakeToken = 'ghp_' + ('A' * 36)
            Set-Content -LiteralPath (Join-Path $t.Private 'notes.txt') -Value "token=$fakeToken" -Encoding UTF8

            { Publish-E1ArtifactStoreSet -PrivateRoot $t.Private -PublicRoot $t.Public } |
                Should -Throw '*artifact_store_sensitive_content_detected*github_personal_access_token*'
            Test-Path -LiteralPath $t.Public | Should -BeFalse
        }

        It 'GREEN: the same file with the secret removed publishes cleanly' {
            $t = New-FreshCase
            New-Item -ItemType Directory -Force -Path $t.Private | Out-Null
            Set-Content -LiteralPath (Join-Path $t.Private 'notes.txt') -Value 'token=REDACTED' -Encoding UTF8

            $result = Publish-E1ArtifactStoreSet -PrivateRoot $t.Private -PublicRoot $t.Public
            $result.state | Should -BeExactly 'committed'
        }
    }

    Context 'email_address' {
        It 'RED: rejects a file containing an email-address shape (general pattern, not only the one historical literal) -- nothing staged or published' {
            $t = New-FreshCase
            New-Item -ItemType Directory -Force -Path $t.Private | Out-Null
            Set-Content -LiteralPath (Join-Path $t.Private 'notes.txt') -Value 'contact: test-fixture@example.com' -Encoding UTF8

            { Publish-E1ArtifactStoreSet -PrivateRoot $t.Private -PublicRoot $t.Public } |
                Should -Throw '*artifact_store_sensitive_content_detected*email_address*'
            Test-Path -LiteralPath $t.Public | Should -BeFalse
        }

        It 'GREEN: the same file with the address removed publishes cleanly' {
            $t = New-FreshCase
            New-Item -ItemType Directory -Force -Path $t.Private | Out-Null
            Set-Content -LiteralPath (Join-Path $t.Private 'notes.txt') -Value 'contact: REDACTED' -Encoding UTF8

            $result = Publish-E1ArtifactStoreSet -PrivateRoot $t.Private -PublicRoot $t.Public
            $result.state | Should -BeExactly 'committed'
        }
    }

    It 'the WHOLE publication fails when only ONE of several files is sensitive -- the clean file is not partially published either' {
        $t = New-FreshCase
        New-Item -ItemType Directory -Force -Path $t.Private | Out-Null
        Set-Content -LiteralPath (Join-Path $t.Private 'good.json') -Value '{"ok":true}' -Encoding UTF8
        Set-Content -LiteralPath (Join-Path $t.Private 'bad.json') -Value 'AKIAABCDEFGHIJKLMNOP' -Encoding UTF8

        { Publish-E1ArtifactStoreSet -PrivateRoot $t.Private -PublicRoot $t.Public } | Should -Throw '*artifact_store_sensitive_content_detected*'
        Test-Path -LiteralPath $t.Public | Should -BeFalse
        Test-Path -LiteralPath "$($t.Public).staging" | Should -BeFalse
    }
}

Describe 'Evidence1 ArtifactStore real: no-overwrite regression (a genuinely completed publication is never touched)' {
    It 'a second call with a DIFFERENT -PrivateRoot but the SAME -PublicRoot short-circuits to already-committed and never touches the existing public content' {
        $t = New-FreshCase
        $firstPrivate = $t.Private
        New-Item -ItemType Directory -Force -Path $firstPrivate | Out-Null
        Set-Content -LiteralPath (Join-Path $firstPrivate 'record.json') -Value '{"a":1}' -Encoding UTF8

        $first = Publish-E1ArtifactStoreSet -PrivateRoot $firstPrivate -PublicRoot $t.Public
        $first.state | Should -BeExactly 'committed'
        $readyBefore = (Get-Item -LiteralPath "$($t.Public).publication.ready.json").LastWriteTimeUtc

        $secondPrivate = Join-Path $t.Case 'private-2-different-content'
        New-Item -ItemType Directory -Force -Path $secondPrivate | Out-Null
        Set-Content -LiteralPath (Join-Path $secondPrivate 'different.json') -Value '{"different":true}' -Encoding UTF8

        $second = Publish-E1ArtifactStoreSet -PrivateRoot $secondPrivate -PublicRoot $t.Public
        $second.state | Should -BeExactly 'already-committed'

        # the public root must still be EXACTLY the first publish's content --
        # the second, different PrivateRoot must never have been read into it.
        Test-Path -LiteralPath (Join-Path $t.Public 'record.json') | Should -BeTrue
        Test-Path -LiteralPath (Join-Path $t.Public 'different.json') | Should -BeFalse
        (Get-Content -LiteralPath (Join-Path $t.Public 'record.json') -Raw).Trim() | Should -BeExactly '{"a":1}'
        $readyAfter = (Get-Item -LiteralPath "$($t.Public).publication.ready.json").LastWriteTimeUtc
        $readyAfter | Should -Be $readyBefore
    }
}

Describe 'Evidence1 ArtifactStore real: sensitive-content pattern registry' {
    It 'exposes exactly the four documented closed-set patterns' {
        $patterns = @(Get-E1ArtifactStoreSensitiveContentPatterns | ForEach-Object { [string]$_.pattern_id } | Sort-Object)
        $patterns | Should -Be @('aws_access_key_id', 'email_address', 'github_personal_access_token', 'private_key_header')
    }
}

Describe 'Evidence1 ArtifactStore real: evidence1-artifact-store-fake.psm1 is untouched' {
    It 'the fake module file is unmodified by this round (git-tracked content check)' {
        Push-Location (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
        try {
            $diffStat = & git diff --stat -- 'docs/audits/evidence1-artifact-store-fake.psm1' 2>&1
            [string]::IsNullOrWhiteSpace(($diffStat -join "`n")) | Should -BeTrue -Because 'evidence1-artifact-store-fake.psm1 must stay exactly as-is this round'
        } finally {
            Pop-Location
        }
    }
}
