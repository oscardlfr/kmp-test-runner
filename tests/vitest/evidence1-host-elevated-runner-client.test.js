import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const client = resolve(process.cwd(), 'docs', 'audits', 'evidence1-host-elevated-runner-client.ps1');
const clientSource = readFileSync(client, 'utf8');

describe('Evidence1 elevated runner client queue ownership', () => {
  it.skipIf(process.platform !== 'win32').each(['requests', 'in-progress'])(
    'fails closed without moving an existing %s request',
    (occupiedDirectory) => {
      const root = mkdtempSync('C:\\kmp-eval\\scratch\\e1-runner-client-busy-');
      const allowedRoot = join(root, 'deployed');
      const queueRoot = join(root, 'queue');
      const occupiedPath = join(queueRoot, occupiedDirectory, 'existing.request.json');
      const scriptPath = join(allowedRoot, 'fixture.ps1');

      try {
        mkdirSync(allowedRoot, { recursive: true });
        mkdirSync(join(queueRoot, occupiedDirectory), { recursive: true });
        writeFileSync(scriptPath, '# fixture\n');
        writeFileSync(occupiedPath, '{"id":"existing"}\n');

        const result = spawnSync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', client,
          '-ScriptPath', scriptPath,
          '-QueueRoot', queueRoot,
          '-AllowedRoot', allowedRoot,
          '-TaskName', 'Evidence1MissingTaskFixture',
          '-TimeoutMinutes', '1',
        ], { encoding: 'utf8', windowsHide: true });

        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain('runner_queue_busy');
        expect(existsSync(occupiedPath)).toBe(true);
        expect(readFileSync(occupiedPath, 'utf8')).toContain('existing');
        expect(existsSync(join(queueRoot, 'stale'))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe('Evidence1 elevated runner client: bounded /Run retry (2026-09-29 wedge fix, auditor review)', () => {
  // Auditor finding on the first draft: the retry loop's only exits were
  // "request claimed" or "attempts >= maxTriggerAttempts", and attempts never
  // increments while Get-ScheduledTask reports the task Running (the
  // `continue` skips the increment) -- so a task genuinely stuck Running
  // forever spun this loop unbounded instead of failing at -TimeoutMinutes
  // like every other wait in this script. Real behavioral coverage (a fake
  // task-state stuck at Running) would need this script to accept injected
  // overrides for Get-ScheduledTask/schtasks.exe, which it deliberately does
  // not (real infrastructure only, matching evidence1-broker-capability-client.psm1's
  // own -TriggerTask boundary philosophy for this simpler script). A
  // source-shape assertion is the same fallback this suite's sibling Pester
  // coverage already uses for scriptblock-local logic it cannot execute in
  // isolation either.
  const deadlineAssignIndex = clientSource.indexOf('$deadline = (Get-Date).AddMinutes($TimeoutMinutes)');
  const retryLoopIndex = clientSource.indexOf('while ($triggerAttempts -lt $maxTriggerAttempts');
  const responseWaitLoopIndex = clientSource.indexOf('while ((Get-Date) -lt $deadline) {');

  it('computes $deadline exactly once, before the retry loop' , () => {
    const occurrences = clientSource.split('$deadline = (Get-Date).AddMinutes($TimeoutMinutes)').length - 1;
    expect(occurrences).toBe(1);
    expect(deadlineAssignIndex).toBeGreaterThan(0);
    expect(retryLoopIndex).toBeGreaterThan(deadlineAssignIndex);
  });

  it('bounds the retry loop\'s own while-condition by $deadline, not just the attempt count', () => {
    const retryLoopHeader = clientSource.slice(retryLoopIndex, clientSource.indexOf('{', retryLoopIndex) + 1);
    expect(retryLoopHeader).toMatch(/\(Get-Date\)\s+-lt\s+\$deadline/);
  });

  it('the response-wait loop still starts after the retry loop and reuses the same $deadline (no second assignment)', () => {
    expect(responseWaitLoopIndex).toBeGreaterThan(retryLoopIndex);
  });

  it('checks $LASTEXITCODE on the retry trigger the same way the initial trigger does', () => {
    const retryLoopBody = clientSource.slice(retryLoopIndex, responseWaitLoopIndex);
    expect(retryLoopBody).toMatch(/schtasks\.exe \/Run \/TN \$TaskName/);
    expect(retryLoopBody).toMatch(/if \(\$LASTEXITCODE -ne 0\)/);
    expect(retryLoopBody).toMatch(/Fail "failed to re-trigger scheduled task/);
  });

  it('never retriggers while the scheduled task itself reports Running (source-level, enum-shaped check)', () => {
    const retryLoopBody = clientSource.slice(retryLoopIndex, responseWaitLoopIndex);
    expect(retryLoopBody).toMatch(/\$task\.State -ceq 'Running'/);
  });
});
