#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/release-gate.mjs — release path hardening helpers.
//
// Consumed by .github/workflows/*.yml shell steps.
// Pure functions are exported for vitest coverage (no I/O).
// CLI entry points handle all I/O (bottom of file).
//
// Usage:
//   node tools/release-gate.mjs validate-tag <tag> [<pkgJson>]
//     exit 1 on invalid format or tag/package.json version mismatch
//
//   node tools/release-gate.mjs poll-checks <sha> <manifestPath> \
//     --repo <owner/repo> [--timeout-minutes N]
//     exit 1 on failed/missing check or timeout
//     reads token from GH_TOKEN or GITHUB_TOKEN env var

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Pure helpers — testable without I/O

export function validateTagFormat(tag) {
  return /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(String(tag ?? ''));
}

export function parseRequiredChecks(manifestPath) {
  let raw;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read required-checks manifest '${manifestPath}': ${err.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(`required-checks manifest is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(manifest.required_contexts)) {
    throw new Error(`required-checks manifest missing 'required_contexts' array`);
  }
  if (manifest.required_contexts.length === 0) {
    throw new Error(`required-checks manifest has empty 'required_contexts' array`);
  }
  if (!manifest.required_contexts.every(c => typeof c === 'string')) {
    throw new Error(`required-checks manifest 'required_contexts' must contain only strings`);
  }
  return manifest.required_contexts;
}

export function verifyTagVersion(tag, pkgJsonPath) {
  const tagVer = String(tag ?? '').replace(/^v/, '');
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read package.json '${pkgJsonPath}': ${err.message}`);
  }
  const pkgVer = pkg.version;
  return { ok: tagVer === pkgVer, tagVer, pkgVer };
}

// ---------------------------------------------------------------------------
// mergeCheckSources — pure, testable with fixture data
//
// checkRuns: [{name, conclusion, status}]
//   conclusion: 'success'|'failure'|'cancelled'|'timed_out'|'skipped'|
//               'action_required'|'stale'|null  (null = in_progress/queued)
// statuses: [{context, state}] — MUST be deduped to newest-per-context
//   state: 'success'|'failure'|'error'|'pending'
// contexts: string[] from manifest
//
// Returns: { [context]: { verdict, source } }
//   verdict: 'ok' | 'refuse' | 'wait' | 'missing'
//
// Sentinel case (report-skipped-as-success bridge):
//   check-run skipped  +  commit status success  →  'ok'
// Failure always wins:
//   check-run failure/cancelled/... overrides any commit status

const REFUSE_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale']);

export function mergeCheckSources(checkRuns, statuses, contexts) {
  // Build status map (newest-per-context — caller should dedupe, but be defensive)
  const statusMap = {};
  for (const s of statuses) {
    if (!statusMap[s.context]) statusMap[s.context] = s;
  }

  // Build check-run map: keep the LATEST run per name using started_at / completed_at.
  // Never rank by conclusion (e.g. "success beats failure") — a newer failure must
  // beat an older success, not the other way around.
  // If no timestamps are available and conclusions conflict, fail closed (refuse).
  const checkRunMap = {};
  for (const cr of checkRuns) {
    const existing = checkRunMap[cr.name];
    if (!existing) {
      checkRunMap[cr.name] = cr;
      continue;
    }
    const newTs  = _crTimestamp(cr);
    const prevTs = _crTimestamp(existing);
    if (newTs !== null && prevTs !== null) {
      if (newTs > prevTs) checkRunMap[cr.name] = cr;
      // else keep existing (it's newer or same time)
    } else {
      // Timestamps absent: fail closed — if either is a REFUSE conclusion, keep it.
      // This covers the case where a re-run has no timestamps yet (in-progress replacement).
      const newRefuse  = REFUSE_CONCLUSIONS.has(cr.conclusion) || cr.conclusion === 'skipped';
      const prevRefuse = REFUSE_CONCLUSIONS.has(existing.conclusion) || existing.conclusion === 'skipped';
      if (newRefuse && !prevRefuse) checkRunMap[cr.name] = cr;
      // else keep existing
    }
  }

  const result = {};
  for (const ctx of contexts) {
    const cr = checkRunMap[ctx];
    const st = statusMap[ctx];
    const verdict = _classify(cr, st);
    // When the sentinel applies (skipped check-run bridged by a success commit status),
    // report source as 'status' — that is the signal that made the verdict 'ok'.
    // Otherwise the check-run is the authoritative source when present.
    const isSentinelBridge = cr?.conclusion === 'skipped' && st?.state === 'success' && verdict === 'ok';
    const source = isSentinelBridge ? 'status' : cr ? 'check-run' : st ? 'status' : 'missing';
    result[ctx] = { verdict, source };
  }
  return result;
}

// Returns the best available timestamp for a check-run as a comparable value,
// or null if no timestamp is present.
function _crTimestamp(cr) {
  const ts = cr.completed_at ?? cr.started_at ?? null;
  return ts ? new Date(ts).getTime() : null;
}

function _classify(cr, st) {
  // Real failure from a check-run always wins — overrides any commit status
  if (cr && REFUSE_CONCLUSIONS.has(cr.conclusion)) return 'refuse';

  // Commit status success with absent/skipped/in-flight check-run → sentinel bridge
  const statusSuccess = st?.state === 'success';
  const crAbsentOrBridgeable = !cr || cr.conclusion === 'skipped' || cr.conclusion === null;
  if (statusSuccess && crAbsentOrBridgeable) return 'ok';

  // Commit status failure
  if (st?.state === 'failure' || st?.state === 'error') return 'refuse';

  // Check-run alone
  if (cr?.conclusion === 'success') return 'ok';
  if (cr?.conclusion === 'skipped') return 'refuse'; // no bridge status
  if (cr && !cr.conclusion) return 'wait'; // in_progress / queued

  // No conclusive check-run
  if (st?.state === 'pending') return 'wait';

  return 'missing';
}

// ---------------------------------------------------------------------------
// pollChecksForSha — fetches GitHub APIs, waits for in-flight checks
//
// opts:
//   sha          string  — commit SHA to poll
//   contexts     string[] — from parseRequiredChecks()
//   repo         string  — "owner/repo"
//   intervalMs   number  — poll interval (default 30 000)
//   timeoutMs    number  — give-up time (default 15 * 60 000)
//
// returns Promise<{ ok, timedOut?, results, missing: string[] }>

export async function pollChecksForSha({
  sha,
  contexts,
  repo,
  intervalMs = 30_000,
  timeoutMs  = 15 * 60_000,
}) {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const [crData, stData] = await Promise.all([
      _ghFetch(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`),
      _ghFetch(`/repos/${repo}/statuses/${sha}?per_page=100`),
    ]);

    // Warn (don't fail) if check-runs may be truncated
    if (crData.total_count > 100) {
      console.warn(`[release-gate] Warning: ${crData.total_count} check-runs found, only 100 fetched — increase per_page or add pagination if this repo has many CI jobs`);
    }

    const checkRuns = crData.check_runs ?? [];

    // Statuses API returns newest-first; deduplicate to newest-per-context
    const seenCtx = new Set();
    const statuses = [];
    for (const s of (Array.isArray(stData) ? stData : [])) {
      if (!seenCtx.has(s.context)) {
        seenCtx.add(s.context);
        statuses.push(s);
      }
    }

    const merged = mergeCheckSources(checkRuns, statuses, contexts);
    const entries = Object.entries(merged);

    const refusing = entries.filter(([, v]) => v.verdict === 'refuse' || v.verdict === 'missing');
    const allOk = entries.every(([, v]) => v.verdict === 'ok');
    const missing = entries.filter(([, v]) => v.verdict === 'missing').map(([ctx]) => ctx);

    if (allOk) return { ok: true, results: merged, missing: [] };
    if (refusing.length > 0) return { ok: false, results: merged, missing };

    // Some are still waiting — check timeout before sleeping
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { ok: false, timedOut: true, results: merged, missing };
    }
    await _sleep(Math.min(intervalMs, remaining));
  }
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function _ghFetch(path) {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization:        token ? `Bearer ${token}` : '',
      Accept:               'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API GET ${path} → HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// CLI entry points

async function main(argv) {
  const [cmd, ...rest] = argv;

  if (cmd === 'validate-tag') {
    // validate-tag <tag> [<pkgJson>]
    const [tag, pkgJson = join(REPO_ROOT, 'package.json')] = rest;
    if (!tag) {
      console.error('::error::usage: validate-tag <tag> [<pkgJson>]');
      process.exit(1);
    }
    if (!validateTagFormat(tag)) {
      console.error(`::error::Invalid tag format: '${tag}'. Expected: v<major>.<minor>.<patch>`);
      process.exit(1);
    }
    const { ok, tagVer, pkgVer } = verifyTagVersion(tag, pkgJson);
    if (!ok) {
      console.error(`::error::Tag version '${tagVer}' does not match package.json version '${pkgVer}'`);
      process.exit(1);
    }
    console.log(`Tag ${tag} is valid and matches package.json (${pkgVer}).`);
    return;
  }

  if (cmd === 'poll-checks') {
    // poll-checks <sha> <manifestPath> --repo <owner/repo> [--timeout-minutes N]
    const [sha, manifestPath, ...flags] = rest;
    if (!sha || !manifestPath) {
      console.error('::error::usage: poll-checks <sha> <manifestPath> --repo <owner/repo> [--timeout-minutes N]');
      process.exit(1);
    }

    let repo = process.env.GITHUB_REPOSITORY;
    let timeoutMinutes = 15;
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === '--repo' && flags[i + 1]) { repo = flags[++i]; continue; }
      if (flags[i] === '--timeout-minutes' && flags[i + 1]) { timeoutMinutes = Number(flags[++i]); continue; }
    }
    if (!repo) {
      console.error('::error::--repo <owner/repo> is required (or set GITHUB_REPOSITORY env var)');
      process.exit(1);
    }

    let contexts;
    try {
      contexts = parseRequiredChecks(manifestPath);
    } catch (err) {
      console.error(`::error::${err.message}`);
      process.exit(1);
    }

    console.log(`Polling CI checks for SHA ${sha} on ${repo} (timeout ${timeoutMinutes}m, ${contexts.length} required contexts)...`);
    contexts.forEach(ctx => console.log(`  • ${ctx}`));

    let result;
    try {
      result = await pollChecksForSha({
        sha,
        contexts,
        repo,
        intervalMs: 30_000,
        timeoutMs:  timeoutMinutes * 60_000,
      });
    } catch (err) {
      console.error(`::error::CI check poll failed: ${err.message}`);
      process.exit(1);
    }

    if (result.ok) {
      console.log(`All ${contexts.length} required CI checks are green. Proceeding.`);
      return;
    }

    if (result.timedOut) {
      console.error(`::error::Timed out after ${timeoutMinutes}m waiting for required CI checks to complete.`);
    } else {
      for (const [ctx, { verdict, source }] of Object.entries(result.results)) {
        if (verdict !== 'ok') {
          console.error(`::error::Required check '${ctx}' is not green (verdict=${verdict}, source=${source})`);
        }
      }
      if (result.missing.length > 0) {
        console.error(`::error::Missing required checks: ${result.missing.join(', ')}`);
      }
    }
    process.exit(1);
    return;
  }

  console.error(`::error::Unknown command '${cmd}'. Use: validate-tag | poll-checks`);
  process.exit(1);
}

// Only run CLI when invoked directly (not when imported by tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(err => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
