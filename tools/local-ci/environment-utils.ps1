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
