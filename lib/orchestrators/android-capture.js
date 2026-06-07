// SPDX-License-Identifier: MIT
// lib/orchestrators/android-capture.js — best-effort on-failure device artifact
// capture for Android instrumented tests (--capture-on-fail).
//
// When an instrumented test module FAILS, capture a device screenshot + a
// UI-hierarchy dump via adb and write them next to the existing forensic
// artifacts (log / logcat / errors.json) under
// <project>/.kmp-test-runner/logs/android/<runId>/. The paths are surfaced on
// the envelope's `module_failed` error entry as `screenshot_file` /
// `ui_hierarchy_file` so an agent gets visual + structural triage context for a
// failing Compose UI / Espresso test.
//
// POST-HOC SEMANTICS (documented honestly in README/schema): adb runs AFTER the
// gradle task finished, so the screenshot shows the device state at task-end,
// NOT the exact frame of the assertion failure — the same way the `logcat -d`
// buffer dump this sits beside is post-hoc. High value for crashes / ANRs /
// hangs (the error dialog is still on screen); for a clean Compose assertion
// failure the screen may already be torn down. The UI-hierarchy dump + logcat +
// errors.json retain the failure detail regardless.
//
// BEST-EFFORT by construction: every adb call is wrapped; any failure sets
// `capture_error` and leaves the corresponding path null. This NEVER throws and
// NEVER affects the run's exit code — it is forensic-only plumbing.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

// A device screenshot PNG can be several MB on a high-res panel (e.g. S22
// Ultra). spawnSync's default maxBuffer is 1 MB, which would truncate/ERROR the
// capture — bump it well past any plausible screenshot size.
const SCREENCAP_MAX_BUFFER = 64 * 1024 * 1024;

// Extract just the `<hierarchy>…</hierarchy>` XML from uiautomator output. The
// `dump /dev/tty` form can prepend/append chrome ("UI hierchary dumped to: …");
// slicing from the first XML/hierarchy marker to the closing tag yields clean,
// parseable XML. Returns '' when no hierarchy element is present.
function extractHierarchyXml(s) {
  if (!s) return '';
  const text = String(s);
  const close = '</hierarchy>';
  const end = text.lastIndexOf(close);
  if (end === -1) return '';
  let start = text.indexOf('<?xml');
  if (start === -1) start = text.indexOf('<hierarchy');
  if (start === -1) return '';
  return text.slice(start, end + close.length);
}

/**
 * Capture a screenshot + UI-hierarchy dump from the connected device, best-effort.
 *
 * @param {object}   args
 * @param {string}   args.deviceSerial - adb serial of the target device.
 * @param {string}   args.outDir       - Directory to write artifacts into (already created).
 * @param {string}   args.safeName     - Filesystem-safe module name (e.g. `core_db`).
 * @param {Function} [args.spawn=spawnSync] - Injected spawn (for tests).
 * @param {number}   [args.timeoutMs=15000] - Per-adb-call timeout.
 * @returns {{screenshot_file: (string|null), ui_hierarchy_file: (string|null), capture_error: (string|null)}}
 */
export function captureOnFailure({
  deviceSerial,
  outDir,
  safeName,
  spawn = spawnSync,
  timeoutMs = 15000,
}) {
  const result = { screenshot_file: null, ui_hierarchy_file: null, capture_error: null };
  const errs = [];

  if (!deviceSerial) {
    result.capture_error = 'no device serial';
    return result;
  }

  // 1. Screenshot — `exec-out screencap -p` streams a raw PNG to stdout. Using
  //    exec-out (not `shell`) avoids the CRLF byte translation that corrupts
  //    `adb shell screencap -p` output on some hosts. Written as a binary buffer.
  const pngPath = path.join(outDir, `${safeName}_screenshot.png`);
  try {
    const r = spawn('adb', ['-s', deviceSerial, 'exec-out', 'screencap', '-p'], {
      encoding: 'buffer',
      timeout: timeoutMs,
      maxBuffer: SCREENCAP_MAX_BUFFER,
    });
    const buf = r && r.stdout;
    const ok = r && (r.status === 0 || r.status === null) && !r.error;
    if (ok && buf && buf.length > 0) {
      writeFileSync(pngPath, buf);
      result.screenshot_file = pngPath;
    } else {
      errs.push(`screencap failed (${describeFailure(r)})`);
    }
  } catch (e) {
    errs.push(`screencap: ${errMsg(e)}`);
  }

  // 2. UI hierarchy — try `exec-out uiautomator dump /dev/tty` (single call,
  //    XML on stdout); fall back to dump-to-file + `exec-out cat` when the
  //    streamed form yields no parseable hierarchy (some OEM/One UI builds).
  const xmlPath = path.join(outDir, `${safeName}_ui-hierarchy.xml`);
  try {
    let xml = '';
    try {
      const r = spawn('adb', ['-s', deviceSerial, 'exec-out', 'uiautomator', 'dump', '/dev/tty'], {
        encoding: 'utf8',
        timeout: timeoutMs,
      });
      xml = extractHierarchyXml(r && r.stdout);
    } catch { /* fall through to file-based dump */ }

    if (!xml) {
      spawn('adb', ['-s', deviceSerial, 'shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml'], {
        encoding: 'utf8',
        timeout: timeoutMs,
      });
      const cat = spawn('adb', ['-s', deviceSerial, 'exec-out', 'cat', '/sdcard/window_dump.xml'], {
        encoding: 'utf8',
        timeout: timeoutMs,
      });
      xml = extractHierarchyXml(cat && cat.stdout);
    }

    if (xml) {
      writeFileSync(xmlPath, xml, 'utf8');
      result.ui_hierarchy_file = xmlPath;
    } else {
      errs.push('uiautomator dump produced no hierarchy XML');
    }
  } catch (e) {
    errs.push(`uiautomator: ${errMsg(e)}`);
  }

  if (errs.length > 0) result.capture_error = errs.join('; ');
  return result;
}

function describeFailure(r) {
  if (!r) return 'no result';
  if (r.error) return errMsg(r.error);
  if (r.status && r.status !== 0) return `status=${r.status}`;
  return 'empty output';
}

function errMsg(e) {
  return e && e.message ? e.message : 'error';
}

export { extractHierarchyXml };
