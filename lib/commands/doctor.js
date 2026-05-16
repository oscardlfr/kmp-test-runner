// SPDX-License-Identifier: MIT
// lib/commands/doctor.js — `kmp-test doctor` subcommand: environment diagnostics.
// Extracted from lib/cli.js in refactor PR-04 (pre-v0.10). The CLI re-exports
// runDoctor / runDoctorChecks from this file via its export block so external
// consumers (info-orchestrator, tests) keep importing from './cli.js' through
// ESM live bindings.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { discoverInstalledJdks } from '../jdk-catalogue.js';
import { discoverAndroidSdk, inspectLocalProperties } from '../android-sdk-catalogue.js';
import { loadProjectConfig, CONFIG_FILE_NAME } from '../project-config.js';
import {
  loadUserGlobalConfig,
  resolveProjectKey,
  selectUserGlobalPreset,
  userConfigPath,
} from '../user-config.js';
import { EXIT, ENVELOPE_SCHEMA_VERSION } from '../envelope/exit-codes.js';
import { emitJson, readVersion } from '../envelope/builder.js';
// Three helpers stay in cli.js (still used elsewhere). ESM live bindings
// resolve the cli.js → commands/doctor.js → cli.js cycle the same way it
// already does for info/describe/update orchestrators (see comment block at
// the top of lib/cli.js).
import { getProjectRoot, parseGradleConfig, checkGradlew } from '../cli.js';

function pad(s, n) {
  const str = String(s ?? '');
  if (str.length >= n) return str;
  return str + ' '.repeat(n - str.length);
}

/**
 * Build the array of doctor checks. Pure over spawnSync results — mockable.
 * @param {string} projectRoot
 * @param {boolean} [isWin=process.platform === 'win32']
 * @returns {{checks: Array<{name:string,status:string,detail:string}>, exitCode:number}}
 */
function runDoctorChecks(projectRoot, isWin = process.platform === 'win32') {
  const checks = [];

  // Node version
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  checks.push({
    name: 'Node',
    status: nodeMajor >= 18 ? 'OK' : 'FAIL',
    value: 'v' + process.versions.node,
    message: nodeMajor >= 18 ? '>=18 required' : 'upgrade to Node 18+',
  });

  // Shell
  if (isWin) {
    const pwsh = spawnSync('pwsh', ['-NoLogo', '-Command', '$null'], { stdio: 'ignore' });
    const ps = spawnSync('powershell.exe', ['-NoLogo', '-Command', '$null'], { stdio: 'ignore' });
    if (pwsh.status === 0) {
      checks.push({ name: 'pwsh', status: 'OK', value: 'available', message: 'cross-platform PowerShell present' });
    } else if (ps.status === 0) {
      checks.push({ name: 'pwsh', status: 'WARN', value: 'powershell.exe only', message: 'install pwsh 7+ for cross-shell parity' });
    } else {
      checks.push({ name: 'pwsh', status: 'FAIL', value: 'not found', message: 'install PowerShell to run kmp-test on Windows' });
    }
  } else {
    const bash = spawnSync('bash', ['-c', 'true'], { stdio: 'ignore' });
    if (bash.status === 0) {
      checks.push({ name: 'bash', status: 'OK', value: 'available', message: 'shell present' });
    } else {
      checks.push({ name: 'bash', status: 'FAIL', value: 'not found', message: 'install bash to run kmp-test on Unix' });
    }
  }

  // gradlew (warn-only — doctor itself doesn't require a project)
  if (checkGradlew(projectRoot, isWin)) {
    checks.push({ name: 'gradlew', status: 'OK', value: 'present', message: projectRoot });
  } else {
    checks.push({
      name: 'gradlew',
      status: 'WARN',
      value: 'not found',
      message: `no wrapper in ${projectRoot} — run from a Gradle project or pass --project-root`,
    });
  }

  // JDK — `java -version` writes to stderr in most JVMs.
  const java = spawnSync('java', ['-version'], { encoding: 'utf8' });
  if (java.error || java.status === null) {
    checks.push({ name: 'JDK', status: 'FAIL', value: 'not found', message: 'install JDK 17+ and add to PATH' });
  } else {
    const out = (java.stderr || '') + (java.stdout || '');
    const m = out.match(/version "([^"]+)"/);
    const ver = m ? m[1] : 'unknown';
    let major = 0;
    if (m) {
      const head = m[1].split('.')[0];
      major = head === '1' ? parseInt(m[1].split('.')[1] || '0', 10) : parseInt(head, 10);
    }
    if (major >= 17) {
      checks.push({ name: 'JDK', status: 'OK', value: ver, message: '>=17 recommended' });
    } else if (major > 0) {
      checks.push({ name: 'JDK', status: 'WARN', value: ver, message: 'upgrade to JDK 17+ for current Gradle/AGP' });
    } else {
      checks.push({ name: 'JDK', status: 'WARN', value: ver, message: 'unable to parse java -version output' });
    }
  }

  // v0.6.x Gap 2: surface the JDK catalogue so users can see which installs
  // are eligible for auto-select. WARN if zero installs detected (no
  // auto-select possible); OK otherwise. Each entry is reported as a
  // separate check so the JSON envelope stays granular.
  let installedJdks = [];
  try { installedJdks = discoverInstalledJdks(); } catch { /* best-effort */ }
  if (installedJdks.length === 0) {
    checks.push({
      name: 'JDK catalogue',
      status: 'WARN',
      value: 'empty',
      message: 'no installs detected — auto-select disabled, gate will fire on JDK mismatch',
    });
  } else {
    checks.push({
      name: 'JDK catalogue',
      status: 'OK',
      value: `${installedJdks.length} install${installedJdks.length === 1 ? '' : 's'}`,
      message: installedJdks.map(e => `JDK ${e.majorVersion} (${e.vendor})`).join(', '),
    });
  }

  // 2026-05-03 — Android SDK presence check. Warns when ANDROID_HOME unset
  // AND no SDK auto-detected at canonical paths (Confetti / PeopleInSpace
  // wide-smoke surfaced "SDK location not found" failures with no
  // diagnostic). When found via auto-detect, reports the path so the user
  // sees what gradle would receive.
  try {
    const envSdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || null;
    const detected = discoverAndroidSdk();
    if (envSdk) {
      checks.push({
        name: 'Android SDK',
        status: 'OK',
        value: 'env',
        message: `ANDROID_HOME=${envSdk}`,
      });
    } else if (detected) {
      checks.push({
        name: 'Android SDK',
        status: 'OK',
        value: 'auto-detect',
        message: `${detected} (will be auto-set as ANDROID_HOME for android dispatches)`,
      });
    } else {
      checks.push({
        name: 'Android SDK',
        status: 'WARN',
        value: 'not found',
        message: 'set ANDROID_HOME or install Android Studio (skips android subcommand)',
      });
    }

    // 2026-05-03 — local.properties health check. Detects the malformed-
    // Properties-escape gotcha that throws AGP IOException even when
    // ANDROID_HOME is correctly set. Common shape: `sdk.dir=C\:\Users\...`
    // (single backslashes are Properties escape characters, get silently
    // stripped, yielding a non-existent path).
    const lp = inspectLocalProperties(projectRoot);
    if (lp === null) {
      // No local.properties OR no sdk.dir line — nothing to validate
      // (auto-detect handles this case via ANDROID_HOME augmentation).
    } else if (lp.ok) {
      checks.push({
        name: 'local.properties',
        status: 'OK',
        value: 'sdk.dir',
        message: `${lp.path}`,
      });
    } else {
      checks.push({
        name: 'local.properties',
        status: 'WARN',
        value: 'malformed sdk.dir',
        message: `${lp.reason} (raw: ${lp.raw}; resolved: ${lp.path})`,
      });
    }
  } catch { /* best-effort — never block doctor on this check */ }

  // v0.8.0 — project config file (`.kmp-test-runner.json`) presence + parseability.
  try {
    const configPath = path.join(projectRoot, CONFIG_FILE_NAME);
    if (!existsSync(configPath)) {
      checks.push({
        name: 'Config file',
        status: 'OK',
        value: 'not present',
        message: `optional — see README for ${CONFIG_FILE_NAME} schema`,
      });
    } else {
      const cfg = loadProjectConfig(projectRoot);
      if (cfg === null) {
        checks.push({
          name: 'Config file',
          status: 'WARN',
          value: 'parse error',
          message: `${configPath} — file present but failed to load (see prior [WARN] line)`,
        });
      } else {
        const fields = [];
        if (cfg.sharedProject?.name) fields.push('sharedProject');
        if (cfg.defaults && Object.keys(cfg.defaults).length) fields.push('defaults');
        if (cfg.skip && Object.keys(cfg.skip).length) fields.push('skip');
        checks.push({
          name: 'Config file',
          status: 'OK',
          value: 'found',
          message: `${configPath}${fields.length ? ` — ${fields.join(', ')}` : ' — empty (no recognised fields)'}`,
        });
      }
    }
  } catch { /* best-effort — never block doctor on this check */ }

  // v0.10 #3 — user-global config (~/.kmp-test/config.json) presence + matched
  // preset for the current project's lookup key.
  try {
    const userCfgPath = userConfigPath();
    if (!existsSync(userCfgPath)) {
      checks.push({
        name: 'User config',
        status: 'OK',
        value: 'not present',
        message: `optional — see README for ${userCfgPath} schema`,
      });
    } else {
      const userCfg = loadUserGlobalConfig();
      if (userCfg === null) {
        checks.push({
          name: 'User config',
          status: 'WARN',
          value: 'parse error',
          message: `${userCfgPath} — file present but failed to load (see prior [WARN] line)`,
        });
      } else {
        const key = resolveProjectKey(projectRoot);
        const preset = selectUserGlobalPreset(userCfg, key);
        if (preset) {
          const fields = [];
          if (preset.sharedProject?.name) fields.push('sharedProject');
          if (preset.defaults && Object.keys(preset.defaults).length) fields.push('defaults');
          if (preset.skip && Object.keys(preset.skip).length) fields.push('skip');
          if (typeof preset.java_home === 'string' && preset.java_home) fields.push('java_home');
          checks.push({
            name: 'User config',
            status: 'OK',
            value: 'preset matched',
            message: `${userCfgPath} — key=${key}${fields.length ? ` (${fields.join(', ')})` : ''}`,
          });
        } else {
          checks.push({
            name: 'User config',
            status: 'OK',
            value: 'no preset',
            message: `${userCfgPath} — no preset for key=${key}`,
          });
        }
      }
    }
  } catch { /* best-effort — never block doctor on this check */ }

  // ADB — warn-only (only the android subcommand uses it).
  // KMP_TEST_SKIP_ADB=1 opt-out: on macos-latest GH runners the adb client
  // inherits Node's pipe FDs and prevents bats from reaching pipe EOF on
  // suite exit, hanging the whole run. Tests that invoke `kmp-test doctor`
  // export this var so the probe is bypassed; the contract is also pre-
  // published for orchestrator wrappers (BACKLOG input contracts).
  if (process.env.KMP_TEST_SKIP_ADB === '1') {
    checks.push({
      name: 'ADB',
      status: 'WARN',
      value: 'skipped',
      message: 'KMP_TEST_SKIP_ADB=1 — unset to re-enable adb probe',
    });
  } else {
    const adb = spawnSync('adb', ['version'], { encoding: 'utf8' });
    if (adb.error || adb.status !== 0) {
      checks.push({
        name: 'ADB',
        status: 'WARN',
        value: 'not found',
        message: 'install Android SDK platform-tools to run android subcommand',
      });
    } else {
      const out = (adb.stdout || '') + (adb.stderr || '');
      const m = out.match(/Version (\S+)/);
      checks.push({
        name: 'ADB',
        status: 'OK',
        value: m ? m[1] : 'available',
        message: 'instrumented tests supported',
      });
    }
  }

  const exitCode = checks.some(c => c.status === 'FAIL') ? EXIT.ENV_ERROR : EXIT.SUCCESS;
  return { checks, exitCode };
}

/**
 * Run `kmp-test doctor` — print or emit env diagnostic envelope.
 * @param {string[]} args - CLI argv tail (post subcommand name).
 * @param {boolean} jsonMode - When true, emit JSON envelope to stdout.
 * @returns {number} Process exit code (EXIT.SUCCESS or EXIT.ENV_ERROR).
 */
function runDoctor(args, jsonMode) {
  const startTime = Date.now();
  const projectRoot = path.resolve(getProjectRoot(args));
  const { checks, exitCode } = runDoctorChecks(projectRoot);
  // v0.8.1 — informational gradle_config diagnostic. Top-level alongside
  // checks[] (NOT a check itself — no PASS/WARN/FAIL judgement).
  const gradleConfig = parseGradleConfig(projectRoot);
  const durationMs = Date.now() - startTime;

  if (jsonMode) {
    // wet-audit-v0.9-part2 OBS-1 — unify envelope shape across subcommands.
    // Pre-fix `doctor` envelope had 9 keys while `info`/`describe`/`parallel`/
    // etc had 14-16 keys (extra: tests, modules, skipped, coverage, errors,
    // warnings). Same `schema_version: 1` covered two distinct shapes,
    // forcing agents to special-case `subcommand:"doctor"` in generic
    // envelope-readers. Add the empty defaults here so the unified shape
    // holds across all subcommands. `checks` and `gradle_config` remain the
    // doctor-specific top-level fields. Additive: `schema_version` does NOT
    // bump (per ENVELOPE_SCHEMA_VERSION policy at line ~96 — additive fields
    // do not bump).
    emitJson({
      tool: 'kmp-test',
      schema_version: ENVELOPE_SCHEMA_VERSION,
      subcommand: 'doctor',
      version: readVersion(),
      project_root: projectRoot,
      exit_code: exitCode,
      duration_ms: durationMs,
      tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
      modules: [],
      skipped: [],
      coverage: { tool: 'none', missed_lines: null },
      errors: [],
      warnings: [],
      checks,
      gradle_config: gradleConfig,
    });
    return exitCode;
  }

  process.stdout.write('\nkmp-test doctor — environment diagnostics\n');
  process.stdout.write(`Project root: ${projectRoot}\n\n`);
  const namePad = Math.max(7, ...checks.map(c => c.name.length));
  const valPad = Math.max(5, ...checks.map(c => (c.value || '').length));
  process.stdout.write(
    pad('CHECK', namePad) + '  ' + pad('STATUS', 6) + '  ' + pad('VALUE', valPad) + '  MESSAGE\n'
  );
  process.stdout.write('-'.repeat(namePad + 6 + valPad + 12) + '\n');
  for (const c of checks) {
    process.stdout.write(
      pad(c.name, namePad) + '  ' + pad(c.status, 6) + '  ' + pad(c.value || '', valPad) + '  ' + (c.message || '') + '\n'
    );
  }

  // v0.8.1 — Gradle config block (informational, separate from checks table).
  const cfgSrcs = [];
  if (gradleConfig.sources.project) cfgSrcs.push('project');
  if (gradleConfig.sources.user) cfgSrcs.push('user');
  const cfgSrcLabel = cfgSrcs.length
    ? cfgSrcs.join(' + ') + ' resolved'
    : 'gradle defaults — no .properties found';
  process.stdout.write(`\nGradle config (${cfgSrcLabel}):\n`);
  process.stdout.write(
    `  parallel=${gradleConfig.parallel}` +
    `  workers.max=${gradleConfig.workers_max ?? 'auto'}` +
    `  caching=${gradleConfig.caching}` +
    `  daemon=${gradleConfig.daemon}` +
    `  configureondemand=${gradleConfig.configureondemand}\n`
  );
  if (gradleConfig.jvmargs) {
    process.stdout.write(`  jvmargs=${gradleConfig.jvmargs}\n`);
  }

  process.stdout.write('\n');
  if (exitCode === EXIT.ENV_ERROR) {
    process.stdout.write('1+ FAIL detected — kmp-test may not run correctly. Address the remediation hints above.\n');
  } else {
    process.stdout.write('All checks OK or WARN — kmp-test should run correctly.\n');
  }
  return exitCode;
}

// Refactor PR-09 — dispatch-table contract.
// `parse(args)` returns { ok, errors, parsed } so the cli.js#main dispatch
// layer can short-circuit on invalid input. doctor has no enum/int validation
// (it's pure environment diagnostics) so parse always returns ok.
function parse(_args) {
  return { ok: true, errors: [], parsed: {} };
}

// `run({ projectRoot, args, jsonMode })` returns the exit code. The dispatch
// table never needs the envelope back (doctor emits its JSON directly).
function run({ args, jsonMode }) {
  return runDoctor(args, jsonMode);
}

export { runDoctor, runDoctorChecks, parse, run };
