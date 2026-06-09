// SPDX-License-Identifier: MIT
// lib/project-config.js — v0.8.0 project-level config file loader
// (`.kmp-test-runner.json`).
//
// Resolution precedence (per BACKLOG.md L623):
//   CLI flag > env var > config file > built-in default
//
// This module owns the "config file" layer of that chain. CLI/env layers are
// applied by lib/cli.js (flag re-injection via applyConfigDefaults) and by
// orchestrators (env-first, config-fallback for SHARED_PROJECT_NAME +
// SKIP_*_MODULES).
//
// Behavior contract:
// - Absent file -> returns null silently.
// - Malformed JSON -> warns once on stderr, returns null.
// - Type mismatches in known fields -> warn + drop the offending field, keep
//   the rest. Never throws.
// - Unknown top-level fields are preserved as-is for forward compatibility.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import {
  loadUserGlobalPresetForProject,
  mergeConfigs,
} from './user-config.js';

export const CONFIG_FILE_NAME = '.kmp-test-runner.json';

function warnStderr(msg) {
  process.stderr.write(`[WARN] ${CONFIG_FILE_NAME}: ${msg}\n`);
}

// `collect` (optional) receives one structured entry per dropped field so the
// runner can surface config-validation problems in the JSON envelope's
// warnings[] — stderr-only warns are invisible to --json consumers.
export function loadProjectConfig(projectRoot, collect) {
  if (!projectRoot) return null;
  const configPath = path.join(projectRoot, CONFIG_FILE_NAME);
  if (!existsSync(configPath)) return null;
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (e) {
    warnStderr(`read failed: ${e.message} — ignoring`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    warnStderr(`parse failed: ${e.message} — ignoring`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnStderr('top-level must be a JSON object — ignoring');
    return null;
  }
  return validateConfig(parsed, collect);
}

function validateConfig(cfg, collect) {
  // Shadows the module-level stderr helper: every existing warn() call in
  // this function keeps its stderr line AND feeds the collector when one is
  // provided (envelope warnings[] surfacing).
  const warn = (msg) => {
    warnStderr(msg);
    if (collect) collect({ code: 'config_invalid_field', source: 'project_local', message: msg });
  };
  const out = {};

  if (cfg.sharedProject != null) {
    if (typeof cfg.sharedProject === 'object' && !Array.isArray(cfg.sharedProject)) {
      out.sharedProject = {};
      if (typeof cfg.sharedProject.name === 'string' && cfg.sharedProject.name) {
        out.sharedProject.name = cfg.sharedProject.name;
      } else if (cfg.sharedProject.name != null) {
        warn('sharedProject.name must be a non-empty string — dropped');
      }
      if (typeof cfg.sharedProject.path === 'string' && cfg.sharedProject.path) {
        out.sharedProject.path = cfg.sharedProject.path;
      } else if (cfg.sharedProject.path != null) {
        warn('sharedProject.path must be a non-empty string — dropped');
      }
    } else {
      warn('sharedProject must be an object — dropped');
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
          warn(`defaults.${k} must be a non-empty string — dropped`);
        }
      }
    } else {
      warn('defaults must be an object — dropped');
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
          warn(`skip.${k} must be an array of strings — dropped`);
        }
      }
    } else {
      warn('skip must be an object — dropped');
    }
  }

  if (cfg.cleanup != null) {
    if (typeof cfg.cleanup === 'object' && !Array.isArray(cfg.cleanup)) {
      out.cleanup = {};
      if (typeof cfg.cleanup.auto === 'boolean') {
        out.cleanup.auto = cfg.cleanup.auto;
      } else if (cfg.cleanup.auto != null) {
        warn('cleanup.auto must be a boolean — dropped');
      }
      const days = cfg.cleanup.logsTtlDays;
      if (typeof days === 'number' && Number.isFinite(days) && days > 0) {
        out.cleanup.logsTtlDays = days;
      } else if (days != null) {
        warn('cleanup.logsTtlDays must be a positive number — dropped');
      }
    } else {
      warn('cleanup must be an object — dropped');
    }
  }

  // Forward-compat: preserve unknown top-level keys silently.
  for (const k of Object.keys(cfg)) {
    if (!['sharedProject', 'defaults', 'skip', 'cleanup'].includes(k)) out[k] = cfg[k];
  }
  return out;
}

// applyConfigDefaults — re-inject argv defaults from config when the
// corresponding flag is absent. CLI flags always win; this helper only fills
// gaps. Used by lib/cli.js before dispatching to the wrapper script.
//
// Also injects `--java-home <path>` when the resolved config (after
// user-global + project-local merge) carries `java_home` and the flag
// is not already present on the command line.
export function applyConfigDefaults(args, config) {
  if (!config) return args;
  const out = [...args];

  if (config.defaults) {
    for (const [flag, key] of [
      ['--test-type', 'testType'],
      ['--coverage-tool', 'coverageTool'],
      ['--exclude-modules', 'excludeModules'],
    ]) {
      if (out.includes(flag)) continue;
      const val = config.defaults[key];
      if (typeof val === 'string' && val) {
        out.push(flag, val);
      }
    }
  }

  if (typeof config.java_home === 'string' && config.java_home && !out.includes('--java-home')) {
    out.push('--java-home', config.java_home);
  }

  return out;
}

// loadMergedConfig — load both layers and return the resolved view.
//
// Resolution chain (handled here):
//   user-global preset (~/.kmp-test/config.json, keyed by project)
//   ⊕ project-local (.kmp-test-runner.json)
// Project-local wins per merge precedence. Returns null when neither layer
// produced anything.
//
// Consumers that need to surface provenance (e.g. doctor) should call
// loadProjectConfig + loadUserGlobalPresetForProject separately. This wrapper
// is for the dispatch path (cli.js, runner.js, script-dispatcher.js) that only
// needs the resolved view.
//
// opts (forwarded to user-config loader):
//   - homeOverride
//   - projectKey
export function loadMergedConfig(projectRoot, opts = {}) {
  const collect = opts.collect || null;
  const userPreset = loadUserGlobalPresetForProject(projectRoot, { ...opts, collect });
  const projectLocal = loadProjectConfig(projectRoot, collect);
  return mergeConfigs(userPreset, projectLocal, collect);
}
