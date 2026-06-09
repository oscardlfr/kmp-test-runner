// SPDX-License-Identifier: MIT
// Tests for lib/project-config.js — v0.8.0 .kmp-test-runner.json loader.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadProjectConfig, applyConfigDefaults, loadMergedConfig, CONFIG_FILE_NAME } from '../../lib/project-config.js';
import { USER_CONFIG_DIR_NAME, USER_CONFIG_FILE_NAME } from '../../lib/user-config.js';

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
      sharedProject: { name: 'private-lib', path: '../private-lib' },
      defaults: { testType: 'common', coverageTool: 'kover', excludeModules: '*:test-fakes' },
      skip: { android: ['legacy-app'], ios: ['bench-android'] },
    }));
    const cfg = loadProjectConfig(dir);
    expect(cfg).toEqual({
      sharedProject: { name: 'private-lib', path: '../private-lib' },
      defaults: { testType: 'common', coverageTool: 'kover', excludeModules: '*:test-fakes' },
      skip: { android: ['legacy-app'], ios: ['bench-android'] },
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

  // v0.10 #3 — user-global java_home injection.
  it('injects --java-home from config.java_home when flag is absent', () => {
    const args = ['parallel', '--json'];
    const cfg = { java_home: 'C:/opt/jdk21' };
    expect(applyConfigDefaults(args, cfg)).toEqual(['parallel', '--json', '--java-home', 'C:/opt/jdk21']);
  });

  it('CLI --java-home wins over config.java_home', () => {
    const args = ['--java-home', '/cli/path'];
    const cfg = { java_home: '/config/path' };
    expect(applyConfigDefaults(args, cfg)).toEqual(['--java-home', '/cli/path']);
  });

  it('does not inject when config.java_home is empty / non-string', () => {
    expect(applyConfigDefaults(['parallel'], { java_home: '' })).toEqual(['parallel']);
    expect(applyConfigDefaults(['parallel'], { java_home: 42 })).toEqual(['parallel']);
  });

  it('java_home injection works alongside defaults injection', () => {
    const args = [];
    const cfg = { defaults: { testType: 'common' }, java_home: '/jdk' };
    const out = applyConfigDefaults(args, cfg);
    expect(out).toContain('--test-type');
    expect(out).toContain('common');
    expect(out).toContain('--java-home');
    expect(out).toContain('/jdk');
  });
});

// v0.10 #3 — loadMergedConfig integration.
describe('loadMergedConfig', () => {
  let workDir;
  let homeDir;

  function makeProject() {
    workDir = mkdtempSync(path.join(tmpdir(), 'kmp-merged-proj-'));
    return workDir;
  }

  function makeHome() {
    homeDir = mkdtempSync(path.join(tmpdir(), 'kmp-merged-home-'));
    mkdirSync(path.join(homeDir, USER_CONFIG_DIR_NAME), { recursive: true });
    return homeDir;
  }

  afterEach(() => {
    if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
    if (homeDir && existsSync(homeDir)) rmSync(homeDir, { recursive: true, force: true });
    workDir = null;
    homeDir = null;
  });

  it('returns null when neither layer exists', () => {
    const proj = makeProject();
    const home = makeHome();
    expect(loadMergedConfig(proj, { homeOverride: home, projectKey: 'k' })).toBeNull();
  });

  it('returns user-global preset when project-local is absent', () => {
    const proj = makeProject();
    const home = makeHome();
    writeFileSync(
      path.join(home, USER_CONFIG_DIR_NAME, USER_CONFIG_FILE_NAME),
      JSON.stringify({ projects: { 'demo': { defaults: { testType: 'common' }, java_home: '/jdk21' } } }),
    );
    const merged = loadMergedConfig(proj, { homeOverride: home, projectKey: 'demo' });
    expect(merged).toEqual({ defaults: { testType: 'common' }, java_home: '/jdk21' });
  });

  it('project-local wins for shared keys (defaults.testType)', () => {
    const proj = makeProject();
    const home = makeHome();
    writeFileSync(
      path.join(home, USER_CONFIG_DIR_NAME, USER_CONFIG_FILE_NAME),
      JSON.stringify({ projects: { 'demo': { defaults: { testType: 'common', coverageTool: 'kover' } } } }),
    );
    writeFileSync(path.join(proj, CONFIG_FILE_NAME), JSON.stringify({ defaults: { testType: 'jvm' } }));
    const merged = loadMergedConfig(proj, { homeOverride: home, projectKey: 'demo' });
    expect(merged.defaults).toEqual({ testType: 'jvm', coverageTool: 'kover' });
  });

  it('user-global java_home survives merge, project-local java_home is dropped + warned', () => {
    const proj = makeProject();
    const home = makeHome();
    writeFileSync(
      path.join(home, USER_CONFIG_DIR_NAME, USER_CONFIG_FILE_NAME),
      JSON.stringify({ projects: { 'demo': { java_home: '/user-jdk' } } }),
    );
    writeFileSync(path.join(proj, CONFIG_FILE_NAME), JSON.stringify({ java_home: '/project-jdk', defaults: { testType: 'jvm' } }));
    const orig = process.stderr.write.bind(process.stderr);
    const captured = [];
    process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
    let merged;
    try {
      merged = loadMergedConfig(proj, { homeOverride: home, projectKey: 'demo' });
    } finally {
      process.stderr.write = orig;
    }
    expect(merged.java_home).toBe('/user-jdk');
    expect(captured.join('')).toContain('java_home is not allowed in project-local config');
  });
});

// ---------------------------------------------------------------------------
// Warning collector — config-validation drops surfaced to envelope warnings[]
// ---------------------------------------------------------------------------
describe('loadMergedConfig warning collector', () => {
  it('collects per-field drops from project-local config with source tag', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, CONFIG_FILE_NAME), JSON.stringify({
      defaults: { testType: 42 },          // wrong type — dropped
      cleanup: { logsTtlDays: 'soon' },    // wrong type — dropped
    }), 'utf8');
    const collected = [];
    withSilencedStderr(() => {
      loadMergedConfig(dir, { collect: (w) => collected.push(w), projectKey: 'no-such-key' });
    });
    expect(collected.length).toBe(2);
    for (const w of collected) {
      expect(w.code).toBe('config_invalid_field');
      expect(w.source).toBe('project_local');
      expect(typeof w.message).toBe('string');
    }
    expect(collected.map(w => w.message).join('\n')).toContain('defaults.testType');
    expect(collected.map(w => w.message).join('\n')).toContain('cleanup.logsTtlDays');
  });

  it('collects the project-local java_home security drop', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, CONFIG_FILE_NAME), JSON.stringify({
      java_home: '/evil/jdk',
    }), 'utf8');
    const collected = [];
    withSilencedStderr(() => {
      loadMergedConfig(dir, { collect: (w) => collected.push(w), projectKey: 'no-such-key' });
    });
    const drop = collected.find(w => w.message.includes('java_home is not allowed'));
    expect(drop).toBeTruthy();
    expect(drop.code).toBe('config_invalid_field');
    expect(drop.source).toBe('project_local');
  });

  it('collects nothing for a fully valid config', () => {
    const dir = makeProject();
    writeFileSync(path.join(dir, CONFIG_FILE_NAME), JSON.stringify({
      defaults: { testType: 'common' },
      cleanup: { auto: true, logsTtlDays: 7 },
    }), 'utf8');
    const collected = [];
    withSilencedStderr(() => {
      loadMergedConfig(dir, { collect: (w) => collected.push(w), projectKey: 'no-such-key' });
    });
    expect(collected).toEqual([]);
  });
});
