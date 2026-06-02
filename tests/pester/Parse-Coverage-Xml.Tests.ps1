#Requires -Modules Pester
# Parser smoke for scripts/lib/parse-coverage-xml.py — PowerShell parity to the
# tests/bats/test-coverage.bats parser smoke (the Windows backstop for the
# vitest parse-coverage-xml suite, which skips when no interpreter resolves).
#
# Contract: a class at 100% line coverage lists NO missed lines, and only
# fully-uncovered lines (ci==0) are reported — never partially-covered ones
# (mi>0 AND ci>0). Gated on a usable interpreter (Windows runners may expose
# `python` rather than `python3`).

BeforeAll {
    $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:Parser   = Join-Path $script:RepoRoot 'scripts\lib\parse-coverage-xml.py'

    function script:Get-PythonExe {
        foreach ($exe in @('python3', 'python')) {
            if ($null -eq (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
            try {
                $ver = & $exe --version 2>&1
                if ($LASTEXITCODE -eq 0 -and "$ver" -match 'Python \d') { return $exe }
            } catch { }
        }
        return $null
    }
    $script:Python = script:Get-PythonExe
}

Describe 'parse-coverage-xml.py report-mode missed-line column' {
    It 'lists no missed lines for a 100% file and excludes partially-covered lines' {
        if ($null -eq $script:Python) {
            Set-ItResult -Skipped -Because 'no python3/python interpreter available'
            return
        }

        $xml = @'
<?xml version="1.0" encoding="UTF-8"?>
<report name="t">
  <package name="com/example">
    <sourcefile name="Full.kt">
      <line nr="10" mi="0" ci="3"/>
      <line nr="11" mi="2" ci="5"/>
      <counter type="LINE" missed="0" covered="2"/>
    </sourcefile>
    <sourcefile name="Partial.kt">
      <line nr="20" mi="0" ci="4"/>
      <line nr="21" mi="3" ci="2"/>
      <line nr="22" mi="4" ci="0"/>
      <counter type="LINE" missed="1" covered="2"/>
    </sourcefile>
  </package>
</report>
'@
        $tmp = New-TemporaryFile
        try {
            Set-Content -Path $tmp -Value $xml -Encoding ASCII
            $out = & $script:Python $script:Parser $tmp.FullName ':app'
            $LASTEXITCODE | Should -Be 0
            $joined = ($out -join "`n")
            # Full.kt at 100% ends with an empty missed-lines field.
            $joined | Should -Match 'Full\.kt\|Full\|2\|0\|2\|100\.0\|'
            # Partial.kt reports only the fully-missed line 22, not the partial 21.
            $joined | Should -Match 'Partial\.kt\|Partial\|2\|1\|3\|66\.7\|22'
            $joined | Should -Not -Match '\|21,22'
        } finally {
            Remove-Item -Force $tmp -ErrorAction SilentlyContinue
        }
    }
}
