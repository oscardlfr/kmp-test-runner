// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RUNNER_CONTRACTS,
  supportsRunnerContract,
} from '../../lib/envelope/contracts.js';
import { ENVELOPE_SCHEMA_VERSION } from '../../lib/envelope/exit-codes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '../../bin/kmp-test.js');

describe('runner coverage-evidence contract detection', () => {
  it('--version --json exposes a compatible machine-readable identity without running Gradle', () => {
    const result = spawnSync(process.execPath, [BIN, '--version', '--json'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const identity = JSON.parse(result.stdout);
    expect(identity).toEqual(expect.objectContaining({
      tool: 'kmp-test',
      schema_version: ENVELOPE_SCHEMA_VERSION,
      contracts: { coverage_evidence: RUNNER_CONTRACTS.coverage_evidence },
    }));
    expect(supportsRunnerContract(identity, 'coverage_evidence', 1)).toBe(true);
  });

  it('plain --version remains backward-compatible semver text', () => {
    const result = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  });

  it.each([
    ['legacy bare version', '0.15.0'],
    ['missing contract', { tool: 'kmp-test', version: '0.15.0', schema_version: 2, contracts: {} }],
    ['too-old contract', { tool: 'kmp-test', contracts: { coverage_evidence: 0 } }],
    ['malformed contract', { tool: 'kmp-test', contracts: { coverage_evidence: '1' } }],
    ['wrong tool', { tool: 'other', contracts: { coverage_evidence: 1 } }],
  ])('rejects incompatible identity: %s', (_label, identity) => {
    expect(supportsRunnerContract(identity, 'coverage_evidence', 1)).toBe(false);
  });
});
