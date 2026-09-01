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
  'docs/audits/evidence1-live-handoff-contract.psm1',
  'docs/audits/evidence1-hyperv-regenerate-readiness-direct.ps1',
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
  'docs/audits/evidence1-stageb-network-seal.ps1',
  'docs/audits/evidence1-cache-provision-host.psm1',
  'docs/audits/evidence1-hyperv-place-live-autorun.ps1',
  'docs/audits/evidence1-hyperv-read-live-progress.ps1',
  'docs/audits/evidence1-hyperv-copy-live-artifacts.ps1',
  'docs/audits/evidence1-hyperv-verify-guest-claude-auth-direct.ps1',
  'docs/audits/evidence1-hyperv-finalize-auth-checkpoint-offline.ps1',
  'docs/audits/evidence1-stageb-live-wrapper.ps1',
  'docs/audits/evidence1-stageb-live-launch.ps1',
  'docs/audits/evidence1-live-run-contract.psm1',
];

const elevatedRunnerAllowlist = [
  'evidence1-hyperv-copy-live-artifacts.ps1',
  'evidence1-hyperv-read-live-operational-tail.ps1',
  'evidence1-hyperv-read-live-progress.ps1',
  'evidence1-hyperv-regenerate-readiness-direct.ps1',
  'evidence1-hyperv-start-authorized-live.ps1',
  'evidence1-hyperv-verify-guest-claude-auth-direct.ps1',
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
  'evidence1-hyperv-run-network-seal-direct.ps1',
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

  it('uses the script directory as the default elevated-runner trust boundary', () => {
    const runner = read('docs/audits/evidence1-host-elevated-runner.ps1');
    const client = read('docs/audits/evidence1-host-elevated-runner-client.ps1');
    const install = read('docs/audits/evidence1-host-elevated-runner-install.ps1');

    expect(runner).toContain('Resolve-FullPath $PSScriptRoot');
    expect(client).toContain('Resolve-FullPath $PSScriptRoot');
    expect(install).toContain('Resolve-FullPath $PSScriptRoot');
    expect(install).toContain('Join-Path $AllowedRoot');
    expect(install).toContain('-AllowedRoot `"$AllowedRoot`"');
    expect(client).toContain('Assert-PathInside $scriptFull $AllowedRoot');
    expect(runner).toContain('Assert-PathInside $scriptPath $AllowedRoot');
  });

  it('limits the elevated runner to the versioned operational scripts only', () => {
    const runner = read('docs/audits/evidence1-host-elevated-runner.ps1');
    const allowlistBlock = runner.slice(runner.indexOf('$AllowedScripts = @('), runner.indexOf('function Resolve-FullPath'));
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
    expect(reseal).toContain("if ($VMName -cne 'Evidence1-Runner')");
    expect(reseal).toContain("if ($GuestComputerName -cne 'Evidence1Runner')");
    expect(reseal).toContain('failure_code');
    expect(reseal).toContain('auth_process_cleanup_incomplete');
    expect(reseal).toContain('network_seal_execution_failed');
    expect(reseal).toContain('network_seal_result_invalid');
    expect(reseal).toContain('watchdog_cleanup_failed');
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
    expect(handoff).toContain("$VMName = 'Evidence1-Runner'");
    expect(handoff).toContain('$ReadinessMaxAgeMinutes = 60');
    expect(handoff).toContain('$RemoteAuthMaxAgeMinutes = 30');
    expect(handoff).not.toContain('[string]$ReadinessReportPath');
    expect(handoff).not.toContain('[int]$RemoteAuthMaxAgeMinutes');
    expect(handoff).not.toContain('-TurnOff');
    expect(handoff).not.toContain('Stop-VM -Name $VMName -Force');

    const stopIndex = handoff.indexOf('Stop-VM -Name $VMName -Confirm:$false -AsJob');
    const placeIndex = handoff.indexOf('Invoke-PlaceLiveAutorun $script:PriorCustody.run_id');
    const startIndex = handoff.indexOf('Start-VM -Name $VMName');
    expect(stopIndex).toBeGreaterThan(0);
    expect(placeIndex).toBeGreaterThan(stopIndex);
    expect(startIndex).toBeGreaterThan(placeIndex);
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
    const checkpoint = read('docs/audits/evidence1-hyperv-finalize-auth-checkpoint-offline.ps1');

    expect(launcher).toContain('Assert-RemoteAuthCanary');
    expect(launcher).toContain("'ANTHROPIC_AUTH_TOKEN'");
    expect(launcher).toContain("'CLAUDE_CODE_OAUTH_TOKEN'");
    expect(launcher).toContain("check_kind = 'local_credential_presence_only'");
    expect(launcher).toContain('remote_credential_validated = $false');
    expect(launcher).toContain("'http_statuses'");
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
    expect(checkpoint).toContain('does not prove that the remote service accepts the credential');
    expect(checkpoint).toContain('run the separately authorized remote auth canary');
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
});
