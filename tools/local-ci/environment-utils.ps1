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

    foreach ($entry in $Entries) {
        Set-Item -LiteralPath ("Env:{0}" -f $entry.Name) -Value $entry.Value
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
