#Requires -RunAsAdministrator

param(
  [Parameter(Mandatory)][string]$OperationId,
  [Parameter(Mandatory)][string]$ProfilePath,
  [Parameter(Mandatory)][string]$CreatedInspectionReceiptPath,
  [Parameter(Mandatory)][string]$GuestCredentialPath,
  [Parameter(Mandatory)][string]$ReportPath,
  [Parameter(Mandatory)][string]$ExpectedClaudeAccount,
  [Parameter(Mandatory)][string]$ExpectedCodexAccount,
  [string]$ExpectedClaudeSubscription = 'max',
  [string]$ExpectedClaudeRateLimitTier = 'default_claude_max_20x',
  [string]$ExpectedCodexPlan = 'pro',
  [ValidateRange(30, 300)][int]$TimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'evidence1-vm-identity-contract.psm1') -Force -DisableNameChecking
$identity = Get-Evidence1CanonicalE2EVmIdentity -ProfilePath $ProfilePath `
  -CreatedInspectionReceiptPath $CreatedInspectionReceiptPath -GuestCredentialPath $GuestCredentialPath

$parsed = [guid]::Empty
if (-not [guid]::TryParseExact($OperationId, 'D', [ref]$parsed) -or $parsed -eq [guid]::Empty -or
  $OperationId -cne $parsed.ToString('D')) { throw 'operation_id_invalid' }
if ($ExpectedClaudeSubscription -cne 'max' -or $ExpectedClaudeRateLimitTier -cne 'default_claude_max_20x' -or
  $ExpectedCodexPlan -cne 'pro') { throw 'account_mapping_contract_mismatch' }
$reportFull = [IO.Path]::GetFullPath($ReportPath)
if (-not $reportFull.StartsWith('C:\kmp-eval\scratch\evidence1-account-mapping\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'report_path_invalid'
}
if (Test-Path -LiteralPath $reportFull) { throw 'report_already_exists' }

$vm = Get-VM -Name $identity.vm_name -ErrorAction Stop
if (([string]$vm.Id).ToLowerInvariant() -cne $identity.vm_id) { throw 'e2e_vm_identity_mismatch' }
$startedHere = [string]$vm.State -cne 'Running'
$stored = Import-Clixml -LiteralPath $identity.guest_credential_path
$credential = [pscredential]::new("$($identity.guest_computer_name)\$($identity.guest_user)", $stored.Password)
$networkOpenedHere = $false
$guestFirewallOpened = $false
$codexRefreshAttempted = $false
$codexRefreshSucceeded = $false
try {
  if ($startedHere) {
    Start-VM -VM $vm -ErrorAction Stop | Out-Null
    $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSeconds)
    $directReady = $false
    do {
      try {
        $probe = Invoke-Command -VMId ([guid]$identity.vm_id) -Credential $credential `
          -ScriptBlock { 'evidence1-powershell-direct-ready' } -ErrorAction Stop
        $directReady = @($probe | Where-Object { [string]$_ -ceq 'evidence1-powershell-direct-ready' }).Count -eq 1
      } catch { $directReady = $false }
      if ($directReady) { break }
      Start-Sleep -Seconds 1
    } while ([datetime]::UtcNow -lt $deadline)
    if (-not $directReady) { throw 'guest_powershell_direct_timeout' }
  }

  $adapters = @(Get-VMNetworkAdapter -VM $vm -ErrorAction Stop)
  if ($adapters.Count -ne 1) { throw 'account_mapping_network_adapter_count_invalid' }
  $adapterInitiallyIsolated = -not $adapters[0].Connected -and
    ([string]::IsNullOrWhiteSpace([string]$adapters[0].SwitchId) -or [guid]$adapters[0].SwitchId -eq [guid]::Empty)
  $adapterInitiallyCanonical = $adapters[0].Connected -and [string]$adapters[0].SwitchName -ceq 'Default Switch'
  if (-not $adapterInitiallyIsolated -and -not $adapterInitiallyCanonical) {
    throw 'account_mapping_initial_network_topology_invalid'
  }

  $codexCredentialState = Invoke-Command -VMId ([guid]$identity.vm_id) -Credential $credential -ScriptBlock {
    $credentialPath = 'C:\Evidence1RuntimeState\codex\auth.json'
    if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
      return [pscustomobject]@{ refresh_required = $false; refresh_token_present = $false }
    }
    $refreshPresent = $false
    try {
      $credential = Get-Content -LiteralPath $credentialPath -Raw | ConvertFrom-Json -ErrorAction Stop
      $refreshPresent = -not [string]::IsNullOrWhiteSpace([string]$credential.tokens.refresh_token)
      $idToken = [string]$credential.tokens.id_token
      if ($idToken -notmatch '^[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$') {
        return [pscustomobject]@{ refresh_required = $true; refresh_token_present = $refreshPresent }
      }
      $payload = $Matches[1].Replace('-', '+').Replace('_', '/')
      switch ($payload.Length % 4) { 2 { $payload += '==' } 3 { $payload += '=' } 1 { throw 'codex_id_token_invalid' } }
      $claims = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json -ErrorAction Stop
      $expiresAt = [DateTimeOffset]::FromUnixTimeSeconds([int64]$claims.exp).UtcDateTime
      return [pscustomobject]@{
        refresh_required = $expiresAt -le [datetime]::UtcNow.AddMinutes(5)
        refresh_token_present = $refreshPresent
      }
    } catch {
      return [pscustomobject]@{ refresh_required = $true; refresh_token_present = $refreshPresent }
    }
  } -ErrorAction Stop

  if ($codexCredentialState.refresh_required) {
    if (-not $codexCredentialState.refresh_token_present) { throw 'codex_refresh_token_missing' }
    $codexRefreshAttempted = $true
    if ($adapterInitiallyIsolated) {
      Connect-VMNetworkAdapter -VMNetworkAdapter $adapters[0] -SwitchName 'Default Switch' -Confirm:$false -ErrorAction Stop | Out-Null
      $networkOpenedHere = $true
      Start-Sleep -Seconds 3
    }
    Invoke-Command -VMId ([guid]$identity.vm_id) -Credential $credential -ScriptBlock {
      Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Allow
    } -ErrorAction Stop
    $guestFirewallOpened = $true
    try {
      $refreshResult = Invoke-Command -VMId ([guid]$identity.vm_id) -Credential $credential -ScriptBlock {
        param($TimeoutMilliseconds)
      $codex = 'C:\Evidence1Toolchain\codex-cli\0.154.0\bin\codex.exe'
        $state = 'C:\Evidence1RuntimeState\codex'
        if (-not (Test-Path -LiteralPath $codex -PathType Leaf) -or -not (Test-Path -LiteralPath $state -PathType Container)) {
          throw 'codex_refresh_toolchain_missing'
        }
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $codex
        $start.Arguments = 'app-server --listen stdio://'
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardInput = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.EnvironmentVariables['CODEX_HOME'] = $state
        $process = [Diagnostics.Process]::new()
        $process.StartInfo = $start
        $processStarted = $false
        $previousInputEncoding = [Console]::InputEncoding
        try {
          [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
          if (-not $process.Start()) { throw 'codex_refresh_process_start_failed' }
          $processStarted = $true
          $stderrTask = $process.StandardError.ReadToEndAsync()
          $initialize = [ordered]@{
            id = 1; method = 'initialize'
            params = [ordered]@{ clientInfo = [ordered]@{ name = 'evidence1-auth-refresh'; version = '1.0.0' } }
          } | ConvertTo-Json -Depth 5 -Compress
          $accountRead = [ordered]@{ id = 2; method = 'account/read'; params = [ordered]@{ refreshToken = $true } } |
            ConvertTo-Json -Depth 5 -Compress
          $process.StandardInput.WriteLine($initialize)
          $process.StandardInput.Flush()
          $deadline = [datetime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
          $responses = @()
          $initializeResponse = $null
          do {
            $remaining = [math]::Max(1, [int]($deadline - [datetime]::UtcNow).TotalMilliseconds)
            $lineTask = $process.StandardOutput.ReadLineAsync()
            if (-not $lineTask.Wait($remaining)) { throw 'codex_refresh_initialize_timeout' }
            $line = $lineTask.Result
            if ($null -eq $line) { throw 'codex_refresh_stream_closed' }
            try { $message = $line | ConvertFrom-Json -ErrorAction Stop } catch { $message = $null }
            if ($message) { $responses += $message }
            if ($message -and [string]$message.id -ceq '1') { $initializeResponse = $message }
          } while ($null -eq $initializeResponse)
          if ($null -eq $initializeResponse.result -or $initializeResponse.PSObject.Properties['error']) {
            throw 'codex_refresh_initialize_failed'
          }
          $process.StandardInput.WriteLine($accountRead)
          $process.StandardInput.Flush()
          $accountResponse = $null
          do {
            $remaining = [math]::Max(1, [int]($deadline - [datetime]::UtcNow).TotalMilliseconds)
            $lineTask = $process.StandardOutput.ReadLineAsync()
            if (-not $lineTask.Wait($remaining)) { throw 'codex_refresh_account_timeout' }
            $line = $lineTask.Result
            if ($null -eq $line) { throw 'codex_refresh_stream_closed' }
            try { $message = $line | ConvertFrom-Json -ErrorAction Stop } catch { $message = $null }
            if ($message) { $responses += $message }
            if ($message -and [string]$message.id -ceq '2') { $accountResponse = $message }
          } while ($null -eq $accountResponse)
          if ($accountResponse.PSObject.Properties['error'] -or $null -eq $accountResponse.result.account -or
            [string]$accountResponse.result.account.type -cne 'chatgpt') { throw 'codex_refresh_response_invalid' }
          $process.StandardInput.Close()
          if (-not $process.WaitForExit(5000)) {
            taskkill.exe /PID $process.Id /T /F *> $null
            throw 'codex_refresh_shutdown_timeout'
          }
          $null = $stderrTask.GetAwaiter().GetResult()
          if ($process.ExitCode -ne 0) { throw 'codex_refresh_process_failed' }
          return [pscustomobject]@{
            account_type = [string]$accountResponse.result.account.type
            email = [string]$accountResponse.result.account.email
            plan_type = [string]$accountResponse.result.account.planType
          }
        } finally {
          [Console]::InputEncoding = $previousInputEncoding
          if ($processStarted -and -not $process.HasExited) { taskkill.exe /PID $process.Id /T /F *> $null }
          $process.Dispose()
        }
      } -ArgumentList ($TimeoutSeconds * 1000) -ErrorAction Stop
      $refreshedEmail = [string]$refreshResult.email
      $refreshedIdentityMatched = $false
      if ($refreshedEmail -match '^([^@]+)@[^@]+$') {
        $refreshedIdentityMatched = $Matches[1].Equals($ExpectedCodexAccount, [StringComparison]::OrdinalIgnoreCase)
      }
      $codexRefreshSucceeded = $refreshedIdentityMatched -and [string]$refreshResult.plan_type -ceq $ExpectedCodexPlan
      if (-not $codexRefreshSucceeded) { throw 'codex_refresh_account_binding_failed' }
    } finally {
      Invoke-Command -VMId ([guid]$identity.vm_id) -Credential $credential -ScriptBlock {
        Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Block
      } -ErrorAction SilentlyContinue
      $guestFirewallOpened = $false
      if ($networkOpenedHere) {
        Get-VMNetworkAdapter -VM $vm | Disconnect-VMNetworkAdapter -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
        $networkOpenedHere = $false
      }
    }
  }

  $wire = Invoke-Command -VMId ([guid]$identity.vm_id) -Credential $credential -ScriptBlock {
    param($ClaudeExpected, $CodexExpected, $ClaudeSubscription, $ClaudeTier, $CodexPlan)
    Set-StrictMode -Version Latest
    $ErrorActionPreference = 'Stop'

    function Get-FileSha256([string]$Path) {
      if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
      return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    }

    function ConvertFrom-JwtPayload([string]$Value) {
      if ($Value -notmatch '^[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$') { return $null }
      try {
        $payload = $Matches[1].Replace('-', '+').Replace('_', '/')
        switch ($payload.Length % 4) { 2 { $payload += '==' } 3 { $payload += '=' } 1 { return $null } }
        return ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json -ErrorAction Stop)
      } catch { return $null }
    }

    function Test-ExpectedIdentity([string]$Value, [string]$Expected) {
      if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
      $candidate = $Value.Trim()
      if ($candidate.Equals($Expected, [StringComparison]::OrdinalIgnoreCase)) { return $true }
      if ($candidate -match '^([^@]+)@[^@]+$') { return $Matches[1].Equals($Expected, [StringComparison]::OrdinalIgnoreCase) }
      return $false
    }

    function Convert-EpochSeconds([object]$Value) {
      $seconds = [int64]0
      if ($null -eq $Value -or -not [int64]::TryParse([string]$Value, [ref]$seconds)) { return $null }
      return [DateTimeOffset]::FromUnixTimeSeconds($seconds).UtcDateTime
    }

    function Convert-EpochMilliseconds([object]$Value) {
      $milliseconds = [int64]0
      if ($null -eq $Value -or -not [int64]::TryParse([string]$Value, [ref]$milliseconds)) { return $null }
      return [DateTimeOffset]::FromUnixTimeMilliseconds($milliseconds).UtcDateTime
    }

    function Get-ClaudeAccountBinding([string]$Expected, [string]$Subscription, [string]$Tier) {
      $credentialPath = 'C:\Evidence1RuntimeState\claude\.credentials.json'
      $bindingPath = 'C:\Evidence1RuntimeState\claude\account-binding.json'
      if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $bindingPath -PathType Leaf)) {
        return [ordered]@{ binding_valid = $false; identity_matched = $false; subscription_type = $null; rate_limit_tier = $null; credential_sha256 = $null; expires_at_utc = $null }
      }
      try {
        $credentialSha = Get-FileSha256 $credentialPath
        $credential = Get-Content -LiteralPath $credentialPath -Raw | ConvertFrom-Json -ErrorAction Stop
        $binding = Get-Content -LiteralPath $bindingPath -Raw | ConvertFrom-Json -ErrorAction Stop
        $oauth = $credential.claudeAiOauth
        $scopes = @($oauth.scopes | ForEach-Object { [string]$_ })
        $expiresAt = Convert-EpochMilliseconds $oauth.expiresAt
        $identityMatched = Test-ExpectedIdentity ([string]$binding.account) $Expected
        $fingerprintMatched = [string]$binding.credential_sha256 -ceq $credentialSha
        $subscriptionMatched = [string]$oauth.subscriptionType -ceq $Subscription
        $tierMatched = [string]$oauth.rateLimitTier -ceq $Tier
        $scopesMatched = $scopes -ccontains 'user:inference' -and $scopes -ccontains 'user:sessions:claude_code'
        $expiryValid = $null -ne $expiresAt -and $expiresAt -gt [datetime]::UtcNow.AddMinutes(5)
        return [ordered]@{
          binding_valid = $identityMatched -and $fingerprintMatched -and $subscriptionMatched -and $tierMatched -and $scopesMatched -and $expiryValid
          identity_matched = $identityMatched; identity_method = 'fresh_oauth_label_and_credential_fingerprint'
          subscription_type = [string]$oauth.subscriptionType; rate_limit_tier = [string]$oauth.rateLimitTier
          required_scopes_present = $scopesMatched; credential_sha256 = $credentialSha
          expires_at_utc = $(if ($expiresAt) { $expiresAt.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') } else { $null })
        }
      } catch {
        return [ordered]@{ binding_valid = $false; identity_matched = $false; subscription_type = $null; rate_limit_tier = $null; credential_sha256 = $null; expires_at_utc = $null }
      }
    }

    function Get-CodexAccountBinding([string]$Expected, [string]$Plan) {
      $credentialPath = 'C:\Evidence1RuntimeState\codex\auth.json'
      if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
        return [ordered]@{ binding_valid = $false; identity_matched = $false; plan_type = $null; credential_sha256 = $null; expires_at_utc = $null }
      }
      try {
        $credential = Get-Content -LiteralPath $credentialPath -Raw | ConvertFrom-Json -ErrorAction Stop
        $payload = ConvertFrom-JwtPayload ([string]$credential.tokens.id_token)
        if ($null -eq $payload) { throw 'codex_id_token_invalid' }
        $authClaimName = 'https://api.openai.com/auth'
        $legacyPlanClaim = 'https://api.openai.com/auth.chatgpt_plan_type'
        $email = [string]$payload.email
        $authClaims = $payload.PSObject.Properties[$authClaimName].Value
        $planType = if ($null -ne $authClaims -and $null -ne $authClaims.PSObject.Properties['chatgpt_plan_type']) {
          [string]$authClaims.PSObject.Properties['chatgpt_plan_type'].Value
        } else {
          [string]$payload.PSObject.Properties[$legacyPlanClaim].Value
        }
        $expiresAt = Convert-EpochSeconds $payload.exp
        $identityMatched = Test-ExpectedIdentity $email $Expected
        $planMatched = $planType -ceq $Plan
        $expiryValid = $null -ne $expiresAt -and $expiresAt -gt [datetime]::UtcNow.AddMinutes(5)
        return [ordered]@{
          binding_valid = $identityMatched -and $planMatched -and $expiryValid
          identity_matched = $identityMatched; plan_matched = $planMatched; plan_type = $planType
          credential_sha256 = Get-FileSha256 $credentialPath
          expires_at_utc = $(if ($expiresAt) { $expiresAt.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') } else { $null })
        }
      } catch {
        return [ordered]@{ binding_valid = $false; identity_matched = $false; plan_matched = $false; plan_type = $null; credential_sha256 = Get-FileSha256 $credentialPath; expires_at_utc = $null }
      }
    }

    [pscustomobject]@{
      claude = Get-ClaudeAccountBinding $ClaudeExpected $ClaudeSubscription $ClaudeTier
      codex = Get-CodexAccountBinding $CodexExpected $CodexPlan
      raw_tokens_read_into_host = $false
      provider_process_started = $false
    }
  } -ArgumentList $ExpectedClaudeAccount, $ExpectedCodexAccount, $ExpectedClaudeSubscription, $ExpectedClaudeRateLimitTier, $ExpectedCodexPlan -ErrorAction Stop

  $verdict = if ($wire.claude.binding_valid -and $wire.codex.binding_valid) { 'PASS' } else { 'FAIL' }
  $report = [ordered]@{
    schema = 2; kind = 'evidence1-provider-account-plan-binding'; verdict = $verdict
    operation_id = $OperationId; vm_name = $identity.vm_name; vm_id = $identity.vm_id
    expected_mapping = [ordered]@{ claude = $ExpectedClaudeAccount; codex = $ExpectedCodexAccount }
    expected_plans = [ordered]@{ claude_subscription = $ExpectedClaudeSubscription; claude_rate_limit_tier = $ExpectedClaudeRateLimitTier; codex_plan = $ExpectedCodexPlan }
    checks = $wire; provider_process_started = $false; final_provider_sessions_consumed = 0
    codex_refresh = [ordered]@{ attempted = $codexRefreshAttempted; succeeded = $codexRefreshSucceeded; inference_sessions_consumed = 0 }
    generated_at_utc = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $reportFull) | Out-Null
  [IO.File]::WriteAllText($reportFull, ($report | ConvertTo-Json -Depth 10 -Compress), [Text.UTF8Encoding]::new($false))
  if ($verdict -cne 'PASS') { throw 'guest_account_mapping_not_verified' }
  Write-Host "[evidence1-verify-guest-account-mapping] PASS: $reportFull"
} finally {
  if ($guestFirewallOpened) {
    Invoke-Command -VMId ([guid]$identity.vm_id) -Credential $credential -ScriptBlock {
      Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Block
    } -ErrorAction SilentlyContinue
  }
  if ($networkOpenedHere) {
    Get-VMNetworkAdapter -VM $vm | Disconnect-VMNetworkAdapter -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
  }
  if ($startedHere) { Stop-VM -VMName $identity.vm_name -Force -TurnOff -ErrorAction SilentlyContinue | Out-Null }
}
