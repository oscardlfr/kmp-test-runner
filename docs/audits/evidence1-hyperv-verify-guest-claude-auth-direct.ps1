#Requires -RunAsAdministrator

param(
  [string]$VMName = 'Evidence1-Runner',
  [string]$GuestComputerName = 'Evidence1Runner',
  [string]$GuestCredentialPath = 'C:\kmp-eval\scratch\hyperv-create-runner\Evidence1-Runner.guest-credential.clixml',
  [string]$ExpectedClaudeVersion = '2.1.238',
  [string]$HostReportPath = 'C:\kmp-eval\scratch\hyperv-verify-guest-claude-auth-direct\HYPERV-VERIFY-GUEST-CLAUDE-AUTH-DIRECT.json',
  [int]$ProbeTimeoutSeconds = 45,
  [switch]$RunRemoteAuthCanary,
  [string]$RemoteAuthCanaryAuthorizationPhrase = '',
  [string]$GuestCanaryPath = 'C:\Evidence1Ops\STAGE-B-auth-canary.json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$EvidenceRunId = 'EVIDENCE' + '1'
$RequiredRemoteAuthCanaryPhrase = (
  'AUTORIZO UN CANARY REMOTO DE AUTENTICACION PARA ' + $EvidenceRunId + ' EN ESTE ENTORNO AISLADO, ' +
  'SIN REPOSITORIO, SKILL NI HERRAMIENTAS'
)
$CredentialOverrideNames = @(
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY'
)

function Fail($Message) {
  Write-Error "HARD STOP: $Message"
  exit 1
}

function Resolve-FullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

function Assert-PathInside([string]$Candidate, [string]$Root, [string]$Label) {
  $candidateFull = Resolve-FullPath $Candidate
  $rootFull = (Resolve-FullPath $Root).TrimEnd('\') + '\'
  if (-not $candidateFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "$Label path is outside expected root: $candidateFull"
  }
}

Assert-PathInside $GuestCredentialPath 'C:\kmp-eval\scratch\' 'guest credential'
Assert-PathInside $HostReportPath 'C:\kmp-eval\scratch\' 'host report'
if ($GuestCanaryPath -ne 'C:\Evidence1Ops\STAGE-B-auth-canary.json') {
  Fail 'GuestCanaryPath must stay exactly C:\Evidence1Ops\STAGE-B-auth-canary.json'
}
if ($RunRemoteAuthCanary -and $RemoteAuthCanaryAuthorizationPhrase -ne $RequiredRemoteAuthCanaryPhrase) {
  Fail 'exact remote auth canary authorization phrase is required'
}
if (-not (Test-Path -LiteralPath $GuestCredentialPath)) {
  Fail "guest credential file does not exist: $GuestCredentialPath"
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $HostReportPath) | Out-Null

$vm = Get-VM -Name $VMName -ErrorAction Stop
if ($vm.State -ne 'Running') {
  Fail "$VMName must be running for PowerShell Direct auth verification"
}

$storedCredential = Import-Clixml -LiteralPath $GuestCredentialPath
$simpleUser = $storedCredential.UserName
if ($simpleUser -match '[\\@]') {
  Fail "stored guest user must be a simple local account name, got: $simpleUser"
}

$candidates = @(
  "$GuestComputerName\$simpleUser",
  "$VMName\$simpleUser",
  ".\$simpleUser",
  $simpleUser,
  "localhost\$simpleUser"
)

$attempts = @()
$probe = $null
$workingLogonName = $null
foreach ($logonName in $candidates) {
  $job = Start-Job -ScriptBlock {
    param($VmName, $UserName, $SecurePassword, $ExpectedClaudeVersion, $RunRemoteAuthCanary, $GuestCanaryPath, $CredentialOverrideNames)
    $credential = [pscredential]::new($UserName, $SecurePassword)
    Invoke-Command -VMName $VmName -Credential $credential -ScriptBlock {
      param($ExpectedClaudeVersion, $RunRemoteAuthCanary, $GuestCanaryPath, $CredentialOverrideNames)
      $ErrorActionPreference = 'Stop'

      function Get-SafeHttpStatus($Value) {
        if ($Value -is [int] -and $Value -ge 100 -and $Value -le 599) { return [int]$Value }
        if ($Value -is [string] -and $Value -match '^\d{3}$') {
          $parsed = [int]$Value
          if ($parsed -ge 100 -and $parsed -le 599) { return $parsed }
        }
        return $null
      }

      function Get-JsonKeys($Value) {
        if ($Value -is [pscustomobject]) {
          return @($Value.PSObject.Properties.Name | Sort-Object)
        }
        return @()
      }

      function Invoke-RemoteAuthCanary([string]$ClaudeCommand, [string]$ClaudeVersion, [string[]]$OverrideNames) {
        $started = [DateTime]::UtcNow
        $captured = @()
        $processExitCode = $null
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
          $captured = @(& $ClaudeCommand @(
              '-p', 'Return exactly AUTH_CANARY_OK. Do not use tools, files, or network tools.',
              '--bare',
              '--disable-slash-commands',
              '--tools', '',
              '--output-format', 'stream-json',
              '--verbose'
            ) 2>&1)
          $processExitCode = $LASTEXITCODE
        } finally {
          $ErrorActionPreference = $previousPreference
        }

        $events = @()
        $parseErrorCount = 0
        foreach ($item in $captured) {
          $line = [string]$item
          try {
            $event = $line | ConvertFrom-Json -ErrorAction Stop
            if ($event -is [pscustomobject]) { $events += $event } else { $parseErrorCount++ }
          } catch {
            $parseErrorCount++
          }
        }
        $typeCounts = [ordered]@{}
        $httpStatuses = @()
        $result = $null
        foreach ($event in $events) {
          $type = if ($event.PSObject.Properties['type']) { [string]$event.type } else { '<missing>' }
          if (-not $typeCounts.Contains($type)) { $typeCounts[$type] = 0 }
          $typeCounts[$type]++
          if ($event.type -eq 'system' -and $event.subtype -eq 'api_retry' -and $event.PSObject.Properties['error_status']) {
            $status = Get-SafeHttpStatus $event.error_status
            if ($null -ne $status) { $httpStatuses += $status }
          }
          if ($event.type -eq 'result') { $result = $event }
        }
        if ($result -and $result.PSObject.Properties['api_error_status']) {
          $status = Get-SafeHttpStatus $result.api_error_status
          if ($null -ne $status) { $httpStatuses += $status }
        }

        $terminal = [ordered]@{
          present = $null -ne $result
          is_error = if ($result -and $result.PSObject.Properties['is_error']) { $result.is_error -eq $true } else { $null }
          subtype = if ($result -and $result.PSObject.Properties['subtype']) { [string]$result.subtype } else { $null }
          turn_count = if ($result -and $result.PSObject.Properties['num_turns'] -and $result.num_turns -is [int]) { $result.num_turns } else { $null }
          api_http_status = if ($result -and $result.PSObject.Properties['api_error_status']) { Get-SafeHttpStatus $result.api_error_status } else { $null }
        }
        $passed = $processExitCode -eq 0 -and $terminal.present -eq $true -and $terminal.is_error -eq $false -and @($httpStatuses | Where-Object { $_ -eq 401 }).Count -eq 0
        return [ordered]@{
          schema = 1
          state = if ($passed) { 'passed' } else { 'failed' }
          completed_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
          elapsed_milliseconds = [int]([DateTime]::UtcNow - $started).TotalMilliseconds
          claude_version = $ClaudeVersion
          process_exit_code = $processExitCode
          event_type_counts = $typeCounts
          parse_error_count = $parseErrorCount
          http_statuses = @($httpStatuses | Sort-Object -Unique)
          terminal = $terminal
          credential_override_names = @($OverrideNames)
          privacy = [ordered]@{
            raw_content_persisted = $false
            raw_content_printed = $false
            raw_content_read_in_memory_for_sanitization = $true
            error_text_persisted = $false
          }
        }
      }

      $npmPrefix = Join-Path $env:USERPROFILE 'AppData\Roaming\npm'
      $env:Path = @(
        $npmPrefix,
        'C:\Program Files\nodejs',
        'C:\Program Files\Git\cmd',
        'C:\Program Files\Git\bin',
        'C:\Program Files\PowerShell\7',
        $env:Path
      ) -join ';'

      $claude = Get-Command claude.cmd -ErrorAction SilentlyContinue
      if (-not $claude) { $claude = Get-Command claude.exe -ErrorAction SilentlyContinue }
      $version = $null
      $loggedIn = $false
      $authStatusExitCode = $null
      $errorKind = $null
      try {
        if (-not $claude) { throw 'claude command not found inside guest' }
        $version = (& $claude.Source --version).Trim()
        & $claude.Source auth status *> $null
        $authStatusExitCode = $LASTEXITCODE
        $loggedIn = ($LASTEXITCODE -eq 0)
      } catch {
        $errorKind = 'local_auth_status_command_failed'
      }

      $secretEnv = @(Get-ChildItem Env: |
        Where-Object {
          $_.Name -in $CredentialOverrideNames -or
          $_.Name -match 'OPENAI_API_KEY|GOOGLE_API_KEY|AZURE_OPENAI_API_KEY|GH_TOKEN|GITHUB_TOKEN|COPILOT_'
        } |
        Select-Object -ExpandProperty Name |
        Sort-Object -Unique)

      $canary = $null
      if ($RunRemoteAuthCanary) {
        if ($null -eq $claude -or -not $loggedIn -or $secretEnv.Count -gt 0) {
          $canary = [ordered]@{
            schema = 1
            state = 'failed'
            completed_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
            claude_version = $version
            local_auth_status_exit_code = $authStatusExitCode
            process_exit_code = $null
            event_type_counts = [ordered]@{}
            parse_error_count = 0
            http_statuses = @()
            terminal = [ordered]@{ present = $false; is_error = $null; subtype = $null; turn_count = $null; api_http_status = $null }
            credential_override_names = $secretEnv
            privacy = [ordered]@{ raw_content_persisted = $false; raw_content_printed = $false; raw_content_read_in_memory_for_sanitization = $false; error_text_persisted = $false }
          }
        } else {
          $canary = Invoke-RemoteAuthCanary $claude.Source $version $secretEnv
          $canary.local_auth_status_exit_code = $authStatusExitCode
        }
        $canary | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $GuestCanaryPath -Encoding UTF8
      }

      [ordered]@{
        verdict = if ($version -match [regex]::Escape($ExpectedClaudeVersion) -and $loggedIn -and $secretEnv.Count -eq 0 -and (-not $RunRemoteAuthCanary -or $canary.state -eq 'passed')) { 'PASS' } else { 'FAIL' }
        generated_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        claude_version = $version
        claude_logged_in = $loggedIn
        auth_status_exit_code = $authStatusExitCode
        credential_override_names = $secretEnv
        ssh_dir_present = Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.ssh')
        git_credentials_present = Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.git-credentials')
        gh_hosts_present = Test-Path -LiteralPath (Join-Path $env:APPDATA 'GitHub CLI\hosts.yml')
        error_kind = $errorKind
        identity_fields_logged = $false
        remote_auth_canary = $canary
      }
    } -ArgumentList $ExpectedClaudeVersion, $RunRemoteAuthCanary, $GuestCanaryPath, $CredentialOverrideNames -ErrorAction Stop
  } -ArgumentList $VMName, $logonName, $storedCredential.Password, $ExpectedClaudeVersion, $RunRemoteAuthCanary, $GuestCanaryPath, $CredentialOverrideNames

  try {
    $completed = Wait-Job -Job $job -Timeout $ProbeTimeoutSeconds
    if (-not $completed) {
      $attempts += [ordered]@{ logon_name = $logonName; ok = $false; error = 'timed out' }
      continue
    }
    $probe = Receive-Job -Job $job -ErrorAction Stop
    $workingLogonName = $logonName
    $attempts += [ordered]@{ logon_name = $logonName; ok = $true; error = $null }
    break
  } catch {
    $attempts += [ordered]@{ logon_name = $logonName; ok = $false; error = 'powershell_direct_failed' }
  } finally {
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  }
}

$hostReport = [ordered]@{
  verdict = if ($probe -and $probe.verdict -eq 'PASS') { 'PASS' } else { 'FAIL' }
  generated_at_utc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  vm_name = $VMName
  vm_state = $vm.State.ToString()
  powershell_direct_logon = $workingLogonName
  attempts = $attempts
  guest_report = $probe
  note = if ($RunRemoteAuthCanary) {
    'Sanitized guest auth verification plus one separately authorized remote canary. No raw content or error text is persisted or printed.'
  } else {
    'Sanitized local auth verification via PowerShell Direct. It proves only local credential presence, not remote credential acceptance.'
  }
}

$hostReport | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $HostReportPath -Encoding UTF8
if ($hostReport.verdict -ne 'PASS') {
  Fail "sanitized guest Claude auth verification failed; see $HostReportPath"
}
Write-Host "[hyperv-verify-guest-claude-auth-direct] PASS: $HostReportPath"
