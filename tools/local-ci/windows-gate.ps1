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
$sensitiveEnvironment = Suspend-SensitiveEnvironment
Push-Location $RepoRoot
try {
    $node24 = Join-Path $Node24Home 'node.exe'
    if (-not (Test-Path $node24)) {
        throw "Node 24.18.0 not found at $Node24Home. Install it with nvm-windows before running the full gate."
    }
    $env:PATH = "$Node24Home;$originalPath"
    $node24Version = (& $node24 --version).Trim()
    if ($node24Version -ne 'v24.18.0') {
        throw "Windows lane requires Node 24.18.0; found $node24Version"
    }

    Invoke-NativeChecked (Join-Path $Node24Home 'npm.cmd') @('ci') 'npm ci (Node 24)'
    Invoke-NativeChecked $node24 @('tools/check-line-endings.mjs') 'line-ending audit'
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
}
finally {
    $env:PATH = $originalPath
    $env:JAVA_HOME = $originalJavaHome
    Restore-SensitiveEnvironment -Entries $sensitiveEnvironment
    Pop-Location
}
