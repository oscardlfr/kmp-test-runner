import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const q = value => `'${value.replaceAll("'", "''")}'`;
function ps(body) {
  const text = `$ErrorActionPreference='Stop'; Import-Module ${q(resolve(root, 'docs/audits/evidence1-validation-ops.psm1'))} -Force -DisableNameChecking; Import-Module ${q(resolve(root, 'docs/audits/evidence1-validation-forensics.psm1'))} -Force -DisableNameChecking; ${body}`;
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(text, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  expect(result.status, result.stderr || result.error?.message).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}
const available = process.platform === 'win32';
const env = {
  tool: 'kmp-test', subcommand: 'parallel', exit_code: 3,
  tests: { total: 1, passed: 0, failed: 1, individual_total: 0 },
  coverage: { missed_lines: null, modules_contributing: 0, module_buckets: { with_data: [] } },
  errors: [{ code: 'module_failed', setup_failed: true, message: 'PRIVATE_SECRET' }, { code: 'coverage_data_unavailable', reason: 'report-dispatch-failed' }],
  warnings: [{ code: 'coverage_report_dispatch_failed', message: 'PRIVATE_SECRET' }],
  project_root: 'PRIVATE_SECRET', raw: 'PRIVATE_SECRET',
};
const json = value => `ConvertFrom-E1Json ${q(JSON.stringify(value))}`;

describe.skipIf(!available)('readonly wet-gate forensics', () => {
  it('projects actual values without losing null/missing/invalid distinctions or emitting free text', () => {
    const result = ps(`Get-E1ForensicProductSummary (${json(env)}) | ConvertTo-Json -Depth 12 -Compress`);
    expect(result.metrics.tests_failed).toEqual({ status: 'recorded', value: 1 });
    expect(result.metrics.missed_lines).toEqual({ status: 'null', value: null });
    expect(result.error_codes.counts.module_failed).toBe(1);
    expect(result.error_codes.counts.coverage_data_unavailable).toBe(1);
    expect(result.coverage_reasons.counts['report-dispatch-failed']).toBe(1);
    expect(result.metrics.module_failed_setup_count.value).toBe(1);
    expect(result.warning_codes.counts.coverage_report_dispatch_failed).toBe(1);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    const changed = structuredClone(env);
    delete changed.tests.individual_total;
    changed.tests.failed = '1';
    changed.errors[0].code = 'PRIVATE_UNKNOWN_CODE';
    const next = ps(`Get-E1ForensicProductSummary (${json(changed)}) | ConvertTo-Json -Depth 12 -Compress`);
    expect(next.metrics.individual_total.status).toBe('missing');
    expect(next.metrics.tests_failed.status).toBe('invalid');
    expect(next.error_codes.counts.unknown).toBe(1);
    expect(JSON.stringify(next)).not.toContain('PRIVATE');
  });

  it('rejects tampered, extra-field and free-text summaries after transport', () => {
    expect(ps(`$s=Get-E1ForensicProductSummary (${json(env)}); $out=@(); Assert-E1ForensicSummary $s; $out+=$true
      $s.metrics.tests_failed.value='SECRET'; try { Assert-E1ForensicSummary $s; $out+=$false } catch { $out+=$true }
      $s=Get-E1ForensicProductSummary (${json(env)}); $s.error_codes.counts.secret='SECRET'; try { Assert-E1ForensicSummary $s; $out+=$false } catch { $out+=$true }
      $s=Get-E1ForensicProductSummary (${json(env)}); $s.metrics.tests_failed.status='SECRET'; try { Assert-E1ForensicSummary $s; $out+=$false } catch { $out+=$true }
      $out | ConvertTo-Json -Compress`)).toEqual([true, true, true, true]);
  });

  it('reads an existing artifact by hash without writes and rejects wrong hash and oversize', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'e1-forensic-'));
    const path = resolve(dir, 'existing.json');
    const bytes = Buffer.from(JSON.stringify(env));
    writeFileSync(path, bytes);
    const hash = createHash('sha256').update(bytes).digest('hex');
    try {
      // The production path guard is replaced only inside this local synthetic module scope.
      const result = ps(`$m=Get-Module evidence1-validation-forensics; & $m {
        param($path,$hash)
        function Resolve-E1Path { param($Path) return $Path }
        $r=Read-E1ForensicArtifact $path $hash 1048576
        $out=@($r.sha256 -ceq $hash)
        try { $null=Read-E1ForensicArtifact $path ('0'*64) 1048576; $out+=$false } catch { $out+=($_.Exception.Message -ceq 'forensic_hash') }
        try { $null=Read-E1ForensicArtifact $path $hash 2; $out+=$false } catch { $out+=($_.Exception.Message -ceq 'forensic_size') }
        $out | ConvertTo-Json -Compress
      } ${q(path)} '${hash}'`);
      expect(result).toEqual([true, true, true]);
      expect(readFileSync(path).equals(bytes)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('binds a terminal original report and marker without freshness requirements or inferring missing historical process facts', () => {
    const report = { schema: 1, operation: 'wet-v2', state: 'failed', target_commit: 'a'.repeat(40), target_tree: 'b'.repeat(40), source_commit: '7d45eae4f8720a0c77f507712ba2437ff974b6ed', agent_calls: 0, product_invocations: 1, dry_plan_invocations: 0, hashes: { product_stdout_sha256: 'c'.repeat(64) }, failure_code: 'product_contract', checks: { postflight: false } };
    const result = ps(`$r=${json(report)}; Assert-E1ForensicSubject $r ('a'*40) ('b'*40); $h=Get-E1ForensicHistory $r
      $m=${json(report)}; Assert-E1ForensicMarker $m $r
      $m.hashes.product_stdout_sha256='d'*64; $rejected=$false; try { Assert-E1ForensicMarker $m $r } catch { $rejected=$true }
      @{history=$h; mismatch_rejected=$rejected} | ConvertTo-Json -Depth 8 -Compress`);
    expect(result.history.process.status).toBe('not-recorded');
    expect(result.history.postflight_failure.status).toBe('not-recorded');
    expect(result.mismatch_rejected).toBe(true);
  });

  it('refuses a mismatched remote module before evaluating its body', () => {
    expect(ps(`$receiver=Get-E1ForensicReceiverScript
      $ok=try { & $receiver "throw 'PRIVATE_EXECUTION'" ('0'*64) "throw 'PRIVATE_EXECUTION'" ('1'*64) @{}; $false } catch { $_.Exception.Message -ceq 'forensic_module_hash' }; $ok | ConvertTo-Json -Compress`)).toBe(true);
  });
});
