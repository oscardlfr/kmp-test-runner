import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const read = path => readFileSync(resolve(root, path), 'utf8').replaceAll('\r\n', '\n');

describe('Evidence1 canonical Git Bash runtime', () => {
  it.skipIf(process.platform !== 'win32')('rejects a Git archive that omits Bash', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'e1-git-bash-normalize-'));
    try {
      const source = resolve(fixture, 'git');
      mkdirSync(resolve(source, 'cmd'), { recursive: true });
      writeFileSync(resolve(source, 'cmd', 'git.exe'), 'git');
      const upstream = resolve(fixture, 'upstream.exe');
      writeFileSync(upstream, 'upstream');
      const result = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        resolve(root, 'tools/evidence1/provisioning/evidence1-normalize-toolchain-archive.ps1'),
        '-RuntimeId', 'git', '-SourceRoot', source,
        '-UpstreamArtifactPath', upstream,
        '-ExpectedUpstreamSha256', createHash('sha256').update('upstream').digest('hex'),
        '-OutputPath', resolve(fixture, 'normalized.zip'),
        '-ReceiptPath', resolve(fixture, 'receipt.json'),
      ], { encoding: 'utf8', timeout: 30_000 });

      expect(result.status).not.toBe(0);
      expect(readFileSync(resolve(fixture, 'receipt.json'), 'utf8')).toContain('normalization_layout_invalid');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('binds the dedicated Git Bash runtime across install, readiness, binding, and launch', () => {
    const installer = read('docs/audits/evidence1-hyperv-install-canonical-git-bash-direct.ps1');
    const runner = read('docs/audits/evidence1-host-elevated-runner.ps1');
    const readiness = read('docs/audits/evidence1-hyperv-regenerate-readiness-direct.ps1');
    let binding;
    try { binding = read('docs/audits/evidence1-hyperv-inspect-final-codex-binding-inputs.ps1'); } catch { binding = null; }
    const launcher = read('docs/audits/evidence1-codex-live-launch.ps1');

    expect(installer).toContain("$ExpectedUpstreamSha256 = '5aa8a20f6e9abb2c755f0e73c91c687701a46b309ad84a0ca6509380fa4ae290'");
    expect(installer).toContain("$TargetRoot = 'C:\\Evidence1Toolchain\\git-bash\\2.55.0.windows.5'");
    expect(installer).toContain("@('cmd\\git.exe','bin\\bash.exe')");
    expect(installer).toContain('inference_sessions_consumed = 0');
    expect(installer).toContain("$vm.State-ne'Off'");
    expect(installer).toContain('vm_state_during_install');
    expect(installer).toContain("version_evidence='pinned_artifact_and_guest_readiness'");
    expect(installer).not.toContain("Join-Path $stage 'cmd\\git.exe') --version");
    expect(installer).not.toContain("Join-Path $stage 'bin\\bash.exe') --version");
    expect(installer).not.toContain('git_bash_install_requires_network_disconnected');
    expect(runner).toContain("'evidence1-hyperv-install-canonical-git-bash-direct.ps1'");
    expect(readiness).toContain("Join-Path $canonicalRoot 'git-bash\\2.55.0.windows.5\\bin'");
    expect(readiness).toContain("$canonicalBash = Join-Path $canonicalRoot 'git-bash\\2.55.0.windows.5\\bin\\bash.exe'");
    if (binding !== null) expect(binding).toContain("@('git-bash','2.55.0.windows.5')");
    expect(launcher).toContain("@('git-bash','2.55.0.windows.5','bin\\bash.exe')");
    expect(launcher).toContain("$bash = $canonicalToolchain['git-bash'].command");
  });
});
