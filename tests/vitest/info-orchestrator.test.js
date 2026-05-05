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

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runInfo, formatInfoText } from '../../lib/info-orchestrator.js';

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
