# =============================================================================
# Jdk-Check.ps1 — JDK pre-flight gate for any script that spawns gradle.
#
# Dot-source this file and call:
#   $rc = Invoke-JdkMismatchGate -ProjectRoot $ProjectRoot -IgnoreJdkMismatch:$IgnoreJdkMismatch
#   if ($rc -ne 0) { exit $rc }
#
# Behavior:
#   1. If gradle.properties has `org.gradle.java.home` pointing to an existing
#      directory: set $env:JAVA_HOME to that path and return 0 (gradle uses
#      its own java home; no mismatch possible).
#   2. Else: scan *.gradle.kts and *.kt for any of these JDK requirement
#      signals — `jvmToolchain(N)`, `JvmTarget.JVM_N`,
#      `JavaVersion.VERSION_N` — and take the MAX. If found, compare against
#      current `java -version`.
#   3. On mismatch: print actionable error to stderr and return 3, unless
#      -IgnoreJdkMismatch is set, in which case print a WARN and return 0.
#   4. On no mismatch (or no signal found, or no java on PATH): return 0.
#
# Exit code 3 matches kmp-test's EXIT.ENV_ERROR convention.
# =============================================================================

function Get-JdkMismatchHint {
    param([int]$Required)
    return ('$env:JAVA_HOME = "C:\Program Files\...\jdk-{0}"; kmp-test parallel' -f $Required)
}

function Invoke-JdkMismatchGate {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [switch]$IgnoreJdkMismatch
    )

    # 1. Honor explicit gradle.properties org.gradle.java.home (user opt-in).
    $gradleProps = Join-Path $ProjectRoot 'gradle.properties'
    if (Test-Path $gradleProps) {
        $javaHomeLine = Get-Content $gradleProps -ErrorAction SilentlyContinue |
            Where-Object { $_ -match '^\s*org\.gradle\.java\.home\s*=' } |
            Select-Object -First 1
        if ($javaHomeLine) {
            $gradleJava = ($javaHomeLine -split '=', 2)[1].Trim()
            if ($gradleJava -and (Test-Path $gradleJava)) {
                $env:JAVA_HOME = $gradleJava
                return 0
            }
        }
    }

    # 2. Detect required JDK version. Three signals — pick the max:
    #    a) jvmToolchain(N)          — gradle compile/test toolchain
    #    b) JvmTarget.JVM_N          — kotlin bytecode target
    #    c) JavaVersion.VERSION_N    — Android source/target compatibility
    # Scan both *.gradle.kts and *.kt (convention plugins live in build-logic/*.kt).
    $skipDirs = @('build', '.gradle', 'node_modules', '.git', '.idea')
    $signalRegexes = @(
        @{ Pattern = 'jvmToolchain\s*\(\s*(\d+)' ; Group = 1 },
        @{ Pattern = 'JvmTarget\.JVM_(\d+)\b'    ; Group = 1 },
        @{ Pattern = 'JavaVersion\.VERSION_(\d+)\b' ; Group = 1 }
    )
    $required = 0
    Get-ChildItem -Path $ProjectRoot -Recurse -Include '*.gradle.kts','*.kt' -ErrorAction SilentlyContinue |
        Where-Object {
            $segments = $_.FullName.Split([IO.Path]::DirectorySeparatorChar)
            -not ($skipDirs | Where-Object { $segments -contains $_ })
        } |
        ForEach-Object {
            $content = Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue
            if (-not $content) { return }
            foreach ($sig in $signalRegexes) {
                $matches_local = [regex]::Matches($content, $sig.Pattern)
                foreach ($m in $matches_local) {
                    $n = [int]$m.Groups[$sig.Group].Value
                    if ($n -gt $required) { $required = $n }
                }
            }
        }

    if ($required -eq 0) {
        return 0
    }

    # 3. Read current `java -version` (works even if JAVA_HOME unset).
    $javaVersionLine = & java -version 2>&1 | Select-Object -First 1
    if (-not $javaVersionLine -or $javaVersionLine -notmatch '"(\d+)') {
        return 0
    }
    $current = [int]$Matches[1]

    if ($current -eq $required) {
        return 0
    }

    # 4. Mismatch detected.
    if ($IgnoreJdkMismatch) {
        [Console]::Error.WriteLine("[!] WARN: JDK mismatch (required: $required, current: $current) - bypassed by -IgnoreJdkMismatch")
        return 0
    }

    $hint = Get-JdkMismatchHint -Required $required
    [Console]::Error.WriteLine("")
    [Console]::Error.WriteLine("[ERROR] JDK mismatch - project requires JDK $required but current JDK is $current")
    [Console]::Error.WriteLine("        Tests will fail with UnsupportedClassVersionError if we proceed.")
    [Console]::Error.WriteLine("")
    [Console]::Error.WriteLine("        Fix: set `$env:JAVA_HOME to a JDK $required install. Example:")
    [Console]::Error.WriteLine("          $hint")
    [Console]::Error.WriteLine("")
    [Console]::Error.WriteLine("        Bypass (not recommended): pass -IgnoreJdkMismatch")
    [Console]::Error.WriteLine("")
    return 3
}
