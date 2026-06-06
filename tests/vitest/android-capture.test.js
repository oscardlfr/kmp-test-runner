// SPDX-License-Identifier: MIT
// Tests for lib/orchestrators/android-capture.js — the --capture-on-fail helper.
//
// The helper is forensic-only: on instrumented-test failure it grabs a device
// screenshot + UI-hierarchy dump via adb, best-effort. Contract under test:
//   1. Happy path: screencap PNG buffer + uiautomator XML → both files written,
//      paths returned, capture_error null.
//   2. Binary safety: the PNG is written from the raw Buffer (no utf8 mangling).
//   3. screencap spawn uses encoding:'buffer' + a large maxBuffer + a timeout.
//   4. Missing device serial → capture_error, no spawn, null paths.
//   5. screencap failure (non-zero status / spawn error) → screenshot null +
//      capture_error, UI dump still attempted.
//   6. uiautomator /dev/tty empty → fallback to shell-dump + exec-out cat.
//   7. uiautomator chrome around the XML is stripped (extractHierarchyXml).
//   8. Total adb failure never throws and always returns the stable shape.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { captureOnFailure, extractHierarchyXml } from '../../lib/orchestrators/android-capture.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const HIERARCHY_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n<hierarchy rotation="0"><node text="Hello"/></hierarchy>\n';

let workDir;
afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

function tmp() {
  workDir = mkdtempSync(path.join(tmpdir(), 'kmp-capture-test-'));
  return workDir;
}

// Build a spawn mock that classifies adb subcommands and returns programmed
// responses. Records every call (cmd, args, opts) for assertions.
function makeAdbMock(responses = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], opts });
    let key = 'other';
    if (args.includes('screencap')) key = 'screencap';
    else if (args.includes('uiautomator') && args.includes('/dev/tty')) key = 'uiTty';
    else if (args.includes('uiautomator')) key = 'uiFile';
    else if (args.includes('cat')) key = 'cat';
    const resp = responses[key];
    if (typeof resp === 'function') return resp();
    return resp ?? { status: 0, stdout: '', stderr: '', error: null };
  };
  fn.calls = calls;
  return fn;
}

describe('extractHierarchyXml', () => {
  it('returns the XML untouched when it is already clean', () => {
    expect(extractHierarchyXml(HIERARCHY_XML)).toBe(HIERARCHY_XML.trimEnd());
  });

  it('strips leading/trailing chrome around the hierarchy element', () => {
    const wrapped = `noise before\n${HIERARCHY_XML}UI hierchary dumped to: /dev/tty\n`;
    const out = extractHierarchyXml(wrapped);
    expect(out.startsWith('<?xml')).toBe(true);
    expect(out.endsWith('</hierarchy>')).toBe(true);
    expect(out).not.toMatch(/dumped to/);
  });

  it('handles a <hierarchy> root with no <?xml prolog', () => {
    const out = extractHierarchyXml('junk<hierarchy><node/></hierarchy>tail');
    expect(out).toBe('<hierarchy><node/></hierarchy>');
  });

  it('returns empty string when no hierarchy element is present', () => {
    expect(extractHierarchyXml('not xml at all')).toBe('');
    expect(extractHierarchyXml('')).toBe('');
    expect(extractHierarchyXml(null)).toBe('');
  });
});

describe('captureOnFailure', () => {
  it('happy path: writes screenshot PNG + UI hierarchy XML and returns both paths', () => {
    const dir = tmp();
    const spawn = makeAdbMock({
      screencap: { status: 0, stdout: PNG_MAGIC, error: null },
      uiTty: { status: 0, stdout: HIERARCHY_XML, error: null },
    });
    const out = captureOnFailure({ deviceSerial: 'SERIAL1', outDir: dir, safeName: 'core_db', spawn });

    expect(out.capture_error).toBeNull();
    expect(out.screenshot_file).toBe(path.join(dir, 'core_db_screenshot.png'));
    expect(out.ui_hierarchy_file).toBe(path.join(dir, 'core_db_ui-hierarchy.xml'));
    expect(existsSync(out.screenshot_file)).toBe(true);
    expect(existsSync(out.ui_hierarchy_file)).toBe(true);
    // Binary safety — bytes written verbatim from the Buffer.
    expect(readFileSync(out.screenshot_file).equals(PNG_MAGIC)).toBe(true);
    expect(readFileSync(out.ui_hierarchy_file, 'utf8')).toContain('<hierarchy');
  });

  it('screencap spawn uses encoding:buffer + large maxBuffer + timeout, targeting the serial', () => {
    const dir = tmp();
    const spawn = makeAdbMock({
      screencap: { status: 0, stdout: PNG_MAGIC, error: null },
      uiTty: { status: 0, stdout: HIERARCHY_XML, error: null },
    });
    captureOnFailure({ deviceSerial: 'SERIAL1', outDir: dir, safeName: 'm', spawn, timeoutMs: 9000 });

    const screencap = spawn.calls.find(c => c.args.includes('screencap'));
    expect(screencap.args).toEqual(['-s', 'SERIAL1', 'exec-out', 'screencap', '-p']);
    expect(screencap.opts.encoding).toBe('buffer');
    expect(screencap.opts.timeout).toBe(9000);
    expect(screencap.opts.maxBuffer).toBeGreaterThan(8 * 1024 * 1024);
  });

  it('missing device serial → capture_error, no spawn, null paths', () => {
    const dir = tmp();
    const spawn = makeAdbMock();
    const out = captureOnFailure({ deviceSerial: '', outDir: dir, safeName: 'm', spawn });
    expect(out).toEqual({ screenshot_file: null, ui_hierarchy_file: null, capture_error: 'no device serial' });
    expect(spawn.calls).toHaveLength(0);
  });

  it('screencap non-zero status → screenshot null + capture_error, UI dump still captured', () => {
    const dir = tmp();
    const spawn = makeAdbMock({
      screencap: { status: 1, stdout: Buffer.alloc(0), stderr: 'device offline', error: null },
      uiTty: { status: 0, stdout: HIERARCHY_XML, error: null },
    });
    const out = captureOnFailure({ deviceSerial: 'S', outDir: dir, safeName: 'm', spawn });
    expect(out.screenshot_file).toBeNull();
    expect(out.ui_hierarchy_file).not.toBeNull();
    expect(out.capture_error).toMatch(/screencap/);
  });

  it('screencap spawn error (adb missing) is swallowed → capture_error, never throws', () => {
    const dir = tmp();
    const spawn = makeAdbMock({
      screencap: { status: null, stdout: undefined, error: new Error('spawn adb ENOENT') },
      uiTty: { status: null, stdout: '', error: new Error('spawn adb ENOENT') },
    });
    const out = captureOnFailure({ deviceSerial: 'S', outDir: dir, safeName: 'm', spawn });
    expect(out.screenshot_file).toBeNull();
    expect(out.ui_hierarchy_file).toBeNull();
    expect(out.capture_error).toBeTruthy();
  });

  it('uiautomator /dev/tty empty → falls back to shell dump + exec-out cat', () => {
    const dir = tmp();
    const spawn = makeAdbMock({
      screencap: { status: 0, stdout: PNG_MAGIC, error: null },
      uiTty: { status: 0, stdout: '', error: null },         // /dev/tty yields nothing
      uiFile: { status: 0, stdout: '', error: null },        // shell dump to /sdcard
      cat: { status: 0, stdout: HIERARCHY_XML, error: null }, // cat the dumped file
    });
    const out = captureOnFailure({ deviceSerial: 'S', outDir: dir, safeName: 'm', spawn });
    expect(out.ui_hierarchy_file).not.toBeNull();
    expect(readFileSync(out.ui_hierarchy_file, 'utf8')).toContain('<hierarchy');
    // Confirms the fallback path actually ran.
    expect(spawn.calls.some(c => c.args.includes('cat'))).toBe(true);
  });

  it('thrown error inside a spawn is caught and reported, never propagated', () => {
    const dir = tmp();
    const spawn = makeAdbMock({
      screencap: () => { throw new Error('boom'); },
      uiTty: () => { throw new Error('boom'); },
      uiFile: () => { throw new Error('boom'); },
      cat: () => { throw new Error('boom'); },
    });
    let out;
    expect(() => { out = captureOnFailure({ deviceSerial: 'S', outDir: dir, safeName: 'm', spawn }); }).not.toThrow();
    expect(out.screenshot_file).toBeNull();
    expect(out.ui_hierarchy_file).toBeNull();
    expect(out.capture_error).toMatch(/boom/);
  });
});
