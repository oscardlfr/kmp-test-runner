# =============================================================================
# Jdk-Check.ps1 — JDK toolchain pre-flight gate for any script that spawns gradle.
#
# Dot-source this file and call:
#   $rc = Invoke-JdkMismatchGate -ProjectRoot $ProjectRoot -IgnoreJdkMismatch:$IgnoreJdkMismatch
#   if ($rc -ne 0) { exit $rc }
#
# Behavior:
#   1. If gradle.properties has `org.gradle.java.home` pointing to an existing
#      directory: set $env:JAVA_HOME to that path and return 0 (gradle uses
#      its own java home; no mismatch possible).
#   2. Else: scan *.gradle.kts for `jvmToolchain(N)`. If found, compare N
#      against current `java -version`.
#   3. On mismatch: print actionable error to stderr and return 3, unless
#      -IgnoreJdkMismatch is set, in which case print a WARN and return 0.
#   4. On no mismatch (or no jvmToolchain found, or no java on PATH): return 0.
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

    # 2. Detect required jvmToolchain version (first match wins).
    $jvmLine = Get-ChildItem -Path $ProjectRoot -Recurse -Include '*.gradle.kts' -ErrorAction SilentlyContinue |
        Select-Object -First 50 |
        ForEach-Object { Get-Content $_.FullName -ErrorAction SilentlyContinue } |
        Where-Object { $_ -match 'jvmToolchain' } |
        Select-Object -First 1

    if (-not $jvmLine -or $jvmLine -notmatch '(\d+)') {
        return 0
    }
    $required = [int]$Matches[1]

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
