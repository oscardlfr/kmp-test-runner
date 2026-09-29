import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const rel = path => path.replaceAll('\\', '/');
const read = path => readFileSync(resolve(root, path), 'utf8').replaceAll('\r\n', '\n');

const portableOpsScripts = [
  'docs/audits/evidence1-host-elevated-runner.ps1',
  'docs/audits/evidence1-host-elevated-runner-client.ps1',
  'docs/audits/evidence1-host-elevated-runner-install.ps1',
  'docs/audits/evidence1-host-inspect-windows-iso.ps1',
  'docs/audits/evidence1-host-delete-failed-canonical-windows-vm.ps1',
  'docs/audits/evidence1-host-create-canonical-windows-vm.ps1',
  'docs/audits/evidence1-host-install-canonical-windows-unattended.ps1',
  'docs/audits/evidence1-host-apply-canonical-windows-offline.ps1',
  'docs/audits/evidence1-live-handoff-contract.psm1',
  'docs/audits/evidence1-hyperv-install-guest-codex-cli-direct.ps1',
  'docs/audits/evidence1-hyperv-upgrade-canonical-codex-cli-direct.ps1',
  'docs/audits/evidence1-hyperv-install-canonical-git-bash-direct.ps1',
  'docs/audits/evidence1-hyperv-open-codex-auth-window-direct.ps1',
  'docs/audits/evidence1-hyperv-inspect-final-codex-live-state.ps1',
  'docs/audits/evidence1-hyperv-inspect-guest-interactive-logon-diagnostic.ps1',
  'docs/audits/evidence1-hyperv-enable-guest-auto-logon.ps1',
  'docs/audits/evidence1-hyperv-seal-final-codex-network.ps1',
  'docs/audits/evidence1-hyperv-trigger-final-codex-direct.ps1',
  'docs/audits/evidence1-hyperv-copy-final-codex-preflight-diagnostic.ps1',
  'docs/audits/evidence1-hyperv-recover-readonly-diagnostic-mount.ps1',
  'docs/audits/evidence1-hyperv-verify-guest-account-mapping-direct.ps1',
  'docs/audits/evidence1-hyperv-inspect-vm-boot-state.ps1',
  'docs/audits/evidence1-hyperv-verify-account-mapping-offline.ps1',
  'docs/audits/evidence1-hyperv-sync-final-codex-source.ps1',
  'docs/audits/evidence1-hyperv-retire-preflight-failed-final-codex.ps1',
  'docs/audits/evidence1-hyperv-inspect-final-codex-closed-state.ps1',
  'docs/audits/evidence1-hyperv-copy-final-codex-failure-diagnostic.ps1',
  'docs/audits/evidence1-hyperv-create-final-codex-attestation.ps1',
  'docs/audits/evidence1-hyperv-rotate-final-codex-attestation.ps1',
  'docs/audits/evidence1-hyperv-run-codex-device-auth-direct.ps1',
  'docs/audits/evidence1-hyperv-run-claude-auth-direct.ps1',
  'docs/audits/evidence1-hyperv-warm-canonical-gradle-cache-direct.ps1',
  'docs/audits/evidence1-hyperv-regenerate-readiness-direct.ps1',
  'docs/audits/evidence1-hyperv-stop-for-final-codex-auth-capture.ps1',
  'docs/audits/evidence1-hyperv-copy-final-codex-attestation.ps1',
  'docs/audits/evidence1-hyperv-inspect-final-codex-binding-inputs.ps1',
  'docs/audits/evidence1-hyperv-restore-canonical-android-sdk.ps1',
  'docs/audits/evidence1-hyperv-capture-final-codex-auth-blob.ps1',
  'docs/audits/evidence1-hyperv-start-authorized-live.ps1',
  'docs/audits/evidence1-hyperv-read-live-operational-tail.ps1',
  'docs/audits/evidence1-hyperv-update-harness-from-bundle.ps1',
  'docs/audits/evidence1-hyperv-verify-wet-gate-v2-direct.ps1',
  'docs/audits/evidence1-hyperv-verify-canary-dryrun-v3-direct.ps1',
  'docs/audits/evidence1-validation-ops.psm1',
  'docs/audits/evidence1-validation-forensics.psm1',
  'docs/audits/evidence1-hyperv-read-wet-forensics-direct.ps1',
  'docs/audits/evidence1-hyperv-read-source-inventory-direct.ps1',
  'docs/audits/evidence1-hyperv-probe-gradle-offline-direct.ps1',
  'docs/audits/evidence1-hyperv-provision-gradle-cache-direct.ps1',
  'docs/audits/evidence1-hyperv-open-temporary-auth-egress.ps1',
  'docs/audits/evidence1-hyperv-open-claude-login-interactive-task.ps1',
  'docs/audits/evidence1-hyperv-open-vmconnect.ps1',
  'docs/audits/evidence1-hyperv-run-network-seal-direct.ps1',
  'docs/audits/evidence1-hyperv-resume-final-codex-placement.ps1',
  'docs/audits/evidence1-hyperv-retire-unstarted-final-codex.ps1',
  'docs/audits/evidence1-hyperv-retire-unexecuted-final-codex.ps1',
  'docs/audits/evidence1-stageb-network-seal.ps1',
  'docs/audits/evidence1-cache-provision-host.psm1',
  'docs/audits/evidence1-hyperv-place-live-autorun.ps1',
  'docs/audits/evidence1-hyperv-read-live-progress.ps1',
  'docs/audits/evidence1-hyperv-copy-live-artifacts.ps1',
  'docs/audits/evidence1-hyperv-verify-guest-claude-auth-direct.ps1',
  'docs/audits/evidence1-hyperv-verify-guest-dual-auth-direct.ps1',
  'docs/audits/evidence1-guest-dual-auth-canary.ps1',
  'docs/audits/evidence1-hyperv-verify-guest-codex-preflight-direct.ps1',
  'docs/audits/evidence1-hyperv-finalize-auth-checkpoint-offline.ps1',
  'docs/audits/evidence1-stageb-live-wrapper.ps1',
  'docs/audits/evidence1-stageb-live-launch.ps1',
  'docs/audits/evidence1-live-run-contract.psm1',
  'docs/audits/evidence1-dual-condition-canary-launch.ps1',
  'docs/audits/evidence1-dual-condition-canary-wrapper.ps1',
  'docs/audits/evidence1-hyperv-place-dual-condition-canary.ps1',
  'docs/audits/evidence1-hyperv-start-dual-condition-canary.ps1',
  'docs/audits/evidence1-hyperv-copy-dual-condition-canary.ps1',
  'docs/audits/evidence1-hyperv-copy-dual-auth-canary-diagnostic.ps1',
];

const elevatedRunnerAllowlist = [
  'evidence1-host-elevated-runner-install.ps1',
  // ADR-S1 capability-dispatch protocol entrypoint (docs/audits/evidence1-broker-capability-contract.psm1
  // and evidence1-broker-capability-dispatch-core.psm1) -- allowlisted once,
  // never per capability.
  'evidence1-host-broker-capability-dispatch.ps1',
  'evidence1-hyperv-copy-dual-auth-canary-diagnostic.ps1',
  'evidence1-hyperv-copy-dual-condition-canary.ps1',
  'evidence1-hyperv-copy-live-artifacts.ps1',
  'evidence1-hyperv-install-guest-codex-cli-direct.ps1',
  'evidence1-hyperv-upgrade-canonical-codex-cli-direct.ps1',
  'evidence1-hyperv-install-canonical-git-bash-direct.ps1',
  'evidence1-hyperv-open-codex-auth-window-direct.ps1',
  'evidence1-hyperv-inspect-final-codex-live-state.ps1',
  'evidence1-hyperv-inspect-guest-interactive-logon-diagnostic.ps1',
  'evidence1-hyperv-enable-guest-auto-logon.ps1',
  'evidence1-hyperv-seal-final-codex-network.ps1',
  'evidence1-hyperv-trigger-final-codex-direct.ps1',
  'evidence1-hyperv-copy-final-codex-preflight-diagnostic.ps1',
  'evidence1-hyperv-recover-readonly-diagnostic-mount.ps1',
  'evidence1-hyperv-verify-guest-account-mapping-direct.ps1',
  'evidence1-hyperv-inspect-vm-boot-state.ps1',
  'evidence1-hyperv-verify-account-mapping-offline.ps1',
  'evidence1-hyperv-sync-final-codex-source.ps1',
  'evidence1-hyperv-retire-preflight-failed-final-codex.ps1',
  'evidence1-hyperv-inspect-final-codex-closed-state.ps1',
  'evidence1-hyperv-copy-final-codex-failure-diagnostic.ps1',
  'evidence1-hyperv-create-final-codex-attestation.ps1',
  'evidence1-hyperv-rotate-final-codex-attestation.ps1',
  'evidence1-hyperv-run-codex-device-auth-direct.ps1',
  'evidence1-hyperv-run-claude-auth-direct.ps1',
  'evidence1-hyperv-warm-canonical-gradle-cache-direct.ps1',
  'evidence1-hyperv-read-live-operational-tail.ps1',
  'evidence1-hyperv-read-live-progress.ps1',
  'evidence1-hyperv-regenerate-readiness-direct.ps1',
  'evidence1-hyperv-stop-for-final-codex-auth-capture.ps1',
  'evidence1-hyperv-copy-final-codex-attestation.ps1',
  'evidence1-hyperv-inspect-final-codex-binding-inputs.ps1',
  'evidence1-hyperv-restore-canonical-android-sdk.ps1',
  'evidence1-hyperv-capture-final-codex-auth-blob.ps1',
  'evidence1-hyperv-start-authorized-live.ps1',
  'evidence1-hyperv-start-dual-condition-canary.ps1',
  'evidence1-hyperv-verify-guest-claude-auth-direct.ps1',
  'evidence1-hyperv-verify-guest-dual-auth-direct.ps1',
  'evidence1-hyperv-verify-guest-codex-preflight-direct.ps1',
  'evidence1-hyperv-update-harness-from-bundle.ps1',
  'evidence1-hyperv-verify-wet-gate-v2-direct.ps1',
  'evidence1-hyperv-verify-canary-dryrun-v3-direct.ps1',
  'evidence1-hyperv-read-wet-forensics-direct.ps1',
  'evidence1-hyperv-read-source-inventory-direct.ps1',
  'evidence1-hyperv-probe-gradle-offline-direct.ps1',
  'evidence1-hyperv-provision-gradle-cache-direct.ps1',
  'evidence1-hyperv-open-temporary-auth-egress.ps1',
  'evidence1-hyperv-open-claude-login-interactive-task.ps1',
  'evidence1-hyperv-open-vmconnect.ps1',
  'evidence1-hyperv-place-dual-condition-canary.ps1',
  'evidence1-hyperv-run-network-seal-direct.ps1',
  'evidence1-hyperv-place-final-codex.ps1',
  'evidence1-hyperv-resume-final-codex-placement.ps1',
  'evidence1-hyperv-retire-unstarted-final-codex.ps1',
  'evidence1-hyperv-retire-unexecuted-final-codex.ps1',
  'evidence1-hyperv-start-final-codex.ps1',
  'evidence1-hyperv-copy-final-codex.ps1',
  'evidence1-host-inspect-windows-iso.ps1',
  'evidence1-host-delete-failed-canonical-windows-vm.ps1',
  'evidence1-host-create-canonical-windows-vm.ps1',
  'evidence1-host-install-canonical-windows-unattended.ps1',
  'evidence1-host-apply-canonical-windows-offline.ps1',
  'evidence1-host-new-unattended-retry-custody.ps1',
  'evidence1-host-post-os-canonical-windows.ps1',
  'evidence1-host-diagnose-windows-first-boot.ps1',
  'evidence1-host-bootstrap-canonical-windows-toolchain.ps1',
  'evidence1-host-checkpoint-canonical-windows-toolchain.ps1',
  // E2E VM startup-memory override (Amendment A5 round 2): host-only
  // Get-VM/Set-VMMemory, no guest credential, closed VMName/ExpectedVMId and
  // a ValidateSet StartupMemoryGiB -- same shape as
  // evidence1-hyperv-stop-for-final-codex-auth-capture.ps1, requires VM Off
  // and fails closed on read-back mismatch.
  'evidence1-hyperv-set-vm-memory-direct.ps1',
  // E2E VHD/AVHDX chain inspection (Amendment A6 follow-up): host-only,
  // read-only Get-VHD walk of the currently-attached disk's full parent
  // chain, closed VMName/ExpectedVMId, no guest credential, never mutates
  // anything -- answers the host-disk-headroom question with evidence
  // instead of an assumed number.
  'evidence1-hyperv-inspect-vhd-chain-direct.ps1',
];

const privateHostPattern = new RegExp([
  String.raw`C:\\Users\\` + '34645',
  'AndroidStudio' + 'Projects',
  String.raw`D:\\` + 'Oscar',
  'WDAG' + 'UtilityAccount',
].join('|'));

const staleCommitPin = ['e5f5974d980faaadda5bd', '48ef53564a08043cdcf'].join('');
const staleTreePin = ['79fe454c9156775ea2d', '6115cae289132895b91bb'].join('');

describe('Evidence1 Hyper-V ops toolkit', () => {
  it.skipIf(process.platform !== 'win32')('accepts an empty journal snapshot through the Windows PowerShell 5.1 transport', () => {
    const contract = rel(resolve(root, 'docs/audits/evidence1-live-run-contract.psm1')).replaceAll("'", "''");
    const script = `
$ErrorActionPreference = 'Stop'
Import-Module '${contract}'
$runId = 'b48bfb0c-a9ae-4e0e-8d89-56eb1e278090'
$path = Join-Path $env:TEMP ('e1-empty-journal-' + [guid]::NewGuid().ToString('N') + '.json')
try {
  Write-Evidence1JsonAtomically -Path $path -Value ([ordered]@{
    run_id = $runId
    journal_id = '69cd5780-49fa-4531-960a-e26cbd7fda54'
    available = $true
    event_count = 0
    latest_event = $null
    transition_counts = @{}
    publication_pending = $false
    publication_pending_since_utc = $null
  })
  $raw = (Read-Evidence1CanaryJson $path).value
  ConvertTo-Evidence1CanaryJournalSnapshot $raw $runId | ConvertTo-Json -Depth 8 -Compress
} finally {
  Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
}
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const snapshot = JSON.parse(result.stdout.trim());
    expect(snapshot).toMatchObject({ event_count: 0, transition_counts: {} });
  });

  it.skipIf(process.platform !== 'win32')('round-trips worker records as inspectable PSObject properties', () => {
    const script = `
$ErrorActionPreference = 'Stop'
$job = Start-Job {
  [pscustomobject][ordered]@{ record_type = 'transport_stage'; stage = 'session_open_failed' }
  [pscustomobject][ordered]@{ verdict = 'FAIL'; failure_code = 'session_open_failed' }
}
try {
  Wait-Job -Job $job | Out-Null
  $received = @(Receive-Job -Job $job -ErrorAction Stop)
  [ordered]@{
    count = $received.Count
    record_type_property_found = $null -ne $received[0].PSObject.Properties['record_type']
    verdict_property_found = $null -ne $received[1].PSObject.Properties['verdict']
  } | ConvertTo-Json -Compress
} finally {
  Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
}
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      count: 2,
      record_type_property_found: true,
      verdict_property_found: true,
    });
  }, 25_000);

  it.skipIf(process.platform !== 'win32')('starts the real live wrapper when the newest journal has no events yet', () => {
    const wrapper = rel(resolve(root, 'docs/audits/evidence1-stageb-live-wrapper.ps1')).replaceAll("'", "''");
    const script = `
$ErrorActionPreference = 'Stop'
$fixture = Join-Path $env:TEMP ('e1-empty-live-journal-' + [guid]::NewGuid().ToString('N'))
$ops = Join-Path $fixture 'ops'
$harness = Join-Path $fixture 'harness'
$events = Join-Path $harness 'tools\\runs\\agentic-eval-journal\\empty-journal\\events'
$launcher = Join-Path $fixture 'launcher.ps1'
$runId = [guid]::NewGuid().ToString('D')
try {
  New-Item -ItemType Directory -Force -Path $ops,$events | Out-Null
  @'
param([string]$RunId, [string]$TerminalRecordPath)
$record = [ordered]@{
  schema = 1
  run_id = $RunId
  state = 'exited'
  ts_utc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  exit_code = 0
  exit_code_source = 'launcher_record'
}
[IO.File]::WriteAllText($TerminalRecordPath, ($record | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
exit 0
'@ | Set-Content -LiteralPath $launcher -Encoding UTF8
  & '${wrapper}' -RunId $runId -RemoteAuthCanaryOperationId '11111111-1111-4111-8111-111111111111' -LauncherPath $launcher -OpsDir $ops -HarnessDir $harness -HeartbeatSeconds 1 -StopTimeoutMilliseconds 5000
  $wrapperExit = $LASTEXITCODE
  $terminal = Get-Content -LiteralPath (Join-Path $ops 'STAGE-B-live.exit.json') -Raw | ConvertFrom-Json
  $status = Get-Content -LiteralPath (Join-Path $ops 'STAGE-B-live.status.json') -Raw | ConvertFrom-Json
  [ordered]@{
    wrapper_exit = $wrapperExit
    terminal_state = $terminal.state
    terminal_exit = $terminal.exit_code
    wrapper_error_stage = $terminal.wrapper_error_stage
    journal_event_count = $status.journal.event_count
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
}
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      wrapper_exit: 0,
      terminal_state: 'exited',
      terminal_exit: 0,
      wrapper_error_stage: null,
      journal_event_count: 0,
    });
  }, 35_000);

  it.skipIf(process.platform !== 'win32')('validates standard-matrix shutdown custody without accepting canary downgrade', () => {
    const contract = rel(resolve(root, 'docs/audits/evidence1-live-run-contract.psm1')).replaceAll("'", "''");
    const script = `
$ErrorActionPreference = 'Stop'
Import-Module '${contract}' -Force
$runId = [guid]::NewGuid().ToString('D')
$vmName = 'Evidence1-Runner'
$placement = [pscustomobject][ordered]@{
  verdict = 'PASS'; schema = 1; generated_at_utc = '2026-09-01T12:00:00.000Z'
  run_id = $runId; vm_name = $vmName
  launcher_sha256 = ('a' * 64); wrapper_sha256 = ('b' * 64); contract_sha256 = ('c' * 64)
  startup_entry_created = $true
  prior_run_custody = [pscustomobject]@{ state = 'none'; run_id = $null; archived_operational_artifacts = @(); archive_relative_path = $null }
  replacement_or_respawn_used = $false
  launch_policy = 'one-shot'
}
$handoff = [pscustomobject][ordered]@{
  schema = 1; state = 'started'; generated_at_utc = '2026-09-01T12:00:01.000Z'
  vm_name = $vmName; vm_state = 'Running'; target_commit = ('d' * 40); target_tree = ('e' * 40); run_id = $runId
  prior_run_custody = [pscustomobject]@{ state = 'none'; run_id = $null }
  failure_kind = ''; hard_power_fallback_used = $false; replacement_or_respawn_used = $false; raw_content_read = $false
}
$terminal = [pscustomobject][ordered]@{
  schema = 1; run_id = $runId; state = 'wrapper_error'; exit_code = 997; exit_code_source = 'wrapper_error'; canary = $null
}
$accepted = Assert-Evidence1MatrixShutdownCustody $placement $handoff $terminal $runId $vmName
$terminal.canary = [pscustomobject]@{ arm = 'product'; planned_sessions = 1; binding_sha256 = ('f' * 64) }
$downgradeRejected = $false
try { $null = Assert-Evidence1MatrixShutdownCustody $placement $handoff $terminal $runId $vmName }
catch { $downgradeRejected = $true }
[ordered]@{ accepted = $accepted; downgrade_rejected = $downgradeRejected } | ConvertTo-Json -Compress
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ accepted: true, downgrade_rejected: true });
  }, 25_000);

  it.skipIf(process.platform !== 'win32')('observes the real atomic journal publisher before and after linkSync without false failure', () => {
    const contract = rel(resolve(root, 'docs/audits/evidence1-live-run-contract.psm1')).replaceAll("'", "''");
    const publisher = pathToFileURL(resolve(root, 'tools/agentic-eval/evidence-io.mjs')).href;
    const script = `
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const fixture = fs.mkdtempSync(join(tmpdir(), 'e1-canary-publish-'));
const journalRoot = join(fixture, 'journals');
const events = join(journalRoot, '69cd5780-49fa-4531-960a-e26cbd7fda54', 'events');
const prior = join(fixture, 'prior.json');
fs.mkdirSync(events, { recursive: true });
const observations = [];
const quote = s => s.replaceAll("'", "''");
function observe() {
  const ps = "$ErrorActionPreference='Stop'; Import-Module '${contract}'; " +
    "$previous = if (Test-Path -LiteralPath '" + quote(prior) + "') { (Read-Evidence1CanaryJson '" + quote(prior) + "').value } else { $null }; " +
    "$value = Get-Evidence1CanaryJournalProgress '" + quote(journalRoot) + "' @() 'b48bfb0c-a9ae-4e0e-8d89-56eb1e278090' $previous -NowUtc ([datetime]'2026-08-31T12:00:00Z'); " +
    "$json = $value | ConvertTo-Json -Depth 8 -Compress; [IO.File]::WriteAllText('" + quote(prior) + "', $json); $json";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20000 });
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  observations.push(JSON.parse(result.stdout.trim()));
}
const originalLink = fs.linkSync;
try {
  fs.linkSync = (...args) => { observe(); originalLink(...args); observe(); };
  syncBuiltinESMExports();
  const { promoteTargetsAtomically } = await import(${JSON.stringify(publisher)});
  promoteTargetsAtomically([[join(events, '000000000000-0-planned.json'), JSON.stringify({ seq: 0, runKind: 'scenario', cellOrdinal: 0, transition: 'planned', meta: {} })]], events);
  observe();
  process.stdout.write(JSON.stringify(observations));
} finally {
  fs.linkSync = originalLink;
  syncBuiltinESMExports();
  fs.rmSync(fixture, { recursive: true, force: true });
}
`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 70_000 });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const observations = JSON.parse(result.stdout);
    expect(observations.map(item => item.publication_pending)).toEqual([true, true, false]);
    expect(observations.map(item => item.event_count)).toEqual([0, 0, 1]);
    expect(observations[2].transition_counts).toEqual({ planned: 1 });
  }, 75_000);

  it('keeps host-side ops scripts portable and free of stale target pins', () => {
    for (const script of portableOpsScripts) {
      const source = read(script);
      expect(source, script).not.toMatch(privateHostPattern);
      expect(source, script).not.toMatch(/[0-9a-f]{40}.*#\s*stale/i);
      expect(source, script).not.toMatch(/TargetCommit\s*=\s*'[0-9a-f]{40}'/);
      expect(source, script).not.toMatch(/TargetTree\s*=\s*'[0-9a-f]{40}'/);
      expect(source, script).not.toContain(staleCommitPin);
      expect(source, script).not.toContain(staleTreePin);
    }
  });

  it('preserves prior copy reports before Hyper-V access and publishes bounded terminal state', () => {
    const copy = read('docs/audits/evidence1-hyperv-copy-live-artifacts.ps1');
    const initialReport = copy.indexOf("state = 'started'");
    const hyperVAccess = copy.indexOf('Get-VM -Name $VMName');
    expect(initialReport).toBeGreaterThan(0);
    expect(hyperVAccess).toBeGreaterThan(initialReport);
    expect(copy).toContain("failure_code = 'copy_interrupted'");
    expect(copy).toContain("'canary_custody_incomplete'");
    expect(copy).toContain('Write-Evidence1JsonAtomically -Path $copyReportPath');
    expect(copy).not.toMatch(/Exception\.Message/);
    expect(copy).not.toMatch(/HYPERV-COPY-LIVE-ARTIFACTS\.json'\)\s+-Encoding/);
    expect(copy).toContain("$existingState -cin @('passed','failed')");
    expect(copy).toContain("$archiveCode = 'terminal'");
    expect(copy).toContain('$historicalTerminalKeys = @(');
    expect(copy).toContain('$matchesHistoricalTerminal');
    expect(copy).toContain("$archiveIdentity = 'legacy-' +");
    expect(copy).toContain('Get-FileHash -Algorithm SHA256 -LiteralPath $Path');
    expect(copy).toContain("[string]$existing.vm_state -cne 'Off'");
    expect(copy).toContain('$existing.raw_content_read -isnot [bool]');
  });

  it('binds an optional graceful shutdown to exact prior custody without a hard-power fallback', () => {
    const copy = read('docs/audits/evidence1-hyperv-copy-live-artifacts.ps1');
    const terminalReader = copy.slice(copy.indexOf('function Read-RunningTerminal'), copy.indexOf('Assert-PathInside $OutDir'));
    const terminalRead = copy.indexOf('Read-RunningTerminal');
    const custodyCheck = copy.indexOf('Assert-Evidence1CanaryShutdownCustody');
    const shutdown = copy.indexOf('Stop-VM -Name $VMName');
    const intentCheckpoint = copy.indexOf("failure_code = 'vm_shutdown_dispatch_pending'");
    const acceptedCheckpoint = copy.indexOf("failure_code = 'vm_shutdown_interrupted'");
    const preserveCheckpoint = copy.indexOf('Preserve-InterruptedCopyCheckpoint $copyReportPath');
    const initialCheckpoint = copy.indexOf('$startedReport = [ordered]@{');
    expect(copy).toContain('[switch]$GracefulShutdown');
    expect(terminalRead).toBeGreaterThan(0);
    expect(custodyCheck).toBeGreaterThan(terminalRead);
    expect(intentCheckpoint).toBeGreaterThan(custodyCheck);
    expect(shutdown).toBeGreaterThan(intentCheckpoint);
    expect(acceptedCheckpoint).toBeGreaterThan(shutdown);
    expect(preserveCheckpoint).toBeGreaterThan(0);
    expect(initialCheckpoint).toBeGreaterThan(preserveCheckpoint);
    expect(copy).toContain('Test-Evidence1TerminalRecordObject');
    expect(copy).toContain('Assert-Evidence1MatrixShutdownCustody');
    expect(copy).toContain('New-PSSession -VMName $VMName');
    expect(copy).toContain('$shutdownRequested = $true');
    expect(copy).toContain('$shutdownIntentRecorded = $true');
    expect(copy).toContain('graceful_shutdown_intent_recorded = $shutdownIntentRecorded');
    expect(copy).toContain('graceful_shutdown_requested = $shutdownRequested');
    expect(copy).not.toContain('graceful_shutdown_requested = [bool]$GracefulShutdown');
    expect(copy).toContain("failure_code = 'vm_shutdown_interrupted'");
    expect(copy).toContain('hard_power_fallback_used = $false');
    expect(copy).not.toMatch(/Stop-VM[^\r\n]*-TurnOff/);
    expect(terminalReader).not.toMatch(/CommandLine|stderr\.txt|raw\//i);
    expect(terminalReader).toContain("schema = $record.schema");
    expect(terminalReader).toContain("canary = [ordered]@{");
    expect(terminalReader).not.toContain("$result[$entry.key] = $record");
    expect(copy).toContain("@('copy_interrupted','vm_shutdown_dispatch_pending','vm_shutdown_interrupted')");
    expect(copy).toContain("throw 'copy_checkpoint_invalid'");
    expect(copy).toContain("throw 'copy_checkpoint_collision'");
    expect(copy).toContain('Move-Item -LiteralPath $Path -Destination $archivePath');
  });

  it('installs a hash-bound protected snapshot as the elevated-runner trust boundary', () => {
    const runner = read('docs/audits/evidence1-host-elevated-runner.ps1');
    const client = read('docs/audits/evidence1-host-elevated-runner-client.ps1');
    const install = read('docs/audits/evidence1-host-elevated-runner-install.ps1');

    expect(runner).toContain('Resolve-FullPath $PSScriptRoot');
    expect(client).toContain('Resolve-FullPath $PSScriptRoot');
    expect(install).toContain('Resolve-FullPath $PSScriptRoot');
    expect(install).toContain('Join-Path $AllowedRoot');
    expect(install).toContain('-AllowedRoot `"$AllowedRoot`"');
    expect(client).toContain('Assert-PathInside $scriptFull $AllowedRoot');
    expect(runner).toContain('Assert-E1RunnerDirectFile $requestedScriptPath $AllowedRoot $scriptName');
    expect(runner).toContain("'evidence1-host-elevated-runner-manifest.json'");
    expect(runner).toContain("throw 'allowlisted_script_hash_mismatch'");
    expect(runner).toContain('(Get-E1RunnerSha256 $runnerPath)-cne$manifest.runner_sha256');
    expect(install).toContain("'KmpEval\\Evidence1ElevatedRunner'");
    expect(install).toContain('SetAccessRuleProtection($true,$false)');
    expect(install).toContain('Assert-E1InstallProtectedAcl $deploymentBase');
    expect(install).toContain('Assert-E1InstallClosedSet $stagingRoot');
    expect(install).toContain('runnerAst.FindAll');
    expect(install).toContain('Write-E1InstallCreateNew');
    expect(runner).toContain("'evidence1-stageb-network-seal.ps1'");
  });

  it('declares the complete literal PowerShell dependency closure of the elevated snapshot', () => {
    const runner = read('docs/audits/evidence1-host-elevated-runner.ps1');
    const allowlistBlock = runner.slice(runner.indexOf('$AllowedScripts = @('), runner.indexOf('$TrustedSupportFiles = @('));
    const supportBlock = runner.slice(runner.indexOf('$TrustedSupportFiles = @('), runner.indexOf('$TrustedNodeFiles = @('));
    const declared = new Set([
      'evidence1-host-elevated-runner.ps1',
      'evidence1-validation-ops.psm1',
      ...[...allowlistBlock.matchAll(/'([^']+\.ps1)'/g)].map(match => match[1]),
      ...[...supportBlock.matchAll(/'([^']+\.(?:ps1|psm1|mjs))'/g)].map(match => match[1]),
    ]);

    for (const file of declared) {
      const source = read(`docs/audits/${file}`);
      for (const match of source.matchAll(/['"]([A-Za-z0-9][A-Za-z0-9.-]*\.(?:ps1|psm1))['"]/g)) {
        const dependency = match[1];
        if (existsSync(resolve(root, 'docs', 'audits', dependency))) {
          expect(declared.has(dependency), `${file} -> ${dependency}`).toBe(true);
        }
      }
    }
  });

  it('limits the elevated runner to the versioned operational scripts only', () => {
    const runner = read('docs/audits/evidence1-host-elevated-runner.ps1');
    const allowlistBlock = runner.slice(runner.indexOf('$AllowedScripts = @('), runner.indexOf('$TrustedSupportFiles = @('));
    const entries = [...allowlistBlock.matchAll(/'([^']+\.ps1)'/g)].map(match => match[1]).sort();

    expect(entries).toEqual([...elevatedRunnerAllowlist].sort());
    for (const scriptName of entries) {
      const path = `docs/audits/${scriptName}`;
      expect(existsSync(resolve(root, path)), path).toBe(true);
    }

    for (const deliberatelyExcluded of [
      'evidence1-hyperv-create-runner-vm.ps1',
      'evidence1-hyperv-place-live-autorun.ps1',
      'evidence1-hyperv-restore-checkpoint.ps1',
      'evidence1-hyperv-restart-vmms-if-safe.ps1',
      'evidence1-hyperv-stop-runner-vm.ps1',
    ]) {
      expect(entries).not.toContain(deliberatelyExcluded);
    }
  });

  it('bounds elevated child processes and terminates only their owned process tree', () => {
    const runner = read('docs/audits/evidence1-host-elevated-runner.ps1');

    expect(runner).toContain("Import-Module $processModulePath -Force -ErrorAction Stop");
    expect(runner).toContain('$script:PowerShellExecutable = (Get-Command powershell.exe -ErrorAction Stop).Source');
    expect(runner).toContain('$childTimeoutSeconds = 7500');
    expect(runner).toContain('Invoke-E1OwnedProcess -Executable $script:PowerShellExecutable');
    expect(runner).toContain('$isUnattended = $scriptName -in @(');
    expect(runner).toContain("'evidence1-host-apply-canonical-windows-offline.ps1'");
    expect(runner).toContain('$exitCode -ne 0');
    expect(runner).toContain("'-RecoveryOnly'");
    expect(runner).toContain("'elevated_runner_child_timeout'");
    expect(runner).toContain("'elevated_runner_child_failure'");
    expect(runner).toContain("'-RecoveryReasonCode', $ReasonCode");
    expect(runner).toContain("'RecoveryReasonCode'.StartsWith($argumentName, [StringComparison]::OrdinalIgnoreCase)");
    expect(runner).toContain("throw 'reserved unattended recovery argument'");
    expect(runner).toContain("$responseError = 'unattended_nonpass_recovery_pass'");
    expect(runner).toContain("$responseError = 'unattended_nonpass_recovery_failed'");
    expect(runner).toContain("$responseError = 'unattended_runner_error_recovery_pass'");
    expect(runner).toContain("$recoveryTimeoutSeconds = if ([IO.Path]::GetFileName($ScriptPath) -ceq 'evidence1-host-apply-canonical-windows-offline.ps1')");
    expect(runner).toContain('{ 900 } else { 300 }');
    expect(runner).toContain('-Seconds $recoveryTimeoutSeconds');
    expect(runner).not.toContain('-Seconds 180');
    expect(runner).not.toMatch(/Stop-OwnedProcessTree|Start-Process/);
  });

  it.skipIf(process.platform !== 'win32')('reserves every accepted spelling of the recovery reason argument', () => {
    const script = String.raw`
$tokens=$null
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:E1_RUNNER,[ref]$tokens,[ref]$errors)
$definition=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Assert-E1UnattendedRunnerArguments'},$true))
if($errors.Count -or $definition.Count -ne 1){exit 2}
. ([scriptblock]::Create($definition[0].Extent.Text))
$target='evidence1-host-install-canonical-windows-unattended.ps1'
foreach($flag in @('-RecoveryReasonCode','/recoveryreasoncode:elevated_runner_child_timeout','-RecoveryR','-R')) {
  try { Assert-E1UnattendedRunnerArguments $target @($flag); exit 3 }
  catch { if($_.Exception.Message -cne 'reserved unattended recovery argument'){exit 4} }
}
Assert-E1UnattendedRunnerArguments $target @('-RecoveryOnly','-RetryAuthorizationPhrase','value')
Assert-E1UnattendedRunnerArguments 'different-script.ps1' @('-RecoveryReasonCode','value')
exit 0
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, E1_RUNNER: resolve(root, 'docs/audits/evidence1-host-elevated-runner.ps1') },
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it.skipIf(process.platform !== 'win32')('pins the self-install path to the one true repository, task, and queue identity', () => {
    const script = String.raw`
$tokens=$null
$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:E1_RUNNER,[ref]$tokens,[ref]$errors)
$definition=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Assert-E1SelfInstallRunnerArguments'},$true))
$helper=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Get-E1ExactNamedArguments'},$true))
if($errors.Count -or $definition.Count -ne 1 -or $helper.Count -ne 1){exit 2}
. ([scriptblock]::Create($helper[0].Extent.Text))
. ([scriptblock]::Create($definition[0].Extent.Text))
$target='evidence1-host-elevated-runner-install.ps1'
$canonical=@(
  '-TaskName','Evidence1CodexElevatedRunner',
  '-RunnerPath','C:\kmp-eval\agentic-eval-codex-runtime\docs\audits\evidence1-host-elevated-runner.ps1',
  '-QueueRoot','C:\kmp-eval\scratch\host-elevated-runner-codex',
  '-AllowedRoot','C:\kmp-eval\agentic-eval-codex-runtime\docs\audits',
  '-ExecutionIdentity','InteractiveUser',
  '-ReportPath','C:\kmp-eval\scratch\host-elevated-runner-codex\install-abc1234.json'
)
Assert-E1SelfInstallRunnerArguments $target $canonical
Assert-E1SelfInstallRunnerArguments 'different-script.ps1' @('-AllowedRoot','C:\anything')
function Replace-Arg([string[]]$ArgList,[string]$Name,[string]$Value){$copy=[Collections.ArrayList]::new([string[]]$ArgList);$index=$copy.IndexOf($Name);if($index-lt 0){throw "flag not found: $Name"};$copy[$index+1]=$Value;return ,$copy.ToArray()}
$mutations=@(
  (Replace-Arg $canonical '-TaskName' 'SomeOtherTask'),
  (Replace-Arg $canonical '-AllowedRoot' 'C:\kmp-eval\attacker-repo\docs\audits'),
  (Replace-Arg $canonical '-RunnerPath' 'C:\kmp-eval\attacker-repo\docs\audits\evidence1-host-elevated-runner.ps1'),
  (Replace-Arg $canonical '-QueueRoot' 'C:\kmp-eval\scratch\host-elevated-runner'),
  (Replace-Arg $canonical '-ExecutionIdentity' 'System'),
  (Replace-Arg $canonical '-ReportPath' 'C:\kmp-eval\scratch\evidence1-final-codex-auth\install-abc1234.json')
)
foreach($mutated in $mutations){
  try { Assert-E1SelfInstallRunnerArguments $target $mutated; exit 3 }
  catch { if($_.Exception.Message -cne 'canonical self-install argv invalid'){exit 4} }
}
try { Assert-E1SelfInstallRunnerArguments $target @('-TaskName','Evidence1CodexElevatedRunner'); exit 5 }
catch { if($_.Exception.Message -cne 'canonical self-install argv missing required argument'){exit 6} }
exit 0
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, E1_RUNNER: resolve(root, 'docs/audits/evidence1-host-elevated-runner.ps1') },
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it('wires the self-install guard into the main dispatch path', () => {
    const runner = read('docs/audits/evidence1-host-elevated-runner.ps1');
    expect(runner).toContain("'evidence1-host-elevated-runner-install.ps1',");
    expect(runner).toContain('Assert-E1SelfInstallRunnerArguments $scriptName $arguments');
    expect(runner.indexOf('Assert-E1CanonicalPostApplyRunnerArguments $scriptName $arguments')).toBeLessThan(runner.indexOf('Assert-E1SelfInstallRunnerArguments $scriptName $arguments'));
  });

  it('keeps the guest Codex preflight offline, closed, and privacy-safe', () => {
    const probe = read('docs/audits/evidence1-hyperv-verify-guest-codex-preflight-direct.ps1');

    expect(probe).toContain('& $codex.Source login status *> $null');
    expect(probe).toContain("'tools\\agentic-eval\\codex-offline-preflight.mjs'");
    expect(probe).toContain('Get-Evidence1CanonicalE2EVmIdentity');
    expect(probe).toContain('$env:KMP_EVAL_BASH_PATH = $canonicalGitBash');
    expect(probe).toContain("$env:CODEX_HOME = 'C:\\Evidence1RuntimeState\\codex'");
    expect(probe).toContain("$env:KMP_EVAL_CODEX_HOME = 'C:\\Evidence1RuntimeState\\codex'");
    expect(probe).toContain("$env:KMP_EVAL_CODEX_RUNTIME_ROOT = 'C:\\Evidence1RuntimeState'");
    expect(probe).toContain('offline_reason_code');
    expect(probe).toContain('inference_sessions_consumed = 0');
    expect(probe).toContain('product_skill_available');
    expect(probe).toContain('baseline_skill_available');
    expect(probe).toContain('ambient_equivalent');
    expect(probe).toContain('codex_auth_material_read = $false');
    expect(probe).toContain('guest_windows_credential_value_persisted = $false');
    expect(probe).toContain('raw_remote_output_persisted = $false');
    expect(probe).not.toMatch(/codex\s+exec|AUTH_CANARY|--prompt|-p\s/);
    expect(probe).not.toMatch(/Exception\.Message\s*[|>]|Write-(Host|Output)[^\n]*offlineOutput/i);
  });

  it('provisions only the verified Codex binary and never transfers auth state', () => {
    const installer = read('docs/audits/evidence1-hyperv-install-guest-codex-cli-direct.ps1');

    expect(installer).toContain("Join-Path $env:LOCALAPPDATA 'OpenAI\\Codex\\bin'");
    expect(installer).toContain('Get-FileHash -Algorithm SHA256');
    expect(installer).toContain("Get-ChildItem -LiteralPath $trustedHostRoot -Filter 'codex.exe'");
    expect(installer).toContain('Assert-PathInside $candidatePath $trustedHostRoot');
    expect(installer).toContain('Copy-Item -LiteralPath $hostCodexPath');
    expect(installer).toContain('auth_material_copied = $false');
    expect(installer).toContain('codex_auth_material_read = $false');
    expect(installer).toContain('guest_windows_credential_used_for_powershell_direct = $true');
    expect(installer).toContain('guest_windows_credential_value_persisted = $false');
    expect(installer).toContain('network_used_inside_guest = $false');
    expect(installer).toContain('inference_sessions_consumed = 0');
    expect(installer).toContain("$AuthorizationPhrase -cne 'authorize legacy codex migration-only install outside canonical toolchain'");
    expect(installer).toContain('canonical_toolchain = $false');
    expect(installer).toContain('benchmark_eligible = $false');
    expect(installer).toContain('migration_only = $true');
    expect(installer).not.toMatch(/auth\.json|['"]\.codex|OPENAI_API_KEY|login\s/);
    expect(installer).not.toMatch(/USERPROFILE|credential.*Copy-Item|Copy-Item.*credential/i);
    expect(installer).not.toContain('PSComputerName');
  });

  it('upgrades the canonical Codex runtime from the complete official package without hardcoded artifact identity', () => {
    const updater = read('docs/audits/evidence1-hyperv-upgrade-canonical-codex-cli-direct.ps1');

    expect(updater).toContain('[Parameter(Mandatory)][string]$ExpectedArtifactSha256');
    expect(updater).toContain('[Parameter(Mandatory)][long]$ExpectedArtifactBytes');
    expect(updater).toContain('[Parameter(Mandatory)][string]$ExpectedCodexVersion');
    expect(updater).toContain("'bin\\codex-code-mode-host.exe'");
    expect(updater).toContain("'codex-resources\\codex-command-runner.exe'");
    expect(updater).toContain("'codex-resources\\codex-windows-sandbox-setup.exe'");
    expect(updater).not.toMatch(/\$ExpectedArtifactSha256\s*=\s*'[0-9a-f]{64}'/);
    expect(updater).toContain('Get-Evidence1CanonicalE2EVmIdentity');
    expect(updater).toContain('Get-AuthenticodeSignature -LiteralPath');
    expect(updater).toContain("$publisherSignedRelativeFiles = [string[]]@(");
    expect(updater).toContain("if ($publisherSignedRelativeFiles -ccontains $relative)");
    expect(updater).toContain("if ($PublisherSignedRelativeFiles -ccontains $relative)");
    expect(updater).not.toContain("if ($item.Extension -ieq '.exe')");
    expect(updater).not.toContain("Join-Path $env:TEMP ('Evidence1Codex");
    expect(updater).toContain("Join-Path (Split-Path -Parent $Root) ('Evidence1CodexHostProbe-");
    expect(updater).toContain("Join-Path (Split-Path -Parent $Root) ('Evidence1CodexGuestProbe-");
    expect(updater).toContain("Join-Path 'C:\\Evidence1Toolchain\\codex-cli' $ExpectedCodexVersion");
    expect(updater).toContain('companion_binaries_present=$true');
    expect(updater).toContain('prior_runtime_retained=(Test-Path -LiteralPath $PriorRoot)');
    expect(updater).toContain('auth_material_read=$false');
    expect(updater).toContain('auth_material_copied=$false');
    expect(updater).toContain('network_used=$false');
    expect(updater).toContain('inference_sessions_consumed=0');
    expect(updater).not.toMatch(/auth\.json|login\s|codex\s+exec|OPENAI_API_KEY/i);
    expect(updater).not.toContain('Remove-Item -LiteralPath $priorRoot');
  });

  it('bounds Codex device-auth egress and fails closed without content capture', () => {
    const authWindow = read('docs/audits/evidence1-hyperv-open-codex-auth-window-direct.ps1');

    expect(authWindow).toContain("'https://auth.openai.com'");
    expect(authWindow).toContain("$watchdogTaskName = 'Evidence1CodexAuthEgressExpiry'");
    expect(authWindow).toContain('-DefaultInboundAction Block -DefaultOutboundAction Allow');
    expect(authWindow).toContain('-DefaultInboundAction Block -DefaultOutboundAction Block');
    expect(authWindow).toContain('must_reseal_before_readiness_or_live = $true');
    expect(authWindow).toContain('network_response_content_persisted = $false');
    expect(authWindow).toContain('codex_auth_material_read = $false');
    expect(authWindow).toContain('inference_sessions_consumed = 0');
    expect(authWindow).toContain("$AuthorizationPhrase -cne 'authorize bounded codex authentication egress for canonical toolchain'");
    expect(authWindow).toContain("$markerPath = 'C:\\Evidence1Toolchain\\toolchain-marker.json'");
    expect(authWindow).toContain("$codexStateRoot = 'C:\\Evidence1RuntimeState\\codex'");
    expect(authWindow).toContain('Get-AuthenticodeSignature -LiteralPath $codexPath');
    expect(authWindow).toContain('canonical_toolchain = $true');
    expect(authWindow).not.toMatch(/auth\.json|OPENAI_API_KEY|device[_-]?code|access[_-]?token/i);
    expect(authWindow).not.toContain('PSComputerName');
  });

  it('inspects the Windows ISO read-only without persisting its private path', () => {
    const inspector = read('docs/audits/evidence1-host-inspect-windows-iso.ps1');

    expect(inspector).toContain('Mount-DiskImage -ImagePath $isoFull -Access ReadOnly');
    expect(inspector).toContain('$imagePaths = @(@(');
    expect(inspector).toContain('Get-WindowsImage -ImagePath $imagePaths[0]');
    expect(inspector).toContain("-Index ([int]$_.ImageIndex)");
    expect(inspector).toContain('([uint32]$_.MajorVersion)');
    expect(inspector).toContain('([uint32]$_.SPBuild)');
    expect(inspector).toContain("$_.edition_id -ceq 'Professional'");
    expect(inspector).toContain('private_path_persisted = $false');
    expect(inspector).toContain('temporary_mount_performed = $temporaryMountPerformed');
    expect(inspector).toContain('persistent_mutation_performed = $false');
    expect(inspector).toContain('inference_sessions_consumed = 0');
    expect(inspector).toContain('"iso_inspection_failed_$phase"');
    expect(inspector).toContain('Dismount-DiskImage -ImagePath $IsoPath');
    expect(inspector).not.toMatch(/Start-VM|Stop-VM|New-VM|Start-Process|Invoke-Expression/i);
  });

  it('allows only the collision-safe canonical E2E profile through the elevated creator wrapper', () => {
    const creator = read('docs/audits/evidence1-host-create-canonical-windows-vm.ps1');

    expect(creator).toContain("$RequiredPhrase = 'authorize create evidence1 windows vm from verified inputs'");
    expect(creator).toContain("[ValidateSet('Create', 'InspectCreated')] [string]$Mode = 'Create'");
    expect(creator).toContain("$profile = Join-Path $repoRoot 'tools\\evidence1\\provisioning\\evidence1-windows-hyperv-e2e-v1.json'");
    expect(creator).toContain("$creator = Join-Path $repoRoot 'tools\\evidence1\\provisioning\\evidence1-windows-vm.ps1'");
    expect(creator).toContain("Assert-PathInside $InputLockPath 'C:\\kmp-eval\\scratch\\'");
    expect(creator).toContain("Assert-PathInside $ReceiptPath 'C:\\kmp-eval\\scratch\\'");
    expect(creator).toContain("$hostContract = Join-Path $PSScriptRoot 'evidence1-host-snapshot-contract.psm1'");
    expect(creator).toContain('$trustedRuntimeFiles = @(');
    expect(creator).toContain("'tools/evidence1/provisioning/evidence1-windows-vm.ps1'");
    expect(creator).toContain('Resolve-E1HostTrustedRuntime -ScriptRoot $PSScriptRoot');
    expect(creator).toContain("-Mode Create");
    expect(creator).toContain("-Mode InspectCreated");
    expect(creator).not.toMatch(/InspectInstalled|\bValidate\b/);
    expect(creator).not.toMatch(/Start-VM|Stop-VM|Remove-VM|Remove-Item|VMConnect|Invoke-Expression/i);
  });

  it('deletes only the receipt-bound failed canonical E2E VM', () => {
    const remover = read('docs/audits/evidence1-host-delete-failed-canonical-windows-vm.ps1');

    expect(remover).toContain("$RequiredPhrase = 'authorize delete failed Evidence1-Runner-E2E'");
    expect(remover).toContain("$CanonicalVmName = 'Evidence1-Runner-E2E'");
    expect(remover).toContain("$CanonicalVmRoot = 'C:\\kmp-eval\\hyperv-e2e'");
    expect(remover).toContain("Assert-PathInside $FailedReceiptPath 'C:\\kmp-eval\\scratch\\'");
    for (const reason of ['offline_apply_deadline_exceeded', 'dism_apply_unattend_failed', 'powershell_direct_deadline_exceeded']) {
      expect(remover).toContain(`'${reason}'`);
    }
    expect(remover).toContain('Get-E1ProvisioningPlan $profilePath $inputLockFull -AllowSealedRuntimeCommitDrift');
    expect(remover).toContain('Assert-E1FailedVmDeleteReceipt $failed ([string]$profile.profile_id) $inputLockSha $expectedVmIdNormalized');
    expect(remover).toContain('[string]$Failed.input_lock_sha256 -cne $InputLockSha');
    expect(remover).toContain('[string]$Failed.reason_code -cnotin $AllowedFailureReasons');
    expect(remover).toContain('failure_reason = [string]$failed.reason_code');
    expect(remover).toContain('([string]$Failed.vm_id).ToLowerInvariant() -cne $ExpectedVmIdNormalized');
    expect(remover).toContain('Assert-NoReparseTree $vmDir');
    expect(remover).toContain("$expectedVmIdNormalized.ToUpperInvariant() + '.vmcx'");
    expect(remover).toContain('Get-E1FileIdentity $expectedIsoPath $plan.iso.sha256');
    expect(remover).toContain("[string]$vm.State -cne 'Off'");
    expect(remover).toContain('$snapshots.Count -ne 0');
    expect(remover).toContain('Remove-VM -VM $vm -Force -ErrorAction Stop');
    expect(remover).toContain('Remove-Item -LiteralPath $vmDir -Recurse -Force -ErrorAction Stop');
    expect(remover).toContain('inference_sessions_consumed = 0');
    expect(remover).not.toMatch(/Start-VM|Stop-VM|Connect-VMNetworkAdapter|VMConnect|Invoke-Expression/i);
  });

  it.skipIf(process.platform !== 'win32')('accepts only fully attested Recovery custody for failed VM deletion', () => {
    const script = String.raw`
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:E1_REMOVER,[ref]$tokens,[ref]$errors)
$definition=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Assert-E1FailedVmDeleteReceipt'},$true))
if($errors.Count -or $definition.Count -ne 1){exit 2}
. ([scriptblock]::Create($definition[0].Extent.Text))
$script:AllowedFailureReasons=@('offline_apply_failed','offline_apply_deadline_exceeded','dism_apply_image_failed','dism_apply_unattend_failed','recovery_gpt_attributes_mismatch','powershell_direct_deadline_exceeded','operator_recovery')
$sha='a'*64;$vmId='11111111-1111-1111-1111-111111111111'
$recovery=[pscustomobject]@{
  schema=1;verdict='FAIL';mode='Recovery';reason_code='recovery_gpt_attributes_mismatch';profile_id='evidence1-windows-hyperv-e2e-v1'
  input_lock_sha256=$sha;vm_id=$vmId;network_used=$false;private_paths_persisted=$false;credential_value_persisted_in_receipt=$false
  auth_material_read=$false;auth_material_copied=$false;inference_sessions_consumed=0;vm_state='Off';network_state='disconnected'
  vhd_partition_style='GPT';original_iso_is_only_dvd=$true;host_iso_mounted_after_operation=$false;host_vhd_mounted_after_operation=$false;answer_files_absent=$true
  authorization_marker_created=$true;authorization_marker_sha256=$sha;custody_source='authorization-marker';guest_credential_preserved=$true
  start_count=$null;start_count_reason='worker_start_telemetry_unavailable';mutation_performed=$null;mutation_reason='worker_mutation_telemetry_unavailable'
  receipt_source='elevated-runner-recovery'
}
Assert-E1FailedVmDeleteReceipt $recovery 'evidence1-windows-hyperv-e2e-v1' $sha $vmId
$operatorRecovery=$recovery.PSObject.Copy();$operatorRecovery.reason_code='operator_recovery'
Assert-E1FailedVmDeleteReceipt $operatorRecovery 'evidence1-windows-hyperv-e2e-v1' $sha $vmId
$directDeadline=$recovery.PSObject.Copy();$directDeadline.reason_code='powershell_direct_deadline_exceeded'
Assert-E1FailedVmDeleteReceipt $directDeadline 'evidence1-windows-hyperv-e2e-v1' $sha $vmId
$bad=$recovery.PSObject.Copy();$bad.answer_files_absent=$false
try{Assert-E1FailedVmDeleteReceipt $bad 'evidence1-windows-hyperv-e2e-v1' $sha $vmId;exit 3}catch{if($_.Exception.Message -cne 'failed_vm_delete_prior_receipt_not_authoritative'){throw}}
$bad=$recovery.PSObject.Copy();$bad.host_vhd_mounted_after_operation=$true
try{Assert-E1FailedVmDeleteReceipt $bad 'evidence1-windows-hyperv-e2e-v1' $sha $vmId;exit 4}catch{if($_.Exception.Message -cne 'failed_vm_delete_prior_receipt_not_authoritative'){throw}}
exit 0
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, E1_REMOVER: resolve(root, 'docs/audits/evidence1-host-delete-failed-canonical-windows-vm.ps1') },
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it('runs unattended Windows only through the fixed E2E profile and private scratch paths', () => {
    const installer = read('docs/audits/evidence1-host-install-canonical-windows-unattended.ps1');

    expect(installer).toContain("$RequiredPhrase = 'authorize install evidence1 e2e windows unattended offline'");
    expect(installer).toContain("$RequiredRetryPhrase = 'authorize exactly one evidence1 e2e windows unattended retry'");
    expect(installer).toContain("$profile = Join-Path $repoRoot 'tools\\evidence1\\provisioning\\evidence1-windows-hyperv-e2e-v1.json'");
    expect(installer).toContain("$implementation = Join-Path $repoRoot 'tools\\evidence1\\provisioning\\evidence1-install-windows-unattended.ps1'");
    expect(installer).toContain("Assert-PathInside $InputLockPath 'C:\\kmp-eval\\scratch\\'");
    expect(installer).toContain("Assert-PathInside $GuestCredentialPath 'C:\\kmp-eval\\scratch\\'");
    expect(installer).toContain("Assert-PathInside $AnswerMediaPath 'C:\\kmp-eval\\scratch\\'");
    expect(installer).toContain("Assert-PathInside $ReceiptPath 'C:\\kmp-eval\\scratch\\'");
    expect(installer).toContain("Assert-PathInside $PriorFailureReceiptPath 'C:\\kmp-eval\\scratch\\'");
    expect(installer).toContain("throw 'canonical_unattended_private_root_mismatch'");
    expect(installer).toContain("throw 'canonical_unattended_private_root_already_exists'");
    expect(installer).toContain("throw 'exact_unattended_retry_authorization_required'");
    expect(installer).toContain("throw 'retry_guest_credential_missing'");
    expect(installer).toContain('[switch]$RecoveryOnly');
    expect(installer).toContain('-ReceiptPath $ReceiptPath -RecoveryOnly');
    expect(installer).toContain("'tools/evidence1/provisioning/evidence1-install-windows-unattended.ps1'");
    expect(installer).toContain('$implementationArgs.PriorFailureReceiptPath = $priorFailureFull');
    expect(installer).toContain('& $implementation');
    expect(installer).not.toMatch(/Evidence1-Runner(?:'|\")|VMConnect|Connect-VMNetworkAdapter|Remove-VM|Invoke-Expression/i);
  });

  it('keeps interactive auth recovery bounded, privacy-safe, and reversible', () => {
    const egress = read('docs/audits/evidence1-hyperv-open-temporary-auth-egress.ps1');
    const login = read('docs/audits/evidence1-hyperv-open-claude-login-interactive-task.ps1');
    const vmconnect = read('docs/audits/evidence1-hyperv-open-vmconnect.ps1');
    const reseal = read('docs/audits/evidence1-hyperv-run-network-seal-direct.ps1');
    const seal = read('docs/audits/evidence1-stageb-network-seal.ps1');

    expect(egress).toContain("temporary_auth_window = $true");
    expect(egress).toContain("must_reseal_before_readiness_or_live = $true");
    expect(egress).toContain("-DefaultOutboundAction Allow");
    expect(egress).toContain("Evidence1AuthEgressExpiry");
    expect(egress).toContain("'accounts.google.com'");
    expect(egress).toContain("'oauth2.googleapis.com'");
    expect(egress).toContain('auth_probe_host_count');
    expect(egress).toContain('auth_probe_success_count');
    expect(egress).toContain('Invoke-AuthEndpointProbe');
    expect(egress).toContain('auth endpoint probe failed');
    expect(egress).toContain('watchdog_setup_failed');
    expect(egress).toContain('quic_policy_failed');
    expect(egress).toContain('firewall_open_failed');
    expect(egress).toContain('auth_endpoint_probe_failed');
    expect(egress).toContain('fail_closed_cleanup_failed');
    expect(egress).toContain('transport_hresult');
    expect(egress).not.toMatch(/exception_message|error_message/i);
    expect(egress).toContain("-UserId 'SYSTEM' -LogonType ServiceAccount");
    expect(egress).toContain('-StartWhenAvailable');
    expect(egress).toContain("if ($VMName -cne 'Evidence1-Runner')");
    expect(egress).toContain("if ($GuestComputerName -cne 'Evidence1Runner')");
    expect(egress).toContain("if ($GuestCredentialPath -cne 'C:\\kmp-eval\\scratch\\hyperv-create-runner\\Evidence1-Runner.guest-credential.clixml')");
    expect(egress).toContain("if ($simpleUser -cne 'Evidence1')");
    expect(egress.indexOf('Register-ScheduledTask')).toBeLessThan(egress.indexOf('-DefaultOutboundAction Allow'));
    expect(egress).toContain('auth-egress cleanup could not verify outbound blocking');
    expect(egress).not.toMatch(/command_line|password_value|secret_value/i);
    expect(egress).not.toMatch(/powershell_direct_logon|logon_name\s*=/i);
    expect(egress).not.toMatch(/response_body|resolved_address/i);

    expect(login).toContain("Join-Path $env:USERPROFILE 'Desktop\\Claude Login.cmd'");
    expect(login).not.toMatch(/C:\\Users\\/i);
    expect(login).toContain("if ($VMName -cne 'Evidence1-Runner')");
    expect(login).toContain("if ($GuestComputerName -cne 'Evidence1Runner')");
    expect(login).toContain("-LogonType Interactive");
    expect(login).toContain("operator_login_required = $true");
    expect(login).toContain("auth_content_read = $false");
    expect(login).not.toMatch(/CommandLine|Get-Content[^\r\n]*\.claude/i);
    expect(login).not.toMatch(/powershell_direct_logon|logon_name\s*=/i);

    expect(vmconnect).toContain("vmconnect.exe");
    expect(vmconnect).toContain("if ($VMName -cne 'Evidence1-Runner')");
    expect(vmconnect).toContain("Evidence1OpenVmConnect");
    expect(vmconnect).toContain('-LogonType Interactive');
    expect(vmconnect).not.toContain('Start-Process -FilePath $vmconnect -ArgumentList');
    expect(vmconnect).not.toMatch(/SendKeys|WScript\.Shell|ClaudeCommand/i);

    expect(reseal).toContain("evidence1-stageb-network-seal.ps1");
    expect(reseal).toContain("stopped_auth_processes = $true");
    expect(reseal).toContain("Unregister-ScheduledTask");
    expect(reseal).toContain("remaining_auth_process_count");
    expect(reseal).toContain("Join-Path $PSScriptRoot 'evidence1-stageb-network-seal.ps1'");
    expect(reseal).toContain('Get-Evidence1CanonicalE2EVmIdentity');
    expect(reseal).toContain('Connect-VMNetworkAdapter -VMNetworkAdapter $adapter');
    expect(reseal).toContain('Disconnect-VMNetworkAdapter -VMNetworkAdapter $adapter');
    expect(reseal).toContain("[string]$ProfilePath = ''");
    expect(reseal).toContain("[string]$CreatedInspectionReceiptPath = ''");
    expect(reseal).toContain('$candidates = @(\n  if ($canonicalIdentity)');
    expect(reseal).toContain('$resealCompleted = $false');
    expect(reseal).toContain('if (-not $resealCompleted -and $connectedByReseal)');
    expect(reseal).toContain('Disconnect-VMNetworkAdapter -VMNetworkAdapter $currentAdapter');
    expect(reseal).toContain("if ($VMName -cne 'Evidence1-Runner')");
    expect(reseal).toContain("if ($GuestComputerName -cne 'Evidence1Runner')");
    expect(reseal).toContain('failure_code');
    expect(reseal).toContain('auth_process_cleanup_incomplete');
    expect(reseal).toContain('network_seal_execution_failed');
    expect(reseal).toContain('network_seal_result_invalid');
    expect(reseal).toContain('watchdog_cleanup_failed');
    expect(reseal).toContain('session_open_failed');
    expect(reseal).toContain('payload_copy_failed');
    expect(reseal).toContain('guest_invoke_failed');
    expect(reseal).toContain('transport_hresult');
    expect(reseal).toContain('Receive-Job -Job $job -ErrorAction SilentlyContinue');
    expect(reseal).not.toContain('Receive-Job -Job $job -ErrorAction Stop');
    expect(reseal).toContain("record_type = 'transport_stage'");
    const workerBlock = reseal.slice(
      reseal.indexOf('$job = Start-Job'),
      reseal.indexOf('} -ArgumentList $VMName'),
    );
    expect(workerBlock).not.toMatch(/(?<!\[pscustomobject\])\[ordered\]@\{/);
    expect(workerBlock.match(/\[pscustomobject\]\[ordered\]@\{/g)).toHaveLength(7);
    expect(reseal).toMatch(
      /credential_materialization_failed[\s\S]*\[pscredential\]::new[\s\S]*session_open_failed[\s\S]*New-PSSession[\s\S]*payload_copy_failed[\s\S]*Copy-Item[\s\S]*guest_invoke_failed[\s\S]*Invoke-Command/,
    );
    expect(reseal).toContain('worker_job_state');
    expect(reseal).toContain('worker_error_count');
    expect(reseal).toContain('worker_error_hresult');
    expect(reseal).not.toMatch(/worker_error_message|job_reason_message/i);
    expect(reseal).not.toMatch(/exception_message|error_message/i);
    expect(reseal).not.toContain("error = 'powershell_direct_failed'");
    expect(reseal).not.toMatch(/\[string\]\$NetworkSealSourcePath/);
    expect(reseal).not.toMatch(/powershell_direct_logon|logon_name\s*=/i);
    expect(seal).toContain("-DefaultOutboundAction Block");
    expect(seal).toContain("network_mode = 'restricted'");
    expect(seal).toContain('finally {');
    expect(seal).toContain('$sealCompleted = $true');
    expect(seal).toContain('$DeadlineSeconds = 300');
    expect(seal).not.toMatch(/allow DNS (UDP|TCP)/);
    expect(seal).not.toContain('output_first_line');
  });

  it('documents the no-live boundary for the host toolkit', () => {
    const doc = read('docs/audits/evidence1-hyperv-ops-toolkit.md');
    expect(doc).toContain('does not authorize live sessions');
    expect(doc).toContain('Do not run another live campaign from this PR');
    expect(doc.toLowerCase()).toContain('raw transcript');
    expect(doc).toContain('TargetCommit');
    expect(doc).toContain('TargetTree');
    expect(doc).toContain('remote-auth canary');
    expect(doc).toContain('local credential presence');
    expect(doc).toContain('evidence1-hyperv-start-authorized-live.ps1');
    expect(doc).toContain('Running + verified -> Off -> Armed -> Running');
  });

  it('owns the live state transition without a hard power cut', () => {
    const handoff = read('docs/audits/evidence1-hyperv-start-authorized-live.ps1');

    expect(handoff).toContain('Assert-Evidence1LiveHandoffEvidence');
    expect(handoff).toContain('Assert-Evidence1PreviousRunCustody');
    expect(handoff).toContain('Stop-VM -Name $VMName -Confirm:$false -AsJob');
    expect(handoff).toContain('Start-VM -Name $VMName');
    expect(handoff).toContain('previous handoff and copied terminal custody run_id mismatch');
    expect(handoff).toContain('Archive-PreviousHandoff');
    expect(handoff).toContain('Test-E1ClosedPrestartCanaryHandoff');
    expect(handoff).toContain('$archiveHandoffRunId = [string]$existingHandoff.run_id');
    expect(handoff).toContain('Archive-PreviousHandoff $archiveHandoffRunId');
    expect(handoff).toContain('Get-Evidence1CanonicalE2EVmIdentity');
    expect(handoff).toContain('$VMName=$vmIdentity.vm_name');
    expect(handoff).not.toContain('6e5848f5-37dd-4653-9f3d-df2871e6293a');
    expect(handoff).toContain('$ReadinessMaxAgeMinutes = 60');
    expect(handoff).toContain('$RemoteAuthMaxAgeMinutes = 30');
    expect(handoff).not.toContain('[string]$ReadinessReportPath');
    expect(handoff).not.toContain('[int]$RemoteAuthMaxAgeMinutes');
    expect(handoff).not.toContain('-TurnOff');
    expect(handoff).not.toContain('Stop-VM -Name $VMName -Force');

    const stopIndex = handoff.indexOf('Stop-VM -Name $VMName -Confirm:$false -AsJob');
    const placeIndex = handoff.indexOf('Invoke-PlaceLiveAutorun $script:PriorCustody.run_id');
    const startIndex = handoff.indexOf('Start-VM -Name $VMName');
    const initialStateIndex = handoff.indexOf('$initialState = Get-VMStateName $VMName');
    const canaryBindingIndex = handoff.indexOf('$script:Canary = New-Evidence1CanaryHostBundle');
    expect(stopIndex).toBeGreaterThan(0);
    expect(placeIndex).toBeGreaterThan(stopIndex);
    expect(startIndex).toBeGreaterThan(placeIndex);
    expect(initialStateIndex).toBeGreaterThan(0);
    expect(canaryBindingIndex).toBeGreaterThan(initialStateIndex);
  });

  it('refuses to replace an already armed live autorun', () => {
    const place = read('docs/audits/evidence1-hyperv-place-live-autorun.ps1');

    expect(place).toContain('existing live autorun');
    expect(place).toContain('refusing to replace');
    expect(place).toContain("area = 'scratch'; name = 'STAGE-B-live.log'");
    expect(place).toContain('archived_operational_artifacts');
    expect(place).not.toContain("Remove-Required (Join-Path $startupDir 'Evidence1RunLive.cmd')");
  });

  it('requires a fresh remote-auth canary before a live launch', () => {
    const launcher = read('docs/audits/evidence1-stageb-live-launch.ps1');
    const verifier = read('docs/audits/evidence1-hyperv-verify-guest-claude-auth-direct.ps1');
    const dualVerifier = read('docs/audits/evidence1-hyperv-verify-guest-dual-auth-direct.ps1');
    const dualGuest = read('docs/audits/evidence1-guest-dual-auth-canary.ps1');
    const contract = read('docs/audits/evidence1-live-handoff-contract.psm1');
    let checkpoint; try { checkpoint = read('docs/audits/evidence1-hyperv-finalize-auth-checkpoint-offline.ps1'); } catch { checkpoint = null; }

    expect(launcher).toContain('Assert-RemoteAuthCanary');
    expect(launcher).toContain("'ANTHROPIC_AUTH_TOKEN'");
    expect(launcher).toContain("'CLAUDE_CODE_OAUTH_TOKEN'");
    expect(launcher).toContain("check_kind = 'local_credential_presence_only'");
    expect(launcher).toContain('remote_credential_validated = $false');
    expect(launcher).toContain('Assert-Evidence1DualRemoteAuthCanary');
    expect(launcher).toContain("check_kind = 'dual_remote_inference_auth_canary'");
    expect(contract).toContain("'http_statuses'");
    expect(contract).toContain("'runtime_does_not_expose_http_status'");
    expect(verifier).toContain('[switch]$RunRemoteAuthCanary');
    expect(verifier).toContain("$EvidenceRunId = 'EVIDENCE' + '1'");
    expect(verifier).toContain('$RequiredRemoteAuthCanaryPhrase');
    expect(verifier).toContain("raw_content_persisted = $false");
    expect(verifier).toContain("raw_content_printed = $false");
    expect(verifier).toContain("'-p', 'Return exactly AUTH_CANARY_OK. Do not use tools, files, or network tools.'");
    expect(verifier).not.toContain("'--bare'");
    expect(verifier).toContain("'--setting-sources', 'user'");
    expect(verifier).toContain("'--disable-slash-commands'");
    expect(verifier).toContain("'--tools', ''");
    expect(verifier).toContain("'--strict-mcp-config'");
    expect(verifier).toContain("'--mcp-config', $mcpConfigPath");
    expect(verifier).toContain("Join-Path $env:TEMP 'evidence1-auth-canary'");
    expect(dualVerifier).toContain('[Parameter(Mandatory = $true)][string]$OperationId');
    expect(dualVerifier).toContain('Get-Evidence1CanonicalE2EVmIdentity');
    expect(dualVerifier).toContain('$VMName = $vmIdentity.vm_name');
    expect(dualVerifier).not.toContain('6e5848f5-37dd-4653-9f3d-df2871e6293a');
    expect(dualGuest).toContain("runtime_id = 'claude-code'; dispatch_ordinal = 1");
    expect(dualGuest).toContain("runtime_id = 'codex-cli'; dispatch_ordinal = 2");
    expect(dualGuest).toContain("'exec', '--json', '--ephemeral'");
    expect(dualGuest).toContain("tools_disabled = $null; tool_observation = 'observed_zero_tool_items'");
    expect(dualGuest).toContain('Write-E1CreateNewJson $claimPath');
    if (checkpoint !== null) {
      expect(checkpoint).toContain('does not prove that the remote service accepts the credential');
      expect(checkpoint).toContain('run the separately authorized remote auth canary');
    }
  });

  it('treats Git stderr as diagnostic output and decides success from its exit code', () => {
    for (const file of [
      'docs/audits/evidence1-hyperv-update-harness-from-bundle.ps1',
      'docs/audits/evidence1-hyperv-regenerate-readiness-direct.ps1',
    ]) {
      const source = read(file);
      expect(source).toContain('$previousErrorActionPreference = $ErrorActionPreference');
      expect(source).toContain("$ErrorActionPreference = 'Continue'");
      expect(source).toContain('$ErrorActionPreference = $previousErrorActionPreference');
      expect(source).toContain('$exit = $LASTEXITCODE');
    }
    const updater = read('docs/audits/evidence1-hyperv-update-harness-from-bundle.ps1');
    expect(updater).toContain('git.exe -C $HarnessDir init --initial-branch=evidence1');
    expect(updater).not.toContain('git.exe -C $HarnessDir init 2>&1');
  });

  it('scopes Git safe.directory to the exact pinned host repositories for SYSTEM operations', () => {
    const readiness = read('docs/audits/evidence1-hyperv-regenerate-readiness-direct.ps1');
    const updater = read('docs/audits/evidence1-hyperv-update-harness-from-bundle.ps1');
    const sourceSync = read('docs/audits/evidence1-hyperv-sync-final-codex-source.ps1');
    const hostContract = read('docs/audits/evidence1-final-codex-host-contract.psm1');
    expect(readiness).toContain("@('-c', \"safe.directory=$SourceRepoDir\") + $Arguments");
    expect(updater).toContain("@('-c', \"safe.directory=$SourceRepoDir\") + $Arguments");
    expect(sourceSync).toContain("@('-c', \"safe.directory=$SourcePath\", '-C', $SourcePath)");
    expect(hostContract).toContain("@('-c', \"safe.directory=$actual\", '-C', $actual)");
    for (const source of [readiness, updater, sourceSync, hostContract]) {
      expect(source).not.toContain('git config --global --add safe.directory');
    }
  });

  it('treats successful readiness auth status stderr as native diagnostic output', () => {
    const readiness = read('docs/audits/evidence1-hyperv-regenerate-readiness-direct.ps1');
    expect(readiness).toContain('& $claude auth status *> $null');
    expect(readiness).toContain('$claudeAuthExit = $LASTEXITCODE');
    expect(readiness).toContain('& $codex login status *> $null');
    expect(readiness).toContain('$codexAuthExit = $LASTEXITCODE');
    expect(readiness).toContain("$ErrorActionPreference = 'Continue'");
    expect(readiness).toContain('if ($claudeAuthExit -ne 0)');
    expect(readiness).toContain('if ($codexAuthExit -ne 0)');
    expect(readiness).not.toContain('if ($LASTEXITCODE -ne 0) {\n        FailGuest "codex auth status');
  });

  it('uses a process-only execution-policy override in clean PowerShell Direct sessions', () => {
    const readiness = read('docs/audits/evidence1-hyperv-regenerate-readiness-direct.ps1');
    expect(readiness).toContain("Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force");
    expect(readiness).not.toContain('Set-ExecutionPolicy -Scope LocalMachine');
    expect(readiness.indexOf('Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force'))
      .toBeLessThan(readiness.indexOf('Import-Module $custodyModule'));
  });

  it('runs Codex device auth through a bounded fail-closed E2E operation', () => {
    const runner = read('docs/audits/evidence1-host-elevated-runner.ps1');
    const source = read('docs/audits/evidence1-hyperv-run-codex-device-auth-direct.ps1');
    expect(runner).toContain("'evidence1-hyperv-run-codex-device-auth-direct.ps1'");
    expect(source).toContain('Get-Evidence1CanonicalE2EVmIdentity');
    expect(source).toContain("login --device-auth");
    expect(source).toContain('Evidence1CodexDeviceAuthHostExpiry');
    expect(source).toContain('Disconnect-VMNetworkAdapter');
    expect(source).toContain('Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Block');
    expect(source).toContain('inference_sessions_consumed=0');
    expect(source).toContain('[string]::IsNullOrWhiteSpace([string]$_.SwitchId)');
    expect(source).toContain("[IO.FileShare]'ReadWrite,Delete'");
    expect(source).toContain('$PriorFailedOperationId');
    expect(source).toContain("$terminal-cne'PASS'");
    expect(source).toContain('$previousPreference=$ErrorActionPreference');
    expect(source).toContain("$ErrorActionPreference='Continue'");
    expect(source).toContain('$ErrorActionPreference=$previousPreference');
    expect(source).not.toContain("if([int]$existingAuth-eq0){$terminal='PASS'}else{");
    expect(source).toContain('[Parameter(Mandatory)][string]$ExpectedCodexAccount');
    expect(source).toContain("[string]$ExpectedCodexPlan='pro'");
    expect(source).toContain('Get-E1CodexAccountBinding');
    expect(source).toContain("$authClaimName='https://api.openai.com/auth'");
    expect(source).toContain("$legacyPlanClaim='https://api.openai.com/auth.chatgpt_plan_type'");
    expect(source).toContain("$authClaims.PSObject.Properties['chatgpt_plan_type'].Value");
    expect(source).toContain('$existingBinding.identity_matched -and $existingBinding.plan_matched');
    expect(source).toContain("& $codex logout *> $null");
    expect(source).toContain("throw 'codex_device_auth_account_binding_failed'");
    expect(source).toContain('auth.pre-$OperationId.json');
    expect(source).toContain('Copy-Item -LiteralPath $backup -Destination $auth -Force');
    expect(source).toContain('account_binding_verified=');
    expect(source.indexOf('$existingAuth=Invoke-Command')).toBeLessThan(source.indexOf('Connect-VMNetworkAdapter'));
    expect(source).toContain("$adapterInitiallyCanonical=$adapters[0].Connected-and[string]$adapters[0].SwitchName-ceq'Default Switch'");
    expect(source).toContain("throw 'codex_device_auth_initial_guest_firewall_not_sealed'");
    expect(source).toContain('if($adapterInitiallyIsolated){Connect-VMNetworkAdapter');
  });

  it('refreshes stale Codex OAuth non-interactively before verifying provider account-plan metadata', () => {
    const source = read('docs/audits/evidence1-hyperv-verify-guest-account-mapping-direct.ps1');
    expect(source).toContain("[string]$ExpectedClaudeSubscription = 'max'");
    expect(source).toContain("[string]$ExpectedClaudeRateLimitTier = 'default_claude_max_20x'");
    expect(source).toContain("[string]$ExpectedCodexPlan = 'pro'");
    expect(source).toContain('Get-ClaudeAccountBinding');
    expect(source).toContain('Get-CodexAccountBinding');
    expect(source).toContain("$authClaimName = 'https://api.openai.com/auth'");
    expect(source).toContain("$legacyPlanClaim = 'https://api.openai.com/auth.chatgpt_plan_type'");
    expect(source).toContain("$authClaims.PSObject.Properties['chatgpt_plan_type'].Value");
    expect(source).toContain("'user:inference'");
    expect(source).toContain("'user:sessions:claude_code'");
    expect(source).toContain('credential_sha256');
    expect(source).toContain('expires_at_utc');
    expect(source).toContain('provider_process_started = $false');
    expect(source).toContain('final_provider_sessions_consumed = 0');
    expect(source).toContain("$start.Arguments = 'app-server --listen stdio://'");
    expect(source).toContain("method = 'account/read'");
    expect(source).toContain('refreshToken = $true');
    expect(source).toContain('[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)');
    expect(source).toContain("[string]$message.id -ceq '1'");
    expect(source).toContain("[string]$message.id -ceq '2'");
    expect(source.indexOf('$process.StandardInput.Close()')).toBeGreaterThan(source.indexOf("[string]$message.id -ceq '2'"));
    expect(source).toContain('[Console]::InputEncoding = $previousInputEncoding');
    expect(source).toContain("throw 'codex_refresh_token_missing'");
    expect(source).toContain("throw 'codex_refresh_account_binding_failed'");
    expect(source).toContain('codex_refresh = [ordered]@{ attempted = $codexRefreshAttempted; succeeded = $codexRefreshSucceeded; inference_sessions_consumed = 0 }');
    expect(source).toContain('Disconnect-VMNetworkAdapter');
    expect(source).toContain('Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Block');
  });

  it('rotates only the canonical stale Codex attestation with rollback protection', () => {
    const runner = read('docs/audits/evidence1-host-elevated-runner.ps1');
    const source = read('docs/audits/evidence1-hyperv-rotate-final-codex-attestation.ps1');

    expect(runner).toContain("'evidence1-hyperv-rotate-final-codex-attestation.ps1'");
    expect(source).toContain("#Requires -RunAsAdministrator");
    expect(source).toContain("'C:\\kmp-eval\\measurement-scopes\\evidence1-codex-windows-isolation-attestation.json'");
    expect(source).toContain("throw 'exact_vm_must_be_off'");
    expect(source).toContain("'guest_attestation_missing_or_invalid'");
    expect(source).toContain("throw 'guest_attestation_invalid_oversize'");
    expect(source).toContain("$rotationReason = 'invalid_existing_attestation'");
    expect(source).toContain("'C:\\kmp-eval\\scratch\\evidence1-final-codex-auth\\prior-attestations'");
    expect(source).toContain('[IO.File]::Copy($guest, $invalidGuestArchive, $false)');
    expect(source).toContain("throw 'invalid_guest_archive_hash_mismatch'");
    expect(source).toContain("throw 'guest_attestation_not_stale'");
    expect(source).toContain('[IO.File]::Replace');
    expect(source).toContain('$guestReplaced = $true');
    expect(source).toContain('$hostReplaced = $true');
    expect(source).toContain('Restore-Attestation');
    expect(source).toContain('attestation_rotation_rollback_incomplete');
    expect(source).toContain('if ($cleanupBackups)');
    expect(source).toContain('host_guest_exact_bytes = $true');
    expect(source).toContain('invalid_guest_archived = (-not $oldGuestValid)');
    expect(source).toContain('raw_content_printed = $false');
    expect(source).not.toMatch(/Start-Process|Invoke-Expression|EncodedCommand/);
  });

  it('runs Claude subscription auth through a bounded fail-closed E2E operation', () => {
    const runner = read('docs/audits/evidence1-host-elevated-runner.ps1');
    const source = read('docs/audits/evidence1-hyperv-run-claude-auth-direct.ps1');
    expect(runner).toContain("'evidence1-hyperv-run-claude-auth-direct.ps1'");
    expect(source).toContain('Get-Evidence1CanonicalE2EVmIdentity');
    expect(source).toContain("auth login --claudeai");
    expect(source).toContain('Evidence1ClaudeAuthHostExpiry');
    expect(source).toContain('RedirectStandardInput=`$true');
    expect(source).toContain('auth-code.private.txt');
    expect(source).toContain('Disconnect-VMNetworkAdapter');
    expect(source).toContain('Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Block');
    expect(source).toContain('inference_sessions_consumed=0');
    expect(source).toContain("[IO.FileShare]'ReadWrite,Delete'");
    expect(source).toContain("$terminal-cne'PASS'");
    expect(source).toContain('$previousPreference=$ErrorActionPreference');
    expect(source).toContain("$ErrorActionPreference='Continue'");
    expect(source).toContain('$ErrorActionPreference=$previousPreference');
    expect((source.match(/\$code-cnotmatch'\^\[A-Za-z0-9_\-\]\+\#\[A-Za-z0-9_\-\]\+\$'/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(source).toContain("$adapterInitiallyCanonical=$adapters[0].Connected-and[string]$adapters[0].SwitchName-ceq'Default Switch'");
    expect(source).toContain("throw 'claude_auth_initial_guest_firewall_not_sealed'");
    expect(source).toContain('if($adapterInitiallyIsolated){Connect-VMNetworkAdapter');
    expect(source).toContain('[Parameter(Mandatory)][string]$ExpectedClaudeAccount');
    expect(source).toContain("throw 'claude_auth_account_binding_failed'");
    expect(source).toContain("Join-Path $config 'account-binding.json'");
    expect(source).toContain("identity_method='fresh_oauth_label_and_credential_fingerprint'");
  });

  it('warms and certifies the canonical Gradle cache before any live session', () => {
    const runner = read('docs/audits/evidence1-host-elevated-runner.ps1');
    const source = read('docs/audits/evidence1-hyperv-warm-canonical-gradle-cache-direct.ps1');
    expect(runner).toContain("'evidence1-hyperv-warm-canonical-gradle-cache-direct.ps1'");
    expect(source).toContain('Get-Evidence1CanonicalE2EVmIdentity');
    expect(source).toContain("':core:domain:test'");
    expect(source).toContain("':core:domain:createDemoDebugUnitTestCoverageReport'");
    expect(source).toContain("':core:domain:createProdDebugUnitTestCoverageReport'");
    expect(source).toContain("'--offline'");
    expect(source).toContain("'--rerun-tasks'");
    expect(source).toContain('Evidence1GradleCacheHostExpiry');
    expect(source).toContain('Disconnect-VMNetworkAdapter');
    expect(source).toContain('Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Block');
    expect(source).toContain("'C:\\Evidence1RuntimeState\\gradle-cache-certification.json'");
    expect(source).toContain('inference_sessions_consumed=0');
    expect(source).toContain('$gradleHome=');
    expect(source).not.toMatch(/\$home\s*=/i);
    expect((source.match(/\$previousErrorActionPreference=\$ErrorActionPreference/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect((source.match(/\$ErrorActionPreference=\$previousErrorActionPreference/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(source).toContain('return $value');
    expect(source).not.toContain('return$v');
    expect(source).toContain("$extendedCopy='\\\\?\\'+$copy");
    expect(source).toContain('cmd.exe /d /c rd /s /q $extendedCopy');
    expect(source).not.toContain('Remove-Item -LiteralPath $copy -Recurse -Force');
  });

  it('archives only untracked finalized scenario artifacts before updating the harness', () => {
    const updater = read('docs/audits/evidence1-hyperv-update-harness-from-bundle.ps1');

    expect(updater).toContain("'?? tools/runs/agentic-eval-scenario/'");
    expect(updater).toContain("git.exe ls-files --others --exclude-standard -- 'tools/runs/agentic-eval-scenario'");
    expect(updater).toContain("$scenarioArtifactRoot = 'tools/runs/agentic-eval-scenario/'");
    expect(updater).toContain('archived_untracked_scenario_files');
    expect(updater).toContain('content_read = $false');
    expect(updater).not.toContain("'tools\\runs\\agentic-eval-scenario'\n        ))");
  });

  it.skipIf(process.platform !== 'win32')('PowerShell Evidence1 ops entrypoints parse cleanly', () => {
    const fileList = portableOpsScripts
      .map(file => `'${resolve(root, file).replaceAll("'", "''")}'`)
      .join(',');
    const script = `
$hadError = $false
foreach ($path in @(${fileList})) {
  $tokens = $null
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count) {
    Write-Output "PARSE_ERROR:$path"
    $errors | ForEach-Object { Write-Output $_.Message }
    $hadError = $true
  }
}
if ($hadError) { exit 1 }
`;
    const parsed = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(parsed.status, `${parsed.stdout}${parsed.stderr}`).toBe(0);
  }, 35_000);

  it('diagnoses guest interactive logon read-only, bounded, and never touches the stored password value', () => {
    const script = read('docs/audits/evidence1-hyperv-inspect-guest-interactive-logon-diagnostic.ps1');
    expect(script).toContain('#Requires -RunAsAdministrator');
    expect(script).toContain("throw 'vm_must_already_be_running'");
    expect(script).toContain("throw 'report_path_not_canonical'");
    expect(script).toContain("throw 'report_must_be_create_new'");
    expect(script).toContain('[ValidateRange(30, 570)][int]$MaxWaitSeconds = 300');
    expect(script).toContain('$stored.Password');
    expect(script).not.toContain('DefaultPassword');
    expect(script).not.toContain('$stored.Password |');
    expect(script).toContain('winlogon_auto_admin_logon');
    expect(script).toContain('winlogon_default_user_name');
    expect(script).toContain('Get-Process -Name explorer -ErrorAction SilentlyContinue');
    expect(script).toContain('quser.exe');
    expect(script.match(/Set-Content/g) ?? []).toHaveLength(1);
  });

  it('enables guest auto-logon without ever returning the plaintext password to the host', () => {
    const script = read('docs/audits/evidence1-hyperv-enable-guest-auto-logon.ps1');
    expect(script).toContain("throw 'vm_must_already_be_running'");
    expect(script).toContain("throw 'report_path_not_canonical'");
    expect(script).toContain("throw 'report_must_be_create_new'");
    expect(script).toContain("throw 'no_direct_session_established'");
    expect(script).toContain("throw 'auto_logon_verification_failed'");
    expect(script).toContain("Set-ItemProperty -LiteralPath $winlogonPath -Name 'AutoAdminLogon' -Value '1'");
    expect(script).toContain("Set-ItemProperty -LiteralPath $winlogonPath -Name 'DefaultPassword' -Value $networkCredential.Password");
    expect(script).toContain("Remove-ItemProperty -LiteralPath $winlogonPath -Name 'AutoLogonCount'");
    expect(script).toContain('$result.auto_logon_count_present');
    expect(script).toContain('password_value_read_by_host = $false');
    // DefaultPassword is written once and compared once inside the remote scriptblock;
    // it is never assigned into the object that scriptblock returns, so no path from
    // $result to the report file can carry the plaintext value across the session.
    expect(script.match(/DefaultPassword/g) ?? []).toHaveLength(3);
    expect(script.match(/\$networkCredential\.Password/g) ?? []).toHaveLength(2);
  });

  it('runs the trusted stage-B network seal script in the guest and verifies its restricted-mode report', () => {
    const script = read('docs/audits/evidence1-hyperv-seal-final-codex-network.ps1');
    expect(script).toContain("throw 'vm_must_already_be_running'");
    expect(script).toContain("throw 'network_seal_script_missing'");
    expect(script).toContain('throw "network_seal_report_missing: is_admin=$isAdmin seal_error=$sealErrorMessage"');
    expect(script).toContain("throw 'network_seal_verification_failed'");
    expect(script).toContain("$sealScript = Join-Path $PSScriptRoot 'evidence1-stageb-network-seal.ps1'");
    expect(script).toContain('Invoke-Command -Session $session -FilePath $sealScript -ArgumentList $guestReportPath');
    // A failure inside the trusted seal script must surface its actual message here
    // instead of being indistinguishable from an unrelated logon-candidate failure.
    expect(script).toContain('[Security.Principal.WindowsBuiltInRole]::Administrator');
    expect(script).toContain('} catch {\n        $sealErrorMessage = $_.Exception.Message\n      }');
    expect(script).toContain("$verified.verdict -cne 'PASS' -or $verified.network_mode -cne 'restricted'");
    // The seal script itself is a manifest-pinned TrustedSupportFile, already hash-verified
    // by the elevated runner before this script can even start; it is invoked directly by
    // reference rather than copied or re-hashed here.
    const runner = read('docs/audits/evidence1-host-elevated-runner.ps1');
    expect(runner).toContain("'evidence1-stageb-network-seal.ps1',");
    expect(runner).toContain("'evidence1-hyperv-seal-final-codex-network.ps1',");
  });

  it('the trusted network-seal script pins allowed inference hosts and proves probe hosts stay blocked', () => {
    const script = read('docs/audits/evidence1-stageb-network-seal.ps1');
    expect(script).toContain("'api.anthropic.com'");
    expect(script).toContain("'auth.openai.com'");
    expect(script).toContain("'github.com'");
    expect(script).toContain("Fail 'restricted network probe reached a blocked destination'");
    expect(script).toContain("Fail \"$hostName was not reachable after the network seal\"");
    expect(script.indexOf('DefaultOutboundAction Allow')).toBeLessThan(script.indexOf('Set-PinnedHostsEntries $resolvedByHost'));
    expect(script.indexOf('Set-PinnedHostsEntries $resolvedByHost')).toBeLessThan(script.indexOf('DefaultOutboundAction Block'));
    expect(script).toContain("network_mode = 'restricted'");
  });
});
