// SPDX-License-Identifier: MIT
// Tests for lib/user-config.js — v0.10 #3 user-global config loader.

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  USER_CONFIG_DIR_NAME,
  USER_CONFIG_FILE_NAME,
  userConfigPath,
  loadUserGlobalConfig,
  resolveProjectKey,
  selectUserGlobalPreset,
  loadUserGlobalPresetForProject,
  mergeConfigs,
} from '../../lib/user-config.js';

const tmpDirs = [];

function makeTmpHome() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kmp-user-home-'));
  mkdirSync(path.join(dir, USER_CONFIG_DIR_NAME), { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function makeTmpProject() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kmp-user-proj-'));
  tmpDirs.push(dir);
  return dir;
}

function writeUserConfig(home, body) {
  writeFileSync(path.join(home, USER_CONFIG_DIR_NAME, USER_CONFIG_FILE_NAME), body);
}

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

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

describe('userConfigPath', () => {
  it('returns ~/.kmp-test/config.json under the override home', () => {
    const home = makeTmpHome();
    const expected = path.join(home, '.kmp-test', 'config.json');
    expect(userConfigPath(home)).toBe(expected);
  });
});

describe('loadUserGlobalConfig', () => {
  it('returns null when the file is absent', () => {
    const home = makeTmpHome();
    // dir exists but no file inside
    expect(loadUserGlobalConfig(home)).toBeNull();
  });

  it('parses a valid JSON object', () => {
    const home = makeTmpHome();
    writeUserConfig(home, JSON.stringify({ projects: { 'my-key': { defaults: { testType: 'common' } } } }));
    const cfg = loadUserGlobalConfig(home);
    expect(cfg).toEqual({ projects: { 'my-key': { defaults: { testType: 'common' } } } });
  });

  it('warns and returns null on malformed JSON', () => {
    const home = makeTmpHome();
    writeUserConfig(home, '{ "projects": ');
    withSilencedStderr((captured) => {
      expect(loadUserGlobalConfig(home)).toBeNull();
      expect(captured.join('')).toContain('parse failed');
    });
  });

  it('warns and returns null when top-level is an array', () => {
    const home = makeTmpHome();
    writeUserConfig(home, JSON.stringify(['nope']));
    withSilencedStderr((captured) => {
      expect(loadUserGlobalConfig(home)).toBeNull();
      expect(captured.join('')).toContain('top-level must be a JSON object');
    });
  });
});

describe('resolveProjectKey', () => {
  it('returns null when projectRoot is falsy', () => {
    expect(resolveProjectKey(null)).toBeNull();
    expect(resolveProjectKey('')).toBeNull();
  });

  it('returns the git remote URL when origin is set', () => {
    const proj = makeTmpProject();
    execFileSync('git', ['init', '--quiet'], { cwd: proj });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/repo.git'], { cwd: proj });
    expect(resolveProjectKey(proj)).toBe('https://github.com/example/repo.git');
  });

  it('falls back to rootProject.name in settings.gradle.kts when no git origin', () => {
    const proj = makeTmpProject();
    writeFileSync(path.join(proj, 'settings.gradle.kts'), 'rootProject.name = "my-fancy-project"\ninclude(":app")\n');
    expect(resolveProjectKey(proj)).toBe('my-fancy-project');
  });

  it('falls back to rootProject.name in settings.gradle (groovy) when no git origin', () => {
    const proj = makeTmpProject();
    writeFileSync(path.join(proj, 'settings.gradle'), "rootProject.name = 'groovy-project'\n");
    expect(resolveProjectKey(proj)).toBe('groovy-project');
  });

  it('falls back to basename(projectRoot) when no git and no settings.gradle', () => {
    const proj = makeTmpProject();
    expect(resolveProjectKey(proj)).toBe(path.basename(proj));
  });
});

describe('selectUserGlobalPreset', () => {
  it('returns the preset when projects[key] exists', () => {
    const cfg = { projects: { 'k1': { defaults: { testType: 'common' } } } };
    expect(selectUserGlobalPreset(cfg, 'k1')).toEqual({ defaults: { testType: 'common' } });
  });

  it('returns null when projects[key] is absent', () => {
    const cfg = { projects: { 'k1': {} } };
    expect(selectUserGlobalPreset(cfg, 'missing')).toBeNull();
  });

  it('returns null when the projects block is missing or not an object', () => {
    expect(selectUserGlobalPreset({}, 'k1')).toBeNull();
    expect(selectUserGlobalPreset({ projects: ['nope'] }, 'k1')).toBeNull();
  });

  it('returns null for falsy inputs', () => {
    expect(selectUserGlobalPreset(null, 'k')).toBeNull();
    expect(selectUserGlobalPreset({ projects: { k: {} } }, '')).toBeNull();
  });
});

describe('loadUserGlobalPresetForProject', () => {
  it('returns the validated preset for the resolved key', () => {
    const home = makeTmpHome();
    const proj = makeTmpProject();
    writeUserConfig(home, JSON.stringify({
      projects: {
        'demo-key': {
          defaults: { testType: 'common' },
          java_home: '/opt/jdk21',
        },
      },
    }));
    const preset = loadUserGlobalPresetForProject(proj, { homeOverride: home, projectKey: 'demo-key' });
    expect(preset).toEqual({
      defaults: { testType: 'common' },
      java_home: '/opt/jdk21',
    });
  });

  it('returns null when no user config file exists', () => {
    const home = makeTmpHome();
    const proj = makeTmpProject();
    expect(loadUserGlobalPresetForProject(proj, { homeOverride: home, projectKey: 'k' })).toBeNull();
  });

  it('returns null when the file exists but the key has no preset', () => {
    const home = makeTmpHome();
    const proj = makeTmpProject();
    writeUserConfig(home, JSON.stringify({ projects: { 'other': {} } }));
    expect(loadUserGlobalPresetForProject(proj, { homeOverride: home, projectKey: 'mine' })).toBeNull();
  });

  it('drops java_home when not a string and warns', () => {
    const home = makeTmpHome();
    const proj = makeTmpProject();
    writeUserConfig(home, JSON.stringify({
      projects: { 'k': { java_home: 42, defaults: { testType: 'common' } } },
    }));
    withSilencedStderr((captured) => {
      const preset = loadUserGlobalPresetForProject(proj, { homeOverride: home, projectKey: 'k' });
      expect(preset).toEqual({ defaults: { testType: 'common' } });
      expect(captured.join('')).toContain('java_home must be a non-empty string');
    });
  });

  it('drops type-mismatched fields with warnings (parity with project-config)', () => {
    const home = makeTmpHome();
    const proj = makeTmpProject();
    writeUserConfig(home, JSON.stringify({
      projects: {
        'k': {
          defaults: { testType: 'common', coverageTool: 42 },
          skip: { android: 'not-an-array', ios: ['ok'] },
        },
      },
    }));
    withSilencedStderr((captured) => {
      const preset = loadUserGlobalPresetForProject(proj, { homeOverride: home, projectKey: 'k' });
      expect(preset.defaults).toEqual({ testType: 'common' });
      expect(preset.skip).toEqual({ ios: ['ok'] });
      const joined = captured.join('');
      expect(joined).toContain('defaults.coverageTool must be a non-empty string');
      expect(joined).toContain('skip.android must be an array of strings');
    });
  });

  it('uses resolveProjectKey when no projectKey override is provided', () => {
    const home = makeTmpHome();
    const proj = makeTmpProject();
    const autoKey = path.basename(proj); // resolveProjectKey falls back to basename
    writeUserConfig(home, JSON.stringify({
      projects: { [autoKey]: { defaults: { testType: 'common' } } },
    }));
    const preset = loadUserGlobalPresetForProject(proj, { homeOverride: home });
    expect(preset).toEqual({ defaults: { testType: 'common' } });
  });
});

describe('mergeConfigs', () => {
  it('returns null when both inputs are null', () => {
    expect(mergeConfigs(null, null)).toBeNull();
  });

  it('returns project-local when user-global is null', () => {
    const proj = { defaults: { testType: 'common' } };
    expect(mergeConfigs(null, proj)).toEqual(proj);
  });

  it('returns user-global when project-local is null', () => {
    const user = { defaults: { testType: 'common' }, java_home: '/opt/jdk' };
    expect(mergeConfigs(user, null)).toEqual(user);
  });

  it('project-local overrides user-global for defaults.testType', () => {
    const user = { defaults: { testType: 'common', coverageTool: 'kover' } };
    const proj = { defaults: { testType: 'jvm' } };
    expect(mergeConfigs(user, proj)).toEqual({
      defaults: { testType: 'jvm', coverageTool: 'kover' }, // testType from proj, coverageTool from user
    });
  });

  it('user-global persists when project-local omits the key entirely', () => {
    const user = { defaults: { testType: 'common', coverageTool: 'kover' } };
    const proj = { sharedProject: { name: 'x' } };
    const merged = mergeConfigs(user, proj);
    expect(merged.defaults).toEqual({ testType: 'common', coverageTool: 'kover' });
    expect(merged.sharedProject).toEqual({ name: 'x' });
  });

  it('skip[platform] from project-local REPLACES user-global list (not concat)', () => {
    const user = { skip: { android: ['user-a', 'user-b'], ios: ['user-i'] } };
    const proj = { skip: { android: ['proj-a'] } };
    const merged = mergeConfigs(user, proj);
    expect(merged.skip.android).toEqual(['proj-a']);     // replaced
    expect(merged.skip.ios).toEqual(['user-i']);          // unchanged
  });

  it('user-global java_home survives the merge', () => {
    const user = { java_home: '/opt/jdk21' };
    const proj = { defaults: { testType: 'common' } };
    expect(mergeConfigs(user, proj).java_home).toBe('/opt/jdk21');
  });

  it('project-local java_home is dropped + warned (security guard)', () => {
    const user = { defaults: { testType: 'common' } };
    const proj = { java_home: '/malicious/jdk', defaults: { testType: 'jvm' } };
    withSilencedStderr((captured) => {
      const merged = mergeConfigs(user, proj);
      expect(merged.java_home).toBeUndefined();
      expect(captured.join('')).toContain('java_home is not allowed in project-local config');
    });
  });

  it('project-local java_home is dropped + warned even when user-global is null', () => {
    const proj = { java_home: '/x', defaults: { testType: 'jvm' } };
    withSilencedStderr((captured) => {
      const merged = mergeConfigs(null, proj);
      expect(merged.java_home).toBeUndefined();
      expect(merged.defaults).toEqual({ testType: 'jvm' });
      expect(captured.join('')).toContain('java_home is not allowed in project-local config');
    });
  });

  it('preserves unknown top-level keys from both layers (project-local wins)', () => {
    const user = { customA: 1, customB: 'user' };
    const proj = { customB: 'proj', customC: true };
    const merged = mergeConfigs(user, proj);
    expect(merged.customA).toBe(1);
    expect(merged.customB).toBe('proj');
    expect(merged.customC).toBe(true);
  });
});
