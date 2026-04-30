# =============================================================================
# ProjectModel.ps1 — PowerShell readers over the ProjectModel JSON (v0.5.1 Phase 4).
#
# Dot-source this file and call:
#   $jdk    = Get-PmJdkRequirement      -ProjectRoot $PR
#   $unit   = Get-PmUnitTestTask        -ProjectRoot $PR -Module 'core-foo'
#   $device = Get-PmDeviceTestTask      -ProjectRoot $PR -Module ':core-foo'
#   $cov    = Get-PmCoverageTask        -ProjectRoot $PR -Module 'core-foo'
#   $type   = Get-PmModuleType          -ProjectRoot $PR -Module 'core-foo'
#   $hasT   = Get-PmModuleHasTests      -ProjectRoot $PR -Module 'core-foo'
#
# Each reader returns the requested value or $null when the model JSON is
# absent / unreadable / the requested field doesn't exist. Callers fall
# through to legacy detection on $null. Never throws on legitimate
# "model missing" — fail-soft is the contract.
#
# Model layout: <project>\.kmp-test-runner-cache\model-<sha>.json (sha is
# the same content-keyed SHA1 used by Gradle-Tasks-Probe.ps1).
# =============================================================================

# Sourced helpers — Gradle-Tasks-Probe owns the cache-key algorithm and we
# reuse it verbatim here so model and probe agree on the current SHA.
$pmLibDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $pmLibDir 'Gradle-Tasks-Probe.ps1')

function _Get-PmModelFile {
    param([Parameter(Mandatory)][string]$ProjectRoot)
    if (-not (Test-Path $ProjectRoot)) { return $null }
    $cacheKey = $null
    try { $cacheKey = Get-KmpCacheKey -ProjectRoot $ProjectRoot } catch { return $null }
    if (-not $cacheKey) { return $null }
    $file = Join-Path $ProjectRoot ".kmp-test-runner-cache\model-$cacheKey.json"
    if (-not (Test-Path $file)) { return $null }
    if ((Get-Item $file).Length -eq 0) { return $null }
    return $file
}

function _Get-PmModelData {
    param([Parameter(Mandatory)][string]$ProjectRoot)
    $file = _Get-PmModelFile -ProjectRoot $ProjectRoot
    if (-not $file) { return $null }
    try {
        $raw = Get-Content $file -Raw -ErrorAction Stop
        return ConvertFrom-Json $raw -ErrorAction Stop
    } catch {
        return $null
    }
}

function _Normalize-PmModule {
    param([Parameter(Mandatory)][string]$Module)
    if ($Module.StartsWith(':')) { return $Module }
    return ":$Module"
}

# `ConvertFrom-Json` returns PSCustomObject. Object-key indexing via `.PSObject.Properties[name]`
# would null-coalesce gracefully but the simpler `.<name>` syntax also works
# because missing keys yield $null. We deliberately access nested fields via
# the safe-nav-style helper below to handle missing intermediate keys cleanly.
function _Get-PmField {
    param(
        [Parameter(Mandatory)]$Root,
        [Parameter(Mandatory)][string[]]$Path
    )
    $cur = $Root
    foreach ($k in $Path) {
        if ($null -eq $cur) { return $null }
        if ($cur -is [PSCustomObject]) {
            $prop = $cur.PSObject.Properties[$k]
            $cur = if ($null -eq $prop) { $null } else { $prop.Value }
        } elseif ($cur -is [System.Collections.IDictionary]) {
            $cur = $cur[$k]
        } else {
            return $null
        }
    }
    return $cur
}

function Get-PmJdkRequirement {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ProjectRoot)
    $data = _Get-PmModelData -ProjectRoot $ProjectRoot
    if (-not $data) { return $null }
    return (_Get-PmField -Root $data -Path @('jdkRequirement','min'))
}

function Get-PmUnitTestTask {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ProjectRoot,
        [Parameter(Mandatory)][string]$Module
    )
    $data = _Get-PmModelData -ProjectRoot $ProjectRoot
    if (-not $data) { return $null }
    $m = _Normalize-PmModule -Module $Module
    return (_Get-PmField -Root $data -Path @('modules', $m, 'resolved', 'unitTestTask'))
}

function Get-PmDeviceTestTask {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ProjectRoot,
        [Parameter(Mandatory)][string]$Module
    )
    $data = _Get-PmModelData -ProjectRoot $ProjectRoot
    if (-not $data) { return $null }
    $m = _Normalize-PmModule -Module $Module
    return (_Get-PmField -Root $data -Path @('modules', $m, 'resolved', 'deviceTestTask'))
}

function Get-PmCoverageTask {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ProjectRoot,
        [Parameter(Mandatory)][string]$Module
    )
    $data = _Get-PmModelData -ProjectRoot $ProjectRoot
    if (-not $data) { return $null }
    $m = _Normalize-PmModule -Module $Module
    return (_Get-PmField -Root $data -Path @('modules', $m, 'resolved', 'coverageTask'))
}

# v0.6 Bug 3: JS / Wasm test task — typically jsTest or wasmJsTest. Returns
# $null when the module has no JS/Wasm targets, when the model is missing,
# or when the probe didn't see the candidate task. Parallel to
# Get-PmDeviceTestTask for Android — scripts opt in by reading this when
# they want web-side test invocation.
function Get-PmWebTestTask {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ProjectRoot,
        [Parameter(Mandatory)][string]$Module
    )
    $data = _Get-PmModelData -ProjectRoot $ProjectRoot
    if (-not $data) { return $null }
    $m = _Normalize-PmModule -Module $Module
    return (_Get-PmField -Root $data -Path @('modules', $m, 'resolved', 'webTestTask'))
}

function Get-PmModuleType {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ProjectRoot,
        [Parameter(Mandatory)][string]$Module
    )
    $data = _Get-PmModelData -ProjectRoot $ProjectRoot
    if (-not $data) { return $null }
    $m = _Normalize-PmModule -Module $Module
    return (_Get-PmField -Root $data -Path @('modules', $m, 'type'))
}

function Get-PmModuleHasTests {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ProjectRoot,
        [Parameter(Mandatory)][string]$Module
    )
    $data = _Get-PmModelData -ProjectRoot $ProjectRoot
    if (-not $data) { return $null }
    $m = _Normalize-PmModule -Module $Module
    $sourceSets = _Get-PmField -Root $data -Path @('modules', $m, 'sourceSets')
    if ($null -eq $sourceSets) { return $null }
    foreach ($prop in $sourceSets.PSObject.Properties) {
        if ($prop.Value -eq $true) { return $true }
    }
    return $false
}
