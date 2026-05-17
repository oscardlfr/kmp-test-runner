<#
.SYNOPSIS
    Convenience wrapper for kmp-test. Picks the subcommand from -Type
    (default: unit), forwards everything else verbatim, and auto-injects
    --json + --project-root . so the call is location-agnostic and
    produces a single parseable envelope on stdout.

.DESCRIPTION
    For -Type android, an env preamble runs detect-env.ps1 first and prints
    [INFO] env: HAS_ANDROID_CLI|NO_ANDROID_CLI to stderr — the agent can
    branch on the enriched-vs-fallback troubleshooting workflow without
    parsing it out of the envelope.

    kmp-test is invoked via `npx kmp-test` so the script works regardless of
    whether the CLI was installed via npm-global or the installer's HKCU
    PATH augmentation (npx resolves both forms identically).

.PARAMETER Type
    Test type / kmp-test subcommand selector. Default 'unit'. One of:
    unit | android | coverage | benchmark | changed | info | doctor | describe.

.PARAMETER Rest
    Extra args forwarded verbatim to kmp-test. --json and --project-root .
    are injected automatically; do not pass them here.

.EXAMPLE
    pwsh run-tests.ps1
    # → npx kmp-test parallel --json --project-root .

.EXAMPLE
    pwsh run-tests.ps1 android --device R3CT30KAMEH
    # → [INFO] env: HAS_ANDROID_CLI (on stderr)
    # → npx kmp-test android --json --project-root . --device R3CT30KAMEH
#>
[CmdletBinding()]
param(
    [string]$Type = 'unit',
    [Parameter(ValueFromRemainingArguments = $true)]
    $Rest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# PowerShell binds dash-prefixed args to $Rest, not $Type — scan the
# combined arg surface so `pwsh run-tests.ps1 --help` works whether the
# flag lands in $Type (rare) or $Rest (the common case).
$allArgs = @($Type)
if ($Rest) { $allArgs += $Rest }
$helpFlags = @('--help', '-h', '-Help', 'help')
if ($allArgs | Where-Object { $_ -in $helpFlags }) {
    @'
Usage: pwsh run-tests.ps1 [-Type TYPE] [-- extra kmp-test args...]

TYPE (-Type or first positional, default = unit):
  unit       → kmp-test parallel --json
  android    → kmp-test android --json
  coverage   → kmp-test coverage --json
  benchmark  → kmp-test benchmark --json
  changed    → kmp-test changed --json
  info       → kmp-test info --json
  doctor     → kmp-test doctor --json
  describe   → kmp-test describe --json

Extra args after TYPE are forwarded verbatim. --json and
--project-root . are injected automatically.

For `android`, an env preamble runs detect-env.ps1 and prints
[INFO] env: HAS_ANDROID_CLI|NO_ANDROID_CLI to stderr.
'@
    exit 0
}

$typeMap = @{
    'unit'      = 'parallel'
    'android'   = 'android'
    'coverage'  = 'coverage'
    'benchmark' = 'benchmark'
    'changed'   = 'changed'
    'info'      = 'info'
    'doctor'    = 'doctor'
    'describe'  = 'describe'
}

if (-not $typeMap.ContainsKey($Type)) {
    [Console]::Error.WriteLine("run-tests.ps1: unknown -Type '$Type'")
    [Console]::Error.WriteLine('Run `pwsh run-tests.ps1 --help` for the supported list.')
    exit 2
}

$sub = $typeMap[$Type]

if ($Type -eq 'android') {
    $detectEnv = Join-Path $PSScriptRoot 'detect-env.ps1'
    if (Test-Path $detectEnv) {
        $env = & pwsh -NoLogo -NoProfile -File $detectEnv
        [Console]::Error.WriteLine("[INFO] env: $env")
    }
}

# Build the args list. $Rest may be $null when no extras were passed —
# guard so we don't splat a $null into the argv.
$forwarded = @($sub, '--json', '--project-root', '.')
if ($Rest) { $forwarded += $Rest }

# `npx` resolves both `npm install -g kmp-test-runner` and the installer's
# HKCU PATH augmentation. Using the call operator (&) ensures the args
# pass through verbatim with PowerShell's native arg parsing.
& npx kmp-test @forwarded
exit $LASTEXITCODE
