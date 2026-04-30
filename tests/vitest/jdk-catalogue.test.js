// Tests for lib/jdk-catalogue.js — v0.6.x Gap 2 JDK discovery.
//
// All filesystem state is in mkdtempSync temp dirs. We synthesize JDK
// install layouts (root `release` file for Linux/Windows-style installs,
// `Contents/Home/release` for macOS bundles) so the platform-agnostic
// probe logic can be tested cross-platform.

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { discoverInstalledJdks } from '../../lib/jdk-catalogue.js';

let workDir;

function makeTempRoot() {
  workDir = mkdtempSync(path.join(tmpdir(), 'kmp-jdk-cat-test-'));
  return workDir;
}

afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
});

// Create a synthetic JDK root with a `release` file at <root>/release.
function makeLinuxStyleJdk(root, name, version, vendor) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const lines = [`JAVA_VERSION="${version}"`];
  if (vendor) lines.push(`IMPLEMENTOR="${vendor}"`);
  writeFileSync(path.join(dir, 'release'), lines.join('\n') + '\n');
  return dir;
}

// Create a synthetic macOS-style JDK bundle with release at Contents/Home/release.
function makeMacOSBundleJdk(root, name, version, vendor) {
  const dir = path.join(root, name);
  const home = path.join(dir, 'Contents', 'Home');
  mkdirSync(home, { recursive: true });
  const lines = [`JAVA_VERSION="${version}"`];
  if (vendor) lines.push(`IMPLEMENTOR="${vendor}"`);
  writeFileSync(path.join(home, 'release'), lines.join('\n') + '\n');
  return dir;
}

describe('discoverInstalledJdks (v0.6.x Gap 2)', () => {
  it('returns empty array when no candidate dir exists', () => {
    const root = makeTempRoot();
    const result = discoverInstalledJdks({
      platform: 'linux',
      env: {},
      candidateDirs: [path.join(root, 'nonexistent')],
    });
    expect(result).toEqual([]);
  });

  it('detects multiple JDKs from a single candidate dir, sorted by majorVersion', () => {
    const root = makeTempRoot();
    makeLinuxStyleJdk(root, 'jdk-21', '21.0.1', 'Eclipse Adoptium');
    makeLinuxStyleJdk(root, 'jdk-11', '11.0.20', 'Eclipse Adoptium');
    makeLinuxStyleJdk(root, 'jdk-17', '17.0.10', 'Microsoft');
    const result = discoverInstalledJdks({
      platform: 'linux',
      env: {},
      candidateDirs: [root],
    });
    expect(result.map(e => e.majorVersion)).toEqual([11, 17, 21]);
    expect(result[0].vendor).toBe('Eclipse Adoptium');
    expect(result[1].vendor).toBe('Microsoft');
  });

  it('parses macOS bundle layout (Contents/Home/release)', () => {
    const root = makeTempRoot();
    makeMacOSBundleJdk(root, 'zulu-17.jdk', '17.0.5', 'Azul Zulu');
    const result = discoverInstalledJdks({
      platform: 'darwin',
      env: {},
      candidateDirs: [root],
    });
    expect(result).toHaveLength(1);
    expect(result[0].majorVersion).toBe(17);
    expect(result[0].vendor).toBe('Azul Zulu');
    // path points to the JAVA_HOME (Contents/Home), not the bundle root.
    expect(result[0].path.endsWith(path.join('Contents', 'Home'))).toBe(true);
  });

  it('falls back to vendor: "unknown" when IMPLEMENTOR is missing', () => {
    const root = makeTempRoot();
    makeLinuxStyleJdk(root, 'jdk-17', '17.0.0', null);
    const result = discoverInstalledJdks({
      platform: 'linux',
      env: {},
      candidateDirs: [root],
    });
    expect(result).toHaveLength(1);
    expect(result[0].vendor).toBe('unknown');
  });

  it('handles JDK 8 version format (1.8.x → major 8)', () => {
    const root = makeTempRoot();
    makeLinuxStyleJdk(root, 'jdk-8', '1.8.0_372', 'Eclipse Adoptium');
    const result = discoverInstalledJdks({
      platform: 'linux',
      env: {},
      candidateDirs: [root],
    });
    expect(result).toHaveLength(1);
    expect(result[0].majorVersion).toBe(8);
  });

  it('also probes JAVA_HOME from env', () => {
    const root = makeTempRoot();
    const javaHome = makeLinuxStyleJdk(root, 'custom-jdk-17', '17.0.0', 'Custom');
    const result = discoverInstalledJdks({
      platform: 'linux',
      env: { JAVA_HOME: javaHome },
      candidateDirs: [],   // no scan, only JAVA_HOME
    });
    expect(result).toHaveLength(1);
    expect(result[0].majorVersion).toBe(17);
    expect(result[0].vendor).toBe('Custom');
  });

  it('dedups by realpath when JAVA_HOME points to a scanned dir', () => {
    const root = makeTempRoot();
    const javaHome = makeLinuxStyleJdk(root, 'jdk-17', '17.0.0', 'Eclipse Adoptium');
    const result = discoverInstalledJdks({
      platform: 'linux',
      env: { JAVA_HOME: javaHome },
      candidateDirs: [root],   // JAVA_HOME also lives here, so the same JDK gets probed twice
    });
    expect(result).toHaveLength(1);
  });

  it('skips entries with malformed release file', () => {
    const root = makeTempRoot();
    const dir = path.join(root, 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'release'), 'GARBAGE\nNO_VERSION_HERE\n');
    makeLinuxStyleJdk(root, 'good', '21.0.0', 'Eclipse Adoptium');
    const result = discoverInstalledJdks({
      platform: 'linux',
      env: {},
      candidateDirs: [root],
    });
    expect(result).toHaveLength(1);
    expect(result[0].majorVersion).toBe(21);
  });
});
