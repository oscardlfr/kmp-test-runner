import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { TEST_TYPE_VALUES } from '../../lib/parsers/argv-constants.js';
import { BIN_PATH, REPO_ROOT } from './_parity-helpers.js';

function runHelp(subcommand) {
  return spawnSync(process.execPath, [BIN_PATH, subcommand, '--help'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

function extractShellExamples(markdown) {
  return [...markdown.matchAll(/```(?:sh|bash)\r?\n([\s\S]*?)```/g)].map(match => match[1]);
}

function jsFilesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const resolved = path.join(directory, entry.name);
    return entry.isDirectory() ? jsFilesUnder(resolved) : (entry.name.endsWith('.js') ? [resolved] : []);
  });
}

describe('documentation-backed help contracts', () => {
  it('parallel and changed advertise every implemented test type', () => {
    for (const subcommand of ['parallel', 'changed']) {
      const result = runHelp(subcommand);
      expect(result.status).toBe(0);
      for (const testType of TEST_TYPE_VALUES) expect(result.stdout).toContain(testType);
    }
  });

  it('coverage help advertises the managed run-scoped report path', () => {
    const result = runHelp('coverage');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('.kmp-test-runner/reports/coverage/<runId>.md');
    expect(result.stdout).toContain('updates latest.md');
    expect(result.stdout).toContain('gradlew tasks --all --quiet');
    expect(result.stdout).toContain('never runs tests or coverage report tasks');
    expect(result.stdout).not.toContain('Default: coverage-full-report.md');
  });

  it('benchmark help does not promise JVM filtering that the orchestrator rejects', () => {
    const result = runHelp('benchmark');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('JVM tasks do not support this flag');
    expect(result.stdout).toContain('test_filter_unsupported');
    expect(result.stdout).not.toContain("jvm gradle's --tests handles");
  });

  it('the envelope catalogue names every literal code emitted by production JavaScript', () => {
    const documented = readFileSync(path.join(REPO_ROOT, 'docs', 'envelope-contract.md'), 'utf8');
    const emitted = new Set();
    for (const file of jsFilesUnder(path.join(REPO_ROOT, 'lib'))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/code:\s*'([a-z_]+)'/g)) emitted.add(match[1]);
    }

    expect([...emitted].filter(code => !documented.includes(`\`${code}\``)).sort()).toEqual([]);
  });

  it('the README successful envelope is internally coherent', () => {
    const readme = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
    const match = readme.match(/representative successful envelope is:\s*```json\r?\n(\{[^\r\n]+\})\r?\n```/);
    expect(match).not.toBeNull();

    const envelope = JSON.parse(match[1]);
    expect(envelope.parallel.legs).toHaveLength(1);
    expect(envelope.parallel.legs[0].test_type).toBe(envelope.parallel.test_type);
    expect(envelope.parallel.legs[0].execution.fresh).toBe(envelope.tests.passed);
    expect(envelope.coverage.modules_contributing).toBe(envelope.coverage.module_buckets.with_data.length);
  });

  it('Evidence1 runbook uses parameter names declared by the V2 gate', () => {
    const runbook = readFileSync(path.join(REPO_ROOT, 'docs', 'evaluation',
      'evidence1-live-canary.md'), 'utf8');
    const gate = readFileSync(path.join(REPO_ROOT, 'docs', 'audits',
      'evidence1-hyperv-verify-wet-gate-v2-direct.ps1'), 'utf8');

    expect(gate).toMatch(/\[string\]\$TargetCommit/);
    expect(gate).toMatch(/\[string\]\$TargetTree/);
    expect(runbook).toMatch(/evidence1-hyperv-verify-wet-gate-v2-direct\.ps1'[\s\S]{0,300}'-TargetCommit',[\s\S]{0,100}'-TargetTree'/);
    expect(runbook).not.toMatch(/verify-wet-gate-v2-direct\.ps1 `[\s\S]{0,200}-ExpectedTargetCommit/);
  });

  it('unrestricted-profile examples include the required attestation', () => {
    for (const relative of [
      ['docs', 'evaluation', 'running-agentic-eval.md'],
      ['tools', 'agentic-eval', 'README.md'],
    ]) {
      const doc = readFileSync(path.join(REPO_ROOT, ...relative), 'utf8');
      const examples = extractShellExamples(doc)
        .filter(example => example.includes('--execution-profile sandboxed-unrestricted-v1')
          || example.includes('--campaign-design claude-2x2-williams-v1')
          || example.includes('--campaign-design claude-product-vs-free-baseline-v1')
          || example.includes('--campaign-design claude-product-canary-v1')
          || example.includes('--campaign-design claude-free-baseline-canary-v1'));
      expect(examples.length).toBeGreaterThan(0);
      for (const example of examples) {
        expect(example).toContain('--isolation-attestation-file');
      }
    }
  });
});
