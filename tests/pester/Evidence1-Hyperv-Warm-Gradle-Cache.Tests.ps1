# WO-08: the canonical Gradle cache warm takes its task list from the caller (-TaskList) and may run each of its
# two phases for up to 50 minutes. The script needs elevation and the Hyper-V host, so these tests run the part
# that handles its own arguments: everything before the script asks for the VM identity, with the #Requires and
# Import-Module lines dropped and the identity call replaced by a throw that reports the task list the script
# would go on with.
BeforeAll {
    $script:RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $script:WarmScript = Join-Path $script:RepoRoot 'docs/audits/evidence1-hyperv-warm-canonical-gradle-cache-direct.ps1'
    $script:WarmText = [IO.File]::ReadAllText($script:WarmScript)
    $script:OldTasks = ':core:domain:test,:core:domain:createDemoDebugUnitTestCoverageReport,:core:domain:createProdDebugUnitTestCoverageReport'
    $script:Phrase = 'authorize bounded canonical gradle cache warm and offline certification'

    # Returns what the argument handling ended with: 'tasks=<comma list>' once every check passed, or the
    # script's own error code.
    function script:Invoke-WarmArgumentHandling([hashtable]$Overrides = @{}) {
        $lines = $script:WarmText -split "`r?`n"
        $identityIndex = -1
        for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i].StartsWith('$identity=Get-Evidence1CanonicalE2EVmIdentity')) { $identityIndex = $i; break } }
        if ($identityIndex -lt 1) { throw 'test setup: the identity call was not found in the warm script' }
        $kept = @($lines[0..($identityIndex - 1)] | Where-Object { $_ -notmatch '^#Requires' -and $_ -notmatch '^Import-Module ' })
        $source = ($kept -join "`n") + "`n" + 'throw (''tasks='' + (@($tasks) -join '',''))'
        $parameters = @{
            ProfilePath = 'C:\kmp-eval\profile.json'; CreatedInspectionReceiptPath = 'C:\kmp-eval\receipt.json'
            GuestCredentialPath = 'C:\kmp-eval\guest-credential.clixml'; OperationId = [guid]::NewGuid().ToString()
            AuthorizationPhrase = $script:Phrase
        }
        foreach ($key in $Overrides.Keys) { $parameters[$key] = $Overrides[$key] }
        try { & ([scriptblock]::Create($source)) @parameters } catch { return [string]$_.Exception.Message }
        return 'no throw'
    }
}

Describe 'the warm script''s task list' {
    It 'is still the three core:domain tasks without -TaskList' {
        Invoke-WarmArgumentHandling | Should -BeExactly "tasks=$($script:OldTasks)"
    }

    It 'keeps today''s literal task line unchanged, so the ops toolkit''s own assertions on it stay true' {
        $script:WarmText | Should -Match ([regex]::Escape('$tasks=@('':core:domain:test'','':core:domain:createDemoDebugUnitTestCoverageReport'','':core:domain:createProdDebugUnitTestCoverageReport'')'))
    }

    It 'is replaced by -TaskList, trimmed, with empty entries dropped' {
        $result = Invoke-WarmArgumentHandling @{ TaskList = ' :core:common:test, :core:data:testDemoDebugUnitTest ,,:lint:test ' }
        $result | Should -BeExactly 'tasks=:core:common:test,:core:data:testDemoDebugUnitTest,:lint:test'
    }

    It 'takes a single task' {
        Invoke-WarmArgumentHandling @{ TaskList = ':core:data:testDemoDebugUnitTest' } | Should -BeExactly 'tasks=:core:data:testDemoDebugUnitTest'
    }

    It 'takes the whole 96-task list of a real scenario in one string' {
        $tasks = @(1..96 | ForEach-Object { ":module$_`:testDemoDebugUnitTest" })
        Invoke-WarmArgumentHandling @{ TaskList = ($tasks -join ',') } | Should -BeExactly ('tasks=' + ($tasks -join ','))
    }

    It 'rejects an entry that is not a Gradle task path' {
        foreach ($bad in @('core:common:test', ':core:common:test;calc', ':core:common:test x', ':core::test', ':', '::', ':core:common/test', ':core:common:te$st', ':core:common:test,evil')) {
            Invoke-WarmArgumentHandling @{ TaskList = $bad } | Should -BeExactly 'gradle_cache_task_list_invalid' -Because "list: $bad"
        }
    }

    It 'rejects a list that has no entry once separators and blanks are dropped' {
        foreach ($blank in @(',', ' , ,, ', ' ')) {
            Invoke-WarmArgumentHandling @{ TaskList = $blank } | Should -BeExactly 'gradle_cache_task_list_invalid' -Because "list: '$blank'"
        }
    }
}

Describe 'the warm script''s per-phase time limit' {
    It 'accepts 10 and 50 minutes and everything between, and the 20 minute default' {
        foreach ($minutes in @(10, 20, 30, 31, 50)) {
            Invoke-WarmArgumentHandling @{ TimeoutMinutes = $minutes } | Should -BeExactly "tasks=$($script:OldTasks)" -Because "$minutes minutes"
        }
        Invoke-WarmArgumentHandling | Should -BeExactly "tasks=$($script:OldTasks)"
    }

    It 'rejects 51 minutes and anything above' {
        foreach ($minutes in @(51, 60, 1000)) {
            Invoke-WarmArgumentHandling @{ TimeoutMinutes = $minutes } | Should -BeExactly 'gradle_cache_timeout_invalid' -Because "$minutes minutes"
        }
    }

    It 'keeps the 10 minute minimum' {
        foreach ($minutes in @(9, 1, 0, -5)) {
            Invoke-WarmArgumentHandling @{ TimeoutMinutes = $minutes } | Should -BeExactly 'gradle_cache_timeout_invalid' -Because "$minutes minutes"
        }
    }

    It 'bounds each of the two phases by the same value, so two phases fit under the runner''s 7500 s child cap' {
        # 2 x 50 min + overhead stays under 7500 s only if the cap is the per-phase value: the same TimeoutMinutes
        # feeds both Invoke-Command phases and the host watchdog.
        ([regex]::Matches($script:WarmText, [regex]::Escape('$TimeoutMinutes'))).Count | Should -BeGreaterOrEqual 5
        $script:WarmText | Should -Match ([regex]::Escape("'warm',`$false,`$SourceDir,`$sourceCommit,`$tasks,`$TimeoutMinutes"))
        $script:WarmText | Should -Match ([regex]::Escape("'certify',`$true,`$SourceDir,`$sourceCommit,`$tasks,`$TimeoutMinutes"))
    }
}

Describe 'the warm script''s other checks still apply' {
    It 'rejects an operation id that is not a GUID' {
        Invoke-WarmArgumentHandling @{ OperationId = 'not-a-guid' } | Should -BeExactly 'gradle_cache_operation_id_invalid'
    }

    It 'rejects the wrong authorization phrase' {
        Invoke-WarmArgumentHandling @{ AuthorizationPhrase = 'please' } | Should -BeExactly 'gradle_cache_authorization_required'
    }

    It 'rejects a source directory other than the canonical template' {
        Invoke-WarmArgumentHandling @{ SourceDir = 'C:\kmp-eval\other' } | Should -BeExactly 'gradle_cache_source_path_invalid'
    }
}
