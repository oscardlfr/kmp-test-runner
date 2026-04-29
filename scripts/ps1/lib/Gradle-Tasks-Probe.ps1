# =============================================================================
# Gradle-Tasks-Probe.ps1 — One-shot Gradle task-set probe with content-keyed cache.
#
# Dot-source this file and call:
#   $cache = Invoke-GradleTasksProbe -ProjectRoot $PR     # path to cache file, or $null
#   $exists = Test-ModuleHasTask -ProjectRoot $PR -Module 'core-foo' -Task 'jacocoTestReport'
#   $task = Get-ModuleFirstExistingTask -ProjectRoot $PR -Module 'core-foo' `
#                                       -Candidates @('connectedDebugAndroidTest','androidConnectedCheck')
#   Clear-GradleTasksCache -ProjectRoot $PR
#
# Cache layout: <project>\.kmp-test-runner-cache\tasks-<sha>.txt
# Cache key:    SHA1 of concatenated file contents of settings.gradle.kts,
#               gradle.properties, and every per-module build.gradle.kts.
#               Any content change invalidates the cache deterministically.
#
# Probe failure (gradle missing, timeout, exit nonzero) is non-fatal: the
# probe returns $null and callers fall back to their pre-probe behavior. A
# WARN is emitted to stderr exactly once per cache miss.
# =============================================================================

function Get-KmpHashString {
    # NB: do NOT name the parameter $Input — that collides with PowerShell's
    # automatic pipeline-input variable and silently arrives empty.
    param([string]$Text)
    $sha1 = [System.Security.Cryptography.SHA1]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        $hash = $sha1.ComputeHash($bytes)
        return ([System.BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
    } finally {
        $sha1.Dispose()
    }
}

function Get-KmpCacheKey {
    param([Parameter(Mandatory)][string]$ProjectRoot)
    $sb = New-Object System.Text.StringBuilder

    $settings = Join-Path $ProjectRoot 'settings.gradle.kts'
    if (Test-Path $settings) {
        [void]$sb.Append((Get-Content $settings -Raw -ErrorAction SilentlyContinue))
    }
    $props = Join-Path $ProjectRoot 'gradle.properties'
    if (Test-Path $props) {
        [void]$sb.Append((Get-Content $props -Raw -ErrorAction SilentlyContinue))
    }

    $buildFiles = Get-ChildItem -Path $ProjectRoot -Recurse -Filter 'build.gradle.kts' `
        -Depth 4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.FullName -notmatch '[/\\]build[/\\]' -and
            $_.FullName -notmatch '[/\\]\.gradle[/\\]'
        } |
        Sort-Object FullName

    foreach ($f in $buildFiles) {
        [void]$sb.Append((Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue))
    }

    return Get-KmpHashString -Text $sb.ToString()
}

function Invoke-GradleTasksProbe {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ProjectRoot,
        [int]$TimeoutSeconds = 60
    )

    if (-not (Test-Path $ProjectRoot)) { return $null }
    $gradlewBat = Join-Path $ProjectRoot 'gradlew.bat'
    $gradlewSh  = Join-Path $ProjectRoot 'gradlew'
    if (-not (Test-Path $gradlewBat) -and -not (Test-Path $gradlewSh)) { return $null }

    $cacheDir = Join-Path $ProjectRoot '.kmp-test-runner-cache'
    $cacheKey = Get-KmpCacheKey -ProjectRoot $ProjectRoot
    if (-not $cacheKey) { return $null }
    $cacheFile = Join-Path $cacheDir "tasks-$cacheKey.txt"

    if ((Test-Path $cacheFile) -and ((Get-Item $cacheFile).Length -gt 0)) {
        return $cacheFile
    }

    if (-not (Test-Path $cacheDir)) {
        New-Item -ItemType Directory -Path $cacheDir -ErrorAction SilentlyContinue | Out-Null
    }

    $tmp = "$cacheFile.tmp.$PID"
    $exe = if (Test-Path $gradlewBat) { $gradlewBat } else { $gradlewSh }

    try {
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $exe
        $startInfo.Arguments = 'tasks --all --quiet'
        $startInfo.WorkingDirectory = $ProjectRoot
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true

        $proc = [System.Diagnostics.Process]::Start($startInfo)
        $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
        $finished = $proc.WaitForExit($TimeoutSeconds * 1000)

        if (-not $finished) {
            try { $proc.Kill() } catch { }
            [Console]::Error.WriteLine("[!] WARN: gradle task probe exceeded ${TimeoutSeconds}s - falling back to legacy detection")
            return $null
        }

        if ($proc.ExitCode -ne 0) {
            [Console]::Error.WriteLine("[!] WARN: gradle task probe failed (exit $($proc.ExitCode)) - falling back to legacy detection")
            return $null
        }

        $stdout = $stdoutTask.Result
        if ([string]::IsNullOrWhiteSpace($stdout)) {
            [Console]::Error.WriteLine("[!] WARN: gradle task probe produced no output - falling back to legacy detection")
            return $null
        }

        Set-Content -Path $tmp -Value $stdout -NoNewline -Encoding UTF8
        Move-Item -Path $tmp -Destination $cacheFile -Force
        return $cacheFile
    } catch {
        [Console]::Error.WriteLine("[!] WARN: gradle task probe error - falling back to legacy detection: $_")
        if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
        return $null
    }
}

function Test-ModuleHasTask {
    <#
    .SYNOPSIS
    Tristate task-existence check.

    .DESCRIPTION
    Returns:
      $true  - task confirmed present in cache
      $false - cache present, task NOT in it (definitely missing)
      $null  - probe unavailable (caller should fall back to legacy behavior)
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ProjectRoot,
        [Parameter(Mandatory)][string]$Module,
        [Parameter(Mandatory)][string]$Task
    )
    $cache = Invoke-GradleTasksProbe -ProjectRoot $ProjectRoot
    if (-not $cache) { return $null }

    # `gradlew tasks --all` emits `module:task - description` (NO leading
    # colon) at column 0. Earlier versions of this probe required a `:`
    # prefix in the needle, which never matched and caused every probe to
    # fall back to the legacy umbrella task (Bug observed in shared-kmp-libs:
    # `core-encryption:androidConnectedCheck` was in cache but probe rc=1).
    $mod = $Module.TrimStart(':')
    $needle = "${mod}:${Task}"
    $pattern = "(^|\s)" + [regex]::Escape($needle) + "(\s|$)"

    if (Select-String -Path $cache -Pattern $pattern -Quiet -ErrorAction SilentlyContinue) {
        return $true
    }
    return $false
}

function Get-ModuleFirstExistingTask {
    <#
    .SYNOPSIS
    Pick the first task name from a candidate list that exists for the module.

    .DESCRIPTION
    Returns a hashtable: @{ Task = <name|$null>; Status = 'found'|'no_match'|'probe_unavailable' }
    Caller switches on Status to distinguish "probe says it doesn't exist" from
    "probe couldn't run; use legacy fallback".
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ProjectRoot,
        [Parameter(Mandatory)][string]$Module,
        [Parameter(Mandatory)][string[]]$Candidates
    )
    $cache = Invoke-GradleTasksProbe -ProjectRoot $ProjectRoot
    if (-not $cache) { return @{ Task = $null; Status = 'probe_unavailable' } }

    # See Test-ModuleHasTask for cache-format rationale (no leading colon).
    $mod = $Module.TrimStart(':')
    foreach ($t in $Candidates) {
        $needle = "${mod}:${t}"
        $pattern = "(^|\s)" + [regex]::Escape($needle) + "(\s|$)"
        if (Select-String -Path $cache -Pattern $pattern -Quiet -ErrorAction SilentlyContinue) {
            return @{ Task = $t; Status = 'found' }
        }
    }
    return @{ Task = $null; Status = 'no_match' }
}

function Clear-GradleTasksCache {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ProjectRoot)
    if (-not (Test-Path $ProjectRoot)) { return }
    $cacheDir = Join-Path $ProjectRoot '.kmp-test-runner-cache'
    if (-not (Test-Path $cacheDir)) { return }
    Get-ChildItem -Path $cacheDir -Filter 'tasks-*.txt' -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
}
