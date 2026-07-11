#Requires -Modules Pester
# Parser + smoke tests for scripts/install.ps1 and scripts/uninstall.ps1

Describe 'install.ps1 syntax' {
    It 'parses without error' {
        $ScriptPath = Join-Path $PSScriptRoot '..\..\scripts\install.ps1'
        { [System.Management.Automation.Language.Parser]::ParseFile(
              $ScriptPath, [ref]$null, [ref]$null) } | Should -Not -Throw
    }
    It 'uninstall.ps1 parses without error' {
        $ScriptPath = Join-Path $PSScriptRoot '..\..\scripts\uninstall.ps1'
        { [System.Management.Automation.Language.Parser]::ParseFile(
              $ScriptPath, [ref]$null, [ref]$null) } | Should -Not -Throw
    }
}

Describe 'install.ps1 Get-LocationHeader (PS7 compat regression)' {
    # Regression for v0.3.5: in PowerShell 7+ the response Headers object is
    # System.Net.Http.Headers.HttpResponseHeaders, which has no indexer — the
    # original `$Response.Headers["Location"]` threw "Unable to index into an
    # object of type ...". The fix introduces Get-LocationHeader, which must
    # work for BOTH a Hashtable-style Headers (PS 5.1) and the
    # HttpResponseHeaders shape (PS 7+).

    BeforeAll {
        # Dot-source install.ps1 in -WhatIf-equivalent way: parse + extract just
        # the Get-LocationHeader function body so we can test it without running
        # the whole installer. The simplest reliable approach: source the file
        # but short-circuit before any side-effecting code runs.
        $InstallScript = Join-Path $PSScriptRoot '..\..\scripts\install.ps1'
        $content = Get-Content $InstallScript -Raw
        # Pull the function body via the AST so the test stays robust to file
        # reordering.
        $ast = [System.Management.Automation.Language.Parser]::ParseInput($content, [ref]$null, [ref]$null)
        $fnAst = $ast.Find({
            param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-LocationHeader'
        }, $true)
        if ($null -eq $fnAst) { throw "Get-LocationHeader function not found in install.ps1" }
        Invoke-Expression $fnAst.Extent.Text
    }

    It 'returns the Location string when given a Hashtable-style header (PS 5.1 shape)' {
        $headers = @{ 'Location' = 'https://github.com/oscardlfr/kmp-test-runner/releases/tag/v0.3.5' }
        $result = Get-LocationHeader $headers
        $result | Should -Be 'https://github.com/oscardlfr/kmp-test-runner/releases/tag/v0.3.5'
    }

    It 'returns the first Location string when given an array of values (intermediate runtime shape)' {
        $headers = @{ 'Location' = @('https://github.com/oscardlfr/kmp-test-runner/releases/tag/v0.3.5') }
        $result = Get-LocationHeader $headers
        $result | Should -Be 'https://github.com/oscardlfr/kmp-test-runner/releases/tag/v0.3.5'
    }

    It 'returns null for null Headers' {
        Get-LocationHeader $null | Should -BeNullOrEmpty
    }

    It 'returns null when Location key is missing' {
        $headers = @{ 'Content-Type' = 'text/html' }
        Get-LocationHeader $headers | Should -BeNullOrEmpty
    }

    It 'works against a real GitHub redirect response under the current PS edition' {
        # End-to-end: hit /releases/latest with -MaximumRedirection 0 and verify
        # Get-LocationHeader extracts the v* tag URL. This is the exact path that
        # broke in PS 7 before the fix.
        $url = 'https://github.com/oscardlfr/kmp-test-runner/releases/latest'
        try {
            $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -MaximumRedirection 0 -ErrorAction SilentlyContinue
            $loc = Get-LocationHeader $resp.Headers
        } catch {
            $loc = Get-LocationHeader $_.Exception.Response.Headers
        }
        $loc | Should -Match '^https://github\.com/oscardlfr/kmp-test-runner/releases/tag/v\d+\.\d+\.\d+'
    }
}

Describe 'install.ps1 safety constraints' {
    BeforeAll {
        $script:InstallContent   = Get-Content (Join-Path $PSScriptRoot '..\..\scripts\install.ps1') -Raw
        $script:UninstallContent = Get-Content (Join-Path $PSScriptRoot '..\..\scripts\uninstall.ps1') -Raw
    }

    It 'uses -UseBasicParsing on all Invoke-WebRequest calls' {
        $Calls = [regex]::Matches($script:InstallContent, 'Invoke-WebRequest[^\r\n]*')
        $Calls.Count | Should -BeGreaterThan 0
        foreach ($Call in $Calls) {
            $Call.Value | Should -Match '-UseBasicParsing'
        }
    }

    It 'never references Machine scope for PATH' {
        $script:InstallContent   | Should -Not -Match "'Machine'"
        $script:UninstallContent | Should -Not -Match "'Machine'"
    }

    It 'sets PATH with User scope' {
        $script:InstallContent | Should -Match '"User"'
    }

    It 'does not use Get-WmiObject' {
        $script:InstallContent   | Should -Not -Match 'Get-WmiObject'
        $script:UninstallContent | Should -Not -Match 'Get-WmiObject'
    }

    It 'does not use Invoke-Expression on remote content' {
        $script:InstallContent | Should -Not -Match 'Invoke-Expression'
    }
}

# --------------------------------------------------------------------------
# Guarded uninstall — safety / negative tests (no archive needed).
# Guard tests run uninstall in a subprocess so exit 1 cannot poison Pester.
# --------------------------------------------------------------------------

Describe 'uninstall.ps1 guard checks' {
    BeforeAll {
        $script:GuardUninstallScript = Join-Path $PSScriptRoot '..\..\scripts\uninstall.ps1'
    }

    It 'refuses when prefix exists but has no marker and invalid layout' {
        $tmpdir  = Join-Path $env:TEMP ("kmp-guard-" + [System.IO.Path]::GetRandomFileName())
        $fakePfx = Join-Path $tmpdir "fake-prefix"
        New-Item -ItemType Directory -Path $fakePfx | Out-Null
        Set-Content -Path (Join-Path $fakePfx "random-file.txt") -Value "junk" -Encoding UTF8
        $null = pwsh -NoProfile -NonInteractive -File $script:GuardUninstallScript -Prefix $fakePfx 2>&1
        $exitCode    = $LASTEXITCODE
        $stillExists = Test-Path $fakePfx
        Remove-Item -Recurse -Force $tmpdir -ErrorAction SilentlyContinue
        $exitCode    | Should -Not -Be 0
        $stillExists | Should -BeTrue
    }

    It 'refuses drive root' {
        $null = pwsh -NoProfile -NonInteractive -File $script:GuardUninstallScript -Prefix 'C:\' 2>&1
        $LASTEXITCODE | Should -Not -Be 0
    }

    It 'refuses USERPROFILE' {
        $null = pwsh -NoProfile -NonInteractive -File $script:GuardUninstallScript -Prefix $env:USERPROFILE 2>&1
        $LASTEXITCODE | Should -Not -Be 0
    }
}

# --------------------------------------------------------------------------
# E2E tests — use local archive (no network). Tagged 'E2E'.
# Run with: Invoke-Pester -TagFilter 'E2E'
# --------------------------------------------------------------------------

Describe 'install.ps1 E2E — local archive' -Tag 'E2E' {
    BeforeAll {
        $script:ArtifactVer = "0.3.3"
        $script:E2ETmpDir   = Join-Path $env:TEMP ("kmp-e2e-" + [System.IO.Path]::GetRandomFileName())
        $script:E2EPrefix   = Join-Path $script:E2ETmpDir "prefix"
        New-Item -ItemType Directory -Path $script:E2ETmpDir | Out-Null

        # Build minimal archive structure mirroring publish-release.yml
        $wrapper    = "kmp-test-runner-$($script:ArtifactVer)"
        $staging    = Join-Path $script:E2ETmpDir "staging\$wrapper"
        $stagingBin = Join-Path $staging "bin"
        New-Item -ItemType Directory -Path $stagingBin | Out-Null

        # Minimal package.json so cli.js resolves version
        $pkgJson = '{"name":"kmp-test-runner","version":"' + $script:ArtifactVer + '"}'
        Set-Content -Path (Join-Path $staging "package.json") -Value $pkgJson -Encoding UTF8

        # Minimal bin/kmp-test.js
        $binJs = @'
#!/usr/bin/env node
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(pkg.version); process.exit(0); }
if (args[0] === '--help')    { console.log('kmp-test-runner help'); process.exit(0); }
'@
        Set-Content -Path (Join-Path $stagingBin "kmp-test.js") -Value $binJs -Encoding UTF8

        # Placeholder LICENSE
        Set-Content -Path (Join-Path $staging "LICENSE") -Value "MIT" -Encoding UTF8

        # Create zip archive
        $script:LocalArchive = Join-Path $script:E2ETmpDir "kmp-test-runner-$($script:ArtifactVer)-windows.zip"
        Compress-Archive -Path (Join-Path $script:E2ETmpDir "staging\$wrapper") `
                         -DestinationPath $script:LocalArchive

        Remove-Item -Recurse -Force (Join-Path $script:E2ETmpDir "staging")

        # Run install.ps1 with local archive
        $script:InstallScript   = Join-Path $PSScriptRoot '..\..\scripts\install.ps1'
        $script:UninstallScript = Join-Path $PSScriptRoot '..\..\scripts\uninstall.ps1'

        & $script:InstallScript `
            -Version      $script:ArtifactVer `
            -Prefix       $script:E2EPrefix `
            -LocalArchive $script:LocalArchive
    }

    AfterAll {
        if (Test-Path $script:E2ETmpDir) {
            Remove-Item -Recurse -Force $script:E2ETmpDir -ErrorAction SilentlyContinue
        }
        if (Test-Path $script:E2EPrefix) {
            Remove-Item -Recurse -Force $script:E2EPrefix -ErrorAction SilentlyContinue
        }
    }

    It 'installs kmp-test.cmd using local archive' {
        $wrapper = Join-Path $script:E2EPrefix "bin\kmp-test.cmd"
        $wrapper | Should -Exist
    }

    It 'kmp-test.cmd is non-empty after install' {
        $wrapper = Join-Path $script:E2EPrefix "bin\kmp-test.cmd"
        (Get-Item $wrapper).Length | Should -BeGreaterThan 0
    }

    It 'package.json is present after install (v0.3.2 regression guard)' {
        $pkgPath = Join-Path $script:E2EPrefix "lib\package.json"
        $pkgPath | Should -Exist
    }

    It 'install.ps1 writes install marker' {
        $marker = Join-Path $script:E2EPrefix ".kmp-test-runner-install.json"
        $marker | Should -Exist
        $json = Get-Content $marker -Raw | ConvertFrom-Json
        $json.tool | Should -Be 'kmp-test-runner'
    }

    It 'uninstall.ps1 adopts legacy layout when marker is missing' {
        # Install fresh to a separate temp prefix, remove marker, verify adoption succeeds.
        $tmpdir2 = Join-Path $env:TEMP ("kmp-legacy-" + [System.IO.Path]::GetRandomFileName())
        $pfx2    = Join-Path $tmpdir2 "kmp-test-runner"
        New-Item -ItemType Directory -Path $tmpdir2 | Out-Null
        & $script:InstallScript `
            -Version      $script:ArtifactVer `
            -Prefix       $pfx2 `
            -LocalArchive $script:LocalArchive
        Remove-Item (Join-Path $pfx2 ".kmp-test-runner-install.json") -ErrorAction SilentlyContinue
        $proc = Start-Process pwsh `
            -ArgumentList @('-NoProfile', '-NonInteractive', '-File', $script:UninstallScript, '-Prefix', $pfx2) `
            -Wait -PassThru -NoNewWindow
        $exitCode    = $proc.ExitCode
        $stillExists = Test-Path $pfx2
        Remove-Item -Recurse -Force $tmpdir2 -ErrorAction SilentlyContinue
        $exitCode    | Should -Be 0
        $stillExists | Should -BeFalse
    }

    It 'uninstall.ps1 removes prefix cleanly' {
        & $script:UninstallScript -Prefix $script:E2EPrefix
        $script:E2EPrefix | Should -Not -Exist
    }
}

Describe 'install.ps1 - TLS 1.2 enforcement' {
    It 'sets TLS 1.2 before the first Invoke-WebRequest call' {
        $content = Get-Content (Join-Path $PSScriptRoot '..\..\scripts\install.ps1') -Raw
        $tlsPos = $content.IndexOf('[System.Net.ServicePointManager]::SecurityProtocol')
        $webPos = $content.IndexOf('Invoke-WebRequest')
        $tlsPos | Should -BeGreaterThan -1 -Because 'TLS 1.2 setup must be present'
        $webPos | Should -BeGreaterThan -1 -Because 'Invoke-WebRequest must be present'
        $tlsPos | Should -BeLessThan $webPos -Because 'TLS must be set before any web call'
    }
}

Describe 'ps1 encoding - PS 5.1 ASCII safety' {
    BeforeAll {
        $root = Join-Path $PSScriptRoot '..\..'
        $script:LintFiles = @(
            (Join-Path $root 'scripts\install.ps1'),
            (Join-Path $root 'scripts\uninstall.ps1'),
            (Join-Path $root '.skills\kmp-test-runner\scripts\detect-env.ps1'),
            (Join-Path $root '.skills\kmp-test-runner\scripts\run-tests.ps1')
        )
    }

    It 'runtime ps1 files contain only ASCII characters' {
        foreach ($f in $script:LintFiles) {
            $bytes = [System.IO.File]::ReadAllBytes($f)
            $nonAscii = @($bytes | Where-Object { $_ -gt 127 })
            $nonAscii.Count | Should -Be 0 -Because "PS 5.1 needs ASCII-only in $(Split-Path $f -Leaf)"
        }
    }

    It 'runtime ps1 files parse cleanly under Windows PowerShell 5.1' {
        $ps51 = Get-Command 'powershell.exe' -ErrorAction SilentlyContinue
        if (-not $ps51) {
            Set-ItResult -Skipped -Because 'powershell.exe (5.1) not available on this host'
            return
        }
        # Write a helper script to powershell.exe that parses a file and exits
        # with the error count -- avoids escaping a full inline command string.
        $helper = Join-Path $env:TEMP "kmp-ps51-parse-$(Get-Random).ps1"
        try {
            Set-Content -Path $helper -Encoding ASCII -Value @'
param([string]$Path)
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
    $Path, [ref]$null, [ref]$errors) | Out-Null
exit $errors.Count
'@
            foreach ($f in $script:LintFiles) {
                & 'powershell.exe' -NoLogo -NoProfile -NonInteractive -File $helper -Path $f
                $LASTEXITCODE | Should -Be 0 -Because "PS 5.1 parse errors in $(Split-Path $f -Leaf)"
            }
        } finally {
            Remove-Item $helper -ErrorAction SilentlyContinue
        }
    }
}
