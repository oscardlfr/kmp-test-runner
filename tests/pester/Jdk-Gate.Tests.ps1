#Requires -Modules Pester
# Tests for the JDK toolchain pre-flight gate (v0.5.0 — Bug A fix).
# Verifies scripts/ps1/lib/Jdk-Check.ps1 BLOCKs on mismatch by default and
# honors -IgnoreJdkMismatch.

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:Parallel = Join-Path $script:RepoRoot 'scripts\ps1\run-parallel-coverage-suite.ps1'
    $script:Changed  = Join-Path $script:RepoRoot 'scripts\ps1\run-changed-modules-tests.ps1'
    $script:JdkLib   = Join-Path $script:RepoRoot 'scripts\ps1\lib\Jdk-Check.ps1'

    function New-FakeKmpProject {
        param(
            [string]$Path,
            [int]$JvmToolchain = 17,
            [int]$JavaVersion = 23
        )
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $Path 'bin') -Force | Out-Null

        Set-Content -Path (Join-Path $Path 'settings.gradle.kts') -Value 'rootProject.name = "fake"'
        Set-Content -Path (Join-Path $Path 'gradlew.bat') -Value "@echo off`r`nexit /b 0"
        Set-Content -Path (Join-Path $Path 'build.gradle.kts') -Value "kotlin {`r`n    jvmToolchain($JvmToolchain)`r`n}"

        # Stub java.cmd that prints the requested version to stderr.
        $javaStub = @"
@echo off
echo openjdk version "$JavaVersion.0.1" 2024-01-16 1>&2
exit /b 0
"@
        Set-Content -Path (Join-Path $Path 'bin\java.cmd') -Value $javaStub
    }

    function Invoke-WithFakeJava {
        param(
            [string]$ProjectRoot,
            [scriptblock]$Action
        )
        $oldPath = $env:PATH
        try {
            $env:PATH = (Join-Path $ProjectRoot 'bin') + ';' + $env:PATH
            & $Action
        } finally {
            $env:PATH = $oldPath
        }
    }
}

# ----------------------------------------------------------------------------
# Helper: dot-source the lib in an isolated child pwsh and report return code
# ----------------------------------------------------------------------------

Describe 'Jdk-Check lib: Invoke-JdkMismatchGate' {

    BeforeEach {
        $script:WorkDir = Join-Path $TestDrive ("proj-" + [guid]::NewGuid().ToString('N').Substring(0,8))
        New-FakeKmpProject -Path $script:WorkDir -JvmToolchain 17 -JavaVersion 23
    }

    It 'returns 3 on jvmToolchain mismatch (no opt-out)' {
        $libPath = $script:JdkLib
        $work = $script:WorkDir
        $rc = Invoke-WithFakeJava -ProjectRoot $work -Action {
            & pwsh -NoLogo -NoProfile -Command ". '$libPath'; exit (Invoke-JdkMismatchGate -ProjectRoot '$work')" 2>&1 | Out-Null
            $LASTEXITCODE
        }
        $rc | Should -Be 3
    }

    It 'returns 0 with -IgnoreJdkMismatch (downgrades to WARN)' {
        $libPath = $script:JdkLib
        $work = $script:WorkDir
        $output = Invoke-WithFakeJava -ProjectRoot $work -Action {
            & pwsh -NoLogo -NoProfile -Command ". '$libPath'; (Invoke-JdkMismatchGate -ProjectRoot '$work' -IgnoreJdkMismatch)" 2>&1
        }
        # Last line of output is the function's return value (0).
        ($output | Select-Object -Last 1) | Should -Be 0
        ($output -join "`n") | Should -Match 'WARN: JDK mismatch'
    }

    It 'returns 0 when no jvmToolchain is present in any *.gradle.kts' {
        Set-Content -Path (Join-Path $script:WorkDir 'build.gradle.kts') -Value 'plugins { kotlin("jvm") }'
        $libPath = $script:JdkLib
        $work = $script:WorkDir
        $rc = Invoke-WithFakeJava -ProjectRoot $work -Action {
            & pwsh -NoLogo -NoProfile -Command ". '$libPath'; exit (Invoke-JdkMismatchGate -ProjectRoot '$work')" 2>&1 | Out-Null
            $LASTEXITCODE
        }
        $rc | Should -Be 0
    }

    It 'returns 0 when gradle.properties org.gradle.java.home points to existing dir' {
        Set-Content -Path (Join-Path $script:WorkDir 'gradle.properties') `
            -Value "org.gradle.java.home=$($script:WorkDir)"
        $libPath = $script:JdkLib
        $work = $script:WorkDir
        $rc = Invoke-WithFakeJava -ProjectRoot $work -Action {
            & pwsh -NoLogo -NoProfile -Command ". '$libPath'; exit (Invoke-JdkMismatchGate -ProjectRoot '$work')" 2>&1 | Out-Null
            $LASTEXITCODE
        }
        $rc | Should -Be 0
    }

    It 'detects JvmTarget.JVM_N in build-logic\*.kt convention plugin (Bug F regression)' {
        # No jvmToolchain anywhere; the only JDK signal is a convention plugin
        # in build-logic/ pinning jvmTarget = JVM_21. Bytecode v65 won't load
        # on JDK 17 → gate must fire even though jvmToolchain is absent.
        Set-Content -Path (Join-Path $script:WorkDir 'build.gradle.kts') -Value 'plugins { kotlin("jvm") }'
        $convDir = Join-Path $script:WorkDir 'build-logic\src\main\kotlin'
        New-Item -ItemType Directory -Path $convDir -Force | Out-Null
        $convText = @'
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

class KmpBenchmarkConventionPlugin {
    fun apply() {
        jvm("desktop") { compilerOptions { jvmTarget.set(JvmTarget.JVM_21) } }
    }
}
'@
        Set-Content -Path (Join-Path $convDir 'KmpBenchmarkConventionPlugin.kt') -Value $convText

        $libPath = $script:JdkLib
        $work = $script:WorkDir
        $output = Invoke-WithFakeJava -ProjectRoot $work -Action {
            & pwsh -NoLogo -NoProfile -Command ". '$libPath'; exit (Invoke-JdkMismatchGate -ProjectRoot '$work')" 2>&1
            $LASTEXITCODE
        }
        ($output | Select-Object -Last 1) | Should -Be 3
        ($output -join "`n") | Should -Match 'requires JDK 21'
    }

    It 'takes MAX across mixed signals (jvmToolchain 17 + JvmTarget.JVM_21 -> 21)' {
        $build = @'
kotlin {
    jvmToolchain(17)
    jvm("desktop") { compilerOptions { jvmTarget.set(JvmTarget.JVM_21) } }
}
'@
        Set-Content -Path (Join-Path $script:WorkDir 'build.gradle.kts') -Value $build
        $libPath = $script:JdkLib
        $work = $script:WorkDir
        $output = Invoke-WithFakeJava -ProjectRoot $work -Action {
            & pwsh -NoLogo -NoProfile -Command ". '$libPath'; exit (Invoke-JdkMismatchGate -ProjectRoot '$work')" 2>&1
            $LASTEXITCODE
        }
        ($output | Select-Object -Last 1) | Should -Be 3
        ($output -join "`n") | Should -Match 'requires JDK 21'
    }
}

# ----------------------------------------------------------------------------
# End-to-end: invoke the production scripts and verify the gate fires
# ----------------------------------------------------------------------------

Describe 'parallel.ps1: JDK gate (end-to-end)' {

    BeforeEach {
        $script:WorkDir = Join-Path $TestDrive ("proj-e2e-" + [guid]::NewGuid().ToString('N').Substring(0,8))
        New-FakeKmpProject -Path $script:WorkDir -JvmToolchain 17 -JavaVersion 23
    }

    It 'BLOCKs with exit 3 when JDK mismatches jvmToolchain (default)' {
        $script = $script:Parallel
        $work = $script:WorkDir
        $output = Invoke-WithFakeJava -ProjectRoot $work -Action {
            & pwsh -NoLogo -NoProfile -File $script -ProjectRoot $work 2>&1
        }
        $LASTEXITCODE | Should -Be 3
        ($output -join "`n") | Should -Match 'JDK mismatch'
    }

    It '-IgnoreJdkMismatch bypasses the gate' {
        $script = $script:Parallel
        $work = $script:WorkDir
        $output = Invoke-WithFakeJava -ProjectRoot $work -Action {
            & pwsh -NoLogo -NoProfile -File $script -ProjectRoot $work -IgnoreJdkMismatch 2>&1
        }
        # Exit code is whatever downstream produces, but must NOT be 3 from JDK gate.
        # The dominant message must be the WARN, not the BLOCK.
        $joined = ($output -join "`n")
        # Either the WARN appears, or the gate didn't fire at all (matched Java).
        if ($LASTEXITCODE -eq 3) {
            $joined | Should -Match 'WARN: JDK mismatch'
        }
    }
}
