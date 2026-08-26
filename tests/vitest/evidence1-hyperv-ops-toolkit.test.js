import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const rel = path => path.replaceAll('\\', '/');
const read = path => readFileSync(resolve(root, path), 'utf8').replaceAll('\r\n', '\n');

const portableOpsScripts = [
  'docs/audits/evidence1-host-elevated-runner.ps1',
  'docs/audits/evidence1-host-elevated-runner-client.ps1',
  'docs/audits/evidence1-host-elevated-runner-install.ps1',
  'docs/audits/evidence1-hyperv-regenerate-readiness-direct.ps1',
  'docs/audits/evidence1-hyperv-read-live-operational-tail.ps1',
  'docs/audits/evidence1-hyperv-update-harness-from-bundle.ps1',
  'docs/audits/evidence1-hyperv-place-live-autorun.ps1',
  'docs/audits/evidence1-hyperv-read-live-progress.ps1',
  'docs/audits/evidence1-hyperv-copy-live-artifacts.ps1',
  'docs/audits/evidence1-stageb-live-wrapper.ps1',
  'docs/audits/evidence1-stageb-live-launch.ps1',
  'docs/audits/evidence1-live-run-contract.psm1',
];

const elevatedRunnerAllowlist = [
  'evidence1-hyperv-copy-live-artifacts.ps1',
  'evidence1-hyperv-place-live-autorun.ps1',
  'evidence1-hyperv-read-live-operational-tail.ps1',
  'evidence1-hyperv-read-live-progress.ps1',
  'evidence1-hyperv-regenerate-readiness-direct.ps1',
  'evidence1-hyperv-update-harness-from-bundle.ps1',
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
      'evidence1-hyperv-open-vmconnect.ps1',
      'evidence1-hyperv-restore-checkpoint.ps1',
      'evidence1-hyperv-restart-vmms-if-safe.ps1',
    ]) {
      expect(entries).not.toContain(deliberatelyExcluded);
    }
  });

  it('documents the no-live boundary for the host toolkit', () => {
    const doc = read('docs/audits/evidence1-hyperv-ops-toolkit.md');
    expect(doc).toContain('does not authorize live sessions');
    expect(doc).toContain('Do not run another live campaign from this PR');
    expect(doc.toLowerCase()).toContain('raw transcript');
    expect(doc).toContain('TargetCommit');
    expect(doc).toContain('TargetTree');
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
    const parsed = spawnSync('pwsh', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(parsed.status, `${parsed.stdout}${parsed.stderr}`).toBe(0);
  }, 35_000);
});
