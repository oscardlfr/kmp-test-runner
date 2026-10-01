#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/transcript-access-scan.mjs <closure-dir> -- at closure, scan the raw text of every
// cell's transcript for the ground truth an agent must never have reached: the scenario corpus (expected
// answers, scenarios, fixtures), the preregistration, the private-evidence directories, and the harness's own
// test fixtures, which hold copies of a scenario's answer. The scan reports, per cell, how many times each
// pattern matched; it never prints or keeps the text it matched.
// campaign-summary.mjs --access-scan excludes every cell with a hit.
//
// It reads `<closure-dir>/manifest.json` (for the campaign id and the campaign's own private root) and
// `<closure-dir>/private/<cell>/transcript.jsonl`, the layout campaign-summary.mjs reads. A Windows path
// appears in a transcript JSON-escaped (every backslash doubled), so every separator below matches a
// forward slash, a backslash, or any run of either.
//
// Deliberately NOT a pattern: the harness checkout's own directory. kmp-test's stack traces print paths
// inside it, so a match there would flag an innocent cell.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACCESS_SCAN_SCHEMA = 1;

const SEPARATOR = /[\\/]+/.source;

// `Evidence1Private` is the guest prefix every run's private root shares, so a path into a SIBLING
// campaign's private evidence is a hit too, not only this campaign's own.
// The guest's harness checkout also holds copies of a scenario's answer outside the corpus: the harness's test
// fixtures and Pester and vitest suites. `harness_tests` needs a separator before `tests` and one of the three
// harness directories after it, so the project under test (`src/test/`, `build/reports/tests/<task>/`) is no
// hit; `answer_fixtures` names the two fixture files that carry the multi-module answer.
const FIXED_PATTERNS = Object.freeze([
  { label: 'corpus', source: `corpus${SEPARATOR}(?:expected|scenarios|fixtures)` },
  { label: 'preregistration', source: 'preregistration' },
  { label: 'private_evidence', source: 'Evidence1Private' },
  { label: 'harness_tests', source: String.raw`[\\/]tests[\\/]+(?:fixtures|pester|vitest)[\\/]` },
  { label: 'answer_fixtures', source: 'agentic-eval-multi-module|kmp-test-envelope-failing' },
]);

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The manifest's private_root as a pattern built segment by segment, so it matches however the path is
 * written and is never read as a regular expression itself. Null when the manifest names no private root. */
function privateRootPattern(privateRoot) {
  if (typeof privateRoot !== 'string') return null;
  const segments = privateRoot.split(/[\\/]+/).filter((segment) => segment !== '');
  if (segments.length === 0) return null;
  return { label: 'private_root', source: segments.map(escapeRegExp).join(SEPARATOR) };
}

function readManifest(closureDir) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(closureDir, 'manifest.json'), 'utf8'));
  } catch {
    throw new Error('the closure directory has no readable manifest.json');
  }
  if (manifest === null || typeof manifest !== 'object' || typeof manifest.campaign_id !== 'string' || manifest.campaign_id === '') {
    throw new Error('the closure manifest.json has no campaign_id');
  }
  return manifest;
}

const byKey = (a, b) => (a.cell_key < b.cell_key ? -1 : a.cell_key > b.cell_key ? 1 : 0);

/** The scan of one closure directory: `{schema, campaign_id, patterns, cells}`, each cell
 * `{cell_key, scanned, hits:[{label, count}]}` sorted by cell key (hits in pattern order, only patterns
 * that matched). `scanned` is false when the cell's transcript is missing or unreadable -- access then
 * was not verified, which is not the same as no hit. Throws when the closure has no readable manifest or
 * no private directory, rather than reporting an empty scan. */
export function scanClosure(closureDir) {
  const manifest = readManifest(closureDir);
  const patterns = [...FIXED_PATTERNS];
  const rootPattern = privateRootPattern(manifest.private_root);
  if (rootPattern !== null) patterns.push(rootPattern);
  const compiled = patterns.map(({ label, source }) => ({ label, regexp: new RegExp(source, 'gi') }));

  const privateDir = join(closureDir, 'private');
  let entries;
  try {
    entries = readdirSync(privateDir, { withFileTypes: true });
  } catch {
    throw new Error('the closure directory has no readable private directory');
  }

  const cells = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      let text;
      try {
        text = readFileSync(join(privateDir, entry.name, 'transcript.jsonl'), 'utf8');
      } catch {
        return { cell_key: entry.name, scanned: false, hits: [] };
      }
      const hits = [];
      for (const { label, regexp } of compiled) {
        const count = (text.match(regexp) ?? []).length;
        if (count > 0) hits.push({ label, count });
      }
      return { cell_key: entry.name, scanned: true, hits };
    })
    .sort(byKey);

  return { schema: ACCESS_SCAN_SCHEMA, campaign_id: manifest.campaign_id, patterns: patterns.map((p) => p.label), cells };
}

function main(argv) {
  const closureDir = argv[0];
  if (!closureDir || !existsSync(closureDir)) {
    console.error('usage: transcript-access-scan.mjs <closure-dir>');
    return 1;
  }
  let scan;
  try {
    scan = scanClosure(closureDir);
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 1;
  }
  console.log(JSON.stringify(scan, null, 2));
  return 0;
}

// Same entry-point guard as campaign-summary.mjs: compare resolved filesystem paths, since
// import.meta.url is a file:// URL and never equals a Windows argv[1].
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
