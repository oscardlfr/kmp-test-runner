// SPDX-License-Identifier: MIT
// lib/user-config.js — user-global config loader.
// File path: ~/.kmp-test/config.json (Linux/macOS), %USERPROFILE%\.kmp-test\config.json (Windows).
//
// Schema:
//   {
//     "projects": {
//       "<lookup-key>": {
//         "sharedProject": { name, path },
//         "defaults":      { testType, coverageTool, excludeModules },
//         "skip":          { android, desktop, ios, macos },
//         "java_home":     "/path/to/jdk"
//       }
//     }
//   }
//
// Lookup-key resolution (most → least stable, first hit wins):
//   1. git remote get-url origin
//   2. rootProject.name = "..." in settings.gradle(.kts)
//   3. basename(projectRoot)
//
// Precedence (full chain owned by lib/project-config.js loadMergedConfig):
//   CLI flag > env var > project-local > user-global > built-in default
//
// Security (Decision #4): java_home is allowed ONLY in the user-global preset.
// Project-local .kmp-test-runner.json may be checked into a repo — letting it
// mutate JAVA_HOME would be a supply-chain vector. mergeConfigs drops + warns
// when project-local carries java_home.
//
// All paths are best-effort: missing/malformed inputs → null, never throw.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

export const USER_CONFIG_DIR_NAME = '.kmp-test';
export const USER_CONFIG_FILE_NAME = 'config.json';

const USER_CONFIG_LABEL = `${USER_CONFIG_DIR_NAME}/${USER_CONFIG_FILE_NAME}`;
const PROJECT_LOCAL_LABEL = '.kmp-test-runner.json';

function userWarnStderr(msg) {
  process.stderr.write(`[WARN] ${USER_CONFIG_LABEL}: ${msg}\n`);
}

export function userConfigPath(homeOverride) {
  const home = homeOverride || os.homedir();
  return path.join(home, USER_CONFIG_DIR_NAME, USER_CONFIG_FILE_NAME);
}

export function loadUserGlobalConfig(homeOverride) {
  const cfgPath = userConfigPath(homeOverride);
  if (!existsSync(cfgPath)) return null;
  let raw;
  try {
    raw = readFileSync(cfgPath, 'utf8');
  } catch (e) {
    userWarnStderr(`read failed: ${e.message} — ignoring`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    userWarnStderr(`parse failed: ${e.message} — ignoring`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    userWarnStderr('top-level must be a JSON object — ignoring');
    return null;
  }
  return parsed;
}

// Resolve current project's lookup key. Best-effort: never throws.
export function resolveProjectKey(projectRoot) {
  if (!projectRoot) return null;

  // 1) git remote get-url origin
  try {
    const out = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      encoding: 'utf8',
    }).trim();
    if (out) return out;
  } catch { /* fall through to settings.gradle parse */ }

  // 2) rootProject.name in settings.gradle(.kts)
  for (const settingsName of ['settings.gradle.kts', 'settings.gradle']) {
    const p = path.join(projectRoot, settingsName);
    if (!existsSync(p)) continue;
    try {
      const text = readFileSync(p, 'utf8');
      const m = text.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/);
      if (m && m[1]) return m[1];
    } catch { /* fall through to basename */ }
  }

  // 3) basename
  return path.basename(path.resolve(projectRoot));
}

// Pick projects[key] from a loaded user-global config. Returns null on miss.
export function selectUserGlobalPreset(userConfig, projectKey) {
  if (!userConfig || !projectKey) return null;
  const projects = userConfig.projects;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return null;
  const preset = projects[projectKey];
  if (!preset || typeof preset !== 'object' || Array.isArray(preset)) return null;
  return preset;
}

// Validate a user-global preset. Mirrors project-config.validateConfig but
// adds the user-global-only `java_home` field. Duplicate-by-design: the warn
// prefix is namespace-specific.
function validateUserPreset(cfg, collect) {
  // Shadows the module-level stderr helper: every existing userWarn() call
  // in this function keeps its stderr line AND feeds the collector when one
  // is provided (envelope warnings[] surfacing).
  const userWarn = (msg) => {
    userWarnStderr(msg);
    if (collect) collect({ code: 'config_invalid_field', source: 'user_global', message: msg });
  };
  const out = {};

  if (cfg.sharedProject != null) {
    if (typeof cfg.sharedProject === 'object' && !Array.isArray(cfg.sharedProject)) {
      out.sharedProject = {};
      if (typeof cfg.sharedProject.name === 'string' && cfg.sharedProject.name) {
        out.sharedProject.name = cfg.sharedProject.name;
      } else if (cfg.sharedProject.name != null) {
        userWarn('sharedProject.name must be a non-empty string — dropped');
      }
      if (typeof cfg.sharedProject.path === 'string' && cfg.sharedProject.path) {
        out.sharedProject.path = cfg.sharedProject.path;
      } else if (cfg.sharedProject.path != null) {
        userWarn('sharedProject.path must be a non-empty string — dropped');
      }
    } else {
      userWarn('sharedProject must be an object — dropped');
    }
  }

  if (cfg.defaults != null) {
    if (typeof cfg.defaults === 'object' && !Array.isArray(cfg.defaults)) {
      out.defaults = {};
      for (const k of ['testType', 'coverageTool', 'excludeModules']) {
        const v = cfg.defaults[k];
        if (typeof v === 'string' && v) {
          out.defaults[k] = v;
        } else if (v != null) {
          userWarn(`defaults.${k} must be a non-empty string — dropped`);
        }
      }
    } else {
      userWarn('defaults must be an object — dropped');
    }
  }

  if (cfg.skip != null) {
    if (typeof cfg.skip === 'object' && !Array.isArray(cfg.skip)) {
      out.skip = {};
      for (const k of ['android', 'desktop', 'ios', 'macos']) {
        const v = cfg.skip[k];
        if (Array.isArray(v) && v.every(x => typeof x === 'string')) {
          out.skip[k] = v;
        } else if (v != null) {
          userWarn(`skip.${k} must be an array of strings — dropped`);
        }
      }
    } else {
      userWarn('skip must be an object — dropped');
    }
  }

  if (cfg.cleanup != null) {
    if (typeof cfg.cleanup === 'object' && !Array.isArray(cfg.cleanup)) {
      out.cleanup = {};
      if (typeof cfg.cleanup.auto === 'boolean') {
        out.cleanup.auto = cfg.cleanup.auto;
      } else if (cfg.cleanup.auto != null) {
        userWarn('cleanup.auto must be a boolean — dropped');
      }
      const days = cfg.cleanup.logsTtlDays;
      if (typeof days === 'number' && Number.isFinite(days) && days > 0) {
        out.cleanup.logsTtlDays = days;
      } else if (days != null) {
        userWarn('cleanup.logsTtlDays must be a positive number — dropped');
      }
    } else {
      userWarn('cleanup must be an object — dropped');
    }
  }

  if (cfg.java_home != null) {
    if (typeof cfg.java_home === 'string' && cfg.java_home) {
      out.java_home = cfg.java_home;
    } else {
      userWarn('java_home must be a non-empty string — dropped');
    }
  }

  // Forward-compat: preserve unknown top-level keys silently.
  const knownKeys = new Set(['sharedProject', 'defaults', 'skip', 'java_home']);
  for (const k of Object.keys(cfg)) {
    if (!knownKeys.has(k)) out[k] = cfg[k];
  }
  return out;
}

// One-shot: load user-global config, resolve current project key, select
// preset, validate. Returns null when nothing applicable.
//
// opts:
//   - homeOverride: override $HOME (tests)
//   - projectKey: skip resolveProjectKey and use this key directly (tests)
export function loadUserGlobalPresetForProject(projectRoot, opts = {}) {
  const userConfig = loadUserGlobalConfig(opts.homeOverride);
  if (!userConfig) return null;
  const key = opts.projectKey != null ? opts.projectKey : resolveProjectKey(projectRoot);
  if (!key) return null;
  const preset = selectUserGlobalPreset(userConfig, key);
  if (!preset) return null;
  return validateUserPreset(preset, opts.collect);
}

// Merge user-global preset (weak) with project-local config (strong).
// Project-local wins per Decision #3. Sub-objects are shallow-merged at the
// leaf level (project-local leaves override; user-global leaves persist when
// project-local omits them). skip[platform] arrays: project-local list
// REPLACES user-global list (not concatenated — matches "checked-in wins").
//
// Security: project-local java_home is dropped + warned (Decision #4).
export function mergeConfigs(userPreset, projectLocal, collect) {
  if (!userPreset && !projectLocal) return null;

  // Security guard: project-local cannot carry java_home.
  if (projectLocal && projectLocal.java_home != null) {
    process.stderr.write(
      `[WARN] ${PROJECT_LOCAL_LABEL}: java_home is not allowed in project-local config (use ${USER_CONFIG_LABEL}) — dropped\n`
    );
    if (collect) {
      collect({
        code: 'config_invalid_field',
        source: 'project_local',
        message: `java_home is not allowed in project-local config (use ${USER_CONFIG_LABEL}) — dropped`,
      });
    }
  }

  if (!userPreset) {
    return stripProjectLocalJavaHome(projectLocal);
  }
  if (!projectLocal) {
    return userPreset;
  }

  const out = {};

  // sharedProject
  const sharedKeys = collectKeys(userPreset.sharedProject, projectLocal.sharedProject);
  if (sharedKeys.size) {
    out.sharedProject = {};
    for (const k of sharedKeys) {
      const pv = projectLocal.sharedProject && projectLocal.sharedProject[k];
      const uv = userPreset.sharedProject && userPreset.sharedProject[k];
      out.sharedProject[k] = pv != null ? pv : uv;
    }
  }

  // defaults
  const defaultsKeys = collectKeys(userPreset.defaults, projectLocal.defaults);
  if (defaultsKeys.size) {
    out.defaults = {};
    for (const k of defaultsKeys) {
      const pv = projectLocal.defaults && projectLocal.defaults[k];
      const uv = userPreset.defaults && userPreset.defaults[k];
      out.defaults[k] = pv != null ? pv : uv;
    }
  }

  // skip — project-local list REPLACES user-global list per platform.
  const skipKeys = collectKeys(userPreset.skip, projectLocal.skip);
  if (skipKeys.size) {
    out.skip = {};
    for (const k of skipKeys) {
      const pv = projectLocal.skip && projectLocal.skip[k];
      const uv = userPreset.skip && userPreset.skip[k];
      if (Array.isArray(pv)) out.skip[k] = pv;
      else if (Array.isArray(uv)) out.skip[k] = uv;
    }
  }

  // cleanup — per-key merge, project-local wins (mirrors defaults).
  const cleanupKeys = collectKeys(userPreset.cleanup, projectLocal.cleanup);
  if (cleanupKeys.size) {
    out.cleanup = {};
    for (const k of cleanupKeys) {
      const pv = projectLocal.cleanup && projectLocal.cleanup[k];
      const uv = userPreset.cleanup && userPreset.cleanup[k];
      out.cleanup[k] = pv != null ? pv : uv;
    }
  }

  // java_home — user-global ONLY.
  if (userPreset.java_home) out.java_home = userPreset.java_home;

  // Forward-compat unknown top-level keys, project-local winning.
  const knownKeys = new Set(['sharedProject', 'defaults', 'skip', 'java_home', 'cleanup']);
  for (const k of Object.keys(userPreset)) {
    if (knownKeys.has(k)) continue;
    if (out[k] === undefined) out[k] = userPreset[k];
  }
  for (const k of Object.keys(projectLocal)) {
    if (knownKeys.has(k)) continue;
    out[k] = projectLocal[k];
  }

  return out;
}

function collectKeys(a, b) {
  const out = new Set();
  if (a && typeof a === 'object') for (const k of Object.keys(a)) out.add(k);
  if (b && typeof b === 'object') for (const k of Object.keys(b)) out.add(k);
  return out;
}

function stripProjectLocalJavaHome(projectLocal) {
  if (!projectLocal || projectLocal.java_home == null) return projectLocal;
  const { java_home, ...rest } = projectLocal;
  return rest;
}
