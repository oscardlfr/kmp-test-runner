import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { BIN_PATH, REPO_ROOT } from './_parity-helpers.js';

function extractShExamples(markdown) {
  return [...markdown.matchAll(/```sh\r?\n([\s\S]*?)```/g)].map(match => match[1]);
}

describe('documentation-backed help contracts', () => {
  it('parallel and changed advertise every implemented test type', () => {
    for (const subcommand of ['parallel', 'changed']) {
      const result = spawnSync(process.execPath, [BIN_PATH, subcommand, '--help'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      for (const testType of ['all', 'common', 'jvm', 'androidUnit', 'androidInstrumented',
        'desktop', 'ios', 'macos', 'js', 'wasm']) {
        expect(result.stdout).toContain(testType);
      }
    }
  });

  it('coverage help advertises the run-scoped report path', () => {
    const result = spawnSync(process.execPath, [BIN_PATH, 'coverage', '--help'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('.kmp-test-runner/reports/coverage/<run-id>.md');
    expect(result.stdout).not.toContain('Default: coverage-full-report.md');
  });

  it('benchmark help does not promise JVM filtering that the orchestrator rejects', () => {
    const result = spawnSync(process.execPath, [BIN_PATH, 'benchmark', '--help'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('JVM benchmark legs are skipped');
    expect(result.stdout).toContain('test_filter_unsupported');
    expect(result.stdout).not.toContain("for jvm gradle's --tests");
  });

  it('agentic-eval help describes current supported analysis and live canaries', () => {
    const result = spawnSync(process.execPath, ['tools/agentic-eval/cli.mjs', '--help'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('already-committed supported scenario run records');
    expect(result.stdout).toContain('Evidence1 live wrapper supports these one-cell designs');
    expect(result.stdout).not.toContain('live wrapper currently requires matrix8');
    expect(result.stdout).not.toContain('analyze reads ONLY already-committed schema-v5');
  });

  it('Evidence1 runbook uses the parameter names declared by the V2 gate', () => {
    const runbook = readFileSync(path.join(REPO_ROOT, 'docs', 'evaluation',
      'evidence1-live-canary.md'), 'utf8');
    const gate = readFileSync(path.join(REPO_ROOT, 'docs', 'audits',
      'evidence1-hyperv-verify-wet-gate-v2-direct.ps1'), 'utf8');

    expect(gate).toMatch(/\[string\]\$TargetCommit/);
    expect(gate).toMatch(/\[string\]\$TargetTree/);
    expect(runbook).toContain('"-TargetCommit","<full-sha>","-TargetTree","<full-tree-sha>"');
    expect(runbook).not.toMatch(/verify-wet-gate-v2-direct\.ps1 `[\s\S]{0,200}-ExpectedTargetCommit/);
    expect(runbook).toMatch(/verify-wet-gate-v2-direct\.ps1 `[\s\S]{0,400}"-ReportPath"/);
    expect(runbook).toMatch(/verify-canary-dryrun-v3-direct\.ps1 `[\s\S]{0,400}"-ReportPath"/);
  });

  it('unrestricted-profile examples include the required attestation', () => {
    expect(extractShExamples('```sh\necho lf\n```')).toHaveLength(1);
    expect(extractShExamples('```sh\r\necho crlf\r\n```')).toHaveLength(1);

    for (const relative of [
      ['docs', 'evaluation', 'running-agentic-eval.md'],
      ['tools', 'agentic-eval', 'README.md'],
    ]) {
      const doc = readFileSync(path.join(REPO_ROOT, ...relative), 'utf8');
      const examples = extractShExamples(doc)
        .filter(example => example.includes('--execution-profile sandboxed-unrestricted-v1'));
      expect(examples.length).toBeGreaterThan(0);
      for (const example of examples) {
        expect(example).toContain('--isolation-attestation-file');
      }
    }
  });
});
