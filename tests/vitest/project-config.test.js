// SPDX-License-Identifier: MIT
// Tests for lib/project-config.js — v0.8.0 .kmp-test-runner.json loader.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadProjectConfig, applyConfigDefaults, CONFIG_FILE_NAME } from '../../lib/project-config.js';

let workDir;

function makeProject() {
  workDir = mkdtempSync(path.join(tmpdir(), 'kmp-cfg-test-'));
  return workDir;
}

afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

function withSilencedStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  const captured = [];
  process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
  try {
    fn(captured);
  } finally {
    process.stderr.write = orig;
  }
}

describe('loadProjectConfig', () => {
  it('returns null when projectRoot is falsy', () => {
    expect(loadProjectConfig(null)).toBeNull();
    expect(loadProjectConfig('')).toBeNull();
  });

  it('returns null silently when .kmp-test-runner.json is absent', () => {
    const dir = makeProject();
    expect(loadProjectConfig(dir)).toBeNull();
  });

  it('parses a valid config with all known fields', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, CONFIG_FILE_NAME), JSON.stringify({
      sharedProject: { name: 'shared-kmp-libs', path: '../shared-kmp-libs' },
      defaults: { testType: 'common', coverageTool: 'kover', excludeModules: '*:test-fakes' },
      skip: { android: ['legacy-app'], ios: ['benchmark-android-test'] },
    }));
    const cfg = loadProjectConfig(dir);
    expect(cfg).toEqual({
      sharedProject: { name: 'shared-kmp-libs', path: '../shared-kmp-libs' },
      defaults: { testType: 'common', coverageTool: 'kover', excludeModules: '*:test-fakes' },
      skip: { android: ['legacy-app'], ios: ['benchmark-android-test'] },
    });
  });

  it('warns and returns null on malformed JSON', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, CONFIG_FILE_NAME), '{ "skip": [missing closing brace');
    withSilencedStderr((captured) => {
      const cfg = loadProjectConfig(dir);
      expect(cfg).toBeNull();
      expect(captured.join('')).toContain('parse failed');
    });
  });

  it('warns and returns null when top-level is not an object', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, CONFIG_FILE_NAME), JSON.stringify(['array', 'top']));
    withSilencedStderr((captured) => {
      const cfg = loadProjectConfig(dir);
      expect(cfg).toBeNull();
      expect(captured.join('')).toContain('top-level must be a JSON object');
    });
  });

  it('drops type-mismatched fields with warning, keeps valid ones', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, CONFIG_FILE_NAME), JSON.stringify({
      sharedProject: { name: 'good' },
      defaults: { testType: 'common', coverageTool: 42 },  // 42 is invalid
      skip: { android: 'legacy-app', ios: ['ok'] },        // string instead of array
    }));
    withSilencedStderr((captured) => {
      const cfg = loadProjectConfig(dir);
      expect(cfg.sharedProject).toEqual({ name: 'good' });
      expect(cfg.defaults).toEqual({ testType: 'common' });   // coverageTool dropped
      expect(cfg.skip).toEqual({ ios: ['ok'] });              // android dropped
      expect(captured.join('')).toContain('defaults.coverageTool must be a non-empty string');
      expect(captured.join('')).toContain('skip.android must be an array of strings');
    });
  });

  it('preserves unknown top-level fields for forward compat', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, CONFIG_FILE_NAME), JSON.stringify({
      sharedProject: { name: 'x' },
      futureFeature: { foo: 'bar' },
    }));
    const cfg = loadProjectConfig(dir);
    expect(cfg.futureFeature).toEqual({ foo: 'bar' });
  });

  it('accepts an empty object {} and returns it without warning', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, CONFIG_FILE_NAME), '{}');
    withSilencedStderr((captured) => {
      const cfg = loadProjectConfig(dir);
      expect(cfg).toEqual({});
      expect(captured.join('').trim()).toBe('');
    });
  });
});

describe('applyConfigDefaults', () => {
  it('is a no-op when config is null', () => {
    const args = ['parallel', '--json'];
    expect(applyConfigDefaults(args, null)).toEqual(args);
  });

  it('is a no-op when config has no defaults section', () => {
    const args = ['parallel'];
    expect(applyConfigDefaults(args, { sharedProject: { name: 'x' } })).toEqual(args);
  });

  it('injects --test-type from config when not in argv', () => {
    const args = ['--json'];
    const cfg = { defaults: { testType: 'common' } };
    expect(applyConfigDefaults(args, cfg)).toEqual(['--json', '--test-type', 'common']);
  });

  it('CLI flag wins over config — does NOT inject when --test-type already in argv', () => {
    const args = ['--test-type', 'ios'];
    const cfg = { defaults: { testType: 'common' } };
    expect(applyConfigDefaults(args, cfg)).toEqual(['--test-type', 'ios']);
  });

  it('injects multiple defaults when none are present', () => {
    const args = [];
    const cfg = { defaults: { testType: 'common', coverageTool: 'kover', excludeModules: '*:fakes' } };
    const out = applyConfigDefaults(args, cfg);
    expect(out).toContain('--test-type');
    expect(out).toContain('common');
    expect(out).toContain('--coverage-tool');
    expect(out).toContain('kover');
    expect(out).toContain('--exclude-modules');
    expect(out).toContain('*:fakes');
  });
});
