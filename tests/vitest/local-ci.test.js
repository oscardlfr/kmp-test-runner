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

  // Post-review hardening (round 1): windows-gate.ps1 previously ran its 3 setup mutations
  // (Set-ScopedEnvVar for npm_config_script_shell, Suspend-SensitiveEnvironment, Push-Location)
  // BEFORE its own try block started -- a failure partway through (e.g. the 2nd or 3rd step
  // throwing after the 1st already succeeded) would leave that already-mutated state permanently
  // unrestored, since PowerShell's finally only guards code INSIDE the try. This test doesn't force
  // windows-gate.ps1's own specific Get-Command/Push-Location calls to fail (fragile and, for
  // Get-Command, would require neutering this test process's own PATH) -- it instead proves the
  // GENERAL resilience pattern windows-gate.ps1 now uses, with the same real functions
  // (Set-ScopedEnvVar/Suspend-SensitiveEnvironment/Restore-ScopedEnvVar/Restore-SensitiveEnvironment)
  // it actually calls, injecting a deliberate failure between the 2nd and 3rd setup step and
  // proving the first two ARE still cleanly restored despite the third never running.
  it.skipIf(process.platform !== 'win32')('the resilience pattern windows-gate.ps1 uses restores every mutation that already succeeded, even when a LATER setup step fails', () => {
    const scriptPath = resolve(root, 'tools/local-ci/environment-utils.ps1').replaceAll("'", "''");
    // A real multi-line try/catch/finally, not a `.join('; ')`'d array -- joining a compound
    // try/catch/finally statement with '; ' as the separator inserts a semicolon between the `}`
    // closing catch and the `finally` keyword, which breaks PowerShell's parsing of the compound
    // statement (every other script in this file is flat/single-statement-per-line, so this is the
    // first one to hit that pitfall).
    const script = `
. '${scriptPath}'
$env:KMP_RESILIENCE_TEST_NPM_SHELL = 'before-gate'
$env:ANTHROPIC_API_KEY = 'placeholder-only'
$npmScope = $null
$sensitive = $null
$thirdStepRan = $false
$caught = $null
try {
  $npmScope = Set-ScopedEnvVar -Name 'KMP_RESILIENCE_TEST_NPM_SHELL' -Value 'during-gate'
  $sensitive = Suspend-SensitiveEnvironment
  throw 'simulated: the 3rd setup step (e.g. Push-Location) fails here'
  $thirdStepRan = $true
} catch {
  $caught = $_
} finally {
  if ($npmScope) { Restore-ScopedEnvVar -Saved $npmScope }
  if ($sensitive) { Restore-SensitiveEnvironment -Entries $sensitive }
}
if ($null -eq $caught) { exit 1 }
if ($thirdStepRan) { exit 2 }
if ($env:KMP_RESILIENCE_TEST_NPM_SHELL -ne 'before-gate') { exit 3 }
if ($env:ANTHROPIC_API_KEY -ne 'placeholder-only') { exit 4 }
`;
    const checked = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    expect(checked.status, checked.stdout + checked.stderr).toBe(0);
  });

  it.skipIf(process.platform !== 'win32')('windows-gate.ps1 wraps its OWN setup mutations (npm_config_script_shell, Suspend-SensitiveEnvironment, Push-Location) inside its try, not before it', () => {
    const gate = read('tools/local-ci/windows-gate.ps1');
    const tryIndex = gate.indexOf('\ntry {');
    // The real statements, not a bare substring -- this file's own explanatory comment ahead of
    // the try block mentions "Suspend-SensitiveEnvironment"/"Push-Location" by name too (describing
    // what used to run unguarded), so a plain indexOf would match the COMMENT, not the call.
    const npmScopeIndex = gate.indexOf("Set-ScopedEnvVar -Name 'npm_config_script_shell'");
    const suspendIndex = gate.indexOf('$sensitiveEnvironment = Suspend-SensitiveEnvironment');
    const pushLocationIndex = gate.indexOf('Push-Location $RepoRoot\n    $pushedLocation');
    expect(tryIndex).toBeGreaterThan(-1);
    expect(npmScopeIndex).toBeGreaterThan(tryIndex);
    expect(suspendIndex).toBeGreaterThan(tryIndex);
    expect(pushLocationIndex).toBeGreaterThan(tryIndex);
  });

  // Post-review hardening (round 3): the round-1 test above proves SETUP-mutation resilience (a
  // failure among the 3 steps BEFORE the try body runs). It does not prove CLEANUP-mutation
  // resilience -- confirmed via direct repro that a bare `throw` as the FIRST statement inside a
  // `finally` block aborts every statement after it in that SAME block; only wrapping each
  // restoration in its own try/catch lets every later one still run. windows-gate.ps1's `finally`
  // previously called Restore-ScopedEnvVar/Restore-SensitiveEnvironment/Pop-Location as bare
  // sequential statements with no per-statement guard -- an exception from the FIRST restoration
  // would have silently skipped every one after it.
  it.skipIf(process.platform !== 'win32')('the resilience pattern windows-gate.ps1 uses attempts every restoration independently, even when an EARLIER restoration itself throws', () => {
    const scriptPath = resolve(root, 'tools/local-ci/environment-utils.ps1').replaceAll("'", "''");
    const script = `
. '${scriptPath}'
$env:ANTHROPIC_API_KEY = 'placeholder-only'
$sensitive = $null
$cleanupErrors = @()
try {
  $sensitive = Suspend-SensitiveEnvironment
  throw 'simulated body failure'
} catch {
  $caught = $_
} finally {
  try { throw 'simulated: the FIRST restoration (e.g. Restore-ScopedEnvVar) itself throws' } catch { $cleanupErrors += $_.Exception.Message }
  if ($sensitive) { try { Restore-SensitiveEnvironment -Entries $sensitive } catch { $cleanupErrors += $_.Exception.Message } }
}
if ($null -eq $caught) { exit 1 }
if ($cleanupErrors.Count -ne 1) { exit 2 }
if ($env:ANTHROPIC_API_KEY -ne 'placeholder-only') { exit 3 }
`;
    const checked = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    expect(checked.status, checked.stdout + checked.stderr).toBe(0);
  });

  it.skipIf(process.platform !== 'win32')('windows-gate.ps1 wraps each of its OWN cleanup restorations in an independent try/catch, not as bare sequential statements', () => {
    const gate = read('tools/local-ci/windows-gate.ps1');
    const finallyIndex = gate.indexOf('\nfinally {');
    expect(finallyIndex).toBeGreaterThan(-1);
    // Real statements, not comment text -- this file's own explanatory comment ahead of the
    // finally block also mentions "Restore-ScopedEnvVar"/"Restore-SensitiveEnvironment"/
    // "Pop-Location" by name (describing what used to run unguarded), so each pattern below
    // requires the specific `try { <call>` shape, not a bare substring.
    const restorationPatterns = [
      "try { Restore-ScopedEnvVar -Saved $npmScriptShellScope }",
      "try { Restore-ScopedEnvVar -Saved $nodeExeScope }",
      'try { Restore-SensitiveEnvironment -Entries $sensitiveEnvironment }',
      'try { Pop-Location }',
    ];
    for (const pattern of restorationPatterns) {
      const index = gate.indexOf(pattern);
      expect(index, `expected to find "${pattern}" after the finally block starts`).toBeGreaterThan(finallyIndex);
    }
  });

  // Post-review hardening (round 4): Restore-SensitiveEnvironment's own internal foreach loop has
  // no per-entry try/catch -- a Set-Item throw on one entry (confirmed live: an env var name
  // containing '=' reliably throws ArgumentException) stops the loop outright, leaving every later
  // entry unrestored. windows-gate.ps1's own OUTER try/catch around the whole call only catches ONE
  // exception for the entire call, with no visibility into which individual entries inside it
  // succeeded -- the fix must live INSIDE Restore-SensitiveEnvironment itself.
  it.skipIf(process.platform !== 'win32')('Restore-SensitiveEnvironment attempts every entry independently, even when an earlier entry fails to restore', () => {
    const scriptPath = resolve(root, 'tools/local-ci/environment-utils.ps1').replaceAll("'", "''");
    // Every branch ends in an EXPLICIT exit, never relying on the script's natural end to imply
    // success -- confirmed via direct repro that pwsh -Command's own process exit code reflects
    // the ambient $?/error state left by a REAL, caught .NET exception (Set-Item's own
    // ArgumentException on an illegal env var name) when the script reaches its end without an
    // explicit exit, even though the exception was genuinely caught and handled. A plain `throw
    // 'literal string'` (as every OTHER script in this file uses) does not leave that same
    // residue -- this is the one test in this file whose tested code path throws a real cmdlet
    // exception, so it is the one that needs the explicit exit in both branches.
    const script = `
. '${scriptPath}'
$entries = @(
  [pscustomobject]@{ Name = 'KMP_RESTORE_TEST_BAD=NAME'; Value = 'x' },
  [pscustomobject]@{ Name = 'KMP_RESTORE_TEST_GOOD'; Value = 'restored-value' }
)
try { Restore-SensitiveEnvironment -Entries $entries } catch {}
if ($env:KMP_RESTORE_TEST_GOOD -ne 'restored-value') { exit 1 } else { exit 0 }
`;
    const checked = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    expect(checked.status, checked.stdout + checked.stderr).toBe(0);
  });

  // Post-review hardening (round 4): windows-gate.ps1's round-3 fix collected $cleanupErrors but
  // only Write-Warning'd them -- never affecting the script's own exit code, so a green body plus a
  // failed restoration could still report overall success while leaving altered state. Proves the
  // GENERAL pattern (not the live gate file, for the same cost/fragility reasons round 1/3 already
  // established) with the same real functions: a body that succeeds cleanly, paired with a cleanup
  // step that fails, must make the OVERALL script fail.
  it.skipIf(process.platform !== 'win32')('the resilience pattern windows-gate.ps1 uses fails the OVERALL script when the body succeeded but a cleanup restoration failed', () => {
    const scriptPath = resolve(root, 'tools/local-ci/environment-utils.ps1').replaceAll("'", "''");
    const script = `
. '${scriptPath}'
$bodySucceeded = $false
$cleanupErrors = @()
try {
  Write-Host 'body ran and succeeded'
  $bodySucceeded = $true
} finally {
  try { throw 'simulated: a real restoration (e.g. Restore-ScopedEnvVar) throws' } catch { $cleanupErrors += $_.Exception.Message }
  if ($cleanupErrors.Count -gt 0) {
    Write-Warning "cleanup encountered $($cleanupErrors.Count) error(s)"
    if ($bodySucceeded) { throw "body succeeded but cleanup failed ($($cleanupErrors.Count) error(s))" }
  }
}
Write-Host 'unreachable if the pattern correctly fails the script'
`;
    const checked = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    expect(checked.status).not.toBe(0);
  });

  // The companion direction: when the BODY itself fails, that original error must remain the
  // PRIMARY reported failure -- a cleanup error must never mask or replace it with a different one.
  it.skipIf(process.platform !== 'win32')('the resilience pattern preserves the ORIGINAL body error as primary when both the body AND a cleanup restoration fail', () => {
    const scriptPath = resolve(root, 'tools/local-ci/environment-utils.ps1').replaceAll("'", "''");
    const script = `
. '${scriptPath}'
$bodySucceeded = $false
$cleanupErrors = @()
try {
  throw 'THE ORIGINAL BODY ERROR'
  $bodySucceeded = $true
} finally {
  try { throw 'a cleanup restoration also throws' } catch { $cleanupErrors += $_.Exception.Message }
  if ($cleanupErrors.Count -gt 0) {
    Write-Warning "cleanup encountered $($cleanupErrors.Count) error(s)"
    if ($bodySucceeded) { throw "body succeeded but cleanup failed ($($cleanupErrors.Count) error(s))" }
  }
}
`;
    const checked = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    expect(checked.status).not.toBe(0);
    expect(checked.stdout + checked.stderr).toContain('THE ORIGINAL BODY ERROR');
    expect(checked.stdout + checked.stderr).not.toContain('body succeeded but cleanup failed');
  });

  // Post-review hardening (round 5): confirmed live (via a throwaway, non-persisted reproduction,
  // not kept in this suite -- a permanently-red test has no place in a committed suite) that
  // Write-Warning becomes a TERMINATING error when the ambient $WarningPreference is 'Stop' -- a new
  // exception raised from inside `finally` (even one this script never intended as a real failure
  // signal) supersedes whatever original exception was already propagating, exactly the same "a
  // throw during unwind replaces the original" semantics documented for the round-3/round-4
  // resilience fixes. Round 4's own `Write-Warning "cleanup encountered..."` call was exactly this
  // shape, confirmed to genuinely lose "THE ORIGINAL BODY ERROR" under $WarningPreference='Stop'.
  // The FIXED pattern (Write-Host, immune to $WarningPreference/$ErrorActionPreference entirely --
  // it writes straight to host output, never through PowerShell's structured warning/error streams)
  // -- proves the original body error survives even under the same hostile $WarningPreference='Stop'.
  it.skipIf(process.platform !== 'win32')('the resilience pattern windows-gate.ps1 uses (Write-Host, not Write-Warning) preserves the ORIGINAL body error even under $WarningPreference=\'Stop\'', () => {
    const script = `
$WarningPreference = 'Stop'
$bodySucceeded = $false
$cleanupErrors = @()
try {
  throw 'THE ORIGINAL BODY ERROR'
  $bodySucceeded = $true
} finally {
  try { throw 'a cleanup restoration also throws' } catch { $cleanupErrors += $_.Exception.Message }
  if ($cleanupErrors.Count -gt 0) {
    Write-Host "cleanup encountered $($cleanupErrors.Count) error(s): $($cleanupErrors -join '; ')"
    if ($bodySucceeded) { throw "body succeeded but cleanup failed ($($cleanupErrors.Count) error(s))" }
  }
}
`;
    const checked = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    expect(checked.status).not.toBe(0);
    expect(checked.stdout + checked.stderr).toContain('THE ORIGINAL BODY ERROR');
    expect(checked.stdout + checked.stderr).not.toContain('body succeeded but cleanup failed');
    expect(checked.stdout + checked.stderr).not.toContain('WarningPreference');
  });

  // The companion direction: cleanup failing after a SUCCESSFUL body must still fail the overall
  // script, even under the same hostile $WarningPreference='Stop'.
  it.skipIf(process.platform !== 'win32')('cleanup after a successful body still fails the script even under $WarningPreference=\'Stop\'', () => {
    const script = `
$WarningPreference = 'Stop'
$bodySucceeded = $false
$cleanupErrors = @()
try {
  Write-Host 'body ran and succeeded'
  $bodySucceeded = $true
} finally {
  try { throw 'a cleanup restoration throws' } catch { $cleanupErrors += $_.Exception.Message }
  if ($cleanupErrors.Count -gt 0) {
    Write-Host "cleanup encountered $($cleanupErrors.Count) error(s): $($cleanupErrors -join '; ')"
    if ($bodySucceeded) { throw "body succeeded but cleanup failed ($($cleanupErrors.Count) error(s))" }
  }
}
`;
    const checked = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    expect(checked.status).not.toBe(0);
    expect(checked.stdout + checked.stderr).toContain('body succeeded but cleanup failed');
  });

  it.skipIf(process.platform !== 'win32')('windows-gate.ps1 does not use Write-Warning inside its own finally block', () => {
    const gate = read('tools/local-ci/windows-gate.ps1');
    const finallyIndex = gate.indexOf('\nfinally {');
    expect(finallyIndex).toBeGreaterThan(-1);
    // The real invocation form (a quote immediately after the cmdlet name), not a bare substring --
    // this file's own explanatory comment ahead of the fix mentions "Write-Warning" by name too
    // (describing what NOT to do and why), so a plain indexOf would match the COMMENT, not a call.
    const afterFinally = gate.slice(finallyIndex);
    expect(/Write-Warning\s*['"]/.test(afterFinally)).toBe(false);
  });
});
