[CmdletBinding()]
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path,
    [string]$Node24Home = (Join-Path $env:LOCALAPPDATA 'nvm/v24.18.0'),
    [string]$Node18Home = (Join-Path $env:LOCALAPPDATA 'nvm/v18.20.8')
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path $RepoRoot).Path
. (Join-Path $PSScriptRoot 'environment-utils.ps1')

function Invoke-NativeChecked {
    param([string]$FilePath, [string[]]$ArgumentList, [string]$Description)
    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE"
    }
}

function Find-Jdk17 {
    $candidates = @()
    if ($env:JAVA_HOME) { $candidates += $env:JAVA_HOME }
    $adoptium = Join-Path $env:ProgramFiles 'Eclipse Adoptium'
    if (Test-Path $adoptium) {
        $candidates += Get-ChildItem $adoptium -Directory -Filter 'jdk-17*' |
            Sort-Object Name -Descending |
            Select-Object -ExpandProperty FullName
    }
    foreach ($candidate in $candidates | Select-Object -Unique) {
        $java = Join-Path $candidate 'bin/java.exe'
        if (Test-Path $java) {
            $version = (& $java -version 2>&1 | Select-Object -First 1) -join ''
            if ($version -match 'version "17[\.]') { return $candidate }
        }
    }
    throw 'JDK 17 not found. Install Temurin 17 or set JAVA_HOME to a JDK 17 installation.'
}

$originalPath = $env:PATH
$originalJavaHome = $env:JAVA_HOME
# Every state mutation below (env vars, current-location) is initialized to an inert default here,
# then only ever ASSIGNED inside the try block that follows -- so the finally block's own
# conditional restoration (`if ($x) { ... }`) can tell "this step never even ran" apart from "this
# step ran and needs undoing" regardless of exactly where inside the try a throw happens. Before
# this hardening, the 3 setup mutations below ran BEFORE the try started: a failure partway through
# them (Get-Command not finding powershell, Suspend-SensitiveEnvironment itself throwing,
# Push-Location failing) left whatever had already succeeded permanently unrestored, since
# PowerShell's finally only guards code that is actually inside the try.
$npmScriptShellScope = $null
$sensitiveEnvironment = $null
$pushedLocation = $false
$nodeExeScope = $null
# Post-review hardening (round 4): set ONLY as the try block's own last statement, right after the
# success Write-Host -- if the body throws anywhere before reaching that point, this stays $false,
# so the finally block below knows NOT to raise a new cleanup-triggered failure on top of (and
# thereby masking) whatever original exception is already propagating.
$bodySucceeded = $false
try {
    # On hosts where a child cmd.exe process inherits an empty PATH regardless of the caller's own
    # environment, npm's own cmd.exe-routed lifecycle-script execution breaks (e.g. esbuild's
    # postinstall fails to find `node`). Routing npm's lifecycle scripts through PowerShell instead
    # avoids that hop entirely. Set-ScopedEnvVar/Restore-ScopedEnvVar (environment-utils.ps1)
    # capture/restore exactly -- present vs. absent, not just value -- so a caller's own
    # environment is never permanently altered by running this gate.
    $npmScriptShellScope = Set-ScopedEnvVar -Name 'npm_config_script_shell' -Value (Get-Command powershell -ErrorAction Stop).Source
    $sensitiveEnvironment = Suspend-SensitiveEnvironment
    Push-Location $RepoRoot
    $pushedLocation = $true

    $node24 = Join-Path $Node24Home 'node.exe'
    if (-not (Test-Path $node24)) {
        throw "Node 24.18.0 not found at $Node24Home. Install it with nvm-windows before running the full gate."
    }
    $env:PATH = "$Node24Home;$originalPath"
    $node24Version = (& $node24 --version).Trim()
    if ($node24Version -ne 'v24.18.0') {
        throw "Windows lane requires Node 24.18.0; found $node24Version"
    }
    # Test-only: TaskActionTest's Windows shim used to discover node.exe via `cmd.exe /c where
    # node`, which fails identically to the npm case above. Exposing this already-validated path
    # lets the test skip that cmd.exe hop entirely (it still falls back to a pure-Kotlin PATH walk,
    # no cmd.exe, when run standalone without this variable set).
    $nodeExeScope = Set-ScopedEnvVar -Name 'KMP_LOCAL_CI_NODE_EXE' -Value (Resolve-Path $node24).Path

    Invoke-NativeChecked (Join-Path $Node24Home 'npm.cmd') @('ci') 'npm ci (Node 24)'
    Invoke-NativeChecked $node24 @('tools/check-line-endings.mjs') 'line-ending audit'
    Invoke-NativeChecked $node24 @('tools/check-executable-fixtures.mjs') 'fixture executable-bit audit'
    Invoke-NativeChecked (Join-Path $Node24Home 'npm.cmd') @('audit', '--omit=dev', '--audit-level=high') 'production dependency audit'
    & (Join-Path $Node24Home 'npm.cmd') audit --audit-level=high
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'dev-toolchain audit reported advisories (informational, matching CI)'
    }

    $pester = Get-Module -ListAvailable Pester |
        Where-Object { $_.Version.Major -eq 5 } |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if (-not $pester) {
        throw "Pester 5 is required. Run: Install-Module Pester -Scope CurrentUser -Force -RequiredVersion 5.7.1"
    }
    Import-Module $pester.Path -Force
    $pesterResult = Invoke-Pester -Path 'tests/pester/', 'tests/installer/', 'tests/skill-scripts/' -CI -PassThru
    if ($pesterResult.FailedCount -gt 0) {
        throw "Pester failed: $($pesterResult.FailedCount) test(s)"
    }

    $jdk17Home = Find-Jdk17
    $env:JAVA_HOME = $jdk17Home
    $env:PATH = "$(Join-Path $env:JAVA_HOME 'bin');$Node24Home;$originalPath"
    Push-Location (Join-Path $RepoRoot 'gradle-plugin')
    try {
        Invoke-NativeChecked -FilePath '.\gradlew.bat' -ArgumentList @('test', '--tests', '*.TaskActionTest', '--no-daemon') -Description 'Gradle plugin Windows TaskAction smoke'
    }
    finally {
        Pop-Location
    }

    Invoke-NativeChecked (Join-Path $Node24Home 'npx.cmd') @('vitest', 'run', '--coverage') 'Vitest coverage (Node 24)'

    $node18 = Join-Path $Node18Home 'node.exe'
    if (-not (Test-Path $node18)) {
        throw "Node 18.20.8 not found at $Node18Home. Install it with nvm-windows before running the full gate."
    }
    $env:JAVA_HOME = $jdk17Home
    $env:PATH = "$(Join-Path $jdk17Home 'bin');$Node18Home;$originalPath"
    $node18Version = (& $node18 --version).Trim()
    if ($node18Version -notmatch '^v18[.]') {
        throw "expected Node 18 under $Node18Home; found $node18Version"
    }
    $node18Arch = (& $node18 -p 'process.arch').Trim()
    if ($node18Arch -ne 'x64') {
        throw "expected x64 Node 18 under $Node18Home; found $node18Arch"
    }
    Invoke-NativeChecked (Join-Path $Node18Home 'npm.cmd') @('ci') 'npm ci (Node 18)'
    Invoke-NativeChecked (Join-Path $Node18Home 'npx.cmd') @('vitest', 'run') 'Vitest (Node 18)'

    Write-Host '[local-ci] Windows Node 24/18, Pester, and Gradle lane passed' -ForegroundColor Green
    $bodySucceeded = $true
}
finally {
    # Post-review hardening (round 3): each restoration below is now wrapped in its OWN try/catch,
    # not a bare sequential statement -- confirmed via direct repro that an exception thrown by the
    # FIRST restoration in a `finally` block aborts every statement after it in that SAME block
    # (PowerShell does not auto-continue past an unhandled error mid-`finally`, same as every other
    # mainstream language's finally semantics). Before this, a failure in Restore-ScopedEnvVar for
    # npm_config_script_shell would have silently skipped restoring KMP_LOCAL_CI_NODE_EXE, every
    # suspended sensitive env var, PATH/JAVA_HOME, and the pushed location. $cleanupErrors
    # accumulates every individual failure (surfaced via Write-Warning below) without ever
    # interfering with the ORIGINAL exception that triggered entry into this finally in the first
    # place -- that exception keeps propagating normally once this block finishes, since nothing
    # here re-throws or swallows it.
    $cleanupErrors = @()
    try { $env:PATH = $originalPath } catch { $cleanupErrors += "PATH restore: $($_.Exception.Message)" }
    try { $env:JAVA_HOME = $originalJavaHome } catch { $cleanupErrors += "JAVA_HOME restore: $($_.Exception.Message)" }
    if ($npmScriptShellScope) {
        try { Restore-ScopedEnvVar -Saved $npmScriptShellScope } catch { $cleanupErrors += "npm_config_script_shell restore: $($_.Exception.Message)" }
    }
    if ($nodeExeScope) {
        try { Restore-ScopedEnvVar -Saved $nodeExeScope } catch { $cleanupErrors += "KMP_LOCAL_CI_NODE_EXE restore: $($_.Exception.Message)" }
    }
    if ($sensitiveEnvironment) {
        try { Restore-SensitiveEnvironment -Entries $sensitiveEnvironment } catch { $cleanupErrors += "sensitive-environment restore: $($_.Exception.Message)" }
    }
    if ($pushedLocation) {
        try { Pop-Location } catch { $cleanupErrors += "Pop-Location: $($_.Exception.Message)" }
    }
    if ($cleanupErrors.Count -gt 0) {
        # Post-review hardening (round 5): Write-Host, never Write-Warning, for this notice -- a
        # Write-Warning call becomes a TERMINATING error when the ambient (caller-controlled)
        # $WarningPreference is 'Stop', confirmed live: it then supersedes whatever original
        # exception was already propagating from the try body, silently replacing a genuine body
        # failure's error text with a generic "stopped because WarningPreference" message. Write-Host
        # writes straight to host output, bypassing PowerShell's warning/error stream machinery
        # entirely, so it can never itself become a competing terminating error regardless of any
        # ambient preference variable.
        Write-Host "[local-ci] cleanup encountered $($cleanupErrors.Count) error(s) during restoration: $($cleanupErrors -join '; ')"
        # Post-review hardening (round 4): a green body plus a failed restoration previously still
        # exited 0 -- $cleanupErrors was only ever reported, never affecting the script's own exit
        # code, so altered state could be left behind while the gate reported overall success. Only
        # raised when the body itself already succeeded ($bodySucceeded) -- if the body failed too,
        # THAT original exception is already propagating past this finally block on its own and must
        # remain the primary reported error, never replaced by a new one raised from here.
        if ($bodySucceeded) {
            throw "windows-gate.ps1: body succeeded but cleanup failed ($($cleanupErrors.Count) error(s)) -- environment may be left altered: $($cleanupErrors -join '; ')"
        }
    }
}
