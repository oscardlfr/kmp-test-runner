// SPDX-License-Identifier: MIT
// Tests for lib/runners/console-mode.js + the spawnGradle injection hook
// added in v0.10 #1.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  setConsoleMode,
  getConsoleMode,
  shouldInjectConsolePlain,
} from '../../lib/runners/console-mode.js';
import { spawnGradle } from '../../lib/orchestrators/orchestrator-utils.js';
import { consumeColorFlag } from '../../lib/parsers/argv.js';
import { effectiveGradleArgs } from './_spawn-helpers.js';

beforeEach(() => {
  // Reset to the default for every test — module-level state would otherwise
  // leak across cases.
  setConsoleMode('auto');
});

describe('console-mode / shouldInjectConsolePlain', () => {
  it('mode=auto + isTTY=true + no NO_COLOR → no inject', () => {
    expect(shouldInjectConsolePlain({ mode: 'auto', env: {}, isTTY: true })).toBe(false);
  });

  it('mode=auto + isTTY=false → inject (piped capture path)', () => {
    expect(shouldInjectConsolePlain({ mode: 'auto', env: {}, isTTY: false })).toBe(true);
  });

  it('mode=auto + NO_COLOR=1 + isTTY=true → inject (NO_COLOR wins over TTY)', () => {
    expect(shouldInjectConsolePlain({ mode: 'auto', env: { NO_COLOR: '1' }, isTTY: true })).toBe(true);
  });

  it('mode=auto + NO_COLOR="" → no inject (empty string is per-POSIX a no-op)', () => {
    expect(shouldInjectConsolePlain({ mode: 'auto', env: { NO_COLOR: '' }, isTTY: true })).toBe(false);
  });

  it('mode=always → no inject regardless of TTY/NO_COLOR', () => {
    expect(shouldInjectConsolePlain({ mode: 'always', env: { NO_COLOR: '1' }, isTTY: false })).toBe(false);
  });

  it('mode=never → inject regardless of TTY/NO_COLOR', () => {
    expect(shouldInjectConsolePlain({ mode: 'never', env: {}, isTTY: true })).toBe(true);
  });

  it('defaults read module state when called with no args', () => {
    setConsoleMode('always');
    expect(shouldInjectConsolePlain()).toBe(false);
    setConsoleMode('never');
    expect(shouldInjectConsolePlain()).toBe(true);
  });
});

describe('console-mode / setConsoleMode + getConsoleMode', () => {
  it('round-trips valid modes', () => {
    setConsoleMode('always');
    expect(getConsoleMode()).toBe('always');
    setConsoleMode('never');
    expect(getConsoleMode()).toBe('never');
    setConsoleMode('auto');
    expect(getConsoleMode()).toBe('auto');
  });

  it('throws on an unknown mode', () => {
    expect(() => setConsoleMode('bogus')).toThrow(/invalid --color mode/);
  });

  it('propagates the mode to process.env.KMP_COLOR_MODE for descendant Node procs', () => {
    setConsoleMode('never');
    expect(process.env.KMP_COLOR_MODE).toBe('never');
    setConsoleMode('always');
    expect(process.env.KMP_COLOR_MODE).toBe('always');
  });
});

describe('argv / consumeColorFlag', () => {
  it('strips `--color always` and returns mode=always', () => {
    const r = consumeColorFlag(['--module-filter', '*', '--color', 'always', '--json']);
    expect(r.mode).toBe('always');
    expect(r.args).toEqual(['--module-filter', '*', '--json']);
  });

  it('strips `--color=never` (POSIX equals form) and returns mode=never', () => {
    const r = consumeColorFlag(['--color=never', '--dry-run']);
    expect(r.mode).toBe('never');
    expect(r.args).toEqual(['--dry-run']);
  });

  it('returns mode=null when absent', () => {
    const r = consumeColorFlag(['--module-filter', 'core-*']);
    expect(r.mode).toBe(null);
    expect(r.args).toEqual(['--module-filter', 'core-*']);
  });

  it('throws on invalid value', () => {
    expect(() => consumeColorFlag(['--color', 'sparkles'])).toThrow(/invalid --color value/);
  });
});

describe('spawnGradle / --console=plain injection (v0.10 #1)', () => {
  function captureSpawn() {
    const calls = [];
    const spawn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { pid: 1, stdout: null, stderr: null, status: 0 };
    };
    return { spawn, calls };
  }

  it('mode=never → injects --console=plain at the end of argv', () => {
    setConsoleMode('never');
    const { spawn, calls } = captureSpawn();
    spawnGradle(spawn, 'gradlew', ['parallel', '--continue'], {});
    const args = effectiveGradleArgs(calls[0]);
    expect(args).toContain('--console=plain');
    // exactly one occurrence
    expect(args.filter((a) => a === '--console=plain')).toHaveLength(1);
  });

  it('mode=always → does NOT inject --console=plain', () => {
    setConsoleMode('always');
    const { spawn, calls } = captureSpawn();
    spawnGradle(spawn, 'gradlew', ['parallel', '--continue'], {});
    const args = effectiveGradleArgs(calls[0]);
    expect(args).not.toContain('--console=plain');
  });

  it('idempotency: user passed --console=plain via --gradle-args → no second token', () => {
    setConsoleMode('never');
    const { spawn, calls } = captureSpawn();
    spawnGradle(spawn, 'gradlew', ['parallel', '--console=plain'], {});
    const args = effectiveGradleArgs(calls[0]);
    expect(args.filter((a) => a === '--console=plain')).toHaveLength(1);
  });

  it('idempotency: user passed --console=rich → explicit choice wins, no --console=plain added', () => {
    setConsoleMode('never');
    const { spawn, calls } = captureSpawn();
    spawnGradle(spawn, 'gradlew', ['parallel', '--console=rich'], {});
    const args = effectiveGradleArgs(calls[0]);
    expect(args).toContain('--console=rich');
    expect(args).not.toContain('--console=plain');
  });

  it('idempotency: user passed `--console plain` (space form) → no second token', () => {
    setConsoleMode('never');
    const { spawn, calls } = captureSpawn();
    spawnGradle(spawn, 'gradlew', ['parallel', '--console', 'plain'], {});
    const args = effectiveGradleArgs(calls[0]);
    // The /^--console(=|$)/ guard matches the bare `--console` token, so
    // spawnGradle leaves the explicit shape alone (no auto-appended --console=plain).
    expect(args.filter((a) => a === '--console=plain')).toHaveLength(0);
    expect(args).toContain('--console');
    expect(args).toContain('plain');
  });
});
