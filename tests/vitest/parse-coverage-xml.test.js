// SPDX-License-Identifier: MIT
// Direct tests for scripts/lib/parse-coverage-xml.py — the shared Kover/JaCoCo
// coverage XML parser. Previously the parser had NO direct tests; the
// orchestrator suite stubs `python3` and never exercises the real script.
//
// These tests spawn the real parser against synthetic JaCoCo XML built inline.
// CI does not install Python, so we detect the interpreter (`python3` then
// `python`) and skip the suite when neither resolves — ubuntu/macOS runners
// ship `python3` and enforce these assertions; windows-latest is backstopped by
// the bats/Pester parser smoke when its interpreter alias differs.
//
// Coverage focus — the "list only fully-uncovered lines" contract:
//   JaCoCo's LINE counter treats a line with ANY covered instruction (ci>0) as
//   covered, even if it also has missed instructions (mi>0, i.e. partially
//   covered). The report-mode "missed lines" column must therefore list only
//   lines with ci==0, so that a 100%-covered sourcefile shows no line numbers
//   and len(missed_lines) == the LINE counter's `missed`.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  writeFileSync, mkdtempSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PARSER = fileURLToPath(new URL('../../scripts/lib/parse-coverage-xml.py', import.meta.url));

// Resolve a usable Python interpreter. Run `--version` and confirm the output
// actually looks like CPython — this rejects the Windows Store `python3.exe`
// shim (which exits non-zero or prints an install prompt) so we don't hang or
// false-positive on a non-functional alias.
function detectPython() {
  for (const exe of ['python3', 'python']) {
    try {
      const r = spawnSync(exe, ['--version'], { encoding: 'utf8' });
      if (r.status === 0 && /Python \d/.test(`${r.stdout || ''}${r.stderr || ''}`)) {
        return exe;
      }
    } catch { /* try next candidate */ }
  }
  return null;
}

const PY = detectPython();

let workDir;
afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

// Build one <sourcefile> from line specs [{nr, mi, ci}]. The LINE counter is
// derived from the specs the same way JaCoCo computes it: missed = lines with
// ci==0, covered = lines with ci>0.
function sourcefile(name, lines) {
  const lineEls = lines
    .map((l) => `      <line nr="${l.nr}" mi="${l.mi}" ci="${l.ci}"/>`)
    .join('\n');
  const missed = lines.filter((l) => l.ci === 0).length;
  const covered = lines.filter((l) => l.ci > 0).length;
  return `    <sourcefile name="${name}">\n${lineEls}\n`
    + `      <counter type="LINE" missed="${missed}" covered="${covered}"/>\n    </sourcefile>`;
}

function report(sourcefiles, pkg = 'com/example') {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<report name="t">\n  <package name="${pkg}">\n`
    + `${sourcefiles.join('\n')}\n  </package>\n</report>\n`;
}

// Write XML to a tmp file and run the parser; return non-empty stdout rows.
function runParser(xml, moduleName = ':app', mode = 'report') {
  workDir = mkdtempSync(path.join(tmpdir(), 'kmp-parser-test-'));
  const xmlPath = path.join(workDir, 'cov.xml');
  writeFileSync(xmlPath, xml);
  const args = [PARSER, xmlPath, moduleName];
  if (mode === 'gaps') args.push('--mode', 'gaps');
  const r = spawnSync(PY, args, { encoding: 'utf8' });
  expect(r.status).toBe(0);
  // Split on \r?\n: Python text-mode stdout emits \r\n on Windows, so a plain
  // \n split would leave a trailing \r on the last pipe field.
  return String(r.stdout || '').split(/\r?\n/).filter(Boolean);
}

describe.skipIf(!PY)('parse-coverage-xml.py — report mode missed-line column', () => {
  it('a 100%-covered sourcefile lists NO missed lines even with a partial line', () => {
    const xml = report([sourcefile('Full.kt', [
      { nr: 10, mi: 0, ci: 3 }, // fully covered
      { nr: 11, mi: 2, ci: 5 }, // partial: mi>0 AND ci>0 — covered at LINE level
    ])]);
    const rows = runParser(xml);
    expect(rows).toHaveLength(1);
    // module|package|sourcefile|classname|covered|missed|total|pct|missed_lines
    const parts = rows[0].split('|');
    expect(parts[5]).toBe('0'); // missed (LINE counter)
    expect(parts[7]).toBe('100.0'); // pct
    expect(parts[8]).toBe(''); // missed_lines — pre-fix this listed "11"
  });

  it('lists only fully-uncovered lines (ci==0), never partially-covered ones', () => {
    const xml = report([sourcefile('Partial.kt', [
      { nr: 20, mi: 0, ci: 4 }, // covered
      { nr: 21, mi: 3, ci: 2 }, // partial — must NOT be listed
      { nr: 22, mi: 4, ci: 0 }, // fully missed — listed
      { nr: 23, mi: 4, ci: 0 }, // fully missed — listed
    ])]);
    const parts = runParser(xml)[0].split('|');
    expect(parts[5]).toBe('2'); // missed
    expect(parts[8]).toBe('22,23'); // pre-fix: "21,22,23"
  });

  it('per-row invariant: len(missed_lines) === the LINE-counter missed count', () => {
    const xml = report([
      sourcefile('A.kt', [
        { nr: 1, mi: 0, ci: 2 }, // covered
        { nr: 2, mi: 1, ci: 1 }, // partial
        { nr: 3, mi: 2, ci: 0 }, // missed
      ]),
      sourcefile('B.kt', [
        { nr: 5, mi: 5, ci: 0 }, // missed
        { nr: 6, mi: 0, ci: 3 }, // covered
      ]),
    ]);
    const rows = runParser(xml);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const parts = row.split('|');
      const missed = Number(parts[5]);
      const missedLines = parts[8] ? parts[8].split(',') : [];
      expect(missedLines).toHaveLength(missed);
    }
  });

  it('report mode and gaps mode agree on the missed-line set', () => {
    const xml = report([sourcefile('C.kt', [
      { nr: 1, mi: 0, ci: 2 }, // covered
      { nr: 2, mi: 3, ci: 1 }, // partial — excluded by both modes
      { nr: 3, mi: 2, ci: 0 }, // missed
      { nr: 4, mi: 1, ci: 0 }, // missed
    ])]);
    // report mode: missed_lines is the comma list (field 8)
    expect(runParser(xml, ':app', 'report')[0].split('|')[8]).toBe('3,4');
    // gaps mode: sourcefile|package|missed|total|pct|missed_ranges (field 5)
    expect(runParser(xml, ':app', 'gaps')[0].split('|')[5]).toBe('3-4');
  });
});
