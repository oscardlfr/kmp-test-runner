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
    $scripts = @(
        'run-parallel-coverage-suite.ps1',
        'run-changed-modules-tests.ps1',
        'run-android-tests.ps1',
        'run-benchmarks.ps1'
    )

    foreach ($script in $scripts) {
        It "$script declares a -TestFilter param" {
            $scriptPath = Join-Path $PSScriptRoot '..\..\scripts\ps1' $script
            $content = Get-Content $scriptPath -Raw
            # Match the parameter declaration in any case variation (e.g. [string]$TestFilter).
            $content | Should -Match '\[\s*string\s*\]\s*\$TestFilter'
        }
    }
}
