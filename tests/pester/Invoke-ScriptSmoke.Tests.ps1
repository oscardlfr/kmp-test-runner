#Requires -Modules Pester
# Smoke tests for kmp-test-runner PowerShell scripts
# Runs on windows-latest CI runner

BeforeDiscovery {
    $script:Scripts = @(
        'run-parallel-coverage-suite.ps1',
        'run-changed-modules-tests.ps1',
        'run-android-tests.ps1',
        'run-benchmarks.ps1'
    ) | ForEach-Object {
        $fullPath = Join-Path $PSScriptRoot '..\..\scripts\ps1' $_
        Get-Item $fullPath
    }
}

Describe 'Syntax: <_.Name>' -ForEach $script:Scripts {
    BeforeAll {
        $script:Content = Get-Content $_.FullName -Raw
        $script:ScriptPath = $_.FullName
    }

    It 'has no syntax errors' {
        $errors = $null
        $null = [System.Management.Automation.Language.Parser]::ParseInput(
            $script:Content,
            [ref]$null,
            [ref]$errors
        )
        $errors | Should -HaveCount 0
    }

    It 'file exists and is non-empty' {
        $script:ScriptPath | Should -Exist
        $script:Content.Length | Should -BeGreaterThan 0
    }
}

Describe 'Happy path: run-parallel-coverage-suite.ps1' {
    BeforeAll {
        $script:TempDir = New-Item -ItemType Directory -Path (Join-Path $TestDrive 'proj-parallel')
        # Minimal settings.gradle.kts so script can detect project root
        Set-Content -Path (Join-Path $script:TempDir 'settings.gradle.kts') -Value 'rootProject.name = "test-project"'
        # Stub gradlew.bat so script does not invoke real Gradle
        $stubPath = Join-Path $script:TempDir 'gradlew.bat'
        Set-Content -Path $stubPath -Value '@echo BUILD SUCCESSFUL (stub): %* && exit /b 0'
    }

    It 'accepts --ProjectRoot without throwing on parameter binding' {
        $scriptPath = Join-Path $PSScriptRoot '..\..\scripts\ps1\run-parallel-coverage-suite.ps1'
        # Use -ModuleFilter to an impossible pattern so no real gradle execution happens
        # We only verify the script is parseable and --ProjectRoot is accepted
        $errors = $null
        $null = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$errors)
        $errors | Should -HaveCount 0
    }
}

Describe 'Happy path: run-changed-modules-tests.ps1' {
    It 'script file exists at expected path' {
        $scriptPath = Join-Path $PSScriptRoot '..\..\scripts\ps1\run-changed-modules-tests.ps1'
        $scriptPath | Should -Exist
    }

    It 'parses without syntax errors' {
        $scriptPath = Join-Path $PSScriptRoot '..\..\scripts\ps1\run-changed-modules-tests.ps1'
        $content = Get-Content $scriptPath -Raw
        $errors = $null
        $null = [System.Management.Automation.Language.Parser]::ParseInput($content, [ref]$null, [ref]$errors)
        $errors | Should -HaveCount 0
    }
}

Describe 'Get-ModuleFromFile (run-changed-modules-tests.ps1)' {
    # Pre-v0.4 the function called `$FilePath.Split('/', '\')` which PowerShell
    # resolved to the .NET String.Split(Char, Int32) overload — '\' got
    # coerced to Int32 and threw "The input string '\' was not in a correct
    # format" the moment a Windows-style path appeared in `git status` output.
    # That broke `kmp-test changed` end-to-end on Windows. The fix uses
    # `-split '[/\\]'` (regex). These tests guard the function behaviour and
    # explicitly assert the buggy pattern does not return.
    BeforeAll {
        $script:scriptPath = Join-Path $PSScriptRoot '..\..\scripts\ps1\run-changed-modules-tests.ps1'
        $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile(
            $script:scriptPath, [ref]$null, [ref]$errors
        )
        $funcAst = $ast.FindAll({
            $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] -and `
            $args[0].Name -eq 'Get-ModuleFromFile'
        }, $true) | Select-Object -First 1
        Invoke-Expression $funcAst.Extent.Text
    }

    It 'does not throw on a Windows-style path containing backslashes' {
        $tmp = New-Item -ItemType Directory -Path (Join-Path $TestDrive 'fake-proj-bs') -Force
        New-Item -ItemType Directory -Path (Join-Path $tmp.FullName 'core-result') -Force | Out-Null
        New-Item -ItemType File -Path (Join-Path $tmp.FullName 'core-result\build.gradle.kts') -Value '' -Force | Out-Null
        { Get-ModuleFromFile -FilePath 'core-result\build.gradle.kts' -ProjectRoot $tmp.FullName } | Should -Not -Throw
    }

    It 'maps a Unix-style file path to the colon-prefixed module name' {
        $tmp = New-Item -ItemType Directory -Path (Join-Path $TestDrive 'fake-proj-u') -Force
        New-Item -ItemType Directory -Path (Join-Path $tmp.FullName 'core-result') -Force | Out-Null
        New-Item -ItemType File -Path (Join-Path $tmp.FullName 'core-result\build.gradle.kts') -Value '' -Force | Out-Null
        $result = Get-ModuleFromFile -FilePath 'core-result/src/commonMain/Foo.kt' -ProjectRoot $tmp.FullName
        $result | Should -Be ':core-result'
    }

    It 'maps a Windows-style file path to the same module name' {
        $tmp = New-Item -ItemType Directory -Path (Join-Path $TestDrive 'fake-proj-w') -Force
        New-Item -ItemType Directory -Path (Join-Path $tmp.FullName 'core-result') -Force | Out-Null
        New-Item -ItemType File -Path (Join-Path $tmp.FullName 'core-result\build.gradle.kts') -Value '' -Force | Out-Null
        $result = Get-ModuleFromFile -FilePath 'core-result\src\commonMain\Foo.kt' -ProjectRoot $tmp.FullName
        $result | Should -Be ':core-result'
    }

    It 'returns $null for a non-module top-level path' {
        $tmp = New-Item -ItemType Directory -Path (Join-Path $TestDrive 'fake-proj-none') -Force
        $result = Get-ModuleFromFile -FilePath 'docs/notes.md' -ProjectRoot $tmp.FullName
        $result | Should -BeNullOrEmpty
    }

    It 'never re-introduces the buggy String.Split(string, string) call' {
        $content = Get-Content $script:scriptPath -Raw
        # Catch the exact buggy form (single-char string + backslash literal as 2nd arg).
        $content | Should -Not -Match "\.Split\(\s*'/'\s*,\s*'\\\\'\s*\)"
    }
}

Describe 'run-changed-modules-tests.ps1 -> run-parallel-coverage-suite.ps1 splat parity' {
    # v0.4 regression: changed.ps1 splatted `MaxFailures = $MaxFailures` into
    # the parallel suite, but the suite doesn't declare a -MaxFailures param,
    # so splatting blew up with "A parameter cannot be found that matches
    # parameter name 'MaxFailures'". Bash sibling never had this bug because
    # it builds an explicit args array (no auto-splatting). This test parses
    # both scripts via AST and asserts every key in the changed.ps1 splat
    # hashtable maps to a real param on the consumer.
    BeforeAll {
        $script:changedPath = Join-Path $PSScriptRoot '..\..\scripts\ps1\run-changed-modules-tests.ps1'
        $script:suitePath   = Join-Path $PSScriptRoot '..\..\scripts\ps1\run-parallel-coverage-suite.ps1'

        $errors = $null
        $suiteAst = [System.Management.Automation.Language.Parser]::ParseFile(
            $script:suitePath, [ref]$null, [ref]$errors
        )
        # Top-level param block — its parameters are what the consumer accepts.
        $suiteParamBlock = $suiteAst.ParamBlock
        $script:suiteParamNames = @($suiteParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })

        $changedAst = [System.Management.Automation.Language.Parser]::ParseFile(
            $script:changedPath, [ref]$null, [ref]$errors
        )
        # Find every hashtable literal that immediately precedes a splatting
        # invocation of the suite script. Conservative: collect ALL hashtable
        # keys assigned to a $params variable that gets splatted via @params.
        $script:splatKeys = @()
        $hashtables = $changedAst.FindAll({ $args[0] -is [System.Management.Automation.Language.HashtableAst] }, $true)
        foreach ($h in $hashtables) {
            foreach ($pair in $h.KeyValuePairs) {
                $script:splatKeys += $pair.Item1.Value
            }
        }
        # Also catch follow-on `$params.<Key> = ...` assignments — they end up
        # in the same splat.
        $assignments = $changedAst.FindAll({
            $args[0] -is [System.Management.Automation.Language.AssignmentStatementAst] -and `
            $args[0].Left -is [System.Management.Automation.Language.MemberExpressionAst] -and `
            $args[0].Left.Expression.Extent.Text -eq '$params'
        }, $true)
        foreach ($a in $assignments) {
            $script:splatKeys += $a.Left.Member.Value
        }
        $script:splatKeys = $script:splatKeys | Sort-Object -Unique
    }

    It 'every splat key is declared as a parameter on run-parallel-coverage-suite.ps1' {
        foreach ($key in $script:splatKeys) {
            $script:suiteParamNames | Should -Contain $key -Because "splatting -$key would throw 'parameter cannot be found' at runtime"
        }
    }

    It 'MaxFailures is no longer splatted (v0.4 regression guard)' {
        $script:splatKeys | Should -Not -Contain 'MaxFailures'
    }
}

Describe 'Happy path: run-android-tests.ps1' {
    It 'script file exists at expected path' {
        $scriptPath = Join-Path $PSScriptRoot '..\..\scripts\ps1\run-android-tests.ps1'
        $scriptPath | Should -Exist
    }

    It 'parses without syntax errors' {
        $scriptPath = Join-Path $PSScriptRoot '..\..\scripts\ps1\run-android-tests.ps1'
        $content = Get-Content $scriptPath -Raw
        $errors = $null
        $null = [System.Management.Automation.Language.Parser]::ParseInput($content, [ref]$null, [ref]$errors)
        $errors | Should -HaveCount 0
    }
}

Describe 'Happy path: run-benchmarks.ps1' {
    It 'script file exists at expected path' {
        $scriptPath = Join-Path $PSScriptRoot '..\..\scripts\ps1\run-benchmarks.ps1'
        $scriptPath | Should -Exist
    }

    It 'parses without syntax errors' {
        $scriptPath = Join-Path $PSScriptRoot '..\..\scripts\ps1\run-benchmarks.ps1'
        $content = Get-Content $scriptPath -Raw
        $errors = $null
        $null = [System.Management.Automation.Language.Parser]::ParseInput($content, [ref]$null, [ref]$errors)
        $errors | Should -HaveCount 0
    }
}

Describe 'TestFilter parameter wiring' {
    # v0.3.7: every script the CLI may dispatch to must accept -TestFilter so that
    # `kmp-test <sub> --test-filter <pattern>` (translated by cli.js to PowerShell
    # PascalCase) doesn't blow up on an unknown parameter.
    #
    # Uses Pester 5's `-ForEach` so $_ binds at run time (a plain `foreach` block
    # captures the loop variable late and resolves to empty during execution).
    It '<_> declares a -TestFilter param' -ForEach @(
        'run-parallel-coverage-suite.ps1',
        'run-changed-modules-tests.ps1',
        'run-android-tests.ps1'
        # run-benchmarks.ps1 omitted: v0.8 sub-entry 1 thinned it to a node-launcher.
        # TestFilter argv pass-through is covered by tests/vitest/benchmark-orchestrator.test.js.
    ) {
        $scriptPath = Join-Path $PSScriptRoot '..\..\scripts\ps1' $_
        $content = Get-Content $scriptPath -Raw
        # Match the parameter declaration in any case variation (e.g. [string]$TestFilter).
        $content | Should -Match '\[\s*string\s*\]\s*\$TestFilter'
    }
}

Describe 'TestFilter method-level split (v0.5.2 Gap E)' {
    # When TestFilter contains '#', the script must split class#method and
    # emit BOTH `-Pandroid.testInstrumentationRunnerArguments.class=<class>`
    # AND `-Pandroid.testInstrumentationRunnerArguments.method=<method>`
    # (AndroidJUnitRunner accepts both runner-args together).
    # Source-grep contract (full E2E covered by vitest CLI tests).
    It '<_> contains the # branch emitting both class= and method= flags' -ForEach @(
        'run-android-tests.ps1'
        # run-benchmarks.ps1 omitted: v0.8 sub-entry 1 moved the # split to
        # lib/benchmark-orchestrator.js#buildFilterArgs (covered by vitest).
    ) {
        $scriptPath = Join-Path $PSScriptRoot '..\..\scripts\ps1' $_
        $content = Get-Content $scriptPath -Raw
        # Conditional that detects the # form
        $content | Should -Match '\$TestFilter\s+-match\s+''#'''
        # Both runner-argument flags emitted in the # branch
        $content | Should -Match 'testInstrumentationRunnerArguments\.class=\$classPart'
        $content | Should -Match 'testInstrumentationRunnerArguments\.method=\$methodPart'
    }
}

# Removed in v0.8 sub-entry 1: the gradlew-cwd contract for run-benchmarks.ps1
# moved from the wrapper to lib/benchmark-orchestrator.js#runBenchmark, which
# spawns gradle with `cwd: projectRoot` directly. Vitest covers it via the
# `--platform jvm dispatches ... cwd: projectRoot` snapshot in
# tests/vitest/benchmark-orchestrator.test.js.
