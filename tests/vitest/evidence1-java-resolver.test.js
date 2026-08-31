// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverInstalledJdks } from '../../lib/jdk-catalogue.js';

const executable = (name) => process.platform === 'win32' ? `${name}.exe` : name;
const jdk = discoverInstalledJdks().find((entry) => entry.majorVersion === 21
  && existsSync(path.join(entry.path, 'bin', executable('java')))
  && existsSync(path.join(entry.path, 'bin', executable('javac'))));
const fixture = fileURLToPath(new URL('../fixtures/evidence1-java-resolver/ResolverProbe.java', import.meta.url));
const optionNames = ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'JAVA_OPTS'];
const baseEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !optionNames.includes(key.toUpperCase()) && key.toUpperCase() !== 'COMPUTERNAME'));
const ambientOptions = optionNames.map((key) => process.env[key]);

// No Gradle, sockets, downloads, or VM access. Missing JDK 21 is an explicit skip.
describe.skipIf(!jdk)('Evidence1 real Java 21 operation hosts resolver', () => {
  let root;
  let classes;
  let hosts;
  let hostsHash;
  const hash = () => createHash('sha256').update(readFileSync(hosts)).digest('hex');

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'e1 java resolver '));
    classes = path.join(root, 'compiled classes');
    hosts = path.join(root, 'operation with spaces', 'repository.hosts');
    mkdirSync(classes);
    mkdirSync(path.dirname(hosts));
    writeFileSync(hosts, [
      '127.0.0.42 repository.e1.invalid',
      '127.0.0.43 repository.e1.invalid',
      '127.0.0.1 localhost e1-resolver-computer',
      '::1 localhost e1-resolver-computer',
      '',
    ].join('\r\n'), { encoding: 'ascii', flag: 'wx' });
    hostsHash = hash();
    const compiled = spawnSync(path.join(jdk.path, 'bin', executable('javac')),
      ['--release', '21', '-d', classes, fixture], {
        env: baseEnv, encoding: 'utf8', timeout: 30_000, windowsHide: true,
      });
    expect(compiled.error?.code).toBeUndefined();
    expect(compiled.status, 'Java resolver fixture must compile with the selected JDK 21').toBe(0);
  }, 35_000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function launch(toolOptions) {
    const env = { ...baseEnv, COMPUTERNAME: 'e1-resolver-computer' };
    if (toolOptions !== undefined) env.JAVA_TOOL_OPTIONS = toolOptions;
    // Only the environment carries the -D option; the Java child inherits it unchanged.
    const result = spawnSync(path.join(jdk.path, 'bin', executable('java')),
      ['-cp', classes, 'ResolverProbe', 'wrapper', hosts], {
        env, encoding: 'utf8', timeout: 35_000, windowsHide: true, maxBuffer: 64 * 1024,
      });
    expect(result.error?.code).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(hash()).toBe(hostsHash);
    expect(optionNames.map((key) => process.env[key])).toEqual(ambientOptions);
    return result;
  }

  it('inherits the quoted hosts path in wrapper and child; known names are loopback and absent names fail closed', () => {
    const hostsPath = hosts.replaceAll('\\', '/');
    expect(hostsPath).toContain(' ');
    const result = launch(`-Djdk.net.hosts.file="${hostsPath}"`);
    expect(result.status).toBe(0);
    const observations = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(observations).toEqual(['wrapper', 'child'].map((role) => ({
      role,
      jdk_major: 21,
      property_matches: true,
      known_addresses: ['127.0.0.42', '127.0.0.43'],
      unknown_rejected: true,
      localhost_loopback: true,
      computer_loopback: true,
    })));
    // HotSpot prints the option to stderr. Keep it captured, never forward raw logs.
    expect(result.stderr).toContain('Picked up JAVA_TOOL_OPTIONS:');
  }, 40_000);

  it('rejects missing startup injection before attempting any name lookup', () => {
    const result = launch(undefined);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({ error: 'hosts_property_missing_or_mismatched' });
  }, 40_000);

  it('rejects an unquoted hosts path with spaces before the fixture runs', () => {
    const result = launch(`-Djdk.net.hosts.file=${hosts.replaceAll('\\', '/')}`);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  }, 40_000);
});
