#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/infra-flake-classifier.mjs -- classifies each campaign cell for suspected
// exposure to two rare, non-deterministic infra-level faults documented in
// docs/audits/evidence2-preregistration.md D13: the Kotlin compiler-classloader cast fault
// (Amendment A2) and the Gradle daemon-disappeared fault (Amendment A4). A separate, small script,
// not a change to campaign-summary.mjs's own CAMPAIGN_SUMMARY_SCHEMA (stays 2) -- its output is a
// new, standalone file, never merged into or overwriting campaign-summary.json/cost-estimate.json.
//
// Deliberately narrower than a first draft that also tried to detect "preceded by an agent's own
// build-script edit" via executed_commands -- dropped per auditor review (A2 R5):
// executed_commands (schema v9) holds shell commands only, not tool-level Write/Edit/apply_patch
// calls, which are not reliably visible across runtimes in the same shape. The regex below is
// narrow enough (an internal Kotlin compiler-classloader identity cast) that no precedence check
// is needed -- an agent's own build-script edit cannot produce this specific shape.
//
// Reads, per cell: record.json/rejection.json (the same private/<runtime>-<round>/ pair
// campaign-summary.mjs's own loadCell already establishes as this closure's real on-disk shape --
// verified against that file directly) for identity (runtime_id, condition -> arm), and the cell's
// raw transcript for the actual signature search. The raw transcript is copied to the SAME
// per-cell directory as record.json/audit.json, destination name transcript.jsonl, by Evidence1's
// own existing (drafted, not yet wired into any automatic pipeline -- confirmed by grep, no real
// caller exists yet) agentic-eval-accepted-raw-transcript / agentic-eval-rejected-raw-transcript
// artifact-copy bundles (evidence1-artifact-copy-contract.psm1). This script only reads whatever
// is already there; it never invokes a copy itself.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INFRA_FLAKE_CLASSIFIER_SCHEMA = 1;

// D9-aligned: frozen at the canary, recorded in every report this script produces so a later
// change to the regex or the classification rules is visible as a version bump, never a silent
// drift between canary and campaign.
export const INFRA_FLAKE_CLASSIFIER_VERSION = 1;

// The exact shape from the real P2 diagnostic capture (docs/audits/evidence2-preregistration.md
// Amendment A2 §2) -- an internal Kotlin compiler-classloader identity cast, not a shape an
// agent's own build-script edit can produce. The generic "Script compilation error" string is
// deliberately NOT matched here: an agent's own broken edit legitimately produces that text too.
export const INFRA_FLAKE_SIGNATURE_RE =
  /org\.jetbrains\.kotlin\.cli\.jvm\.compiler\.jarfs\.\w+ cannot be cast to class org\.jetbrains\.kotlin\.cli\.jvm\.compiler\.jarfs\./;

// Second, independent signature (2026-09-29, WO-A2 auditor finding, Amendment A4): Gradle's own
// fixed daemon-death message, emitted by the Gradle CLIENT process -- never something a build
// script or an agent's own code edit can produce, the same symmetric guarantee the jarfs cast
// signature above relies on. Fires when the Gradle daemon JVM process itself disappears without a
// clean shutdown (OOM-killed, crashed, or killed externally). Observed live during DryRunPassed's
// product-smoke step (campaign 99f67197, 2026-09-29), correlated with systematic memory pressure:
// NiA's own gradle.properties requests -Xmx4g/-Xms4g for BOTH the Gradle daemon and the Kotlin
// daemon (8GB committed via -Xms alone, before any test JVM) against this harness's VM profile's
// FIXED, non-dynamic 8GB RAM allocation
// (tools/evidence1/provisioning/evidence1-windows-hyperv-e2e-v1.json: startup_memory_bytes
// 8589934592, dynamic_memory false) -- not a one-off, a structural ceiling.
export const INFRA_FLAKE_DAEMON_DISAPPEARED_SIGNATURE_RE =
  /Gradle build daemon disappeared unexpectedly/;

function armFor(condition) {
  if (condition === 'current-skill') return 'product';
  if (condition === 'no-skill') return 'free';
  return null;
}

/** Mirrors campaign-summary.mjs's own expectedCellsFromManifest -- small enough (and this
 * script's whole point is staying small and independent of that file's internals) to duplicate
 * rather than import, matching this codebase's established per-file small-helper convention. */
function expectedCellsFromManifest(manifest) {
  const cells = [];
  for (const runtime of manifest.runtimes ?? []) {
    for (const roundIndex of runtime.campaign_cell_indices ?? []) {
      cells.push({
        runtimeId: String(runtime.runtime_id), roundIndex: Number(roundIndex),
        cellKey: `${runtime.runtime_id}-${roundIndex}`,
      });
    }
  }
  return cells;
}

/** Reads a cell's record.json or rejection.json (whichever is present) for identity only
 * (condition -> arm). Never throws -- an unreadable/absent pair yields arm:null, which the
 * caller folds into the same fail-closed 'unknown' path as a missing transcript. */
function loadCellIdentity(privateRoot, cellKey) {
  const cellDir = join(privateRoot, cellKey);
  if (!existsSync(cellDir)) return { arm: null };
  let entries;
  try {
    entries = readdirSync(cellDir);
  } catch {
    return { arm: null };
  }
  try {
    if (entries.includes('record.json')) {
      const record = JSON.parse(readFileSync(join(cellDir, 'record.json'), 'utf8'));
      return { arm: armFor(record.condition) };
    }
    if (entries.includes('rejection.json')) {
      const rejection = JSON.parse(readFileSync(join(cellDir, 'rejection.json'), 'utf8'));
      const cell = Array.isArray(rejection.cells) ? rejection.cells[0] : null;
      return { arm: cell ? armFor(cell.condition) : null };
    }
  } catch {
    return { arm: null };
  }
  return { arm: null };
}

/** Classifies one cell from its raw transcript text. Returns one of:
 *   - { infra_flake_suspected: true, reason: 'signature_match' }
 *   - { infra_flake_suspected: false, reason: 'probe_failed_absorbed' }   (gradle_probe_failed, recovered:true)
 *   - { infra_flake_suspected: false, reason: 'probe_failed_unrecovered' } (recovered:false, no signature)
 *   - { infra_flake_suspected: false, reason: 'clean' }
 *   - { infra_flake_suspected: 'unknown', reason: 'transcript_missing' | 'transcript_unreadable' }
 * Fail-closed (A2 R6): a missing or unreadable transcript is 'unknown', never coerced to false. */
export function classifyCellTranscript(transcriptPath) {
  if (!existsSync(transcriptPath)) {
    return { infra_flake_suspected: 'unknown', reason: 'transcript_missing' };
  }
  let text;
  try {
    text = readFileSync(transcriptPath, 'utf8');
  } catch {
    return { infra_flake_suspected: 'unknown', reason: 'transcript_unreadable' };
  }
  return classifyTranscriptText(text);
}

/** Pure text-in, classification-out core, separated from the filesystem read above so it can be
 * unit-tested directly against fixture strings without writing files. */
export function classifyTranscriptText(text) {
  if (INFRA_FLAKE_SIGNATURE_RE.test(text) || INFRA_FLAKE_DAEMON_DISAPPEARED_SIGNATURE_RE.test(text)) {
    return { infra_flake_suspected: true, reason: 'signature_match' };
  }

  // gradle_probe_failed is Plan B's own addition (docs/audits/evidence2-preregistration.md
  // Amendment A2 §1) -- not merged as of this script's own authoring. Parsed defensively: any
  // JSON-ish object literal containing "gradle_probe_failed" is treated as a warning occurrence;
  // its own "message" field (if present) is checked against the SAME signature regex, per A2 R5
  // ("Plan B is asked to include the exception line in the excerpt").
  //
  // Scans EVERY match before deciding, never returns on the first one found (auditor review of
  // 9f2aa05): a cell can carry more than one gradle_probe_failed warning in one transcript (one
  // absorbed retry followed by a later, unrecovered one, or vice versa in text order), and an
  // early return on the first match would misclassify whichever came second. Precedence, applied
  // only after the full scan: signature (flagged) > probe_failed_unrecovered > probe_failed_absorbed
  // > clean. A signature inside any warning's own message still short-circuits immediately --
  // that outcome can never be downgraded by a later, lesser warning.
  const warningMatches = [...text.matchAll(/\{[^{}]*"gradle_probe_failed"[^{}]*\}/g)];
  let sawUnrecovered = false;
  let sawAbsorbed = false;
  for (const match of warningMatches) {
    let warning;
    try {
      warning = JSON.parse(match[0]);
    } catch {
      continue;
    }
    if (warning.recovered === true) {
      sawAbsorbed = true;
    } else if (warning.recovered === false) {
      const message = typeof warning.message === 'string' ? warning.message : '';
      if (INFRA_FLAKE_SIGNATURE_RE.test(message) || INFRA_FLAKE_DAEMON_DISAPPEARED_SIGNATURE_RE.test(message)) {
        return { infra_flake_suspected: true, reason: 'signature_match' };
      }
      sawUnrecovered = true;
    }
  }

  if (sawUnrecovered) return { infra_flake_suspected: false, reason: 'probe_failed_unrecovered' };
  if (sawAbsorbed) return { infra_flake_suspected: false, reason: 'probe_failed_absorbed' };
  return { infra_flake_suspected: false, reason: 'clean' };
}

/** Full campaign classification. Enumerates every manifest-expected cell (not only accepted
 * ones -- a cell whose transcript can't be found at all still gets an 'unknown' row, per A2 R6),
 * classifies each from its raw transcript, and rolls flagged/absorbed/unrecovered/unknown counts
 * up per (runtime, arm). Never throws for an individual cell's own defects. */
export function classifyCampaign(campaignDir) {
  const manifestPath = join(campaignDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const privateRoot = join(campaignDir, 'private');

  const cells = [];
  const rollup = {};
  for (const cell of expectedCellsFromManifest(manifest)) {
    const { arm } = loadCellIdentity(privateRoot, cell.cellKey);
    const transcriptPath = join(privateRoot, cell.cellKey, 'transcript.jsonl');
    const classification = classifyCellTranscript(transcriptPath);

    cells.push({
      cell_key: cell.cellKey, runtime_id: cell.runtimeId, arm,
      infra_flake_suspected: classification.infra_flake_suspected, reason: classification.reason,
    });

    const rollupKey = `${cell.runtimeId}:${arm ?? 'unknown'}`;
    rollup[rollupKey] ??= {
      runtime_id: cell.runtimeId, arm: arm ?? null,
      flagged: 0, probe_failed_absorbed: 0, probe_failed_unrecovered: 0, unknown: 0,
    };
    if (classification.infra_flake_suspected === true) rollup[rollupKey].flagged += 1;
    else if (classification.infra_flake_suspected === 'unknown') rollup[rollupKey].unknown += 1;
    else if (classification.reason === 'probe_failed_absorbed') rollup[rollupKey].probe_failed_absorbed += 1;
    else if (classification.reason === 'probe_failed_unrecovered') rollup[rollupKey].probe_failed_unrecovered += 1;
  }

  return {
    schema: INFRA_FLAKE_CLASSIFIER_SCHEMA,
    classifier_version: INFRA_FLAKE_CLASSIFIER_VERSION,
    cells,
    rollup: Object.values(rollup),
  };
}

async function main() {
  const campaignDir = process.argv[2];
  if (!campaignDir) {
    process.stderr.write('usage: node infra-flake-classifier.mjs <campaign-dir>\n');
    process.exit(2);
  }
  const result = classifyCampaign(campaignDir);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

// import.meta.url is always a file:// URL (file:///C:/... on Windows); a bare `file://${argv[1]}`
// string comparison never matches on Windows (no leading slash before the drive letter, backslash
// path separators) -- confirmed live: running this script directly exited 0 with zero output, main()
// never called. Same fix already applied to campaign-summary.mjs and cost-estimate.mjs; this file
// was missed when that fix landed.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
