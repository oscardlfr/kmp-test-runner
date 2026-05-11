// SPDX-License-Identifier: MIT
// lib/info-orchestrator.js — Node-side `kmp-test info` orchestrator (v0.9 step 3).
//
// `kmp-test info` is the lighter sibling of `kmp-test doctor`. Doctor probes
// the same dimensions and judges each as OK / WARN / FAIL with remediation
// hints; info just reports the values in a flat key-value envelope. The
// human-readable doctor output is great for new contributors; info exists for
// agents that need the raw paths/versions without per-check parsing.
//
// Implementation: re-uses `runDoctorChecks` from cli.js verbatim, then
// reshapes the `checks[]` array into a flat envelope. No PASS/WARN/FAIL
// judgments are surfaced. Probes that can't resolve emit `null` values.

import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';

import {
  buildJsonReport,
  EXIT,
  runDoctorChecks,
  parseGradleConfig,
} from '../cli.js';
import { CONFIG_FILE_NAME } from '../project-config.js';
import { discoverInstalledJdks } from '../jdk-catalogue.js';

// Argparse for info-specific flags. Globals are stripped upstream by cli.js.
function parseArgs(argv) {
  const out = {
    noAdb: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--no-adb': out.noAdb = true; break;
      default: /* unknown — drop */ break;
    }
  }
  return out;
}

// Find a check by exact name. runDoctorChecks emits the canonical names:
// "Node", "bash" / "pwsh", "gradlew", "JDK", "JDK catalogue", "Android SDK",
// "local.properties", "Config file", "ADB".
function findCheck(checks, name) {
  return checks.find(c => c.name === name) || null;
}

// Reshape doctor's per-check entry into a typed value. Returns null when the
// probe found nothing useful (e.g., JDK FAIL with no version) so consumers
// can branch on `info.jdk === null` without parsing strings.
function reshapeJdk(jdkCheck, catalogueCheck) {
  if (!jdkCheck) return null;
  if (jdkCheck.status === 'FAIL') return null;
  return {
    version: jdkCheck.value || null,
    java_home: process.env.JAVA_HOME || null,
    note: jdkCheck.message || null,
  };
}

function reshapeJdkCatalogue(installedJdks) {
  // Read installedJdks directly from discoverInstalledJdks() rather than
  // re-parsing doctor's human-readable check.message — vendors can contain
  // commas (e.g. "Azul Systems, Inc.") which break a naive split(',').
  // Wet-validation gate post-PR-10 surfaced this divergence (doctor reported
  // 4 installs, info reported 3).
  return installedJdks.map(e => ({ major: e.majorVersion, vendor: e.vendor }));
}

function reshapeGradlew(gradlewCheck, projectRoot) {
  if (!gradlewCheck) return { present: false };
  if (gradlewCheck.status === 'WARN' && gradlewCheck.value === 'not found') {
    return { present: false };
  }
  return {
    present: true,
    project_root: projectRoot,
  };
}

function reshapeAndroidSdk(sdkCheck) {
  if (!sdkCheck) return null;
  if (sdkCheck.status === 'WARN' && sdkCheck.value === 'not found') return null;
  // env source: "ANDROID_HOME=/path"
  // auto-detect: "/path (will be auto-set as ANDROID_HOME for android dispatches)"
  const msg = sdkCheck.message || '';
  let pathStr = null;
  if (sdkCheck.value === 'env') {
    const m = msg.match(/ANDROID_HOME=(.*)/);
    pathStr = m ? m[1] : null;
  } else if (sdkCheck.value === 'auto-detect') {
    const m = msg.match(/^(\S+)\s+\(/);
    pathStr = m ? m[1] : msg.split(' ')[0];
  }
  return {
    path: pathStr,
    source: sdkCheck.value === 'env' ? 'env' : 'auto-detect',
  };
}

function reshapeAdb(adbCheck) {
  if (!adbCheck) return null;
  if (adbCheck.status === 'WARN') return null; // covers both 'not found' and 'skipped'
  return {
    version: adbCheck.value || null,
  };
}

function reshapeShell(checks) {
  // pwsh on Windows; bash on Unix.
  const pwsh = findCheck(checks, 'pwsh');
  const bash = findCheck(checks, 'bash');
  if (pwsh) {
    return { name: pwsh.value === 'available' ? 'pwsh' : 'powershell.exe', present: pwsh.status !== 'FAIL' };
  }
  if (bash) return { name: 'bash', present: bash.status !== 'FAIL' };
  return { name: null, present: false };
}

function reshapeConfig(configCheck, projectRoot) {
  if (!configCheck) return { present: false };
  if (configCheck.status === 'OK' && configCheck.value === 'not present') {
    return { present: false };
  }
  return {
    present: true,
    path: path.join(projectRoot, CONFIG_FILE_NAME),
    parse_ok: configCheck.status === 'OK',
  };
}

// Main entrypoint — invoked by lib/cli.js#main() on `kmp-test info`.
/**
 * Run `kmp-test info` — emit project summary envelope.
 * @param {object} [opts]
 * @param {string} [opts.projectRoot=process.cwd()]
 * @param {string[]} [opts.args=[]] - CLI argv tail (post subcommand name).
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @returns {{envelope:object, exitCode:number}}
 */
export function runInfo({
  projectRoot = process.cwd(),
  args = [],
  env = process.env,
} = {}) {
  const startTime = Date.now();
  const opts = parseArgs(args);
  const root = path.resolve(projectRoot);

  // Honor --no-adb by setting KMP_TEST_SKIP_ADB=1 for this call only.
  const probeEnv = opts.noAdb ? { ...env, KMP_TEST_SKIP_ADB: '1' } : env;
  const prevSkipAdb = process.env.KMP_TEST_SKIP_ADB;
  if (opts.noAdb) process.env.KMP_TEST_SKIP_ADB = '1';
  let checks;
  try {
    ({ checks } = runDoctorChecks(root));
  } finally {
    if (opts.noAdb) {
      if (prevSkipAdb === undefined) delete process.env.KMP_TEST_SKIP_ADB;
      else process.env.KMP_TEST_SKIP_ADB = prevSkipAdb;
    }
  }
  void probeEnv;

  // Compose flat envelope. Standard fields come from buildJsonReport for
  // tool/subcommand/version/project_root/exit_code/duration_ms; info-specific
  // block lives at the top level (mirrors how android adds android:{...},
  // benchmark adds benchmark:{...}, etc.).
  const gradleConfig = parseGradleConfig(root);
  let installedJdks = [];
  try { installedJdks = discoverInstalledJdks(); } catch { /* best-effort */ }
  const info = {
    node: 'v' + process.versions.node,
    os: `${os.type()} ${os.release()}`,
    platform: process.platform,
    shell: reshapeShell(checks),
    gradlew: reshapeGradlew(findCheck(checks, 'gradlew'), root),
    jdk: reshapeJdk(findCheck(checks, 'JDK'), findCheck(checks, 'JDK catalogue')),
    jdk_catalogue: reshapeJdkCatalogue(installedJdks),
    android_sdk: reshapeAndroidSdk(findCheck(checks, 'Android SDK')),
    adb: reshapeAdb(findCheck(checks, 'ADB')),
    config: reshapeConfig(findCheck(checks, 'Config file'), root),
    gradle_config: {
      parallel: gradleConfig.parallel,
      workers_max: gradleConfig.workers_max ?? null,
      caching: gradleConfig.caching,
      daemon: gradleConfig.daemon,
      configureondemand: gradleConfig.configureondemand,
      sources: gradleConfig.sources,
    },
  };

  // info never fails — missing tools surface as null values.
  const envelope = buildJsonReport({
    subcommand: 'info',
    projectRoot: root,
    exitCode: EXIT.SUCCESS,
    durationMs: Date.now() - startTime,
    parsed: {
      tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
      modules: [],
      skipped: [],
      coverage: { tool: 'auto', missed_lines: null },
      errors: [],
      warnings: [],
      info,
    },
  });

  return { envelope, exitCode: EXIT.SUCCESS };
}

// Render the human-readable info table. Mirrors the `kmp-test doctor` shape
// (same column alignment + section ordering) for visual consistency.
export function formatInfoText(info) {
  const out = [];
  out.push('');
  out.push('kmp-test info — environment paths and versions');
  out.push('');
  out.push(`Node:        ${info.node}`);
  out.push(`OS:          ${info.os}`);
  out.push(`Shell:       ${info.shell.name ?? '(unknown)'}${info.shell.present ? '' : ' (not present)'}`);
  out.push('');
  out.push(`gradlew:     ${info.gradlew.present ? info.gradlew.project_root : '(not found in project root)'}`);
  if (info.jdk) {
    out.push(`JDK:         ${info.jdk.version}`);
    if (info.jdk.java_home) out.push(`JAVA_HOME:   ${info.jdk.java_home}`);
  } else {
    out.push(`JDK:         (not found)`);
  }
  if (info.jdk_catalogue.length > 0) {
    out.push(`Catalogue:   ${info.jdk_catalogue.map(e => `JDK ${e.major} (${e.vendor})`).join(', ')}`);
  } else {
    out.push(`Catalogue:   (empty)`);
  }
  out.push('');
  if (info.android_sdk) {
    out.push(`Android SDK: ${info.android_sdk.path}  [${info.android_sdk.source}]`);
  } else {
    out.push(`Android SDK: (not found)`);
  }
  if (info.adb) {
    out.push(`ADB:         ${info.adb.version}`);
  } else {
    out.push(`ADB:         (not present or skipped)`);
  }
  out.push('');
  if (info.config.present) {
    out.push(`Config:      ${info.config.path}${info.config.parse_ok ? '' : ' (parse error)'}`);
  } else {
    out.push(`Config:      (no .kmp-test-runner.json)`);
  }
  out.push('');
  return out.join('\n') + '\n';
}

export { parseArgs };
