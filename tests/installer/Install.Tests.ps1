#Requires -Modules Pester
# Parser + smoke tests for scripts/install.ps1 and scripts/uninstall.ps1

Describe 'install.ps1 syntax' {
    It 'parses without error' {
        $ScriptPath = Join-Path $PSScriptRoot '..\..\scripts\install.ps1'
        { [System.Management.Automation.Language.Parser]::ParseFile(
              $ScriptPath, [ref]$null, [ref]$null) } | Should -Not -Throw
    }
    It 'uninstall.ps1 parses without error' {
        $ScriptPath = Join-Path $PSScriptRoot '..\..\scripts\uninstall.ps1'
        { [System.Management.Automation.Language.Parser]::ParseFile(
              $ScriptPath, [ref]$null, [ref]$null) } | Should -Not -Throw
    }
}

Describe 'install.ps1 safety constraints' {
    BeforeAll {
        $script:InstallContent   = Get-Content (Join-Path $PSScriptRoot '..\..\scripts\install.ps1') -Raw
        $script:UninstallContent = Get-Content (Join-Path $PSScriptRoot '..\..\scripts\uninstall.ps1') -Raw
    }

    It 'uses -UseBasicParsing on all Invoke-WebRequest calls' {
        $Calls = [regex]::Matches($script:InstallContent, 'Invoke-WebRequest[^\r\n]*')
        $Calls.Count | Should -BeGreaterThan 0
        foreach ($Call in $Calls) {
            $Call.Value | Should -Match '-UseBasicParsing'
        }
    }

    It 'never references Machine scope for PATH' {
        $script:InstallContent   | Should -Not -Match "'Machine'"
        $script:UninstallContent | Should -Not -Match "'Machine'"
    }

    It 'sets PATH with User scope' {
        $script:InstallContent | Should -Match '"User"'
    }

    It 'does not use Get-WmiObject' {
        $script:InstallContent   | Should -Not -Match 'Get-WmiObject'
        $script:UninstallContent | Should -Not -Match 'Get-WmiObject'
    }

    It 'does not use Invoke-Expression on remote content' {
        $script:InstallContent | Should -Not -Match 'Invoke-Expression'
    }
}
