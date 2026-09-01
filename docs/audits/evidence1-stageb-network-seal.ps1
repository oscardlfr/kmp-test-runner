param(
  [string]$ReportPath = 'C:\kmp-eval\scratch\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1\NETWORK-SEAL.json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RulePrefix = 'Evidence1 StageB'
$HostsMarker = '# Evidence1 StageB network seal'
$DeadlineSeconds = 300
$AllowedClaudeHosts = @(
  'api.anthropic.com',
  'platform.claude.com',
  'claude.ai',
  'claude.com'
)
$BlockedProbeHosts = @(
  'github.com',
  'registry.npmjs.org',
  'pypi.org',
  'www.wikipedia.org',
  'example.com',
  'cloudflare.com'
)

function Fail([string]$Message) {
  throw "HARD STOP: $Message"
}

function Require-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail 'network sealing requires an elevated guest session'
  }
}

function Remove-PinnedHostsEntries {
  $hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
  $existing = @(Get-Content -LiteralPath $hostsPath -ErrorAction Stop)
  $kept = @($existing | Where-Object { $_ -notmatch [regex]::Escape($HostsMarker) })
  Set-Content -LiteralPath $hostsPath -Encoding ASCII -Value $kept
}

function Set-PinnedHostsEntries([System.Collections.IDictionary]$HostAddressMap) {
  Remove-PinnedHostsEntries
  $hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
  $lines = @(Get-Content -LiteralPath $hostsPath -ErrorAction Stop)
  foreach ($hostName in $HostAddressMap.Keys) {
    $lines += @($HostAddressMap[$hostName] | ForEach-Object { "$_ $hostName $HostsMarker" })
  }
  Set-Content -LiteralPath $hostsPath -Encoding ASCII -Value $lines
}

$deadlineUtc = [DateTime]::UtcNow.AddSeconds($DeadlineSeconds)
function Get-RemainingSeconds {
  $remaining = [int][Math]::Floor(($deadlineUtc - [DateTime]::UtcNow).TotalSeconds)
  if ($remaining -lt 1) {
    Fail 'network-seal deadline exceeded'
  }
  return $remaining
}

function Invoke-CurlProbe([string]$Uri, [int]$MaxTimeSeconds) {
  $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
  if (-not (Test-Path -LiteralPath $curl -PathType Leaf)) {
    Fail 'curl.exe was not found at the expected system path'
  }
  $timeout = [Math]::Min($MaxTimeSeconds, (Get-RemainingSeconds))
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $curl -IsS --max-time $timeout $Uri *> $null
    return [int]$LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Start-BoundedSleep([int]$Seconds) {
  $remaining = Get-RemainingSeconds
  if ($remaining -le $Seconds) {
    Fail 'network-seal deadline leaves no room for another retry'
  }
  Start-Sleep -Seconds $Seconds
}

Require-Admin
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReportPath) | Out-Null

$sealCompleted = $false
try {
  Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Allow
  Get-NetFirewallRule -DisplayName "$RulePrefix*" -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction Stop
  Remove-PinnedHostsEntries
  Clear-DnsClientCache

  $resolvedByHost = [ordered]@{}
  foreach ($hostName in $AllowedClaudeHosts) {
    $resolved = @(Resolve-DnsName -Name $hostName -ErrorAction Stop |
      Where-Object { $_.Type -in @('A','AAAA') -and $_.IPAddress } |
      Select-Object -ExpandProperty IPAddress -Unique)
    if ($resolved.Count -eq 0) {
      Fail "could not resolve required Claude endpoint: $hostName"
    }
    $resolvedByHost[$hostName] = $resolved
  }
  Set-PinnedHostsEntries $resolvedByHost

  foreach ($hostName in $AllowedClaudeHosts) {
    New-NetFirewallRule `
      -DisplayName "$RulePrefix allow $hostName HTTPS" `
      -Direction Outbound `
      -Action Allow `
      -Protocol TCP `
      -RemotePort 443 `
      -RemoteAddress $resolvedByHost[$hostName] | Out-Null
  }

  foreach ($hostName in $AllowedClaudeHosts) {
    if ((Invoke-CurlProbe "https://$hostName" 12) -ne 0) {
      Fail "$hostName was not reachable before the outbound default block"
    }
  }

  Set-NetFirewallProfile -Profile Domain,Private,Public -DefaultInboundAction Block -DefaultOutboundAction Block

  $allowedSuccessCount = 0
  foreach ($hostName in $AllowedClaudeHosts) {
    $ok = $false
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      if ((Invoke-CurlProbe "https://$hostName" 12) -eq 0) {
        $ok = $true
        break
      }
      if ($attempt -lt 3) {
        Start-BoundedSleep 3
      }
    }
    if (-not $ok) {
      Fail "$hostName was not reachable after the network seal"
    }
    $allowedSuccessCount++
  }

  $blockedSuccessCount = 0
  foreach ($hostName in $BlockedProbeHosts) {
    if ((Invoke-CurlProbe "https://$hostName" 5) -eq 0) {
      $blockedSuccessCount++
    }
  }
  if ($blockedSuccessCount -ne 0) {
    Fail 'restricted network probe reached a blocked destination'
  }

  $profiles = @(Get-NetFirewallProfile -Profile Domain,Private,Public)
  $profilesBlocked = $profiles.Count -eq 3 -and @($profiles | Where-Object {
    $_.Enabled.ToString() -ne 'True' -or $_.DefaultOutboundAction.ToString() -ne 'Block'
  }).Count -eq 0
  if (-not $profilesBlocked) {
    Fail 'firewall profiles are not sealed'
  }

  $report = [ordered]@{
    schema = 1
    verdict = 'PASS'
    generated_at_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    network_mode = 'restricted'
    method = 'default outbound block with pinned Claude HTTPS endpoints and no runtime DNS egress'
    profile_count = $profiles.Count
    allowed_host_count = $AllowedClaudeHosts.Count
    allowed_probe_success_count = $allowedSuccessCount
    blocked_probe_count = $BlockedProbeHosts.Count
    blocked_probe_success_count = $blockedSuccessCount
    deadline_seconds = $DeadlineSeconds
    privacy = [ordered]@{
      resolved_addresses_persisted = $false
      response_content_persisted = $false
    }
  }
  $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
  $sealCompleted = $true
  Write-Host "[network-seal] PASS: $ReportPath"
} finally {
  if (-not $sealCompleted) {
    Set-NetFirewallProfile `
      -Profile Domain,Private,Public `
      -Enabled True `
      -DefaultInboundAction Block `
      -DefaultOutboundAction Block `
      -ErrorAction Continue
    Get-NetFirewallRule -DisplayName "$RulePrefix*" -ErrorAction SilentlyContinue |
      Remove-NetFirewallRule -ErrorAction SilentlyContinue
    $profiles = @(Get-NetFirewallProfile -Profile Domain,Private,Public -ErrorAction SilentlyContinue)
    $stillOpen = @($profiles | Where-Object {
      $_.Enabled.ToString() -ne 'True' -or $_.DefaultOutboundAction.ToString() -ne 'Block'
    }).Count -gt 0
    if ($profiles.Count -ne 3 -or $stillOpen) {
      throw 'HARD STOP: network-seal cleanup could not verify outbound blocking'
    }
  }
}
