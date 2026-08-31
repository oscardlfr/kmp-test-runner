import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { copyFile, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const readiness = resolve(root, 'docs/audits/evidence1-hyperv-regenerate-readiness-direct.ps1');
const moduleRelative = 'docs/audits/evidence1-validation-ops.psm1';
const quote = value => `'${value.replaceAll("'", "''")}'`;
const model = `.kmp-test-runner/cache/model-${'a'.repeat(40)}.json`;
const tasks = `.kmp-test-runner/cache/tasks-${'a'.repeat(40)}.txt`;
// Guest path validation deliberately rejects short-name aliases (RUNNER~1).
// Windows hosted TEMP may contain them, so use a disposable, valid guest-shaped root.
const fixtureParent = process.platform === 'win32' ? resolve('C:/kmp-eval/scratch') : resolve(tmpdir());
const options = { encoding: 'utf8', windowsHide: true, timeout: 40_000 };
const hasPowerShell = await exec('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], options)
  .then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

async function put(dir, path, text = 'synthetic') {
  const file = join(dir, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

async function fixture() {
  await mkdir(fixtureParent, { recursive: true });
  const dir = await mkdtemp(join(fixtureParent, 'e1-readiness-'));
  const source = join(dir, 'source');
  const harness = join(dir, 'harness');
  const scratch = join(dir, 'scratch');
  const git = async (repo, ...args) => (await exec('git', ['-C', repo, ...args], options)).stdout.trim();
  for (const repo of [source, harness]) {
    await mkdir(repo);
    await git(repo, 'init', '-q');
    await git(repo, 'config', 'user.name', 'Fixture');
    await git(repo, 'config', 'user.email', 'fixture@example.invalid');
    await git(repo, 'config', 'core.autocrlf', 'false');
    await put(repo, 'source.txt', 'tracked\n');
  }
  await mkdir(dirname(join(harness, moduleRelative)), { recursive: true });
  await copyFile(join(root, moduleRelative), join(harness, moduleRelative));
  for (const repo of [source, harness]) {
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-qm', 'fixture');
  }
  return { dir, source, harness, scratch, git,
    sourceCommit: await git(source, 'rev-parse', 'HEAD'),
    targetCommit: await git(harness, 'rev-parse', 'HEAD'),
    targetTree: await git(harness, 'rev-parse', 'HEAD^{tree}') };
}

async function withFixture(action) {
  const f = await fixture();
  try { await action(f); }
  finally {
    const target = resolve(f.dir);
    if (dirname(target) !== fixtureParent || !target.startsWith(join(fixtureParent, 'e1-readiness-'))) {
      throw new Error('unsafe fixture cleanup');
    }
    await rm(target, { recursive: true, force: true });
  }
}

function expectRejected(result) {
  expect(result.failure).toBeTruthy();
  expect(result.result).toBeNull();
  expect(result.ledger).toBeNull();
  expect(result.location_restored).toBe(true);
}

// Execute the AST-extracted guest, never the host entrypoint. External environment
// boundaries are synthetic; snapshots, allowlists and postflight use the real module.
async function runGuest(f, { duringDry = '', beforePublish = '', dryFails = false, targetCommit = f.targetCommit, targetTree = f.targetTree } = {}) {
  const script = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$global:Events=[Collections.Generic.List[string]]::new()
$fixtureRoot=${quote(f.dir)}
$fixtureModule=${quote(join(f.harness, moduleRelative))}
$global:FixtureGit=(Get-Command git -CommandType Application | Select-Object -First 1).Source
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(readiness)},[ref]$tokens,[ref]$errors)
if($errors.Count) { throw ($errors.Message -join '; ') }
$command=$ast.Find({param($a) $a -is [Management.Automation.Language.CommandAst] -and $a.GetCommandName() -eq 'Invoke-Command'},$true)
$expression=@($command.CommandElements | Where-Object { $_ -is [Management.Automation.Language.ScriptBlockExpressionAst] })
if($expression.Count -ne 1) { throw 'guest_boundary_missing' }
$guest=$expression[0].ScriptBlock
$text=$guest.Extent.Text
$stubs=@{
  'Add-StageBPath'='function Add-StageBPath {}'
  'Command-Source'='function Command-Source($Name) { switch($Name) { "node.exe" { "Fixture-Node" }; "git.exe" { "git.exe" }; "claude.cmd" { "Fixture-Claude" }; default { throw "unexpected_tool" } } }'
  'Assert-RestrictedNetwork'='function Assert-RestrictedNetwork { @{allowed_probe_count=4;blocked_probe_count=6;blocked_probe_success_count=0} }'
}
$functions=$guest.FindAll({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $stubs.ContainsKey($a.Name)},$true)
if($functions.Count -ne $stubs.Count) { throw 'fixture_boundary_missing' }
foreach($fn in ($functions | Sort-Object { $_.Extent.StartOffset } -Descending)) {
  $offset=$fn.Extent.StartOffset-$guest.Extent.StartOffset
  $text=$text.Remove($offset,$fn.Extent.Text.Length).Insert($offset,$stubs[$fn.Name])
}
$block=[scriptblock]::Create($text.Substring(1,$text.Length-2))
function git.exe {
  $arguments=@($args | ForEach-Object { $_ })
  if($arguments[0] -notin @('rev-parse','status','hash-object','--version')) { throw 'unexpected_git_command' }
  & $global:FixtureGit @arguments
  $global:LASTEXITCODE=$LASTEXITCODE
}
function Import-Module {
  param($Name,[switch]$Force,[switch]$DisableNameChecking)
  if([IO.Path]::GetFullPath($Name) -ne [IO.Path]::GetFullPath($fixtureModule)) { throw 'untrusted_module' }
  $global:Events.Add('import')
  Microsoft.PowerShell.Core\\Import-Module $Name -Force -DisableNameChecking -Global
  $m=Get-Module evidence1-validation-ops
  & $m {
    param($fixtureRoot)
    $script:FixtureRoot=$fixtureRoot
    $script:OriginalResolve=(Get-Command Resolve-E1Path).ScriptBlock
    # Retain native path/link validation on Windows. Linux replaces only the
    # Windows path boundary, not artifact allowlists, hashes or Git checks.
    function script:Resolve-E1Path([string]$Path,[string]$Root) {
      if([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
        return & $script:OriginalResolve $Path $script:FixtureRoot
      }
      $full=[IO.Path]::GetFullPath($Path)
      if(-not $full.StartsWith($script:FixtureRoot+'/')) { throw 'path_outside_root' }
      $current=$full
      while($current) {
        if(Test-Path -LiteralPath $current) {
          $item=Get-Item -LiteralPath $current -Force
          if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.LinkType -eq 'HardLink') { throw 'path_link' }
        }
        $current=[IO.Path]::GetDirectoryName($current)
      }
      return $full
    }
    function script:Invoke-E1Git([string]$Root,[string[]]$Arguments,[string]$Directory) {
      if($Arguments[0] -notin @('rev-parse','ls-files','status')) { throw 'unexpected_custody_git' }
      if($Arguments[0] -eq 'ls-files' -and $Arguments[1] -eq '-v') { $global:Events.Add('snapshot') }
      $output=& $global:FixtureGit --no-optional-locks -c core.fsmonitor=false -C $Root @Arguments
      if($LASTEXITCODE -ne 0) { throw 'git_failed' }
      return ($output -join "\n").Trim()
    }
  } $fixtureRoot
}
function Fixture-Claude {
  if(($args -join ' ') -notin @('--version','auth status')) { throw 'unexpected_claude_call' }
  $global:LASTEXITCODE=0
  if($args[0] -eq '--version') { '2.1.238 (Claude Code)' }
}
function java.exe { $global:LASTEXITCODE=0; 'openjdk version "21"' }
function npm.cmd {
  $global:LASTEXITCODE=0
  ${beforePublish}
  '10.0.0'
}
function Fixture-Node {
  $global:LASTEXITCODE=0
  if($args[0] -eq '--version') { return 'v22.0.0' }
  if($args[0] -eq '--input-type=module') { return '{"ok":true,"schema":1,"sha256":"${'f'.repeat(64)}"}' }
  if($args[0] -ne 'tools/agentic-eval/cli.mjs' -or $args[-1] -ne '--dry-run') { throw 'unexpected_node_call' }
  $global:Events.Add('dry-run')
  ${duringDry}
  if($${dryFails}) { $global:LASTEXITCODE=7; return }
  $plan=@('A','B','B','A','B','A','A','B') | ForEach-Object {
    @{campaign_cell_label=$_;execution_profile_id='sandboxed-unrestricted-v1';
      condition=$(if($_ -eq 'A') {'current-skill'} else {'no-skill'});
      product_access_mode=$(if($_ -eq 'A') {'product-assisted'} else {'free-baseline-no-product'});
      execution_profile_isolation_attestation_sha256=('f'*64)}
  }
  @{dry_run=$true;campaign_design_id='claude-product-vs-free-baseline-v1';planned_sessions=8;max_budget_usd=2;plan=@($plan)} | ConvertTo-Json -Depth 5 -Compress
}
$initialLocation=(Get-Location).Path
$result=$null; $failure=$null; $postflight=$null
try {
  $result=& $block ${quote(f.harness)} ${quote(targetCommit)} ${quote(targetTree)} ${quote(f.sourceCommit)} ${quote(f.source)} ${quote(join(f.dir, 'attestation.json'))} ${quote(f.scratch)}
} catch {
  $failure=$_.Exception.Message
  $postflight=$_.Exception.Data['source_postflight_failure']
}
$ledgerPath=Join-Path ${quote(f.scratch)} 'READINESS.json'
$ledger=if(Test-Path -LiteralPath $ledgerPath) { Get-Content -LiteralPath $ledgerPath -Raw | ConvertFrom-Json } else { $null }
@{result=$result;failure=$failure;postflight=$postflight;ledger=$ledger;events=@($global:Events);location_restored=((Get-Location).Path -eq $initialLocation)} | ConvertTo-Json -Depth 20 -Compress
`;
  // Synthetic subprocesses receive no credentials inherited from the test host.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/ANTHROPIC_|OPENAI_API_KEY|GOOGLE_API_KEY|AZURE_OPENAI_API_KEY|GH_TOKEN|GITHUB_TOKEN|COPILOT_/i.test(name)));
  const result = await exec('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { ...options, env });
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}

describe.skipIf(!hasPowerShell)('readiness source custody guest integration', { timeout: 45_000 }, () => {
  it.skipIf(process.platform !== 'win32')('keeps a valid guest fixture when Windows TEMP uses a short-name alias', async () => {
    const parent = 'C:/kmp-eval/scratch';
    await mkdir(parent, { recursive: true });
    const alias = await mkdtemp(join(parent, 'e1-ci-temp~'));
    const previous = process.env.TEMP;
    process.env.TEMP = alias;
    try {
      await withFixture(async f => {
        const result = await runGuest(f);
        expect(result.failure).toBeNull();
        expect(result.result.verdict).toBe('PASS');
      });
    } finally {
      if (previous === undefined) delete process.env.TEMP;
      else process.env.TEMP = previous;
      if (dirname(resolve(alias)) !== resolve(parent)) throw new Error('unsafe alias cleanup');
      await rm(alias, { recursive: true, force: true });
    }
  });

  it.each([false, true])('accepts immutable bounded runtime artifacts (present=%s) and preserves source anchors', async present => {
    await withFixture(async f => {
      if (present) {
        for (const path of [model, tasks, '.kmp-test-runner/reports/coverage/latest.md', '.kmp-test-runner/reports/coverage/20260830-120000-123456.md']) {
          await put(f.source, path);
        }
      }
      const before = await f.git(f.source, 'status', '--porcelain=v1', '--untracked-files=all');
      const result = await runGuest(f);
      expect(result.failure).toBeNull();
      expect(result.result.verdict).toBe('PASS');
      expect(result.result.source_head).toBe(f.sourceCommit);
      expect(result.ledger.anchors.source_commit_actual).toBe(f.sourceCommit);
      expect(result.ledger.anchors.source_commit_expected).toBe(f.sourceCommit);
      expect(result.events).toEqual(['import', 'snapshot', 'dry-run', 'snapshot']);
      expect(result.location_restored).toBe(true);
      expect(await f.git(f.source, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(before);
      if (present) expect(await readFile(join(f.source, model), 'utf8')).toBe('synthetic');
    });
  });

  it.each(['tracked', 'staged', 'unknown', 'malformed', 'assume-unchanged', 'skip-worktree', 'directory-link', 'hardlink'])('rejects preexisting %s without repairing the source', async kind => {
    await withFixture(async f => {
      if (['tracked', 'staged', 'assume-unchanged', 'skip-worktree'].includes(kind)) {
        if (kind === 'assume-unchanged' || kind === 'skip-worktree') await f.git(f.source, 'update-index', `--${kind}`, 'source.txt');
        await put(f.source, 'source.txt', 'edited\n');
        if (kind === 'staged') await f.git(f.source, 'add', 'source.txt');
      } else if (kind === 'directory-link') {
        const target = join(f.dir, 'linked');
        await mkdir(target);
        await symlink(target, join(f.source, '.kmp-test-runner'), process.platform === 'win32' ? 'junction' : 'dir');
      } else if (kind === 'hardlink') {
        await put(f.dir, 'linked.txt');
        await mkdir(dirname(join(f.source, model)), { recursive: true });
        await link(join(f.dir, 'linked.txt'), join(f.source, model));
      } else {
        await put(f.source, kind === 'unknown' ? 'unknown.txt' : '.kmp-test-runner/cache/model-wrong.json');
      }
      const flags = await f.git(f.source, 'ls-files', '-v');
      const result = await runGuest(f);
      expectRejected(result);
      expect(result.events).not.toContain('dry-run');
      expect(await f.git(f.source, 'ls-files', '-v')).toBe(flags);
    });
  });

  it.each(['add', 'modify', 'remove', 'tracked', 'index-flag', 'empty-directory'])('refuses PASS after dry-run %s mutation', async kind => {
    await withFixture(async f => {
      if (['modify', 'remove'].includes(kind)) await put(f.source, model, 'before');
      const path = quote(join(f.source, model));
      const mutations = {
        add: `$null=New-Item -ItemType Directory -Force ${quote(dirname(join(f.source, tasks)))}; [IO.File]::WriteAllText(${quote(join(f.source, tasks))},'new')`,
        modify: `$stamp=(Get-Item -LiteralPath ${path}).LastWriteTimeUtc; [IO.File]::WriteAllText(${path},'mutate'); [IO.File]::SetLastWriteTimeUtc(${path},$stamp)`,
        remove: `[IO.File]::Delete(${path})`,
        tracked: `[IO.File]::WriteAllText(${quote(join(f.source, 'source.txt'))},'edited')`,
        'index-flag': `& $global:FixtureGit -C ${quote(f.source)} update-index --assume-unchanged source.txt`,
        'empty-directory': `$null=New-Item -ItemType Directory -Force ${quote(join(f.source, '.kmp-test-runner/cache'))}`,
      };
      const result = await runGuest(f, { duringDry: mutations[kind] });
      expectRejected(result);
      expect(result.events).toContain('dry-run');
      expect(result.events.filter(event => event === 'snapshot')).toHaveLength(2);
    });
  });

  it('checks custody after ledger tool probes and before READINESS.json publication', async () => {
    await withFixture(async f => {
      const result = await runGuest(f, { beforePublish: `[IO.File]::WriteAllText(${quote(join(f.source, 'source.txt'))},'late edit')` });
      expectRejected(result);
      expect(result.events).toContain('dry-run');
    });
  });

  it.each([false, true])('runs failure postflight without hiding the primary dry-run failure (mutation=%s)', async mutate => {
    await withFixture(async f => {
      const result = await runGuest(f, { dryFails: true,
        duringDry: mutate ? `[IO.File]::WriteAllText(${quote(join(f.source, 'source.txt'))},'edited')` : '' });
      expectRejected(result);
      expect(result.failure).toBe('HARD STOP: campaign dry-run failed with exit code 7');
      expect(result.postflight).toBe(mutate ? 'repo_dirty' : null);
      expect(result.events).toEqual(['import', 'snapshot', 'dry-run', 'snapshot']);
    });
  });

  it.each(['head', 'tree', 'dirty', 'hidden-module-edit'])('rejects untrusted harness %s before importing its module', async kind => {
    await withFixture(async f => {
      if (kind === 'hidden-module-edit') await f.git(f.harness, 'update-index', '--assume-unchanged', moduleRelative);
      if (kind === 'dirty' || kind === 'hidden-module-edit') await put(f.harness, moduleRelative, "throw 'untrusted module executed'");
      const result = await runGuest(f, {
        targetCommit: kind === 'head' ? 'b'.repeat(40) : f.targetCommit,
        targetTree: kind === 'tree' ? 'b'.repeat(40) : f.targetTree,
      });
      expectRejected(result);
      expect(result.events).toEqual([]);
    });
  });
});
