// SPDX-License-Identifier: MIT
// Tests for lib/parsers/coverage-xml.js -- the Node-native Kover/JaCoCo
// coverage XML parser (PR-17), replacing scripts/lib/parse-coverage-xml.py.
//
// Parity fixtures under tests/fixtures/coverage-xml/*.xml were captured by
// running the real, unmodified Python parser once before it was retired (see
// PR-17's golden-capture procedure) -- the expected row strings asserted
// below are that frozen golden output for well-formed XML. Malformed/
// oversized/non-numeric cases below are deliberate NEW behavior the Python
// parser did not have (see the module header comment in coverage-xml.js for
// the 3 fixes: silent-success-on-malformed-XML, crash-on-non-numeric-attrs,
// no-size-cap).

import {
  describe, it, expect, afterEach, vi,
} from 'vitest';
import {
  mkdtempSync, rmSync, writeFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseCoverageXmlReport,
  parseCoverageXmlGaps,
  resolveCoverageXmlMaxBytes,
  DEFAULT_COVERAGE_XML_MAX_MB,
  _resetCoverageXmlWarnLatch,
  extractSourcefileRecords,
  formatRanges,
  looksLikeCompleteXml,
  decodeXmlEntities,
} from '../../lib/parsers/coverage-xml.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/coverage-xml/', import.meta.url));
const fixture = (name) => path.join(FIXTURES, name);

let workDir;
const savedMaxMb = process.env.KMP_COVERAGE_XML_MAX_MB;
afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
  if (savedMaxMb === undefined) delete process.env.KMP_COVERAGE_XML_MAX_MB;
  else process.env.KMP_COVERAGE_XML_MAX_MB = savedMaxMb;
  _resetCoverageXmlWarnLatch();
  vi.restoreAllMocks();
});

function writeTmpXml(content) {
  workDir = mkdtempSync(path.join(tmpdir(), 'kmp-cov-xml-'));
  const xmlPath = path.join(workDir, 'cov.xml');
  writeFileSync(xmlPath, content, 'utf8');
  return xmlPath;
}

describe('parseCoverageXmlReport — parity with the retired Python parser (golden fixtures)', () => {
  it('a 100%-covered sourcefile lists no missed lines even with a partial line', () => {
    const r = parseCoverageXmlReport(fixture('full-covered.xml'), ':app');
    expect(r.errored).toBe(false);
    expect(r.reason).toBe('ok');
    expect(r.message).toBeNull();
    expect(r.rows).toEqual([':app|com/example|Full.kt|Full|2|0|2|100.0|']);
  });

  it('lists only fully-uncovered lines, never partially-covered ones', () => {
    const r = parseCoverageXmlReport(fixture('partial-lines.xml'), ':app');
    expect(r.rows).toEqual([':app|com/example|Partial.kt|Partial|2|2|4|50.0|22,23']);
  });

  it('aggregates multiple sourcefiles independently within one package', () => {
    const r = parseCoverageXmlReport(fixture('multi-sourcefile.xml'), ':app');
    expect(r.rows).toEqual([
      ':app|com/example|A.kt|A|2|1|3|66.7|3',
      ':app|com/example|B.kt|B|1|1|2|50.0|5',
    ]);
  });

  it('report mode and gaps mode agree on the missed-line set', () => {
    const report = parseCoverageXmlReport(fixture('report-gaps-agreement.xml'), ':app');
    expect(report.rows).toEqual([':app|com/example|C.kt|C|2|2|4|50.0|3,4']);
    const gaps = parseCoverageXmlGaps(fixture('report-gaps-agreement.xml'));
    expect(gaps.rows).toEqual(['C.kt|com.example|2|4|50.0|3-4']);
  });

  it('a leading <!DOCTYPE> declaration does not break well-formedness detection', () => {
    const r = parseCoverageXmlReport(fixture('doctype-preamble.xml'), ':app');
    expect(r.errored).toBe(false);
    expect(r.rows).toEqual([':app|com/example|Full.kt|Full|2|0|2|100.0|']);
  });
});

describe('parseCoverageXmlGaps', () => {
  it('excludes a 100%-covered sourcefile from gaps output (unlike report mode)', () => {
    const r = parseCoverageXmlGaps(fixture('full-covered.xml'));
    expect(r.rows).toEqual([]);
  });

  it('sorts multiple gaps by missed count descending', () => {
    const xmlPath = writeTmpXml([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<report name="t">',
      '  <package name="com/example">',
      '    <sourcefile name="Low.kt">',
      '      <line nr="1" mi="1" ci="0"/>',
      '      <counter type="LINE" missed="1" covered="0"/>',
      '    </sourcefile>',
      '    <sourcefile name="High.kt">',
      '      <line nr="1" mi="1" ci="0"/>',
      '      <line nr="2" mi="1" ci="0"/>',
      '      <line nr="3" mi="1" ci="0"/>',
      '      <counter type="LINE" missed="3" covered="0"/>',
      '    </sourcefile>',
      '  </package>',
      '</report>',
    ].join('\n'));
    const r = parseCoverageXmlGaps(xmlPath);
    expect(r.rows.map((row) => row.split('|')[0])).toEqual(['High.kt', 'Low.kt']);
  });
});

describe('deliberate fixes over the retired Python parser', () => {
  it('missing file -> errored:true reason:read_failed (not silent empty success)', () => {
    const r = parseCoverageXmlReport(path.join(tmpdir(), 'kmp-cov-xml-nonexistent', 'cov.xml'), ':app');
    expect(r.errored).toBe(true);
    expect(r.reason).toBe('read_failed');
    expect(r.rows).toEqual([]);
    expect(r.message).toMatch(/cannot stat/);
  });

  it('truncated/malformed XML -> errored:true reason:parse_failed (not silent empty success)', () => {
    const xmlPath = writeTmpXml('<report name="t"><package name="com/example"><sourcefile');
    const r = parseCoverageXmlReport(xmlPath, ':app');
    expect(r.errored).toBe(true);
    expect(r.reason).toBe('parse_failed');
  });

  it('empty (0-byte) file -> errored:true reason:parse_failed', () => {
    const xmlPath = writeTmpXml('');
    const r = parseCoverageXmlReport(xmlPath, ':app');
    expect(r.errored).toBe(true);
    expect(r.reason).toBe('parse_failed');
  });

  it('legitimately-empty valid XML (no <package> elements) is NOT treated as an error', () => {
    const xmlPath = writeTmpXml('<?xml version="1.0"?>\n<report name="t"/>\n');
    const r = parseCoverageXmlReport(xmlPath, ':app');
    expect(r.errored).toBe(false);
    expect(r.reason).toBe('ok');
    expect(r.rows).toEqual([]);
  });

  it('non-numeric counter/line attributes are coerced to 0, never crash', () => {
    const xmlPath = writeTmpXml([
      '<?xml version="1.0"?>',
      '<report name="t">',
      '  <package name="com/example">',
      '    <sourcefile name="Bad.kt">',
      '      <line nr="1" mi="abc" ci="0"/>',
      '      <counter type="LINE" missed="abc" covered="2"/>',
      '    </sourcefile>',
      '  </package>',
      '</report>',
    ].join('\n'));
    expect(() => parseCoverageXmlReport(xmlPath, ':app')).not.toThrow();
    const r = parseCoverageXmlReport(xmlPath, ':app');
    expect(r.errored).toBe(false);
    // missed coerced from 'abc' to 0, covered=2, total=2 -> 100.0%
    expect(r.rows).toEqual([':app|com/example|Bad.kt|Bad|2|0|2|100.0|']);
  });

  it('oversized file -> errored:true reason:oversized via an explicit opts.maxBytes override', () => {
    const xmlPath = writeTmpXml('<?xml version="1.0"?><report name="t"/>');
    const r = parseCoverageXmlReport(xmlPath, ':app', { maxBytes: 4 });
    expect(r.errored).toBe(true);
    expect(r.reason).toBe('oversized');
    expect(r.size).toBeGreaterThan(4);
    expect(r.maxBytes).toBe(4);
  });

  it('the default size cap comfortably clears the documented real-world ~74 MB Kover XML case', () => {
    expect(DEFAULT_COVERAGE_XML_MAX_MB).toBeGreaterThanOrEqual(74);
  });

  it('oversized file via KMP_COVERAGE_XML_MAX_MB env', () => {
    process.env.KMP_COVERAGE_XML_MAX_MB = '1';
    // ~1.5 MB of padding inside a comment -> above the 1 MB cap. The size
    // check runs before any content parsing, so the padding need not be
    // meaningful XML.
    const xmlPath = writeTmpXml(`<?xml version="1.0"?><!--${'y'.repeat(1_500_000)}--><report name="t"/>`);
    const r = parseCoverageXmlReport(xmlPath, ':app');
    expect(r.errored).toBe(true);
    expect(r.reason).toBe('oversized');
  });
});

describe('resolveCoverageXmlMaxBytes (KMP_COVERAGE_XML_MAX_MB knob)', () => {
  it('defaults to 128 MB when unset / empty', () => {
    expect(resolveCoverageXmlMaxBytes({})).toBe(DEFAULT_COVERAGE_XML_MAX_MB * 1024 * 1024);
    expect(resolveCoverageXmlMaxBytes({ KMP_COVERAGE_XML_MAX_MB: '' })).toBe(DEFAULT_COVERAGE_XML_MAX_MB * 1024 * 1024);
  });

  it('honors a positive integer (MB)', () => {
    expect(resolveCoverageXmlMaxBytes({ KMP_COVERAGE_XML_MAX_MB: '8' })).toBe(8 * 1024 * 1024);
  });

  it('warns once on stderr and falls back on garbage values', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(resolveCoverageXmlMaxBytes({ KMP_COVERAGE_XML_MAX_MB: 'abc' })).toBe(DEFAULT_COVERAGE_XML_MAX_MB * 1024 * 1024);
    expect(resolveCoverageXmlMaxBytes({ KMP_COVERAGE_XML_MAX_MB: '-3' })).toBe(DEFAULT_COVERAGE_XML_MAX_MB * 1024 * 1024);
    const warnCalls = spy.mock.calls.filter((c) => String(c[0]).includes('KMP_COVERAGE_XML_MAX_MB'));
    expect(warnCalls).toHaveLength(1);
  });
});

describe('looksLikeCompleteXml', () => {
  it('accepts a normal <?xml?> + paired-root document', () => {
    expect(looksLikeCompleteXml('<?xml version="1.0"?><report name="t"></report>')).toBe(true);
  });

  it('accepts a self-closed root', () => {
    expect(looksLikeCompleteXml('<?xml version="1.0"?><report name="t"/>')).toBe(true);
  });

  it('accepts a leading <!DOCTYPE> declaration', () => {
    expect(looksLikeCompleteXml(
      '<?xml version="1.0"?><!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd"><report name="t"/>',
    )).toBe(true);
  });

  it('rejects empty/whitespace-only content', () => {
    expect(looksLikeCompleteXml('')).toBe(false);
    expect(looksLikeCompleteXml('   \n  ')).toBe(false);
  });

  it('rejects a truncated document with no closing root tag', () => {
    expect(looksLikeCompleteXml('<report name="t"><package name="x">')).toBe(false);
  });

  it('rejects garbage that is not XML at all', () => {
    expect(looksLikeCompleteXml('BUILD SUCCESSFUL in 3s\nnot xml at all')).toBe(false);
  });
});

describe('decodeXmlEntities', () => {
  it('decodes the five XML entities', () => {
    expect(decodeXmlEntities('&lt;a&gt; &quot;b&quot; &apos;c&apos; &amp;d')).toBe('<a> "b" \'c\' &d');
  });
});

describe('extractSourcefileRecords + formatRanges (internal helpers)', () => {
  it('formatRanges compacts consecutive line numbers', () => {
    expect(formatRanges([3, 4, 9])).toBe('3-4, 9');
    expect(formatRanges([])).toBe('');
    expect(formatRanges([5])).toBe('5');
  });

  it('skips a sourcefile with no LINE counter', () => {
    const xml = [
      '<report name="t">',
      '  <package name="com/example">',
      '    <sourcefile name="NoCounter.kt">',
      '      <line nr="1" mi="1" ci="0"/>',
      '    </sourcefile>',
      '  </package>',
      '</report>',
    ].join('\n');
    expect(extractSourcefileRecords(xml)).toEqual([]);
  });

  it('skips a sourcefile whose LINE counter totals zero', () => {
    const xml = [
      '<report name="t">',
      '  <package name="com/example">',
      '    <sourcefile name="Empty.kt">',
      '      <counter type="LINE" missed="0" covered="0"/>',
      '    </sourcefile>',
      '  </package>',
      '</report>',
    ].join('\n');
    expect(extractSourcefileRecords(xml)).toEqual([]);
  });
});
