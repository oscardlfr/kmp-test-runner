import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8').replaceAll('\r\n', '\n');

describe('local CI cost gate', () => {
  it('pins the same primary runtimes exercised by hosted CI', () => {
    const dockerfile = read('tools/local-ci/Dockerfile');
    const ci = read('.github/workflows/ci.yml');
    expect(dockerfile).toContain('NODE24_VERSION=24.18.0');
    expect(dockerfile).toContain('NODE18_VERSION=18.20.8');
    expect(dockerfile.match(/JAVA_HOME=\/opt\/java17/g)?.length).toBe(2);
    expect(dockerfile).toContain('ACTIONLINT_VERSION=1.7.12');
    expect(dockerfile).toContain('8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8');
    expect(dockerfile).toContain('325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6');
    const node18Stage = dockerfile.slice(dockerfile.indexOf('FROM node:${NODE18_VERSION}-bookworm AS node18'));
    expect(node18Stage).toContain('JAVA_HOME=/opt/java17');
    expect(node18Stage).toContain('openjdk-17-jdk-headless');
    expect(dockerfile).toContain('shellcheck');
    expect(dockerfile).toContain('bats@1.13.0');
    expect(ci.match(/node-version: '24\.18\.0'/g)?.length).toBe(6);
    expect(ci).toContain("node-version: '18.20.8'");
  });

  it('covers the hosted Ubuntu build, plugin, and installer surfaces', () => {
    const gate = read('tools/local-ci/container/linux-gate.sh');
    for (const required of [
      'npm ci',
      'node tools/check-line-endings.mjs',
      'actionlint -shellcheck=',
      'npm audit --omit=dev --audit-level=high',
      'shellcheck --severity=warning',
      'bats tests/bats/ tests/installer/ tests/skill-scripts/',
      'npx vitest run --coverage',
      './gradlew --no-daemon test',
      'bash scripts/build-artifact.sh',
      'bats tests/installer/install.bats --filter E2E',
      'skills-ref@0.1.5 validate',
    ]) expect(gate).toContain(required);
  });

  it('keeps Windows-only behavior on the native host', () => {
    const gate = read('tools/local-ci/windows-gate.ps1');
    expect(gate).toContain("Invoke-Pester -Path 'tests/pester/', 'tests/installer/', 'tests/skill-scripts/'");
    expect(gate).toContain("@('test', '--tests', '*.TaskActionTest', '--no-daemon')");
    expect(gate).toContain("Push-Location (Join-Path $RepoRoot 'gradle-plugin')");
    expect(gate).toContain("$env:PATH = \"$(Join-Path $env:JAVA_HOME 'bin');$Node24Home;$originalPath\"");
    expect(gate).toContain("$env:PATH = \"$(Join-Path $jdk17Home 'bin');$Node18Home;$originalPath\"");
    expect(gate).toContain('Suspend-SensitiveEnvironment');
    expect(gate).toContain('Restore-SensitiveEnvironment');
    expect(gate).toContain("@('vitest', 'run', '--coverage')");
    expect(gate).toContain("@('vitest', 'run')");
    expect(gate).toContain("$node24Version -ne 'v24.18.0'");
    expect(gate).toContain("$node18Arch -ne 'x64'");
    expect(gate).toContain('$_.Version.Major -eq 5');
  });

  it('resolves npm lifecycle scripts and node.exe discovery hermetically (no cmd.exe empty-PATH hop)', () => {
    const gate = read('tools/local-ci/windows-gate.ps1');
    // npm's OWN lifecycle-script execution (e.g. esbuild's postinstall) is routed through
    // PowerShell instead of cmd.exe -- on hosts where a child cmd.exe process inherits an empty
    // PATH regardless of the caller's own environment, that lifecycle-script execution breaks.
    expect(gate).toContain("Set-ScopedEnvVar -Name 'npm_config_script_shell' -Value (Get-Command powershell -ErrorAction Stop).Source");
    // TaskActionTest's Windows shim gets a pre-validated node.exe path instead of shelling out to
    // `cmd.exe /c where node` itself.
    expect(gate).toContain("Set-ScopedEnvVar -Name 'KMP_LOCAL_CI_NODE_EXE' -Value (Resolve-Path $node24).Path");
    // Both are restored via the same scoped-restore primitive, not left set after the gate exits.
    expect(gate).toContain('Restore-ScopedEnvVar -Saved $npmScriptShellScope');
    expect(gate).toContain('Restore-ScopedEnvVar -Saved $nodeExeScope');
  });

  it('mounts source read-only and forwards no host environment wholesale', () => {
    const runner = read('tools/local-ci/run-linux.sh');
    const prepare = read('tools/local-ci/container/prepare-source.sh');
    expect(runner).toContain('dst=/source.tar,readonly');
    expect(runner).toContain('dst=/source.bundle,readonly');
    expect(runner).toContain('ls-files --cached --others --exclude-standard -z');
    expect(runner).toContain('bundle create "${source_bundle}" HEAD');
    expect(runner).toContain('tar -C "${source_root}"');
    expect(runner).toContain('all|node24|node18');
    expect(runner).toContain('if [[ "${lane}" == all || "${lane}" == node24 ]]');
    expect(runner).toContain('if [[ "${lane}" == all || "${lane}" == node18 ]]');
    expect(runner).toContain('source_git=(git --git-dir=');
    expect(runner).not.toContain('git.exe');
    expect(runner).not.toMatch(/--env-file|--privileged|docker\.sock/);
    expect(runner).not.toContain('dst=/source,readonly');
    expect(prepare).toContain('KMP_LOCAL_CI_ARCHIVE:-/source.tar');
    expect(prepare).toContain('--no-same-owner');
    expect(prepare).toContain('config core.autocrlf input');
    expect(prepare).toContain('git clone -q --no-hardlinks');
    expect(prepare).not.toContain('safe.directory');
  });

  it('exposes focused Linux runtime lanes without weakening the final All gate', () => {
    const runner = read('tools/local-ci/run.ps1');
    expect(runner).toContain("ValidateSet('All', 'Linux', 'LinuxNode24', 'LinuxNode18', 'Windows')");
    expect(runner).toContain("'LinuxNode24' { 'node24' }");
    expect(runner).toContain("'LinuxNode18' { 'node18' }");
  });

  it('defers hosted PR jobs while draft and runs them on ready_for_review', () => {
    const ci = read('.github/workflows/ci.yml');
    const commitLint = read('.github/workflows/commit-lint.yml');
    expect(ci).toContain('types: [opened, synchronize, reopened, ready_for_review]');
    expect(ci).toContain('PR_IS_DRAFT: ${{ github.event.pull_request.draft }}');
    expect(ci).toContain('Draft PR -- hosted heavy matrix deferred until ready_for_review');
    expect(ci).toContain('Draft privacy audit (tools/decouple-audit.mjs)');
    expect(ci.match(/github\.event\.pull_request\.draft != true/g)?.length).toBeGreaterThanOrEqual(4);
    const secretsScan = ci.slice(ci.indexOf('  secrets-scan:'), ci.indexOf('  decouple-audit:'));
    expect(secretsScan).not.toContain('github.event.pull_request.draft');
    expect(commitLint).toContain('types: [opened, edited, reopened, synchronize, ready_for_review]');
    expect(commitLint).toContain("if: github.event_name != 'pull_request' || github.event.pull_request.draft != true");
  });

  it.skipIf(process.platform !== 'win32')('PowerShell entrypoints parse cleanly', () => {
    for (const file of [
      'tools/local-ci/environment-utils.ps1',
      'tools/local-ci/path-utils.ps1',
      'tools/local-ci/run.ps1',
      'tools/local-ci/windows-gate.ps1',
    ]) {
      const script = `$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('${resolve(root, file).replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|ForEach-Object Message;exit 1}`;
      const parsed = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
      expect(parsed.status, parsed.stdout + parsed.stderr).toBe(0);
    }
  });

  it.skipIf(process.platform !== 'win32')('the Windows wrapper converts drive paths without shell escaping', () => {
    const scriptPath = resolve(root, 'tools/local-ci/path-utils.ps1').replaceAll("'", "''");
    const script = `. '${scriptPath}'; Convert-ToWslPath 'C:\\Work Tree\\repo'`;
    const converted = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    expect(converted.status, converted.stdout + converted.stderr).toBe(0);
    expect(converted.stdout.trim()).toBe('/mnt/c/Work Tree/repo');
  });

  it.skipIf(process.platform !== 'win32')('the native gate suspends credentials and restores them', () => {
    const scriptPath = resolve(root, 'tools/local-ci/environment-utils.ps1').replaceAll("'", "''");
    const script = [
      `. '${scriptPath}'`,
      `$env:ANTHROPIC_API_KEY = 'placeholder-only'`,
      `$env:ANTHROPIC_API_KEY_FALLBACK = 'fallback-placeholder-only'`,
      `$env:CLAUDE_CODE_OAUTH_TOKEN = 'oauth-placeholder-only'`,
      `$env:KMP_PRIVATE_PATTERNS_B64 = 'patterns-placeholder-only'`,
      `$pathBefore = $env:PATH`,
      `$saved = Suspend-SensitiveEnvironment`,
      `if (Test-Path Env:ANTHROPIC_API_KEY) { exit 1 }`,
      `if (Test-Path Env:ANTHROPIC_API_KEY_FALLBACK) { exit 2 }`,
      `if (Test-Path Env:CLAUDE_CODE_OAUTH_TOKEN) { exit 3 }`,
      `if (Test-Path Env:KMP_PRIVATE_PATTERNS_B64) { exit 4 }`,
      `if ($env:PATH -ne $pathBefore) { exit 5 }`,
      `Restore-SensitiveEnvironment -Entries $saved`,
      `if ($env:ANTHROPIC_API_KEY -ne 'placeholder-only') { exit 6 }`,
      `if ($env:ANTHROPIC_API_KEY_FALLBACK -ne 'fallback-placeholder-only') { exit 7 }`,
      `if ($env:CLAUDE_CODE_OAUTH_TOKEN -ne 'oauth-placeholder-only') { exit 8 }`,
      `if ($env:KMP_PRIVATE_PATTERNS_B64 -ne 'patterns-placeholder-only') { exit 9 }`,
    ].join('; ');
    const checked = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    expect(checked.status, checked.stdout + checked.stderr).toBe(0);
  });

  it.skipIf(process.platform !== 'win32')('Set-ScopedEnvVar/Restore-ScopedEnvVar round-trip when the variable was originally ABSENT', () => {
    const scriptPath = resolve(root, 'tools/local-ci/environment-utils.ps1').replaceAll("'", "''");
    const script = [
      `. '${scriptPath}'`,
      `if (Test-Path Env:KMP_SCOPED_ENV_TEST_ABSENT) { exit 1 }`,
      `$saved = Set-ScopedEnvVar -Name 'KMP_SCOPED_ENV_TEST_ABSENT' -Value 'during-gate'`,
      `if ($env:KMP_SCOPED_ENV_TEST_ABSENT -ne 'during-gate') { exit 2 }`,
      `if ($saved.WasSet -ne $false) { exit 3 }`,
      `Restore-ScopedEnvVar -Saved $saved`,
      `if (Test-Path Env:KMP_SCOPED_ENV_TEST_ABSENT) { exit 4 }`,
    ].join('; ');
    const checked = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    expect(checked.status, checked.stdout + checked.stderr).toBe(0);
  });

  it.skipIf(process.platform !== 'win32')('Set-ScopedEnvVar/Restore-ScopedEnvVar round-trip when the variable was originally PRESENT', () => {
    const scriptPath = resolve(root, 'tools/local-ci/environment-utils.ps1').replaceAll("'", "''");
    const script = [
      `. '${scriptPath}'`,
      `$env:KMP_SCOPED_ENV_TEST_PRESENT = 'before-gate'`,
      `$saved = Set-ScopedEnvVar -Name 'KMP_SCOPED_ENV_TEST_PRESENT' -Value 'during-gate'`,
      `if ($env:KMP_SCOPED_ENV_TEST_PRESENT -ne 'during-gate') { exit 1 }`,
      `if ($saved.WasSet -ne $true) { exit 2 }`,
      `if ($saved.OriginalValue -ne 'before-gate') { exit 3 }`,
      `Restore-ScopedEnvVar -Saved $saved`,
      `if ($env:KMP_SCOPED_ENV_TEST_PRESENT -ne 'before-gate') { exit 4 }`,
    ].join('; ');
    const checked = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    expect(checked.status, checked.stdout + checked.stderr).toBe(0);
  });
});
