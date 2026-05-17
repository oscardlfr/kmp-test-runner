// SPDX-License-Identifier: MIT
// lib/update-orchestrator.js — Node-side `kmp-test update` orchestrator.
//
// `kmp-test update` re-runs the install script for the latest GitHub release.
// Idempotent: when the user is already on the latest release, emits a no-op
// envelope and exits 0. Otherwise spawns scripts/install.{sh,ps1} with
// `--version <latest>` and propagates the script's exit code.
//
// Version detection chain:
//   1. Read package.json from the running CLI (path.join(__dirname, '..', '..', 'package.json')).
//   2. Probe latest release: redirect URL primary, GH REST API fallback
//      (mirrors the canonical pattern documented in CLAUDE.md and used
//      by scripts/install.sh / scripts/install.ps1).
//
// The install script is responsible for archive download + extraction +
// PATH wiring. update-orchestrator just spawns it with the right args.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildJsonReport,
  envErrorJson,
  EXIT,
} from '../cli.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPO = 'oscardlfr/kmp-test-runner';

function parseArgs(argv) {
  const out = {
    check: false,
    force: false,
    prefix: '',
    prerelease: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--check':      out.check = true; break;
      case '--force':      out.force = true; break;
      case '--prefix':     out.prefix = argv[++i] || ''; break;
      case '--prerelease': out.prerelease = true; break;
      default: /* unknown — drop */ break;
    }
  }
  return out;
}

// Read the running CLI's package.json. Mirrors lib/cli.js#readVersion which
// uses the same __dirname-relative path.
function readCurrentVersion() {
  const pkgPath = path.join(__dirname, '..', '..', 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

// Probe the latest release tag. Returns { tag, source } where source is
// "redirect" or "api". Returns null when both probes fail. The redirect-URL
// primary path mirrors the canonical pattern documented in CLAUDE.md and used
// by scripts/install.{sh,ps1} (avoids the 60/hr GitHub API rate limit).
//
// Two-tier dispatch:
//   1. HEAD https://github.com/<repo>/releases/latest, follow redirect
//      → parsed final URL contains /releases/tag/<TAG>
//   2. GET https://api.github.com/repos/<repo>/releases/latest
//      → JSON parse, read tag_name
//
// Uses Node's built-in fetch (Node 18+; engines.node in package.json gates
// older runtimes). Avoids curl/schannel cert quirks on Windows hosts and
// removes a spawn dependency. `fetchImpl` is injectable for unit tests.
//
// `prerelease=false` (default) consumes only stable releases. The redirect
// URL always points to the latest stable; the API fallback strips pre-release
// tags by default (the redirect is canonical, so this only matters when the
// API path fires).
//
// `opts.probeErrors` (optional) is an array the function pushes diagnostic
// `{tier, source, message}` entries into when either tier fails — caught
// exceptions OR non-throw fallthroughs (no-tag-in-url, !res.ok, rejected
// tag). Callers thread it into the `release_resolve_failed` envelope so
// users hit by cert / proxy / DNS / rate-limit failures have an actionable
// signal instead of a bare error message.
async function probeLatestVersion(opts = {}) {
  // Test-only stub. Set KMP_TEST_REGISTRY_STUB to a JSON object
  // {"tag":"X.Y.Z","source":"stub"} to bypass the GitHub release probe.
  // Used by tests that snapshot the `update --check --json` envelope without
  // hitting the network. Production code paths never set this var.
  if (process.env.KMP_TEST_REGISTRY_STUB) {
    try {
      const stub = JSON.parse(process.env.KMP_TEST_REGISTRY_STUB);
      if (stub && typeof stub.tag === 'string' && stub.tag) {
        return { tag: stub.tag, source: stub.source || 'stub' };
      }
    } catch { /* fall through to live probe */ }
  }

  const allowPrerelease = !!opts.prerelease;
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const probeErrors = opts.probeErrors || [];
  if (!fetchImpl) return null;

  // Tier 1: HEAD + follow redirect. fetch() follows redirects by default;
  // the response.url ends at the final tag URL.
  try {
    const res = await fetchImpl(`https://github.com/${REPO}/releases/latest`, {
      method: 'HEAD',
      redirect: 'follow',
    });
    const url = res.url || '';
    const m = url.match(/\/releases\/tag\/(v?[\w.-]+)/);
    if (m) {
      const tag = m[1].replace(/^v/, '');
      if (tag && (allowPrerelease || !/-(alpha|beta|rc)/i.test(tag))) {
        return { tag, source: 'redirect' };
      }
      probeErrors.push({ tier: 1, source: 'redirect', message: `prerelease-tag-rejected: ${tag}` });
    } else {
      probeErrors.push({ tier: 1, source: 'redirect', message: `no-tag-in-url: ${url || '(empty)'}` });
    }
  } catch (err) {
    probeErrors.push({ tier: 1, source: 'redirect', message: err?.message || String(err) });
  }

  // Tier 2: REST API.
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (res && res.ok) {
      const data = await res.json();
      const tag = (data.tag_name || '').replace(/^v/, '');
      if (tag && (allowPrerelease || !data.prerelease)) {
        return { tag, source: 'api' };
      }
      probeErrors.push({ tier: 2, source: 'api', message: `tag-rejected: tag=${tag || '(empty)'} prerelease=${!!data.prerelease}` });
    } else {
      probeErrors.push({ tier: 2, source: 'api', message: `not-ok: status=${res?.status ?? '(unknown)'}` });
    }
  } catch (err) {
    probeErrors.push({ tier: 2, source: 'api', message: err?.message || String(err) });
  }

  return null;
}

// Compare two semver-ish version strings. Returns -1 if a < b, 0 if equal,
// 1 if a > b. Ignores pre-release suffixes for the major/minor/patch compare;
// equal majors with mixed pre-release/stable defer to string comparison.
function compareVersions(a, b) {
  const pa = a.split('.').map(s => parseInt(s, 10));
  const pb = b.split('.').map(s => parseInt(s, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const ai = pa[i] || 0;
    const bi = pb[i] || 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

// Pick the install script path + spawn-arg form for the current platform.
// Returns { command, args } that can be passed to spawnSync. On Windows uses
// pwsh / powershell.exe; on Unix uses bash.
function buildInstallSpawn(version, prefix) {
  const scriptsDir = path.join(__dirname, '..', '..', 'scripts');
  if (process.platform === 'win32') {
    const ps1 = path.join(scriptsDir, 'install.ps1');
    const args = ['-NoLogo', '-NoProfile', '-File', ps1, '-Version', version];
    if (prefix) args.push('-Prefix', prefix);
    // Prefer pwsh; fall back to powershell.exe (cli.js#pickWindowsShell does
    // a probe, but for update we trust whichever is on PATH first).
    return { command: 'pwsh', args, fallback: 'powershell.exe' };
  }
  const sh = path.join(scriptsDir, 'install.sh');
  const args = [sh, '--version', version];
  if (prefix) args.push('--prefix', prefix);
  return { command: 'bash', args };
}

/**
 * Run `kmp-test update` — check or apply self-update from the npm registry.
 * @param {object} [opts]
 * @param {string} [opts.projectRoot=process.cwd()]
 * @param {string[]} [opts.args=[]] - CLI argv tail (post subcommand name).
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @param {Function} [opts.spawn=spawnSync] - Injected spawn for tests.
 * @param {Function|null} [opts.fetchImpl=null] - Injected fetch for tests.
 * @returns {Promise<{envelope:object, exitCode:number}>}
 */
export async function runUpdate({
  projectRoot = process.cwd(),
  args = [],
  env = process.env,
  spawn = spawnSync,
  fetchImpl = null,
} = {}) {
  const startTime = Date.now();
  const opts = parseArgs(args);
  const root = path.resolve(projectRoot);

  const currentVersion = readCurrentVersion();
  if (!currentVersion) {
    const envelope = envErrorJson({
      subcommand: 'update',
      projectRoot: root,
      durationMs: Date.now() - startTime,
      message: '[ERROR] Cannot read package.json — current version unknown',
      code: 'current_version_unresolvable',
    });
    return { envelope, exitCode: EXIT.ENV_ERROR };
  }

  const probeErrors = [];
  const probe = await probeLatestVersion({ prerelease: opts.prerelease, fetchImpl, probeErrors });
  if (!probe) {
    const envelope = envErrorJson({
      subcommand: 'update',
      projectRoot: root,
      durationMs: Date.now() - startTime,
      message: `[ERROR] Could not resolve latest release for ${REPO} (redirect + API both failed)`,
      code: 'release_resolve_failed',
      extra: { probe_errors: probeErrors },
    });
    return { envelope, exitCode: EXIT.ENV_ERROR };
  }

  const cmp = compareVersions(currentVersion, probe.tag);
  const upToDate = cmp >= 0; // current >= latest

  // --check: never spawn install. Just report.
  if (opts.check) {
    const envelope = buildJsonReport({
      subcommand: 'update',
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
        update: {
          current_version: currentVersion,
          latest_version: probe.tag,
          latest_source: probe.source,
          action: 'check-only',
          up_to_date: upToDate,
          install_command: null,
        },
      },
    });
    return { envelope, exitCode: EXIT.SUCCESS };
  }

  // No-op when already on latest and not forced.
  if (upToDate && !opts.force) {
    const envelope = buildJsonReport({
      subcommand: 'update',
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
        update: {
          current_version: currentVersion,
          latest_version: probe.tag,
          latest_source: probe.source,
          action: 'no-op',
          up_to_date: true,
          reason: 'already on latest',
          install_command: null,
        },
      },
    });
    return { envelope, exitCode: EXIT.SUCCESS };
  }

  // Spawn the install script with --version <latest>.
  const { command, args: spawnArgs, fallback } = buildInstallSpawn(probe.tag, opts.prefix);

  let result = spawn(command, spawnArgs, {
    cwd: root,
    encoding: 'utf8',
    env: { ...env },
    stdio: 'inherit',
  });
  // Try the fallback shell on Windows when the primary isn't available.
  if (
    process.platform === 'win32' &&
    fallback &&
    result && (result.error || result.status === null)
  ) {
    result = spawn(fallback, spawnArgs, {
      cwd: root,
      encoding: 'utf8',
      env: { ...env },
      stdio: 'inherit',
    });
  }

  const installExit = (result && typeof result.status === 'number') ? result.status : 1;
  const installCommand = `${command} ${spawnArgs.join(' ')}`;

  if (installExit !== 0) {
    const envelope = envErrorJson({
      subcommand: 'update',
      projectRoot: root,
      durationMs: Date.now() - startTime,
      message: `[ERROR] install script exited ${installExit}`,
      code: 'install_failed',
    });
    envelope.update = {
      current_version: currentVersion,
      latest_version: probe.tag,
      latest_source: probe.source,
      action: 'install-failed',
      up_to_date: false,
      install_command: installCommand,
    };
    return { envelope, exitCode: EXIT.ENV_ERROR };
  }

  const envelope = buildJsonReport({
    subcommand: 'update',
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
      update: {
        current_version: currentVersion,
        latest_version: probe.tag,
        latest_source: probe.source,
        action: 'installed',
        up_to_date: true,
        install_command: installCommand,
      },
    },
  });
  return { envelope, exitCode: EXIT.SUCCESS };
}

export function formatUpdateText(envelope) {
  const u = envelope.update || {};
  const out = [];
  out.push('');
  out.push('kmp-test update');
  out.push('');
  out.push(`Current: ${u.current_version || '(unknown)'}`);
  out.push(`Latest:  ${u.latest_version || '(unresolved)'}${u.latest_source ? ` [${u.latest_source}]` : ''}`);
  out.push(`Action:  ${u.action || '(unknown)'}`);
  if (u.action === 'no-op') {
    out.push('');
    out.push('Already on the latest release. Pass --force to re-install.');
  } else if (u.action === 'check-only') {
    out.push('');
    out.push(u.up_to_date ? 'Up to date.' : `Update available: ${u.current_version} → ${u.latest_version}`);
  } else if (u.action === 'installed') {
    out.push('');
    out.push(`Installed v${u.latest_version} via:\n  ${u.install_command}`);
  } else if (u.action === 'install-failed') {
    out.push('');
    out.push(`Install script failed:\n  ${u.install_command}`);
  }
  out.push('');
  return out.join('\n') + '\n';
}

export {
  parseArgs,
  readCurrentVersion,
  probeLatestVersion,
  compareVersions,
  buildInstallSpawn,
  REPO,
};
