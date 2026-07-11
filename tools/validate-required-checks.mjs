#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/validate-required-checks.mjs — drift detection for .github/required-checks.json.
//
// Two modes:
//   --schema-only   Validate JSON structure only (no API calls). Always safe.
//   --check-drift   Compare manifest vs develop branch protection AND main ruleset.
//                   Reads GH_TOKEN or GITHUB_TOKEN from env.
//                   Only run on push to main/develop (GITHUB_TOKEN needs write context
//                   to read branch protection settings reliably).
//
// Called from ci.yml secrets-scan job.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = join(__dirname, '..');
const MANIFEST   = join(REPO_ROOT, '.github', 'required-checks.json');

// ---------------------------------------------------------------------------
// Schema validation (no network)

function validateSchema(manifestPath) {
  if (!existsSync(manifestPath)) {
    throw new Error(`required-checks manifest not found: ${manifestPath}`);
  }
  let raw, manifest;
  try { raw = readFileSync(manifestPath, 'utf8'); } catch (e) {
    throw new Error(`Cannot read ${manifestPath}: ${e.message}`);
  }
  try { manifest = JSON.parse(raw); } catch (e) {
    throw new Error(`required-checks manifest is not valid JSON: ${e.message}`);
  }
  if (manifest.version !== 1) {
    throw new Error(`required-checks manifest must have version: 1 (got ${JSON.stringify(manifest.version)})`);
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

// ---------------------------------------------------------------------------
// GitHub API via gh CLI (available in all GitHub Actions runners)

function ghApi(path, jqFilter) {
  const args = ['api', path];
  if (jqFilter) args.push('--jq', jqFilter);
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || '').trim();
    throw new Error(`gh api ${path} failed (exit ${result.status}): ${msg}`);
  }
  const text = result.stdout.trim();
  if (!text) throw new Error(`gh api ${path} returned empty output`);
  try { return JSON.parse(text); } catch {
    return text; // let caller handle
  }
}

// ---------------------------------------------------------------------------
// Drift validation (requires API access)

async function checkDrift(manifestContexts) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY env var is required for --check-drift');

  // --- develop: classic branch protection ---
  let developContexts;
  try {
    const developProtection = ghApi(`/repos/${repo}/branches/develop/protection`);
    developContexts = developProtection?.required_status_checks?.contexts;
    if (!Array.isArray(developContexts)) {
      throw new Error('required_status_checks.contexts not found in develop branch protection response');
    }
  } catch (err) {
    throw new Error(`Failed to fetch develop branch protection: ${err.message}`);
  }

  // --- main: repository ruleset ---
  let mainContexts;
  try {
    const rulesets = ghApi(`/repos/${repo}/rulesets`);
    if (!Array.isArray(rulesets)) throw new Error('rulesets API did not return an array');

    // Find the ruleset targeting main — accepts ~DEFAULT_BRANCH or refs/heads/main
    const mainRuleset = rulesets.find(rs => {
      const include = rs?.conditions?.ref_name?.include;
      if (!Array.isArray(include)) return false;
      return include.some(ref => ref === '~DEFAULT_BRANCH' || ref === 'refs/heads/main');
    });
    if (!mainRuleset) {
      throw new Error('No ruleset found targeting main branch (expected ~DEFAULT_BRANCH or refs/heads/main in conditions.ref_name.include)');
    }

    const detail = ghApi(`/repos/${repo}/rulesets/${mainRuleset.id}`);
    const rcRule = (detail.rules ?? []).find(r => r.type === 'required_status_checks');
    if (!rcRule) {
      throw new Error(`Ruleset ${mainRuleset.id} (${mainRuleset.name}) has no required_status_checks rule`);
    }
    mainContexts = (rcRule.parameters?.required_status_checks ?? []).map(c => c.context);
    if (mainContexts.length === 0) {
      throw new Error(`Ruleset ${mainRuleset.id} required_status_checks list is empty`);
    }
  } catch (err) {
    throw new Error(`Failed to fetch main ruleset: ${err.message}`);
  }

  // --- Compare all three lists ---
  const manifestSorted = [...manifestContexts].sort();
  const developSorted  = [...developContexts].sort();
  const mainSorted     = [...mainContexts].sort();

  const errors = [];

  const _diff = (a, b, label) => {
    const missing = a.filter(x => !b.includes(x));
    const extra   = b.filter(x => !a.includes(x));
    if (missing.length || extra.length) {
      errors.push(`Drift: manifest vs ${label}:`);
      missing.forEach(x => errors.push(`  manifest has '${x}' but ${label} does not`));
      extra.forEach(x   => errors.push(`  ${label} has '${x}' but manifest does not`));
    }
  };

  _diff(manifestSorted, developSorted, 'develop branch protection');
  _diff(manifestSorted, mainSorted, 'main ruleset');

  if (errors.length > 0) {
    errors.forEach(e => console.error(`::error::${e}`));
    console.error('::error::Update .github/required-checks.json to match branch protection and main ruleset');
    throw new Error('required-checks manifest is out of sync with branch protection / main ruleset');
  }

  console.log('required-checks manifest matches develop branch protection and main ruleset.');
  console.log(`Validated ${manifestSorted.length} required contexts.`);
}

// ---------------------------------------------------------------------------
// Main

const mode = process.argv[2];

if (mode === '--schema-only') {
  try {
    const contexts = validateSchema(MANIFEST);
    console.log(`required-checks manifest schema OK (${contexts.length} contexts).`);
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
} else if (mode === '--check-drift') {
  try {
    const contexts = validateSchema(MANIFEST);
    await checkDrift(contexts);
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
} else {
  console.error(`::error::usage: validate-required-checks.mjs --schema-only | --check-drift`);
  process.exit(1);
}
