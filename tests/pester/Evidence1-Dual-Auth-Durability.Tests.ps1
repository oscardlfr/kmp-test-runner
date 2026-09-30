#Requires -Modules Pester

BeforeAll {
  $script:RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
  $script:GuestRunner = Join-Path $script:RepoRoot 'docs\audits\evidence1-guest-dual-auth-canary.ps1'
  $script:Phrase = 'AUTORIZO EXACTAMENTE 2 SESIONES REMOTE-AUTH CANARY PARA ' + ('EVIDENCE' + '1') + ': 1 CLAUDE-CODE Y 1 CODEX-CLI; SIN REINTENTOS, REEMPLAZOS NI RESPAWNS.'
  $script:VMName = 'Evidence1-Runner-E2E'
  $script:VMId = '00000000-0000-4000-8000-000000000001'
  $script:Node = (Get-Command node.exe -ErrorAction Stop).Source

  function New-FakeRuntimeSet([string]$Root, [switch]$HangingClaude) {
    [void](New-Item -ItemType Directory -Force -Path $Root)
    $claudeJs = Join-Path $Root 'fake-claude.js'
    $codexJs = Join-Path $Root 'fake-codex.js'
    $claudeCmd = Join-Path $Root 'claude.cmd'
    $codexCmd = Join-Path $Root 'codex.cmd'
    $claudeCount = Join-Path $Root 'claude-count.txt'
    $codexCount = Join-Path $Root 'codex-count.txt'
    $stdinProof = Join-Path $Root 'claude-stdin-ok.txt'
    $childPids = Join-Path $Root 'child-pids.txt'
    if ($HangingClaude) {
      Set-Content -LiteralPath $claudeJs -Encoding UTF8 -Value @'
const fs = require('fs');
const { spawn } = require('child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
fs.appendFileSync(process.env.E1_FAKE_CHILD_PIDS, `${child.pid}\n`);
setInterval(()=>{}, 1000);
'@
    } else {
      Set-Content -LiteralPath $claudeJs -Encoding UTF8 -Value @'
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.E1_FAKE_CLAUDE_COUNT, '1\n');
if (args[0] === '--version') {
  if (process.env.E1_FAKE_CLAUDE_VERSION_ORPHAN === '1') {
    const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { detached: true, stdio: 'ignore' });
    child.unref();
    fs.appendFileSync(process.env.E1_FAKE_CHILD_PIDS, `${child.pid}\n`);
  }
  console.log('2.1.238 (Claude Code)');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') process.exit(0);
if (args.some(v => v.includes('AUTH_CANARY_OK'))) process.exit(91);
if (process.env.E1_FAKE_CLAUDE_DISPATCH_HANG === '1') {
  const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
  fs.appendFileSync(process.env.E1_FAKE_CHILD_PIDS, `${child.pid}\n`);
  setInterval(()=>{}, 1000);
  return;
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  input = input.replace(/^\uFEFF/, '');
  if (input !== 'This is a deterministic response-format check in an isolated evaluation. Do not access files or invoke tools. Respond with the exact text AUTH_CANARY_OK and nothing else.') process.exit(92);
  fs.writeFileSync(process.env.E1_FAKE_STDIN_PROOF, 'stdin');
  if (process.env.E1_FAKE_CLAUDE_HTTP_STATUS) {
    console.log(JSON.stringify({type:'system',subtype:'api_retry',error_status:process.env.E1_FAKE_CLAUDE_HTTP_STATUS}));
  }
  console.log(JSON.stringify({type:'system',subtype:'init',model:'claude-sonnet-5'}));
  console.log(JSON.stringify({type:'result', is_error:false, result:'AUTH_CANARY_OK'}));
  const rateLimitEvent = {
    type:'rate_limit_event',
    rate_limit_info:{status:'allowed',resetsAt:1774918800,rateLimitType:'five_hour',isUsingOverage:false},
    uuid:'11111111-1111-4111-8111-111111111111',
    session_id:'22222222-2222-4222-8222-222222222222'
  };
  if (process.env.E1_FAKE_CLAUDE_RATE_LIMIT_INVALID === '1') rateLimitEvent.raw = 'forbidden';
  if (process.env.E1_FAKE_CLAUDE_RATE_LIMIT_NEW_INFO_FIELD === '1') rateLimitEvent.rate_limit_info.weeklyOpusUtilization = 12;
  console.log(JSON.stringify(rateLimitEvent));
});
'@
    }
    Set-Content -LiteralPath $codexJs -Encoding UTF8 -Value @'
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.E1_FAKE_CODEX_COUNT, '1\n');
if (args[0] === '--version') { console.log('codex-cli 0.154.0'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') process.exit(0);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  input = input.replace(/^\uFEFF/, '');
  if (input !== 'This is a deterministic response-format check in an isolated evaluation. Do not access files or invoke tools. Respond with the exact text AUTH_CANARY_OK and nothing else.') process.exit(93);
  console.log(JSON.stringify({type:'thread.started', thread_id:'sanitized'}));
  if (process.env.E1_FAKE_CODEX_ERROR === '1') {
    console.log(JSON.stringify({type:'turn.started'}));
    console.log(JSON.stringify({type:'item.completed', item:{id:'e1',type:'error',text:'not persisted'}}));
    console.log(JSON.stringify({type:'error', message:'opaque provider failure'}));
    console.log(JSON.stringify({type:'turn.failed', error:{code:'account_ineligible',message:'not persisted'}}));
    process.exit(1);
  }
  console.log(JSON.stringify({type:'item.completed', item:{id:'m1',type:'agent_message',text:'AUTH_CANARY_OK'}}));
  console.log(JSON.stringify({type:'turn.completed', usage:{input_tokens:1,output_tokens:1}}));
});
'@
    Set-Content -LiteralPath $claudeCmd -Encoding ASCII -Value "@echo off`r`n`"$script:Node`" `"$claudeJs`" %*`r`nexit /b %errorlevel%"
    Set-Content -LiteralPath $codexCmd -Encoding ASCII -Value "@echo off`r`n`"$script:Node`" `"$codexJs`" %*`r`nexit /b %errorlevel%"
    return [ordered]@{
      Claude = $claudeCmd; Codex = $codexCmd; ClaudeCount = $claudeCount; CodexCount = $codexCount
      StdinProof = $stdinProof; ChildPids = $childPids
    }
  }

  function Invoke-FakeDualCanary([string]$Root, [string]$OperationId, $Fakes, [int]$FaultAfterSlot = 0,
    [int]$PreflightTimeoutSeconds = 5) {
    $readiness = Join-Path $Root 'READINESS.json'
    if (-not (Test-Path -LiteralPath $readiness)) {
      [IO.File]::WriteAllText($readiness, '{"generated_at_utc":"2026-09-11T10:00:00.000Z"}', [Text.UTF8Encoding]::new($false))
    }
    $env:E1_FAKE_CLAUDE_COUNT = $Fakes.ClaudeCount
    $env:E1_FAKE_CODEX_COUNT = $Fakes.CodexCount
    $env:E1_FAKE_STDIN_PROOF = $Fakes.StdinProof
    $env:E1_FAKE_CHILD_PIDS = $Fakes.ChildPids
    $wire = & $script:GuestRunner -OperationId $OperationId -OperationRoot (Join-Path $Root 'operations') `
      -GuestReadinessPath $readiness -HostReadinessSha256 ('a' * 64) `
      -HostReadinessGeneratedAtUtc '2026-09-11T10:00:00.000Z' -AuthorizationPhrase $script:Phrase `
      -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId `
      -ClaudeCommand $Fakes.Claude -CodexCommand $Fakes.Codex -TestMode `
      -PreflightTimeoutSeconds $PreflightTimeoutSeconds -DispatchTimeoutSeconds 5 -TestFaultAfterSlot $FaultAfterSlot
    if ($null -eq $wire) { return $null }
    return ([string]$wire | ConvertFrom-Json -ErrorAction Stop)
  }

  function Get-LineCount([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    return @(Get-Content -LiteralPath $Path).Count
  }

  function Get-TestSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
      $sha = [Security.Cryptography.SHA256]::Create()
      try { return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '') }
      finally { $sha.Dispose() }
    } finally { $stream.Dispose() }
  }
}

Describe 'Evidence1 durable dual-auth operation' {
  AfterEach {
    foreach ($name in @('E1_FAKE_CLAUDE_COUNT','E1_FAKE_CODEX_COUNT','E1_FAKE_STDIN_PROOF','E1_FAKE_CHILD_PIDS',
        'E1_FAKE_CLAUDE_HTTP_STATUS','E1_FAKE_CLAUDE_DISPATCH_HANG','E1_FAKE_CLAUDE_VERSION_ORPHAN',
        'E1_FAKE_CLAUDE_RATE_LIMIT_INVALID','E1_FAKE_CLAUDE_RATE_LIMIT_NEW_INFO_FIELD','E1_FAKE_CODEX_ERROR')) {
      Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
  }

  It 'claims once, dispatches one slot per provider, uses Claude stdin, and never overwrites final evidence' {
    $root = Join-Path $TestDrive 'success'
    $fakes = New-FakeRuntimeSet (Join-Path $root 'fakes')
    $operation = '11111111-1111-4111-8111-111111111111'
    $result = Invoke-FakeDualCanary $root $operation $fakes
    $result.state | Should -Be 'passed'
    $result.providers[0].event_type_counts.rate_limit_event | Should -Be 1
    (Get-LineCount $fakes.ClaudeCount) | Should -Be 3
    (Get-LineCount $fakes.CodexCount) | Should -Be 3
    (Get-Content -LiteralPath $fakes.StdinProof -Raw) | Should -Be 'stdin'
    $operationPath = Join-Path (Join-Path $root 'operations') $operation
    foreach ($name in @('claim.json','slot-1.claim.json','slot-1.result.json','slot-2.claim.json','slot-2.result.json','final.json')) {
      Test-Path -LiteralPath (Join-Path $operationPath $name) | Should -BeTrue
    }
    @(Get-ChildItem -LiteralPath $operationPath -Filter '*.process-claim.json' -File).Count | Should -Be 6
    @(Get-ChildItem -LiteralPath $operationPath -Filter '*.process.json' -File).Count | Should -Be 6
    @(Get-ChildItem -LiteralPath $operationPath -Filter '*.process-dispatch.json' -File).Count | Should -Be 6
    @(Get-ChildItem -LiteralPath $operationPath -Filter '*.process-cleanup.json' -File).Count | Should -Be 6
    $finalHash = Get-TestSha256 (Join-Path $operationPath 'final.json')
    { Invoke-FakeDualCanary $root $operation $fakes } | Should -Throw
    (Get-LineCount $fakes.ClaudeCount) | Should -Be 3
    (Get-LineCount $fakes.CodexCount) | Should -Be 3
    (Get-TestSha256 (Join-Path $operationPath 'final.json')) | Should -Be $finalHash
  }

  It 'does not permit the same authorization scope to replay under a different operation id' {
    $root = Join-Path $TestDrive 'scope-replay'
    $fakes = New-FakeRuntimeSet (Join-Path $root 'fakes')
    $first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    $second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    (Invoke-FakeDualCanary $root $first $fakes).state | Should -Be 'passed'
    $claudeBefore = Get-LineCount $fakes.ClaudeCount
    $codexBefore = Get-LineCount $fakes.CodexCount
    { Invoke-FakeDualCanary $root $second $fakes } | Should -Throw
    (Get-LineCount $fakes.ClaudeCount) | Should -Be $claudeBefore
    (Get-LineCount $fakes.CodexCount) | Should -Be $codexBefore
    Test-Path -LiteralPath (Join-Path (Join-Path (Join-Path $root 'operations') $second) 'claim.json') | Should -BeFalse
  }

  It 'leaves slot one consumed after a crash and a relaunch dispatches nothing' {
    $root = Join-Path $TestDrive 'crash'
    $fakes = New-FakeRuntimeSet (Join-Path $root 'fakes')
    $operation = '22222222-2222-4222-8222-222222222222'
    { Invoke-FakeDualCanary $root $operation $fakes 1 } | Should -Throw '*test_fault_after_slot_1*'
    $operationPath = Join-Path (Join-Path $root 'operations') $operation
    Test-Path -LiteralPath (Join-Path $operationPath 'slot-1.claim.json') | Should -BeTrue
    Test-Path -LiteralPath (Join-Path $operationPath 'slot-2.claim.json') | Should -BeFalse
    Test-Path -LiteralPath (Join-Path $operationPath 'final.json') | Should -BeFalse
    $claudeBefore = Get-LineCount $fakes.ClaudeCount; $codexBefore = Get-LineCount $fakes.CodexCount
    { Invoke-FakeDualCanary $root $operation $fakes } | Should -Throw
    (Get-LineCount $fakes.ClaudeCount) | Should -Be $claudeBefore
    (Get-LineCount $fakes.CodexCount) | Should -Be $codexBefore
  }

  It 'bounds a hung process and confirms cleanup of its owned descendant' {
    $root = Join-Path $TestDrive 'timeout'
    $fakes = New-FakeRuntimeSet (Join-Path $root 'fakes') -HangingClaude
    $operation = '33333333-3333-4333-8333-333333333333'
    try {
      { Invoke-FakeDualCanary $root $operation $fakes 0 1 } | Should -Throw '*bounded_local_auth_preflight_failed*'
      $pids = @(Get-Content -LiteralPath $fakes.ChildPids | ForEach-Object { [int]$_ })
      $pids.Count | Should -BeGreaterThan 0
      foreach ($childPid in $pids) { Get-Process -Id $childPid -ErrorAction SilentlyContinue | Should -BeNullOrEmpty }
    } finally {
      if (Test-Path -LiteralPath $fakes.ChildPids) {
        foreach ($childPid in @(Get-Content -LiteralPath $fakes.ChildPids)) { Stop-Process -Id ([int]$childPid) -Force -ErrorAction SilentlyContinue }
      }
    }
  }

  It 'kills a descendant when its successful root exits before cleanup observes it' {
    $root = Join-Path $TestDrive 'orphan-after-root-exit'
    $fakes = New-FakeRuntimeSet (Join-Path $root 'fakes')
    $operation = '66666666-6666-4666-8666-666666666666'
    $env:E1_FAKE_CLAUDE_VERSION_ORPHAN = '1'
    try {
      (Invoke-FakeDualCanary $root $operation $fakes).state | Should -Be 'passed'
      $pids = @(Get-Content -LiteralPath $fakes.ChildPids | ForEach-Object { [int]$_ })
      $pids.Count | Should -Be 1
      foreach ($childPid in $pids) {
        Get-Process -Id $childPid -ErrorAction SilentlyContinue | Should -BeNullOrEmpty
      }
      $processRecord = Get-Content -LiteralPath (Join-Path (Join-Path (Join-Path $root 'operations') $operation) 'preflight-claude-version.process.json') -Raw | ConvertFrom-Json
      $processRecord.job_object_kill_on_close | Should -BeTrue
      $processRecord.job_assignment_confirmed | Should -BeTrue
    } finally {
      if (Test-Path -LiteralPath $fakes.ChildPids) {
        foreach ($childPid in @(Get-Content -LiteralPath $fakes.ChildPids)) { Stop-Process -Id ([int]$childPid) -Force -ErrorAction SilentlyContinue }
      }
    }
  }

  It 'stops after adulterated Claude HTTP telemetry and never claims or starts slot two' {
    $root = Join-Path $TestDrive 'slot-one-safety'
    $fakes = New-FakeRuntimeSet (Join-Path $root 'fakes')
    $operation = '44444444-4444-4444-8444-444444444444'
    $env:E1_FAKE_CLAUDE_HTTP_STATUS = '418'
    { Invoke-FakeDualCanary $root $operation $fakes } | Should -Throw '*slot_1_safety_incomplete*'
    $operationPath = Join-Path (Join-Path $root 'operations') $operation
    Test-Path -LiteralPath (Join-Path $operationPath 'slot-1.claim.json') | Should -BeTrue
    Test-Path -LiteralPath (Join-Path $operationPath 'slot-1.result.json') | Should -BeTrue
    Test-Path -LiteralPath (Join-Path $operationPath 'slot-2.claim.json') | Should -BeFalse
    Test-Path -LiteralPath (Join-Path $operationPath 'slot-2.process.json') | Should -BeFalse
    $provider = Get-Content -LiteralPath (Join-Path $operationPath 'slot-1.result.json') -Raw | ConvertFrom-Json
    @($provider.http_statuses).Count | Should -Be 0
    $provider.event_type_counts.unknown | Should -Be 1
    (Get-LineCount $fakes.ClaudeCount) | Should -Be 3
    (Get-LineCount $fakes.CodexCount) | Should -Be 2
    $terminal = Get-Content -LiteralPath (Join-Path $operationPath 'terminal-incomplete.json') -Raw | ConvertFrom-Json
    $terminal.state | Should -Be 'incomplete'
    $terminal.claimed_sessions | Should -Be 1
    $terminal.dispatched_sessions | Should -Be 1
    $terminal.process_tree_cleanup_confirmed | Should -BeTrue
  }

  It 'rejects a rate-limit event that carries fields outside the closed telemetry shape' {
    $root = Join-Path $TestDrive 'invalid-rate-limit-event'
    $fakes = New-FakeRuntimeSet (Join-Path $root 'fakes')
    $operation = '77777777-7777-4777-8777-777777777777'
    $env:E1_FAKE_CLAUDE_RATE_LIMIT_INVALID = '1'
    { Invoke-FakeDualCanary $root $operation $fakes } | Should -Throw '*slot_1_safety_incomplete*'
    $operationPath = Join-Path (Join-Path $root 'operations') $operation
    $provider = Get-Content -LiteralPath (Join-Path $operationPath 'slot-1.result.json') -Raw | ConvertFrom-Json
    $provider.event_type_counts.rate_limit_event | Should -Be 1
    $provider.event_type_counts.unknown | Should -Be 1
    Test-Path -LiteralPath (Join-Path $operationPath 'slot-2.claim.json') | Should -BeFalse
    (Get-LineCount $fakes.CodexCount) | Should -Be 2
  }

  It 'tolerates a new rate_limit_info metadata field as ordinary API evolution' {
    $root = Join-Path $TestDrive 'new-rate-limit-info-field'
    $fakes = New-FakeRuntimeSet (Join-Path $root 'fakes')
    $operation = '88888888-8888-4888-8888-888888888888'
    $env:E1_FAKE_CLAUDE_RATE_LIMIT_NEW_INFO_FIELD = '1'
    $result = Invoke-FakeDualCanary $root $operation $fakes
    $result.state | Should -Be 'passed'
    $result.providers[0].event_type_counts.rate_limit_event | Should -Be 1
    $result.providers[0].event_type_counts.unknown | Should -Be 0
  }

  It 'classifies Codex provider failures without treating error items as tools' {
    $root = Join-Path $TestDrive 'codex-provider-error'
    $fakes = New-FakeRuntimeSet (Join-Path $root 'fakes')
    $operation = '88888888-8888-4888-8888-888888888888'
    $env:E1_FAKE_CODEX_ERROR = '1'
    $result = Invoke-FakeDualCanary $root $operation $fakes
    $result.state | Should -Be 'failed'
    $provider = $result.providers[1]
    $provider.reason_code | Should -BeExactly 'provider_code_account_ineligible'
    $provider.tool_invocation_count | Should -Be 0
    $provider.process_tree_cleanup_confirmed | Should -BeTrue
  }

  It 'requires an origin abort acknowledgement before cleanup declares quiescence' {
    $root = Join-Path $TestDrive 'outer-timeout-race'
    $fakes = New-FakeRuntimeSet (Join-Path $root 'fakes')
    $operation = '55555555-5555-4555-8555-555555555555'
    $readiness = Join-Path $root 'READINESS.json'
    [IO.File]::WriteAllText($readiness, '{"generated_at_utc":"2026-09-11T10:00:00.000Z"}', [Text.UTF8Encoding]::new($false))
    $env:E1_FAKE_CLAUDE_COUNT = $fakes.ClaudeCount
    $env:E1_FAKE_CODEX_COUNT = $fakes.CodexCount
    $env:E1_FAKE_STDIN_PROOF = $fakes.StdinProof
    $env:E1_FAKE_CHILD_PIDS = $fakes.ChildPids
    $env:E1_FAKE_CLAUDE_DISPATCH_HANG = '1'
    $job = Start-Job -ScriptBlock {
      param($Runner, $Operation, $Root, $Readiness, $Phrase, $VMName, $VMId, $Claude, $Codex, $ClaudeCount, $CodexCount, $StdinProof, $ChildPids)
      $env:E1_FAKE_CLAUDE_COUNT = $ClaudeCount
      $env:E1_FAKE_CODEX_COUNT = $CodexCount
      $env:E1_FAKE_STDIN_PROOF = $StdinProof
      $env:E1_FAKE_CHILD_PIDS = $ChildPids
      $env:E1_FAKE_CLAUDE_DISPATCH_HANG = '1'
      & $Runner -OperationId $Operation -OperationRoot (Join-Path $Root 'operations') `
        -GuestReadinessPath $Readiness -HostReadinessSha256 ('a' * 64) `
        -HostReadinessGeneratedAtUtc '2026-09-11T10:00:00.000Z' -AuthorizationPhrase $Phrase `
        -ExpectedVMName $VMName -ExpectedVMId $VMId `
        -ClaudeCommand $Claude -CodexCommand $Codex -TestMode -PreflightTimeoutSeconds 5 -DispatchTimeoutSeconds 3
    } -ArgumentList $script:GuestRunner, $operation, $root, $readiness, $script:Phrase, $script:VMName, $script:VMId, $fakes.Claude, $fakes.Codex,
      $fakes.ClaudeCount, $fakes.CodexCount, $fakes.StdinProof, $fakes.ChildPids
    try {
      $processPath = Join-Path (Join-Path (Join-Path $root 'operations') $operation) 'slot-1.process.json'
      $deadline = [DateTime]::UtcNow.AddSeconds(15)
      while ((-not (Test-Path -LiteralPath $processPath) -or -not (Test-Path -LiteralPath $fakes.ChildPids)) -and
        [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
      Test-Path -LiteralPath $processPath | Should -BeTrue
      Test-Path -LiteralPath $fakes.ChildPids | Should -BeTrue
      $abort = & $script:GuestRunner -OperationId $operation -OperationRoot (Join-Path $root 'operations') `
        -GuestReadinessPath $readiness -HostReadinessSha256 ('a' * 64) `
        -HostReadinessGeneratedAtUtc '2026-09-11T10:00:00.000Z' -AuthorizationPhrase $script:Phrase `
        -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId `
        -ClaudeCommand $fakes.Claude -CodexCommand $fakes.Codex -TestMode -AbortOperation $true
      $abort.abort_claimed | Should -BeTrue
      $abort.abort_acknowledged | Should -BeTrue
      $abort.cleanup_confirmed | Should -BeTrue
      Test-Path -LiteralPath (Join-Path (Split-Path -Parent $processPath) 'abort.claim.json') | Should -BeTrue
      Test-Path -LiteralPath (Join-Path (Split-Path -Parent $processPath) 'abort.ack.json') | Should -BeTrue
      $null = Wait-Job -Job $job -Timeout 15
      $job.State | Should -BeIn @('Completed', 'Failed')
      $cleanup = & $script:GuestRunner -OperationId $operation -OperationRoot (Join-Path $root 'operations') `
        -GuestReadinessPath $readiness -HostReadinessSha256 ('a' * 64) `
        -HostReadinessGeneratedAtUtc '2026-09-11T10:00:00.000Z' -AuthorizationPhrase $script:Phrase `
        -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId `
        -ClaudeCommand $fakes.Claude -CodexCommand $fakes.Codex -TestMode `
        -CleanupOperation $true -CleanupOriginStoppedConfirmed $true
      $cleanup.cleanup_confirmed | Should -BeTrue
      $cleanup.quiescence_confirmed | Should -BeTrue
      Test-Path -LiteralPath (Join-Path (Split-Path -Parent $processPath) 'slot-2.claim.json') | Should -BeFalse
      foreach ($childPid in @(Get-Content -LiteralPath $fakes.ChildPids)) {
        Get-Process -Id ([int]$childPid) -ErrorAction SilentlyContinue | Should -BeNullOrEmpty
      }
    } finally {
      Stop-Job -Job $job -ErrorAction SilentlyContinue
      Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $fakes.ChildPids) {
        foreach ($childPid in @(Get-Content -LiteralPath $fakes.ChildPids)) { Stop-Process -Id ([int]$childPid) -Force -ErrorAction SilentlyContinue }
      }
    }
  }

  It 'does not treat an absent root pid as clean without cleanup or abort acknowledgement' {
    $root = Join-Path $TestDrive 'missing-cleanup-proof'
    $fakes = New-FakeRuntimeSet (Join-Path $root 'fakes')
    $operation = '77777777-7777-4777-8777-777777777777'
    $readiness = Join-Path $root 'READINESS.json'
    [IO.File]::WriteAllText($readiness, '{"generated_at_utc":"2026-09-11T10:00:00.000Z"}', [Text.UTF8Encoding]::new($false))
    $job = Start-Job -ScriptBlock {
      param($Runner, $Operation, $Root, $Readiness, $Phrase, $VMName, $VMId, $Claude, $Codex, $ClaudeCount, $CodexCount, $StdinProof, $ChildPids)
      $env:E1_FAKE_CLAUDE_COUNT = $ClaudeCount; $env:E1_FAKE_CODEX_COUNT = $CodexCount
      $env:E1_FAKE_STDIN_PROOF = $StdinProof; $env:E1_FAKE_CHILD_PIDS = $ChildPids
      $env:E1_FAKE_CLAUDE_DISPATCH_HANG = '1'
      & $Runner -OperationId $Operation -OperationRoot (Join-Path $Root 'operations') `
        -GuestReadinessPath $Readiness -HostReadinessSha256 ('a' * 64) `
        -HostReadinessGeneratedAtUtc '2026-09-11T10:00:00.000Z' -AuthorizationPhrase $Phrase `
        -ExpectedVMName $VMName -ExpectedVMId $VMId `
        -ClaudeCommand $Claude -CodexCommand $Codex -TestMode -PreflightTimeoutSeconds 5 -DispatchTimeoutSeconds 30
    } -ArgumentList $script:GuestRunner, $operation, $root, $readiness, $script:Phrase, $script:VMName, $script:VMId, $fakes.Claude, $fakes.Codex,
      $fakes.ClaudeCount, $fakes.CodexCount, $fakes.StdinProof, $fakes.ChildPids
    try {
      $deadline = [DateTime]::UtcNow.AddSeconds(15)
      while (-not (Test-Path -LiteralPath $fakes.ChildPids) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
      Test-Path -LiteralPath $fakes.ChildPids | Should -BeTrue
      Stop-Job -Job $job -ErrorAction SilentlyContinue
      $cleanup = & $script:GuestRunner -OperationId $operation -OperationRoot (Join-Path $root 'operations') `
        -GuestReadinessPath $readiness -HostReadinessSha256 ('a' * 64) `
        -HostReadinessGeneratedAtUtc '2026-09-11T10:00:00.000Z' -AuthorizationPhrase $script:Phrase `
        -ExpectedVMName $script:VMName -ExpectedVMId $script:VMId `
        -ClaudeCommand $fakes.Claude -CodexCommand $fakes.Codex -TestMode `
        -CleanupOperation $true -CleanupOriginStoppedConfirmed $true
      $cleanup.cleanup_confirmed | Should -BeFalse
      $cleanup.reason_code | Should -Be 'process_tree_cleanup_failed'
    } finally {
      Stop-Job -Job $job -ErrorAction SilentlyContinue
      Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath $fakes.ChildPids) {
        foreach ($childPid in @(Get-Content -LiteralPath $fakes.ChildPids)) { Stop-Process -Id ([int]$childPid) -Force -ErrorAction SilentlyContinue }
      }
    }
  }
}
