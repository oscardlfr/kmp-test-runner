function Suspend-SensitiveEnvironment {
    [CmdletBinding()]
    param()

    $secretShape = '(^|_)(ACCESS_KEY|API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY)(_|$)'
    $explicitNames = @('KMP_PRIVATE_PATTERNS_B64')
    $suspended = @()

    foreach ($entry in Get-ChildItem Env:) {
        if ($entry.Name -match $secretShape -or $explicitNames -contains $entry.Name) {
            $suspended += [pscustomobject]@{ Name = $entry.Name; Value = $entry.Value }
            Remove-Item -LiteralPath ("Env:{0}" -f $entry.Name) -ErrorAction Stop
        }
    }

    return $suspended
}

function Restore-SensitiveEnvironment {
    [CmdletBinding()]
    param([object[]]$Entries)

    # Post-review hardening (round 4): each entry is now attempted independently -- a bare foreach
    # with no per-entry try/catch meant a Set-Item throw on one entry (confirmed live: an entry
    # whose Name contains '=' reliably throws ArgumentException) stopped the loop outright, leaving
    # every later entry unrestored. The caller's own OUTER try/catch around the whole call only
    # catches ONE exception for the entire call, with no visibility into which entries inside it
    # succeeded -- the fix has to live here. Every entry is still attempted; if any failed, a single
    # aggregate exception is thrown AFTER the loop (never mid-loop), so the caller still learns
    # cleanup was incomplete without any entry being skipped to get that signal.
    $failures = @()
    foreach ($entry in $Entries) {
        try {
            Set-Item -LiteralPath ("Env:{0}" -f $entry.Name) -Value $entry.Value
        } catch {
            $failures += "$($entry.Name): $($_.Exception.Message)"
        }
    }
    if ($failures.Count -gt 0) {
        throw "Restore-SensitiveEnvironment failed to restore $($failures.Count) of $($Entries.Count) entrie(s): $($failures -join '; ')"
    }
}

# Sets a single environment variable for the duration of a scoped operation (e.g. one gate run),
# capturing enough to restore it EXACTLY afterward -- present-with-a-value vs. genuinely absent,
# not just "restore to some value". Pair with Restore-ScopedEnvVar in a try/finally.
function Set-ScopedEnvVar {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Value)

    $envPath = "Env:{0}" -f $Name
    $wasSet = Test-Path -LiteralPath $envPath
    $original = if ($wasSet) { (Get-Item -LiteralPath $envPath).Value } else { $null }
    Set-Item -LiteralPath $envPath -Value $Value
    return [pscustomobject]@{ Name = $Name; WasSet = $wasSet; OriginalValue = $original }
}

function Restore-ScopedEnvVar {
    [CmdletBinding()]
    param([Parameter(Mandatory)][object]$Saved)

    $envPath = "Env:{0}" -f $Saved.Name
    if ($Saved.WasSet) {
        Set-Item -LiteralPath $envPath -Value $Saved.OriginalValue
    } else {
        Remove-Item -LiteralPath $envPath -ErrorAction SilentlyContinue
    }
}
