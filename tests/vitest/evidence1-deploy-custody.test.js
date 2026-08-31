import { describe, expect, it } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../docs/audits/evidence1-hyperv-update-harness-from-bundle.ps1', import.meta.url));
const run = promisify(execFile);
const quote = value => `'${value.replaceAll("'", "''")}'`;
const hasPwsh = !spawnSync('pwsh', ['-NoProfile', '-Command', '$true'], { windowsHide: true }).error;

describe.skipIf(!hasPwsh)('deployment tracked-file custody', { timeout: 30000 }, () => {
  it.each(['clean', 'untracked', 'edited', 'staged', 'hidden'])('checks %s state without restoring or changing it', async state => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-deploy-custody-'));
    const git = async (...args) => (await run('git', ['-C', dir, ...args], { windowsHide: true })).stdout;
    try {
      await git('init', '-q');
      await git('config', 'user.name', 'Fixture');
      await git('config', 'user.email', 'fixture@example.invalid');
      await git('config', 'core.autocrlf', 'false');
      writeFileSync(resolve(dir, 'tracked.txt'), 'original\n');
      await git('add', '.');
      await git('commit', '-qm', 'fixture');
      if (['edited', 'staged', 'hidden'].includes(state)) writeFileSync(resolve(dir, 'tracked.txt'), 'preserve-me\n');
      if (state === 'staged') await git('add', '.');
      if (state === 'hidden') await git('update-index', '--assume-unchanged', 'tracked.txt');
      if (state === 'untracked') writeFileSync(resolve(dir, 'untracked.txt'), 'preserve-too\n');
      const before = await git('status', '--porcelain=v1');
      const bytes = readFileSync(resolve(dir, 'tracked.txt'), 'utf8');
      const body = `$ErrorActionPreference='Stop'
        $ast=[Management.Automation.Language.Parser]::ParseFile(${quote(script)},[ref]$null,[ref]$null)
        $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-GuestHarnessTrackedCustody'},$true)
        if($null -eq $fn){throw 'missing deployment custody guard'}
        . ([scriptblock]::Create($fn.Extent.Text))
        if(-not (Get-Command git.exe -ErrorAction SilentlyContinue)){Set-Alias git.exe (Get-Command git).Source}
        $rejected=$false
        try { Assert-GuestHarnessTrackedCustody ${quote(dir)} } catch { $rejected=$true }
        $rejected | ConvertTo-Json -Compress`;
      const result = await run('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')], { windowsHide: true });
      expect(JSON.parse(result.stdout)).toBe(!['clean', 'untracked'].includes(state));
      expect(await git('status', '--porcelain=v1')).toBe(before);
      expect(readFileSync(resolve(dir, 'tracked.txt'), 'utf8')).toBe(bytes);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('runs custody before checkout and never restores tracked scenario files', () => {
    const text = readFileSync(script, 'utf8');
    expect(text).not.toMatch(/git\.exe restore/);
    const guard = text.indexOf('Assert-GuestHarnessTrackedCustody $HarnessDir');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(text.indexOf('$checkoutOutput ='));
  });
});
