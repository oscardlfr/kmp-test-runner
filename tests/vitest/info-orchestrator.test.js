// SPDX-License-Identifier: MIT
// Tests for lib/info-orchestrator.js — v0.9 step 3 DX-parity bundle.
//
// `kmp-test info` is the JSON-friendly sibling of `kmp-test doctor`. Probes
// the same dimensions but emits raw values without PASS/WARN/FAIL judgments.
//
// Test surface:
//   1. Envelope shape — top-level info:{} block with required keys
//   2. Env vars: KMP_TEST_SKIP_ADB=1 → adb null
//   3. --no-adb flag → adb null even without env var
//   4. JDK absent → jdk:null (graceful, never errors)
//   5. JDK present → jdk:{version, java_home, note}
//   6. info never fails — exit 0 even when probes WARN
//   7. envelope.info present alongside standard subcommand block
//   8. info.jdk_catalogue parity with doctor (vendors with commas survive)

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const discoverInstalledJdksMock = vi.hoisted(() => vi.fn(() => []));
vi.mock('../../lib/jdk-catalogue.js', () => ({ discoverInstalledJdks: discoverInstalledJdksMock }));

import { runInfo, formatInfoText, resolveDarwinJavaHome } from '../../lib/orchestrators/info-orchestrator.js';

let workDir;

afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

function makeTempProject() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kmp-info-test-'));
  workDir = dir;
  return dir;
}

describe('runInfo envelope shape', () => {
  it('emits canonical envelope with info:{} block', () => {
    const dir = makeTempProject();
    process.env.KMP_TEST_SKIP_ADB = '1';
    try {
      const { envelope, exitCode } = runInfo({ projectRoot: dir, args: [] });

      expect(envelope.tool).toBe('kmp-test');
      expect(envelope.subcommand).toBe('info');
      expect(envelope.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(envelope.project_root).toBe(dir);
      expect(envelope.exit_code).toBe(0);
      expect(envelope.info).toBeDefined();
      expect(exitCode).toBe(0);
    } finally {
      delete process.env.KMP_TEST_SKIP_ADB;
    }
  });

  it('info block includes node, os, platform, shell, gradlew, jdk, jdk_catalogue, android_sdk, adb, config, gradle_config', () => {
    const dir = makeTempProject();
    process.env.KMP_TEST_SKIP_ADB = '1';
    try {
      const { envelope } = runInfo({ projectRoot: dir, args: [] });
      const info = envelope.info;
      expect(info).toHaveProperty('node');
      expect(info).toHaveProperty('os');
      expect(info).toHaveProperty('platform');
      expect(info).toHaveProperty('shell');
      expect(info).toHaveProperty('gradlew');
      expect(info).toHaveProperty('jdk');
      expect(info).toHaveProperty('jdk_catalogue');
      expect(info).toHaveProperty('android_sdk');
      expect(info).toHaveProperty('adb');
      expect(info).toHaveProperty('config');
      expect(info).toHaveProperty('gradle_config');
    } finally {
      delete process.env.KMP_TEST_SKIP_ADB;
    }
  });

  it('info.node starts with "v" and matches process.versions.node', () => {
    const dir = makeTempProject();
    process.env.KMP_TEST_SKIP_ADB = '1';
    try {
      const { envelope } = runInfo({ projectRoot: dir, args: [] });
      expect(envelope.info.node).toBe('v' + process.versions.node);
    } finally {
      delete process.env.KMP_TEST_SKIP_ADB;
    }
  });
});

describe('runInfo --no-adb flag', () => {
  it('--no-adb forces adb:null even without KMP_TEST_SKIP_ADB env var', () => {
    const dir = makeTempProject();
    // Save and clear env var to isolate the flag's effect.
    const prev = process.env.KMP_TEST_SKIP_ADB;
    delete process.env.KMP_TEST_SKIP_ADB;
    try {
      const { envelope } = runInfo({ projectRoot: dir, args: ['--no-adb'] });
      expect(envelope.info.adb).toBeNull();
    } finally {
      if (prev !== undefined) process.env.KMP_TEST_SKIP_ADB = prev;
    }
  });

  it('--no-adb restores prior KMP_TEST_SKIP_ADB after probe (no env mutation leak)', () => {
    const dir = makeTempProject();
    const prev = process.env.KMP_TEST_SKIP_ADB;
    delete process.env.KMP_TEST_SKIP_ADB;
    try {
      runInfo({ projectRoot: dir, args: ['--no-adb'] });
      expect(process.env.KMP_TEST_SKIP_ADB).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.KMP_TEST_SKIP_ADB = prev;
    }
  });
});

describe('runInfo gradlew detection', () => {
  it('gradlew.present:false when no wrapper file', () => {
    const dir = makeTempProject();
    process.env.KMP_TEST_SKIP_ADB = '1';
    try {
      const { envelope } = runInfo({ projectRoot: dir, args: [] });
      expect(envelope.info.gradlew.present).toBe(false);
    } finally {
      delete process.env.KMP_TEST_SKIP_ADB;
    }
  });

  it('gradlew.present:true when gradlew or gradlew.bat exists', () => {
    const dir = makeTempProject();
    writeFileSync(path.join(dir, 'gradlew'), '#!/usr/bin/env bash\nexit 0\n');
    writeFileSync(path.join(dir, 'gradlew.bat'), '@echo off\r\nexit /b 0\r\n');
    process.env.KMP_TEST_SKIP_ADB = '1';
    try {
      const { envelope } = runInfo({ projectRoot: dir, args: [] });
      expect(envelope.info.gradlew.present).toBe(true);
      expect(envelope.info.gradlew.project_root).toBe(dir);
    } finally {
      delete process.env.KMP_TEST_SKIP_ADB;
    }
  });
});

describe('runInfo never fails (exit 0 always)', () => {
  it('exits 0 even when no JDK / no gradlew / no config / no adb', () => {
    const dir = makeTempProject();
    process.env.KMP_TEST_SKIP_ADB = '1';
    try {
      const { envelope, exitCode } = runInfo({ projectRoot: dir, args: [] });
      // Standard envelope errors[] is empty for info — no soft errors emitted.
      expect(envelope.errors).toEqual([]);
      expect(envelope.exit_code).toBe(0);
      expect(exitCode).toBe(0);
    } finally {
      delete process.env.KMP_TEST_SKIP_ADB;
    }
  });
});

describe('runInfo jdk_catalogue parity with doctor', () => {
  // Wet-validation gate post-PR-10 (2026-05-10): doctor reported 4 JDK installs
  // (incl. one with vendor "Azul Systems, Inc.") but info reported only 3 — the
  // comma in the vendor name broke the message-string split parser. The fix
  // skips the round-trip through doctor's human-readable check.message and
  // reads installedJdks directly, so vendors with commas survive intact.
  afterEach(() => {
    discoverInstalledJdksMock.mockReturnValue([]);
  });

  it('jdk_catalogue includes all installs even when a vendor name contains a comma', () => {
    discoverInstalledJdksMock.mockReturnValue([
      { majorVersion: 11, vendor: 'Eclipse Adoptium' },
      { majorVersion: 17, vendor: 'Eclipse Adoptium' },
      { majorVersion: 21, vendor: 'Azul Systems, Inc.' }, // ← comma in vendor name
      { majorVersion: 23, vendor: 'Eclipse Adoptium' },
    ]);
    const dir = makeTempProject();
    process.env.KMP_TEST_SKIP_ADB = '1';
    try {
      const { envelope } = runInfo({ projectRoot: dir, args: [] });
      expect(envelope.info.jdk_catalogue).toHaveLength(4);
      expect(envelope.info.jdk_catalogue[2]).toEqual({ major: 21, vendor: 'Azul Systems, Inc.' });
      expect(envelope.info.jdk_catalogue.map(e => e.major)).toEqual([11, 17, 21, 23]);
    } finally {
      delete process.env.KMP_TEST_SKIP_ADB;
    }
  });

  it('jdk_catalogue empty array when no installs detected', () => {
    discoverInstalledJdksMock.mockReturnValue([]);
    const dir = makeTempProject();
    process.env.KMP_TEST_SKIP_ADB = '1';
    try {
      const { envelope } = runInfo({ projectRoot: dir, args: [] });
      expect(envelope.info.jdk_catalogue).toEqual([]);
    } finally {
      delete process.env.KMP_TEST_SKIP_ADB;
    }
  });

  it('jdk_catalogue entries use {major, vendor} shape (not {majorVersion, ...})', () => {
    discoverInstalledJdksMock.mockReturnValue([
      { majorVersion: 17, vendor: 'Eclipse Adoptium' },
    ]);
    const dir = makeTempProject();
    process.env.KMP_TEST_SKIP_ADB = '1';
    try {
      const { envelope } = runInfo({ projectRoot: dir, args: [] });
      const entry = envelope.info.jdk_catalogue[0];
      expect(entry).toHaveProperty('major');
      expect(entry).toHaveProperty('vendor');
      expect(entry).not.toHaveProperty('majorVersion');
      expect(entry.major).toBe(17);
    } finally {
      delete process.env.KMP_TEST_SKIP_ADB;
    }
  });
});

describe('formatInfoText', () => {
  it('renders a multi-line human-readable table from the info block', () => {
    const dir = makeTempProject();
    process.env.KMP_TEST_SKIP_ADB = '1';
    try {
      const { envelope } = runInfo({ projectRoot: dir, args: [] });
      const text = formatInfoText(envelope.info);
      expect(text).toMatch(/kmp-test info/);
      expect(text).toMatch(/Node:/);
      expect(text).toMatch(/JDK:/);
      expect(text).toMatch(/Catalogue:/);
      expect(text).toMatch(/Android SDK:/);
      expect(text).toMatch(/ADB:/);
      expect(text).toMatch(/Config:/);
    } finally {
      delete process.env.KMP_TEST_SKIP_ADB;
    }
  });
});

// PR-A from v0.9.1 macOS wet-validation (BACKLOG IDEA from PR #222):
// `info.jdk.java_home` was null in mac shells without an exported
// JAVA_HOME, breaking the parity snapshot (it expects "<string>" because
// CI Linux's setup-java always sets the env var). `resolveDarwinJavaHome`
// falls back to `/usr/libexec/java_home -v <major>` on darwin only;
// linux/windows preserve the existing null behavior. The injectable
// `spawner` arg keeps the unit tests hermetic without globally mocking
// `node:child_process` (which would clobber other tests in this file
// that exercise the real `runDoctorChecks` spawn chain).
describe('resolveDarwinJavaHome (PR-A — darwin fallback)', () => {
  let originalPlatform;

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  });
  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('returns null on non-darwin without invoking the spawner', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const spawner = vi.fn();
    expect(resolveDarwinJavaHome('21.0.5', spawner)).toBeNull();
    expect(spawner).not.toHaveBeenCalled();
  });

  it('returns trimmed stdout when darwin + /usr/libexec/java_home succeeds', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const spawner = vi.fn(() => ({
      status: 0,
      stdout: '/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home\n',
      stderr: '',
    }));
    expect(resolveDarwinJavaHome('21.0.5', spawner))
      .toBe('/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home');
    expect(spawner).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawner.mock.calls[0];
    expect(cmd).toBe('/usr/libexec/java_home');
    expect(args).toEqual(['-v', '21']);
  });

  it('returns null on darwin when the spawner exits non-zero (no crash)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const spawner = vi.fn(() => ({
      status: 1,
      stdout: '',
      stderr: 'Unable to find any JVMs matching version "99".\n',
    }));
    expect(resolveDarwinJavaHome('99.0.0', spawner)).toBeNull();
  });

  it('parses legacy "1.8.0_392" version strings into major "1.8"', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const spawner = vi.fn(() => ({
      status: 0,
      stdout: '/Library/Java/JavaVirtualMachines/jdk-1.8.jdk/Contents/Home\n',
      stderr: '',
    }));
    resolveDarwinJavaHome('1.8.0_392', spawner);
    expect(spawner.mock.calls[0][1]).toEqual(['-v', '1.8']);
  });
});
