// SPDX-License-Identifier: MIT
// lib/parsers/coverage-xml.js -- Kover/JaCoCo coverage XML parser (Node-native).
// Replaces scripts/lib/parse-coverage-xml.py (PR-17): zero new deps, regex/
// string scanning in the same style as lib/parsers/junit-xml.js. Both Kover
// and JaCoCo emit JaCoCo-compatible XML with package, sourcefile,
// counter type=LINE, and line elements; this parser reads only that
// shared subset. Deliberately never reads class elements -- JaCoCo emits one
// class entry per JVM class, so Kotlin sealed/data/inner classes would
// double-count against the same sourcefile; aggregating at the sourcefile
// level (trusting its own LINE counter) avoids that, mirroring the original
// Python parser's own documented reasoning.
//
// Deliberately does NOT reproduce 3 bugs in the retired Python parser:
//   1. malformed/missing/truncated XML -> explicit errored:true (the Python
//      parser silently exited 0 with empty output on any parse exception,
//      indistinguishable from legitimately-empty valid XML)
//   2. non-numeric counter/line attributes -> defensive Number(x)||0
//      coercion (the Python parser crashed with an uncaught ValueError)
//   3. no size cap -> KMP_COVERAGE_XML_MAX_MB guard (the Python parser did a
//      fully unbounded in-memory DOM parse)

import { readFileSync, statSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Oversized-XML guard -- mirrors junit-xml.js's DEFAULT_JUNIT_XML_MAX_MB /
// resolveJunitXmlMaxBytes exactly. Default is higher than junit-xml.js's
// 32 MB: .skills/kmp-test-runner/references/workflows/coverage.md documents
// a real 74 MB Kover XML case that must not be treated as oversized by
// default.
// ---------------------------------------------------------------------------
export const DEFAULT_COVERAGE_XML_MAX_MB = 128;

// Warn-once latch for a malformed env value -- mirrors junit-xml.js's
// warnedBadMaxMbEnv (a per-module-dispatch-loop resolver would otherwise
// repeat the warning once per module).
let warnedBadMaxMbEnv = false;

export function resolveCoverageXmlMaxBytes(env = process.env) {
  const raw = env && env.KMP_COVERAGE_XML_MAX_MB;
  if (raw !== undefined && raw !== null && raw !== '') {
    const mb = Number(raw);
    if (Number.isInteger(mb) && mb > 0) return mb * 1024 * 1024;
    if (!warnedBadMaxMbEnv) {
      warnedBadMaxMbEnv = true;
      process.stderr.write(
        `[WARN] KMP_COVERAGE_XML_MAX_MB='${raw}' is not a positive integer -- using default ${DEFAULT_COVERAGE_XML_MAX_MB} MB\n`,
      );
    }
  }
  return DEFAULT_COVERAGE_XML_MAX_MB * 1024 * 1024;
}

// Test-only: reset the warn-once latch so env-knob cases can assert the warn.
export function _resetCoverageXmlWarnLatch() {
  warnedBadMaxMbEnv = false;
}

// ---------------------------------------------------------------------------
// XML entity decoding + attribute extraction
// ---------------------------------------------------------------------------
function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function getAttr(attrs, name, fallback) {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? decodeXmlEntities(m[1]) : fallback;
}

// Lightweight well-formedness check -- NOT a real XML parser. A pure
// regex/string scan over garbage input would otherwise just find zero
// package matches and silently return empty rows: the same ambiguity the
// retired Python parser's bug had (indistinguishable from legitimately-empty
// valid XML, e.g. a bare self-closed report root). This checks the document
// has a complete, matching root element -- tolerating a leading XML
// declaration, a DOCTYPE declaration (real JaCoCo/Kover output can carry
// one), and leading comments -- so truncated/malformed input is
// distinguishable from real empty coverage.
function looksLikeCompleteXml(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const preambleRe = /^(?:<\?xml\b[^>]*\?>\s*)*(?:<!DOCTYPE\b[^[>]*(?:\[[\s\S]*?\])?\s*>\s*)*(?:<!--[\s\S]*?-->\s*)*/;
  const afterPreamble = trimmed.replace(preambleRe, '');
  const rootMatch = afterPreamble.match(/^<([a-zA-Z_][\w.:-]*)\b[^>]*?(\/)?>/);
  if (!rootMatch) return false;
  if (rootMatch[2] === '/') return true; // self-closed root
  return trimmed.endsWith(`</${rootMatch[1]}>`);
}

// ---------------------------------------------------------------------------
// Core walk: package -> sourcefile -> counter type=LINE / line
// ---------------------------------------------------------------------------
function extractSourcefileRecords(xmlContent) {
  const records = [];
  const pkgRe = /<package\b([^>]*)(?<!\/)>([\s\S]*?)<\/package>/g;
  let pkgMatch;
  while ((pkgMatch = pkgRe.exec(xmlContent)) !== null) {
    const pkgNameRaw = getAttr(pkgMatch[1], 'name', '');
    const sfRe = /<sourcefile\b([^>]*)(?<!\/)>([\s\S]*?)<\/sourcefile>/g;
    let sfMatch;
    while ((sfMatch = sfRe.exec(pkgMatch[2])) !== null) {
      const sourceFile = getAttr(sfMatch[1], 'name', '');
      if (!sourceFile) continue;

      // Use the LINE counter from the sourcefile element (authoritative
      // aggregate) -- matches the retired Python parser's own reasoning.
      let lineCounterAttrs = null;
      const counterRe = /<counter\b([^>]*)\/>/g;
      let cm;
      while ((cm = counterRe.exec(sfMatch[2])) !== null) {
        if (getAttr(cm[1], 'type', '') === 'LINE') { lineCounterAttrs = cm[1]; break; }
      }
      if (!lineCounterAttrs) continue;

      const missed = Number(getAttr(lineCounterAttrs, 'missed', '0')) || 0;
      const covered = Number(getAttr(lineCounterAttrs, 'covered', '0')) || 0;
      const total = missed + covered;
      if (total === 0) continue;

      // Missed lines: fully-uncovered lines only (ci===0). A line with some
      // missed instructions but at least one covered (mi>0 AND ci>0) is a
      // PARTIALLY covered line, which JaCoCo counts as covered at the LINE
      // level -- listing it would contradict the LINE counter.
      const missedLines = [];
      const lineRe = /<line\b([^>]*)\/>/g;
      let lm;
      while ((lm = lineRe.exec(sfMatch[2])) !== null) {
        const mi = Number(getAttr(lm[1], 'mi', '0')) || 0;
        const ci = Number(getAttr(lm[1], 'ci', '0')) || 0;
        if (mi > 0 && ci === 0) missedLines.push(Number(getAttr(lm[1], 'nr', '0')) || 0);
      }
      missedLines.sort((a, b) => a - b); // numeric sort, not lexicographic

      records.push({ pkgNameRaw, sourceFile, missed, covered, total, missedLines });
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Row formatters
// ---------------------------------------------------------------------------
function pct1(covered, total) {
  return ((covered / total) * 100).toFixed(1);
}

function formatReportRows(records, moduleName) {
  return records.map((r) => {
    const displayName = r.sourceFile.endsWith('.kt') ? r.sourceFile.slice(0, -3) : r.sourceFile;
    return `${moduleName}|${r.pkgNameRaw}|${r.sourceFile}|${displayName}|${r.covered}|${r.missed}|${r.total}|${pct1(r.covered, r.total)}|${r.missedLines.join(',')}`;
  });
}

// Ported from the retired Python parser's format_ranges (array-of-numbers
// in). Deliberately NOT reused from
// coverage-orchestrator.js#formatLineRanges (CSV-string-in, markdown-report
// use only) -- orchestrators import parsers, never the reverse.
function formatRanges(lines) {
  if (!lines.length) return '';
  const ranges = [];
  let start = lines[0];
  let end = lines[0];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === end + 1) { end = lines[i]; continue; }
    ranges.push(start === end ? `${start}` : `${start}-${end}`);
    start = end = lines[i];
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(', ');
}

function formatGapsRows(records) {
  const gaps = records
    .filter((r) => r.missed > 0)
    .map((r) => ({
      ...r,
      pkgNameDotted: r.pkgNameRaw.replace(/\//g, '.'),
      pct: pct1(r.covered, r.total),
      ranges: formatRanges(r.missedLines),
    }));
  gaps.sort((a, b) => b.missed - a.missed); // descending, worst-coverage-first
  return gaps.map((g) => `${g.sourceFile}|${g.pkgNameDotted}|${g.missed}|${g.total}|${g.pct}|${g.ranges}`);
}

// ---------------------------------------------------------------------------
// Read + validate
// ---------------------------------------------------------------------------
function readAndValidate(xmlPath, maxBytes) {
  let stat;
  try {
    stat = statSync(xmlPath);
  } catch (err) {
    return { error: { reason: 'read_failed', message: `cannot stat ${xmlPath}: ${err.code || err.message}` } };
  }

  if (stat.size > maxBytes) {
    return {
      error: {
        reason: 'oversized',
        message: `coverage XML is ${stat.size} bytes, exceeds the ${maxBytes}-byte cap (KMP_COVERAGE_XML_MAX_MB)`,
        size: stat.size,
        maxBytes,
      },
    };
  }

  let content;
  try {
    content = readFileSync(xmlPath, 'utf8');
  } catch (err) {
    return { error: { reason: 'read_failed', message: `cannot read ${xmlPath}: ${err.code || err.message}` } };
  }

  if (!looksLikeCompleteXml(content)) {
    return { error: { reason: 'parse_failed', message: `${xmlPath} does not look like well-formed XML (truncated, empty, or not XML)` } };
  }

  return { content };
}

/**
 * Parse a Kover/JaCoCo coverage XML file into pipe-delimited "report mode"
 * rows: module|package|sourcefile|classname|covered|missed|total|pct|missed_lines
 * @param {string} xmlPath
 * @param {string} moduleName
 * @param {{maxBytes?: number, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {{rows: string[], errored: boolean, reason: ('ok'|'read_failed'|'parse_failed'|'oversized'), message: (string|null), size?: number, maxBytes?: number}}
 */
export function parseCoverageXmlReport(xmlPath, moduleName, opts = {}) {
  const maxBytes = opts.maxBytes ?? resolveCoverageXmlMaxBytes(opts.env);
  const { content, error } = readAndValidate(xmlPath, maxBytes);
  if (error) return { rows: [], errored: true, ...error };
  return {
    rows: formatReportRows(extractSourcefileRecords(content), moduleName),
    errored: false,
    reason: 'ok',
    message: null,
  };
}

/**
 * Parse a Kover/JaCoCo coverage XML file into pipe-delimited "gaps mode" rows
 * (worst-coverage-first): sourcefile|package|missed|total|pct|missed_ranges
 * No production caller uses this today -- ported to preserve the existing
 * report/gaps missed-line-agreement test contract.
 * @param {string} xmlPath
 * @param {{maxBytes?: number, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {{rows: string[], errored: boolean, reason: ('ok'|'read_failed'|'parse_failed'|'oversized'), message: (string|null), size?: number, maxBytes?: number}}
 */
export function parseCoverageXmlGaps(xmlPath, opts = {}) {
  const maxBytes = opts.maxBytes ?? resolveCoverageXmlMaxBytes(opts.env);
  const { content, error } = readAndValidate(xmlPath, maxBytes);
  if (error) return { rows: [], errored: true, ...error };
  return {
    rows: formatGapsRows(extractSourcefileRecords(content)),
    errored: false,
    reason: 'ok',
    message: null,
  };
}

export {
  extractSourcefileRecords,
  formatRanges,
  looksLikeCompleteXml,
  decodeXmlEntities,
};
