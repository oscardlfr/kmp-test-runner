import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, copyFileSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const read = (name) => readFileSync(join(process.cwd(), 'docs', 'audits', name), 'utf8');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const psJson = (body, executable = 'powershell.exe') => JSON.parse(execFileSync(executable, [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', body,
], { encoding: 'utf8', windowsHide: true }).trim());
// Async siblings of execFileSync/spawnSync/psJson, same external contract, used ONLY by the one
// test below whose accumulated synchronous PowerShell-invocation time (measured: 58.57s, right at
// vitest's own worker RPC heartbeat window) triggered a `[vitest-worker]: Timeout calling
// "onTaskUpdate"` under full-suite load -- ~20 execFileSync/spawnSync calls in one synchronous test
// body left the event loop with no chance to yield between them. Same pattern already used in
// agentic-eval-run-command.test.js and evidence1-validation-ops.test.js's own `ps()` helper.
// Every OTHER test in this file keeps using the sync helpers above unchanged -- none of them come
// close to the 60s window on their own, so there is no reason to touch them.
const execFileAsync = promisify(execFile);
const execFileAsyncNoThrow = (cmd, args, opts) => execFileAsync(cmd, args, opts).then(
  ({ stdout, stderr }) => ({ status: 0, stdout, stderr }),
  (error) => ({ status: error.code ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }),
);
const psJsonAsync = async (body, executable = 'powershell.exe') => JSON.parse((await execFileAsync(executable, [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', body,
], { encoding: 'utf8', windowsHide: true })).stdout.trim());
const extractPsFunction = (source, name) => {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`missing PowerShell function ${name}`);
  const next = source.indexOf('\nfunction ', start + 10);
  return source.slice(start, next < 0 ? source.length : next);
};
const replacePsFunction = (source, name, replacement) => {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`missing PowerShell function ${name}`);
  const next = source.indexOf('\nfunction ', start + 10);
  return `${source.slice(0, start)}${replacement}\n${source.slice(next < 0 ? source.length : next + 1)}`;
};
const literalRunnerArray = (source, name, nextName) => {
  const start = source.indexOf(`$${name} = @(`);
  const end = source.indexOf(nextName ? `$${nextName} = @(` : 'function Resolve-FullPath', start);
  const slice = source.slice(start, end);
  const withoutComments = slice.split(/\r?\n/).map((line) => line.replace(/#.*$/, '')).join('\n');
  return [...withoutComments.matchAll(/'([^']+)'/g)].map((match) => match[1]);
};

const writeGuestWrapperFixture = (root) => {
  const ops = join(root, 'ops'); const harness = join(root, 'harness'); const runDir = join(root, 'run'); const invokeMarker = join(root, 'invoked.txt'); const errorMarker = join(root, 'error.txt');
  mkdirSync(ops); mkdirSync(runDir); mkdirSync(join(harness, 'tools', 'agentic-eval'), { recursive: true });
  const wrapper = join(runDir, 'wrapper.ps1');
  let wrapperSource = read('evidence1-final-codex-guest-wrapper.ps1')
    .replace("C:\\Evidence1Ops\\final-codex", ops)
    .replaceAll("C:\\kmp-eval\\agentic-eval-codex-runtime", harness)
    .replace(/\$bound=\[ordered\]@\{.*?\r?\nforeach\(\$name in \$bound\.Keys\)\{.*?\}\r?\n/s, '')
    .replace(/} catch \{\r?\n    \$state='failed'/, `} catch {\n    Set-Content -LiteralPath ${psQuote(errorMarker)} -Value $_.Exception.Message\n    $state='failed'`)
    .replace(/\s*& "\$env:SystemRoot\\System32\\shutdown\.exe"[^\n]+/, '\n        # shutdown disabled by behavioral fixture');
  wrapperSource = wrapperSource.replace(/^foreach\(\$runtimePath in .*Assert-E1WrapperRuntimePath.*\r?$/m, '# runtime ACL supplied by production placement; omitted in process-claim fixture');
  writeFileSync(wrapper, wrapperSource);
  const launcher = join(runDir, 'evidence1-codex-live-launch.ps1'); const validation = join(runDir, 'evidence1-validation-ops.psm1');
  const pilot = join(runDir, 'node-runtime', 'docs', 'audits', 'evidence1-codex-pilot-describe.mjs'); const scan = join(runDir, 'node-runtime', 'docs', 'audits', 'evidence1-codex-publication-scan.mjs');
  const control = join(harness, 'tools', 'agentic-eval', 'final-campaign-control.mjs');
  mkdirSync(dirname(pilot), { recursive: true });
  writeFileSync(launcher, '# fixture\n'); writeFileSync(pilot, '// fixture\n'); writeFileSync(scan, '// fixture\n'); writeFileSync(control, '// fixture\n');
  writeFileSync(validation, `function Invoke-E1OwnedProcess { Add-Content -LiteralPath ${psQuote(invokeMarker)} -Value invoked; Start-Sleep -Seconds 30; @{ExitCode=0;TimedOut=$false;CleanupOk=$true} }\nExport-ModuleMember -Function Invoke-E1OwnedProcess\n`);
  const fileHash = (path) => hash(readFileSync(path));
  const binding = { remote_auth_operation_id: randomUUID(), script_sha256: { launcher: fileHash(launcher), wrapper: fileHash(wrapper), validation_helper: fileHash(validation), campaign_control: fileHash(control), pilot_describe: fileHash(pilot), publication_scan: fileHash(scan) } };
  const bindingPath = join(runDir, 'binding.json'); writeFileSync(bindingPath, JSON.stringify(binding));
  const nodeManifestPath = join(runDir, 'node-runtime.manifest.json'); writeFileSync(nodeManifestPath, '{}');
  const runId = randomUUID(); const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper,
    '-RunId', runId, '-BindingPath', bindingPath, '-BindingSha256', 'a'.repeat(64), '-AuthorizationClaimPath', join(runDir, 'auth.json'),
    '-AuthorizationClaimSha256', 'b'.repeat(64), '-GlobalAuthorizationClaimPath', join(runDir, 'global.json'), '-GlobalAuthorizationClaimSha256', 'c'.repeat(64),
    '-RemoteAuthCanaryPath', join(runDir, 'remote.json'), '-RemoteAuthCanarySha256', 'd'.repeat(64),
    '-NodeRuntimeManifestPath', nodeManifestPath, '-NodeRuntimeManifestSha256', hash(readFileSync(nodeManifestPath)), '-TimeoutSeconds', '60'];
  return { ops, wrapper, invokeMarker, errorMarker, runId, args };
};

const writeCopyRecoveryEntrypointFixture = (root) => {
  const repo = join(root, 'repo'); const audits = join(repo, 'docs', 'audits'); const privateRoot = join(root, 'private');
  const reportRoot = join(root, 'reports'); const journalRoot = join(root, 'journals'); const publicRoot = join(repo, 'tools', 'runs');
  for (const path of [audits, privateRoot, reportRoot, journalRoot, publicRoot]) mkdirSync(path, { recursive: true });
  const names = ['evidence1-final-codex-copy-contract.psm1', 'evidence1-validation-ops.psm1', 'evidence1-final-codex-host-contract.psm1', 'evidence1-hyperv-copy-final-codex.ps1'];
  for (const name of names) {
    let source = read(name).replaceAll('C:\\kmp-eval\\agentic-eval-codex-runtime', repo)
      .replaceAll('C:\\kmp-eval\\scratch\\evidence1-final-codex-private', privateRoot)
      .replaceAll('C:\\kmp-eval\\scratch\\evidence1-final-codex-copy-reports', reportRoot)
      .replaceAll('C:\\kmp-eval\\scratch\\evidence1-final-codex-copy-journals', journalRoot);
    if (name === 'evidence1-hyperv-copy-final-codex.ps1') source = source.replace('#Requires -RunAsAdministrator', '# elevation supplied by production entrypoint');
    writeFileSync(join(audits, name), source);
  }
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init'); git('config', 'user.email', 'evidence@example.invalid'); git('config', 'user.name', 'Evidence Test'); git('add', '.'); git('commit', '-m', 'copy recovery fixture');
  return { repo, audits, privateRoot, reportRoot, journalRoot, publicRoot, script: join(audits, 'evidence1-hyperv-copy-final-codex.ps1'), module: join(audits, 'evidence1-final-codex-copy-contract.psm1'), head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
};

const runElevatedRunnerAttackFixture = (attack) => {
  const root = mkdtempSync('C:\\kmp-eval\\scratch\\e1-elevated-runner-test-'); const allowed = join(root, 'deployed'); const queue = join(root, 'queue'); const invoked = join(root, 'invoked.txt');
  mkdirSync(allowed); const runner = join(allowed, 'evidence1-host-elevated-runner.ps1');
  const runnerSource = read('evidence1-host-elevated-runner.ps1').replace('#Requires -RunAsAdministrator', '# elevation supplied by production task'); writeFileSync(runner, runnerSource);
  const names = literalRunnerArray(runnerSource, 'AllowedScripts', 'TrustedSupportFiles');
  for (const name of names) writeFileSync(join(allowed, name), '# safe fixture\n');
  const supportNames = literalRunnerArray(runnerSource, 'TrustedSupportFiles', 'TrustedNodeFiles');
  for (const name of supportNames) writeFileSync(join(allowed, name), '# safe support fixture\n');
  const nodeNames = literalRunnerArray(runnerSource, 'TrustedNodeFiles'); const nodeRoot = join(allowed, 'node-runtime');
  for (const name of nodeNames) { const path = join(nodeRoot, ...name.split('/')); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '// safe node fixture\n'); }
  const processModule = join(allowed, 'evidence1-validation-ops.psm1');
  writeFileSync(processModule, `function Invoke-E1OwnedProcess { Set-Content -LiteralPath ${psQuote(invoked)} -Value invoked; @{ExitCode=0;TimedOut=$false;CleanupOk=$true} }\nExport-ModuleMember -Function Invoke-E1OwnedProcess\n`);
  const fileHash = (path) => hash(readFileSync(path)); const manifest = { schema: 2, kind: 'evidence1-host-elevated-runner-manifest', principal_sid: 'S-1-5-21-1-2-3-4', source_git_commit: 'a'.repeat(40), runner_sha256: fileHash(runner), process_module_sha256: fileHash(processModule), scripts: names.map((name) => ({ name, sha256: fileHash(join(allowed, name)) })), support_files: supportNames.map((name) => ({ name, sha256: fileHash(join(allowed, name)) })), node_files: nodeNames.map((name) => ({ name, sha256: fileHash(join(nodeRoot, ...name.split('/'))), blob_oid: 'b'.repeat(40) })) };
  writeFileSync(join(allowed, 'evidence1-host-elevated-runner-manifest.json'), `${JSON.stringify(manifest)}\n`);
  const selected = names[0]; let requested = join(allowed, selected);
  if (attack === 'subdir') { const subdir = join(allowed, 'nested'); mkdirSync(subdir); requested = join(subdir, selected); writeFileSync(requested, '# attack\n'); }
  if (attack === 'symlink') { const target = join(root, 'payload.ps1'); writeFileSync(target, '# attack\n'); rmSync(requested); symlinkSync(target, requested, 'file'); }
  if (attack === 'tamper') writeFileSync(requested, '# tampered after manifest\n');
  if (attack === 'support-tamper') writeFileSync(join(allowed, supportNames[0]), '# tampered support after manifest\n');
  if (attack === 'node-tamper') writeFileSync(join(nodeRoot, ...nodeNames[0].split('/')), '// tampered node after manifest\n');
  if (attack === 'extra') writeFileSync(join(allowed, 'unexpected.ps1'), '# extra\n');
  mkdirSync(join(queue, 'requests'), { recursive: true }); const id = `attack-${attack}`;
  writeFileSync(join(queue, 'requests', `${id}.request.json`), JSON.stringify({ id, script_path: requested, arguments: [], timeout_seconds: 30 }));
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner, '-QueueRoot', queue, '-AllowedRoot', allowed, '-TestMode', '-Once'], { encoding: 'utf8', windowsHide: true });
  const responsePath = join(queue, 'responses', `${id}.response.json`); const response = existsSync(responsePath) ? JSON.parse(readFileSync(responsePath, 'utf8').replace(/^\uFEFF/, '')) : null;
  return { root, response, invoked: existsSync(invoked), status: result.status, stderr: result.stderr };
};

const guestTerminalChainFixture = () => {
  const campaignId = randomUUID(); const claimSha = '1'.repeat(64); const custodySha = '2'.repeat(64); const manifestSha = '3'.repeat(64);
  const claim = { schema: 1, kind: 'evidence1-final-codex-terminal-claim', run_id: campaignId, binding_sha256: 'a'.repeat(64), authorization_claim_sha256: 'b'.repeat(64), global_authorization_claim_sha256: 'c'.repeat(64), remote_auth_canary_sha256: 'd'.repeat(64), state: 'claimed-before-provider-spawn', retry_count: 0, replacement_or_respawn_authorized: false, claimed_at_utc: new Date().toISOString() };
  const terminal = { schema: 1, run_id: campaignId, terminal_claim_sha256: claimSha, state: 'complete', exit_code: 0, reason_code: 'complete', retry_count: 0, replacement_or_respawn_used: false, process_tree_cleanup: 'job-object-kill-on-close', publication_manifest_sha256: manifestSha, campaign_custody_sha256: custodySha };
  const slotAndPlanClaims = Array.from({ length: 6 }, (_, order_index) => ['slot.claim.json', 'plan.claim.json'].map((name) => ({ order_index, name, sha256: hash(`${order_index}:${name}`) }))).flat();
  const artifacts = Array.from({ length: 6 }, (_, order_index) => ({ order_index, record_path: `C:\\custody\\record-${order_index}.json`, record_sha256: hash(`record:${order_index}`), sidecar_path: `C:\\custody\\audit\\record-${order_index}.accepted.json`, sidecar_sha256: hash(`sidecar:${order_index}`) }));
  const custody = { schema: 1, kind: 'evidence1-final-codex-campaign-custody', identity: { schema: 1, campaign_id: campaignId, campaign_design_id: 'codex-product-vs-free-baseline-v1', sessions_executed: 6, retry_count: 0, slot_order: ['A', 'B', 'B', 'A', 'A', 'B'] }, binding_sha256: claim.binding_sha256, authorization_claim_sha256: claim.authorization_claim_sha256, global_authorization_claim_sha256: claim.global_authorization_claim_sha256, remote_auth_sha256: claim.remote_auth_canary_sha256, group_claim_sha256: 'e'.repeat(64), slot_and_plan_claims: slotAndPlanClaims, artifacts, exact_session_count_evidence: 'six durable pre-spawn slot claims and six unique accepted records', retry_count: 0, replacement_or_respawn_used: false, benchmark_eligible: false };
  return { campaignId, claimSha, custodySha, manifestSha, claim, terminal, custody };
};

describe('final Codex host/guest operational chain', () => {
  it.skipIf(process.platform !== 'win32').each(['powershell.exe', 'pwsh.exe'])(
    'loads the matching Security module under %s even when PSModulePath is poisoned',
    (shell) => {
      const root = mkdtempSync(join(tmpdir(), 'e1-security-module-'));
      try {
        const poisoned = join(root, 'Microsoft.PowerShell.Security');
        mkdirSync(poisoned);
        writeFileSync(join(poisoned, 'Microsoft.PowerShell.Security.psd1'), "throw 'poisoned_security_module'\n");
        const fn = extractPsFunction(read('evidence1-host-elevated-runner-install.ps1'), 'Import-E1InstallSecurityModule');
        const result = psJson(`function Fail([string]$Message){throw $Message};$env:PSModulePath=${psQuote(root)}+';'+$env:PSModulePath;${fn};Import-E1InstallSecurityModule;$module=Get-Module Microsoft.PowerShell.Security;@{loaded_from_pshome=$module.Path.StartsWith((Join-Path $PSHOME 'Modules'),[StringComparison]::OrdinalIgnoreCase);get_acl=[bool](Get-Command Get-Acl -ErrorAction SilentlyContinue);set_acl=[bool](Get-Command Set-Acl -ErrorAction SilentlyContinue)}|ConvertTo-Json -Compress`, shell);
        expect(result).toEqual({ loaded_from_pshome: true, get_acl: true, set_acl: true });
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
  );

  it.skipIf(process.platform !== 'win32').each(['powershell.exe', 'pwsh.exe'])(
    'the elevated runner loads its matching Security module under %s without autoload',
    (shell) => {
      const root = mkdtempSync(join(tmpdir(), 'e1-runner-security-module-'));
      try {
        const poisoned = join(root, 'Microsoft.PowerShell.Security');
        mkdirSync(poisoned);
        writeFileSync(join(poisoned, 'Microsoft.PowerShell.Security.psd1'), "throw 'poisoned_security_module'\n");
        const runner = read('evidence1-host-elevated-runner.ps1');
        const fn = extractPsFunction(runner, 'Import-E1RunnerSecurityModule');
        const result = psJson(`$env:PSModulePath=${psQuote(root)}+';'+$env:PSModulePath;${fn};Import-E1RunnerSecurityModule;$module=Get-Module Microsoft.PowerShell.Security;@{loaded_from_pshome=$module.Path.StartsWith((Join-Path $PSHOME 'Modules'),[StringComparison]::OrdinalIgnoreCase);get_acl=[bool](Get-Command Get-Acl -ErrorAction SilentlyContinue)}|ConvertTo-Json -Compress`, shell);
        expect(result).toEqual({ loaded_from_pshome: true, get_acl: true });
        expect(runner.indexOf('Import-E1RunnerSecurityModule')).toBeLessThan(runner.indexOf('$QueueRoot = Resolve-FullPath $QueueRoot'));
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
  );

  it.skipIf(process.platform !== 'win32')('imports the Security module exactly once before the first deployment ACL mutation', () => {
    const installer = resolve(process.cwd(), 'docs', 'audits', 'evidence1-host-elevated-runner-install.ps1');
    const result = psJson(`$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${psQuote(installer)},[ref]$tokens,[ref]$errors);$topCalls=@($ast.EndBlock.Statements|Where-Object{$_-is[Management.Automation.Language.PipelineAst]-and$_.PipelineElements.Count-eq 1-and$_.PipelineElements[0]-is[Management.Automation.Language.CommandAst]-and$_.PipelineElements[0].GetCommandName()-ceq'Import-E1InstallSecurityModule'});$principal=@($ast.FindAll({param($n)$n-is[Management.Automation.Language.AssignmentStatementAst]-and$n.Left-is[Management.Automation.Language.VariableExpressionAst]-and$n.Left.VariablePath.UserPath-ceq'principalSid'},$true));$deployment=@($ast.FindAll({param($n)$n-is[Management.Automation.Language.AssignmentStatementAst]-and$n.Left-is[Management.Automation.Language.VariableExpressionAst]-and$n.Left.VariablePath.UserPath-ceq'deploymentBase'},$true));$aclCalls=@($ast.FindAll({param($n)$n-is[Management.Automation.Language.CommandAst]-and$n.GetCommandName()-ceq'Set-E1InstallProtectedAcl'},$true)|Sort-Object{$_.Extent.StartOffset});$offset=if($topCalls.Count-eq 1){$topCalls[0].Extent.StartOffset}else{-1};@{parse_errors=$errors.Count;top_level_calls=$topCalls.Count;before_principal=$principal.Count-eq1-and$offset-lt$principal[0].Extent.StartOffset;before_deployment=$deployment.Count-eq1-and$offset-lt$deployment[0].Extent.StartOffset;before_first_acl=$aclCalls.Count-gt0-and$offset-lt$aclCalls[0].Extent.StartOffset}|ConvertTo-Json -Compress`);
    expect(result).toEqual({ parse_errors: 0, top_level_calls: 1, before_principal: true, before_deployment: true, before_first_acl: true });
  });

  it('installs the sealed runner as a hidden non-interactive SYSTEM task', () => {
    const installer = read('evidence1-host-elevated-runner-install.ps1');
    const runner = read('evidence1-host-elevated-runner.ps1');
    expect(installer).toContain("$ExecutionIdentity = 'System'");
    expect(installer).toContain("-UserId 'SYSTEM'");
    expect(installer).toContain('-LogonType ServiceAccount');
    expect(installer).toContain('-NonInteractive -WindowStyle Hidden');
    expect(installer).toContain('-Hidden');
    expect(installer).toContain("$taskLogonType = 'ServiceAccount'");
    expect(installer).toContain("$taskRunAs = 'SYSTEM'");
    expect(installer).toContain('logon_type = $taskLogonType');
    expect(installer).toContain('run_as = $taskRunAs');
    expect(installer).toContain('Set-E1InstallTaskRunAcl $TaskName $principalSid');
    expect(installer).toContain('(A;;GRGX;;;$PrincipalSid)');
    expect(installer).toContain('requestor_on_demand_run = $true');
    expect(runner).toContain("$runnerSid-cne'S-1-5-18'");
    expect(runner).toContain('Assert-E1RunnerProtectedAcl $AllowedRoot $manifest.principal_sid $true');
  });

  it('supports a sealed interactive-user task for user-scoped DPAPI without per-run elevation', () => {
    const installer = read('evidence1-host-elevated-runner-install.ps1');
    expect(installer).toContain("[ValidateSet('System','InteractiveUser')]");
    expect(installer).toContain("$ExecutionIdentity = 'System'");
    expect(installer).toContain("-UserId $identity.Name -LogonType Interactive -RunLevel Highest");
    expect(installer).toContain("$taskLogonType = 'InteractiveToken'");
    expect(installer).toContain('$taskRunAs = $identity.Name');
  });

  it.skipIf(process.platform !== 'win32')('accepts the Task Scheduler mapped GENERIC_EXECUTE mask as on-demand run access', () => {
    const fn = extractPsFunction(read('evidence1-host-elevated-runner-install.ps1'), 'Test-E1InstallTaskRunAccessMask');
    const result = psJson(`${fn};@{mapped_generic_execute=Test-E1InstallTaskRunAccessMask 0x1200a9;task_run_only=Test-E1InstallTaskRunAccessMask 0x8;task_state_only=Test-E1InstallTaskRunAccessMask 0x4}|ConvertTo-Json -Compress`);
    expect(result).toEqual({ mapped_generic_execute: true, task_run_only: true, task_state_only: false });
  });

  it.skipIf(process.platform !== 'win32')('parses every final host/guest entrypoint in Windows PowerShell 5.1 and PowerShell 7', () => {
    const names = [
      'evidence1-hyperv-capture-final-codex-auth-blob.ps1',
      'evidence1-hyperv-place-final-codex.ps1', 'evidence1-hyperv-start-final-codex.ps1',
      'evidence1-final-codex-guest-wrapper.ps1', 'evidence1-codex-live-launch.ps1',
      'evidence1-hyperv-copy-final-codex.ps1', 'evidence1-final-codex-copy-contract.psm1',
      'evidence1-final-codex-host-contract.psm1',
    ].map((name) => resolve(process.cwd(), 'docs/audits', name));
    for (const executable of ['powershell.exe', 'pwsh.exe']) {
      const result = psJson(`$count=0; foreach($path in @(${names.map(psQuote).join(',')})){ $tokens=$null; $errors=$null; $null=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors); $count += $errors.Count }; @{ parse_errors=$count } | ConvertTo-Json -Compress`, executable);
      expect(result).toEqual({ parse_errors: 0 });
    }
  });

  it('places only on the exact powered-off E2E VM and refuses replacement', () => {
    const script = read('evidence1-hyperv-place-final-codex.ps1');
    expect(script).toContain('Get-VM -Name $boundVmName');
    expect(script).toContain("throw 'binding_vm_identity_invalid'");
    expect(script).toContain("throw 'existing_final_campaign_no_replacement'");
    expect(script).toContain("$canonicalGlobalRoot='C:\\kmp-eval\\scratch\\evidence1-final-codex-authorization-claims'");
    expect(script).toContain("throw 'final_campaign_input_path_binding_invalid'");
    expect(script).toContain('[IO.FileMode]::CreateNew');
    expect(script).toContain('Evidence1FinalCodex.vbs');
    expect(script).toContain('fso.DeleteFile self, True');
    expect(script).toContain('If fso.FileExists(self) Then WScript.Quit 91');
    expect(script).toContain('-WindowStyle Hidden');
    expect(script).toContain('window_style=\'hidden\'');
    expect(script.indexOf('New-E1FinalOperationReservation')).toBeLessThan(script.indexOf('Mount-VHD'));
    expect(script).toContain("throw 'bound_script_hash_mismatch'");
    expect(script).toContain("throw 'staged_script_hash_mismatch'");
    expect(script).toContain("'evidence1-live-handoff-contract.psm1'");
    expect(script).toContain("throw 'staged_support_hash_mismatch'");
    expect(script).toContain("throw 'protected_guest_support_hash_mismatch'");
    expect(script).toContain("$snapshotNodeRoot=Join-Path $PSScriptRoot 'node-runtime'");
    expect(script).toContain("throw 'staged_node_hash_mismatch'");
    expect(script).toContain("ProgramData\\KmpEval\\Evidence1FinalCodexRuntime");
    expect(script).toContain('Set-E1FinalGuestRuntimeAcl $runtimeBase $true');
    expect(script).toContain("throw 'protected_guest_node_manifest_hash_mismatch'");
    expect(script.indexOf('Set-E1FinalGuestRuntimeAcl $runtimeBase $true')).toBeLessThan(script.indexOf('New-Item -ItemType Directory -Path $runtimeDir'));
    expect(script.indexOf("throw 'protected_guest_node_manifest_hash_mismatch'")).toBeLessThan(script.indexOf('$startupText='));
    expect(script).toContain("throw 'guest_campaign_control_hash_mismatch'");
    expect(script).toContain("throw 'guest_canonical_repository_missing'");
    expect(script).toContain("throw 'guest_canonical_repository_not_clean_or_pinned'");
    expect(script.indexOf("$guestRepository=Join-Path $root 'kmp-eval\\agentic-eval-codex-runtime'")).toBeLessThan(script.indexOf("$ops=Join-Path $root 'Evidence1Ops\\final-codex'"));
  });

  it.skipIf(process.platform !== 'win32').each(['powershell.exe', 'pwsh.exe'])('rejects a weak guest runtime DACL under %s', (shell) => {
    const modulePath = resolve(process.cwd(), 'docs/audits/evidence1-final-codex-host-contract.psm1');
    const result = psJson(`$m=Import-Module ${psQuote(modulePath)} -Force -PassThru;$result=& $m {$admin=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544');$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18');$users=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-545');function New-TestAcl([bool]$weak){$a=[Security.AccessControl.DirectorySecurity]::new();$a.SetOwner($admin);$a.SetAccessRuleProtection((-not$weak),$false);$i=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit';foreach($pair in @(@($system,[Security.AccessControl.FileSystemRights]::FullControl),@($admin,[Security.AccessControl.FileSystemRights]::FullControl),@($users,[Security.AccessControl.FileSystemRights]::ReadAndExecute))){$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($pair[0],$pair[1],$i,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))|Out-Null};return $a};$script:fake=New-TestAcl $false;function Get-Acl{return $script:fake};$valid=$false;try{Assert-E1FinalGuestRuntimeAcl 'fixture' $true;$valid=$true}catch{};$script:fake=New-TestAcl $true;$blocked=$false;try{Assert-E1FinalGuestRuntimeAcl 'fixture' $true}catch{$blocked=$_.Exception.Message-ceq'guest_runtime_acl_invalid'};@{valid=$valid;blocked=$blocked}};$result|ConvertTo-Json -Compress`, shell);
    expect(result).toEqual({ valid: true, blocked: true });
  });

  it.skipIf(process.platform !== 'win32')('operation reservation replay fails before a caller can mutate external state', () => {
    const root = mkdtempSync(join(tmpdir(), 'e1-final-reservation-'));
    try {
      const report = join(root, 'reports', 'one.json'); mkdirSync(join(root, 'reports'));
      const modulePath = resolve(process.cwd(), 'docs/audits/evidence1-final-codex-host-contract.psm1');
      const result = psJson(`Import-Module ${psQuote(modulePath)} -Force; $mutations=0;New-E1FinalOperationReservation -ReportPath ${psQuote(report)} -ReportRoot ${psQuote(join(root, 'reports'))} -Kind 'test' -CampaignId ${psQuote(randomUUID())} -Prerequisites @{}|Out-Null;$blocked=$false;try{New-E1FinalOperationReservation -ReportPath ${psQuote(report)} -ReportRoot ${psQuote(join(root, 'reports'))} -Kind 'test' -CampaignId ${psQuote(randomUUID())} -Prerequisites @{}|Out-Null;$mutations++}catch{$blocked=$true};@{blocked=$blocked;mutations=$mutations;claims=@(Get-ChildItem ${psQuote(join(root, 'reports'))} -File).Count}|ConvertTo-Json -Compress`);
      expect(result).toEqual({ blocked: true, mutations: 0, claims: 1 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('literalRunnerArray strips comment text before matching, so an apostrophe inside a comment cannot corrupt extraction', () => {
    const synthetic = [
      '$AllowedScripts = @(',
      "  'first-real-entry.ps1',",
      "  # a comment mentioning the disk's own chain, with an apostrophe",
      "  'second-real-entry.ps1',",
      "  # another one -- the campaign's own root",
      "  'third-real-entry.ps1'",
      ')',
      '',
      '$TrustedSupportFiles = @(',
      "  'unrelated.psm1'",
      ')',
    ].join('\n');
    expect(literalRunnerArray(synthetic, 'AllowedScripts', 'TrustedSupportFiles')).toEqual([
      'first-real-entry.ps1', 'second-real-entry.ps1', 'third-real-entry.ps1',
    ]);
  });

  it('literalRunnerArray parses the real evidence1-host-elevated-runner.ps1 AllowedScripts into exactly the real allowlist', () => {
    const runnerSource = read('evidence1-host-elevated-runner.ps1');
    const names = literalRunnerArray(runnerSource, 'AllowedScripts', 'TrustedSupportFiles');
    expect(names).toEqual([
      'evidence1-host-elevated-runner-install.ps1',
      'evidence1-host-broker-capability-dispatch.ps1',
      'evidence1-hyperv-copy-live-artifacts.ps1',
      'evidence1-hyperv-place-dual-condition-canary.ps1',
      'evidence1-hyperv-start-dual-condition-canary.ps1',
      'evidence1-hyperv-copy-dual-condition-canary.ps1',
      'evidence1-hyperv-copy-dual-auth-canary-diagnostic.ps1',
      'evidence1-hyperv-install-guest-codex-cli-direct.ps1',
      'evidence1-hyperv-upgrade-canonical-codex-cli-direct.ps1',
      'evidence1-hyperv-install-canonical-git-bash-direct.ps1',
      'evidence1-hyperv-open-codex-auth-window-direct.ps1',
      'evidence1-hyperv-inspect-final-codex-live-state.ps1',
      'evidence1-hyperv-inspect-guest-interactive-logon-diagnostic.ps1',
      'evidence1-hyperv-enable-guest-auto-logon.ps1',
      'evidence1-hyperv-seal-final-codex-network.ps1',
      'evidence1-hyperv-trigger-final-codex-direct.ps1',
      'evidence1-hyperv-copy-final-codex-preflight-diagnostic.ps1',
      'evidence1-hyperv-recover-readonly-diagnostic-mount.ps1',
      'evidence1-hyperv-verify-guest-account-mapping-direct.ps1',
      'evidence1-hyperv-inspect-vm-boot-state.ps1',
      'evidence1-hyperv-verify-account-mapping-offline.ps1',
      'evidence1-hyperv-sync-final-codex-source.ps1',
      'evidence1-hyperv-retire-preflight-failed-final-codex.ps1',
      'evidence1-hyperv-inspect-final-codex-closed-state.ps1',
      'evidence1-hyperv-copy-final-codex-failure-diagnostic.ps1',
      'evidence1-hyperv-create-final-codex-attestation.ps1',
      'evidence1-hyperv-rotate-final-codex-attestation.ps1',
      'evidence1-hyperv-run-codex-device-auth-direct.ps1',
      'evidence1-hyperv-run-claude-auth-direct.ps1',
      'evidence1-hyperv-warm-canonical-gradle-cache-direct.ps1',
      'evidence1-hyperv-read-live-operational-tail.ps1',
      'evidence1-hyperv-read-live-progress.ps1',
      'evidence1-hyperv-regenerate-readiness-direct.ps1',
      'evidence1-hyperv-stop-for-final-codex-auth-capture.ps1',
      'evidence1-hyperv-copy-final-codex-attestation.ps1',
      'evidence1-hyperv-inspect-final-codex-binding-inputs.ps1',
      'evidence1-hyperv-restore-canonical-android-sdk.ps1',
      'evidence1-hyperv-capture-final-codex-auth-blob.ps1',
      'evidence1-hyperv-start-authorized-live.ps1',
      'evidence1-hyperv-verify-guest-claude-auth-direct.ps1',
      'evidence1-hyperv-verify-guest-dual-auth-direct.ps1',
      'evidence1-hyperv-verify-guest-codex-preflight-direct.ps1',
      'evidence1-hyperv-update-harness-from-bundle.ps1',
      'evidence1-hyperv-verify-wet-gate-v2-direct.ps1',
      'evidence1-hyperv-verify-canary-dryrun-v3-direct.ps1',
      'evidence1-hyperv-read-wet-forensics-direct.ps1',
      'evidence1-hyperv-read-source-inventory-direct.ps1',
      'evidence1-hyperv-probe-gradle-offline-direct.ps1',
      'evidence1-hyperv-provision-gradle-cache-direct.ps1',
      'evidence1-hyperv-open-temporary-auth-egress.ps1',
      'evidence1-hyperv-open-claude-login-interactive-task.ps1',
      'evidence1-hyperv-open-vmconnect.ps1',
      'evidence1-hyperv-run-network-seal-direct.ps1',
      'evidence1-hyperv-place-final-codex.ps1',
      'evidence1-hyperv-resume-final-codex-placement.ps1',
      'evidence1-hyperv-retire-unstarted-final-codex.ps1',
      'evidence1-hyperv-retire-unexecuted-final-codex.ps1',
      'evidence1-hyperv-start-final-codex.ps1',
      'evidence1-hyperv-copy-final-codex.ps1',
      'evidence1-host-inspect-windows-iso.ps1',
      'evidence1-host-delete-failed-canonical-windows-vm.ps1',
      'evidence1-host-create-canonical-windows-vm.ps1',
      'evidence1-host-install-canonical-windows-unattended.ps1',
      'evidence1-host-apply-canonical-windows-offline.ps1',
      'evidence1-host-new-unattended-retry-custody.ps1',
      'evidence1-host-diagnose-windows-first-boot.ps1',
      'evidence1-host-post-os-canonical-windows.ps1',
      'evidence1-host-bootstrap-canonical-windows-toolchain.ps1',
      'evidence1-host-checkpoint-canonical-windows-toolchain.ps1',
      'evidence1-hyperv-set-vm-memory-direct.ps1',
      'evidence1-hyperv-inspect-vhd-chain-direct.ps1',
      'evidence1-hyperv-stat-guest-file-direct.ps1',
    ]);
  });

  it.skipIf(process.platform !== 'win32').each(['subdir', 'symlink', 'tamper', 'support-tamper', 'node-tamper', 'extra'])('the elevated runner rejects %s allowlist substitution before invocation', (attack) => {
    const fixture = runElevatedRunnerAttackFixture(attack);
    try { expect(fixture.response?.exit_code === 1 || fixture.status !== 0, fixture.stderr).toBe(true); expect(fixture.invoked).toBe(false); }
    finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }, 40_000);

  it.skipIf(process.platform !== 'win32')('installs a self-contained hash-bound snapshot and preflights final place/start/copy from it', async () => {
    const root = mkdtempSync('C:\\kmp-eval\\scratch\\e1-final-snapshot-e2e-');
    let deployed = null;
    try {
      const repo = join(root, 'canonical-source'); const audits = join(repo, 'docs', 'audits');
      const queue = join(root, 'queue'); const report = join(root, 'install.json'); const programData = join(root, 'program-data');
      mkdirSync(audits, { recursive: true }); mkdirSync(programData, { recursive: true });
      const runnerSource = read('evidence1-host-elevated-runner.ps1');
      const allowed = literalRunnerArray(runnerSource, 'AllowedScripts', 'TrustedSupportFiles');
      const support = literalRunnerArray(runnerSource, 'TrustedSupportFiles', 'TrustedNodeFiles');
      const nodeFiles = literalRunnerArray(runnerSource, 'TrustedNodeFiles');
      const createMarker = join(root, 'create-wrapper.invoked'); const installMarker = join(root, 'install-wrapper.invoked'); const retryMarker = join(root, 'retry-wrapper.invoked');
      const sourceFiles = new Set(['evidence1-host-elevated-runner.ps1', 'evidence1-validation-ops.psm1', ...allowed, ...support]);
      for (const name of sourceFiles) {
        let source = read(name);
        if (name === 'evidence1-final-codex-host-contract.psm1') {
          source = source.replace("$expected = 'C:\\kmp-eval\\agentic-eval-codex-runtime'", `$expected = ${psQuote(repo)}`);
        }
        if (['evidence1-host-apply-canonical-windows-offline.ps1', 'evidence1-host-create-canonical-windows-vm.ps1', 'evidence1-host-install-canonical-windows-unattended.ps1', 'evidence1-host-new-unattended-retry-custody.ps1'].includes(name)) {
          source = source.replace('#Requires -RunAsAdministrator', '# fixture supplies the required execution boundary');
        }
        writeFileSync(join(audits, name), source);
      }
      for (const relative of nodeFiles) {
        const source = join(process.cwd(), ...relative.split('/')); const destination = join(repo, ...relative.split('/'));
        mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination);
      }
      const offlineImplementation = join(repo, 'tools', 'evidence1', 'provisioning', 'evidence1-apply-windows-offline.ps1');
      const offlineStub = `param([string]$ProfilePath,[string]$InputLockPath,[string]$GuestCredentialPath,[string]$CreatedInspectionReceiptPath,[string]$ReceiptPath,[int]$TimeoutSeconds,[switch]$RecoveryOnly,[string]$RecoveryReasonCode,[string]$AuthorizationPhrase)\n[IO.File]::WriteAllText($ReceiptPath,'{"verdict":"PASS","fixture":true}',[Text.UTF8Encoding]::new($false))\n`;
      writeFileSync(offlineImplementation, offlineStub);
      writeFileSync(join(repo, 'tools', 'evidence1', 'provisioning', 'evidence1-windows-vm.ps1'), `param([string]$Mode,[string]$ProfilePath,[string]$InputLockPath,[string]$ReceiptPath,[string]$CreateAuthorizationPhrase)\n[IO.File]::AppendAllText(${psQuote(createMarker)},('invoked'+[Environment]::NewLine))\n[IO.File]::WriteAllText($ReceiptPath,'{"verdict":"PASS","fixture":true}',[Text.UTF8Encoding]::new($false))\n`);
      writeFileSync(join(repo, 'tools', 'evidence1', 'provisioning', 'evidence1-install-windows-unattended.ps1'), `param([string]$InputLockPath,[string]$GuestCredentialPath,[string]$AnswerMediaPath,[string]$ReceiptPath,[switch]$RecoveryOnly,[string]$PriorFailureReceiptPath,[string]$AuthorizationPhrase,[string]$PriorFailureCustodyPath,[string]$PriorInputLockPath,[string]$PriorCreatedInspectionReceiptPath,[string]$PriorRunnerRequestId,[string]$RetryAuthorizationPhrase,[string]$RecoveryReasonCode)\n[IO.File]::AppendAllText(${psQuote(installMarker)},('invoked'+[Environment]::NewLine))\n`);
      writeFileSync(join(repo, 'tools', 'evidence1', 'provisioning', 'evidence1-new-unattended-retry-custody.ps1'), `param([string]$ProfilePath,[string]$InputLockPath,[string]$PriorInputLockPath,[string]$PriorFailureReceiptPath,[string]$CreatedInspectionReceiptPath,[string]$RunnerRequestId,[string]$GuestCredentialPath,[string]$PriorAnswerMediaPath)\n[IO.File]::AppendAllText(${psQuote(retryMarker)},('invoked'+[Environment]::NewLine))\n$global:LASTEXITCODE=0\n`);
      const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
      git('init'); git('config', 'user.email', 'evidence@example.invalid'); git('config', 'user.name', 'Evidence Test'); git('add', '.'); git('commit', '-m', 'snapshot source fixture');
      const head = git('rev-parse', 'HEAD'); const tree = git('rev-parse', 'HEAD^{tree}');

      let installerSource = read('evidence1-host-elevated-runner-install.ps1')
        .replace('#Requires -RunAsAdministrator', '# fixture exercises production copy/hash/closed-set logic without elevation');
      installerSource = replacePsFunction(installerSource, 'Set-E1InstallProtectedAcl', 'function Set-E1InstallProtectedAcl { param([string]$Path,[string]$PrincipalSid,[bool]$Directory) }');
      installerSource = replacePsFunction(installerSource, 'Assert-E1InstallProtectedAcl', 'function Assert-E1InstallProtectedAcl { param([string]$Path,[string]$PrincipalSid,[bool]$Directory) }');
      installerSource = installerSource.replace(/\$actionArgs = [\s\S]*?Register-ScheduledTask[^\r\n]*\r?\nSet-E1InstallTaskRunAcl[^\r\n]*/, '$task = [pscustomobject]@{ fixture = $true }');
      const installer = join(root, 'installer.ps1'); writeFileSync(installer, installerSource);
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installer,
        '-TaskName', 'Evidence1SnapshotFixture', '-RunnerPath', join(audits, 'evidence1-host-elevated-runner.ps1'),
        '-QueueRoot', queue, '-AllowedRoot', audits, '-ReportPath', report], { windowsHide: true, env: { ...process.env, PROGRAMDATA: programData } });
      const installed = JSON.parse(readFileSync(report, 'utf8').replace(/^\uFEFF/, ''));
      expect(installed.verdict).toBe('PASS');
      deployed = installed.allowed_root; const manifest = JSON.parse(readFileSync(join(deployed, 'evidence1-host-elevated-runner-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
      expect(manifest.schema).toBe(2);
      expect(manifest.source_git_commit).toBe(head);
      expect(manifest.support_files.map((entry) => entry.name).sort()).toEqual([...support].sort());
      for (const entry of [...manifest.scripts, ...manifest.support_files]) expect(hash(readFileSync(join(deployed, entry.name)))).toBe(entry.sha256);
      expect(manifest.node_files.map((entry) => entry.name).sort()).toEqual([...nodeFiles].sort());
      for (const entry of manifest.node_files) {
        expect(hash(readFileSync(join(deployed, 'node-runtime', ...entry.name.split('/'))))).toBe(entry.sha256);
        expect(entry.blob_oid).toBe(git('rev-parse', `HEAD:${entry.name}`));
      }

      const offlineEntrypoint = join(deployed, 'evidence1-host-apply-canonical-windows-offline.ps1');
      const inputLock = join(root, 'offline-input-lock.json'); const credential = join(root, 'offline-credential.clixml'); const inspection = join(root, 'offline-inspection.json');
      writeFileSync(inputLock, '{}'); writeFileSync(credential, 'fixture'); writeFileSync(inspection, '{}');
      for (const executable of ['powershell.exe', 'pwsh.exe']) {
        const receipt = join(root, `offline-${executable}.receipt.json`);
        await execFileAsync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', offlineEntrypoint,
          '-InputLockPath', inputLock, '-GuestCredentialPath', credential, '-CreatedInspectionReceiptPath', inspection,
          '-ReceiptPath', receipt, '-TimeoutSeconds', '900', '-AuthorizationPhrase', 'authorize exactly one evidence1 e2e windows offline apply'], { windowsHide: true });
        expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual({ verdict: 'PASS', fixture: true });
        const createReceipt = join(root, `create-${executable}.receipt.json`);
        await execFileAsync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(deployed, 'evidence1-host-create-canonical-windows-vm.ps1'),
          '-Mode', 'InspectCreated', '-InputLockPath', inputLock, '-ReceiptPath', createReceipt], { windowsHide: true });
        expect(JSON.parse(readFileSync(createReceipt, 'utf8'))).toEqual({ verdict: 'PASS', fixture: true });
        await execFileAsync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(deployed, 'evidence1-host-install-canonical-windows-unattended.ps1'),
          '-InputLockPath', inputLock, '-GuestCredentialPath', join(root, 'recovery-credential.clixml'), '-AnswerMediaPath', join(root, 'recovery-answer.iso'),
          '-ReceiptPath', join(root, `recovery-${executable}.receipt.json`), '-RecoveryOnly', '-RecoveryReasonCode', 'elevated_runner_child_failure',
          '-AuthorizationPhrase', 'authorize install evidence1 e2e windows unattended offline'], { windowsHide: true });
        await execFileAsync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(deployed, 'evidence1-host-new-unattended-retry-custody.ps1'),
          '-InputLockPath', inputLock, '-PriorInputLockPath', inputLock, '-PriorFailureReceiptPath', inspection,
          '-CreatedInspectionReceiptPath', inspection, '-RunnerRequestId', `fixture-${executable}`, '-GuestCredentialPath', credential,
          '-PriorAnswerMediaPath', join(root, 'prior-answer.iso')], { windowsHide: true });
      }
      expect(readFileSync(createMarker, 'utf8').trim().split(/\r?\n/)).toHaveLength(2);
      expect(readFileSync(installMarker, 'utf8').trim().split(/\r?\n/)).toHaveLength(2);
      expect(readFileSync(retryMarker, 'utf8').trim().split(/\r?\n/)).toHaveLength(2);
      writeFileSync(join(deployed, 'node-runtime', 'tools', 'evidence1', 'provisioning', 'evidence1-apply-windows-offline.ps1'), '# tampered fixture\n');
      const blockedReceipt = join(root, 'offline-tamper.receipt.json');
      const blocked = await execFileAsyncNoThrow('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', offlineEntrypoint,
        '-InputLockPath', inputLock, '-GuestCredentialPath', credential, '-CreatedInspectionReceiptPath', inspection,
        '-ReceiptPath', blockedReceipt, '-TimeoutSeconds', '900', '-AuthorizationPhrase', 'authorize exactly one evidence1 e2e windows offline apply'], { encoding: 'utf8', windowsHide: true });
      expect(blocked.status).not.toBe(0);
      expect(existsSync(blockedReceipt)).toBe(false);
      writeFileSync(join(deployed, 'node-runtime', 'tools', 'evidence1', 'provisioning', 'evidence1-apply-windows-offline.ps1'), offlineStub);

      const wrapperTamperCases = [
        {
          implementation: 'evidence1-windows-vm.ps1', entrypoint: 'evidence1-host-create-canonical-windows-vm.ps1', marker: createMarker,
          args: ['-Mode', 'InspectCreated', '-InputLockPath', inputLock, '-ReceiptPath', join(root, 'create-tamper.receipt.json')],
        },
        {
          implementation: 'evidence1-install-windows-unattended.ps1', entrypoint: 'evidence1-host-install-canonical-windows-unattended.ps1', marker: installMarker,
          args: ['-InputLockPath', inputLock, '-GuestCredentialPath', credential, '-AnswerMediaPath', join(root, 'tamper-answer.iso'), '-ReceiptPath', join(root, 'install-tamper.receipt.json'), '-RecoveryOnly', '-RecoveryReasonCode', 'elevated_runner_child_failure', '-AuthorizationPhrase', 'authorize install evidence1 e2e windows unattended offline'],
        },
        {
          implementation: 'evidence1-new-unattended-retry-custody.ps1', entrypoint: 'evidence1-host-new-unattended-retry-custody.ps1', marker: retryMarker,
          args: ['-InputLockPath', inputLock, '-PriorInputLockPath', inputLock, '-PriorFailureReceiptPath', inspection, '-CreatedInspectionReceiptPath', inspection, '-RunnerRequestId', 'tamper-fixture', '-GuestCredentialPath', credential, '-PriorAnswerMediaPath', join(root, 'prior-tamper-answer.iso')],
        },
      ];
      for (const testCase of wrapperTamperCases) {
        const implementation = join(deployed, 'node-runtime', 'tools', 'evidence1', 'provisioning', testCase.implementation);
        const original = readFileSync(implementation);
        writeFileSync(implementation, '# tampered fixture\n');
        const rejected = await execFileAsyncNoThrow('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(deployed, testCase.entrypoint), ...testCase.args], { encoding: 'utf8', windowsHide: true });
        expect(rejected.status, `${testCase.entrypoint}: ${rejected.stderr}`).not.toBe(0);
        expect(readFileSync(testCase.marker, 'utf8').trim().split(/\r?\n/)).toHaveLength(2);
        writeFileSync(implementation, original);
      }

      const entrypoints = ['evidence1-hyperv-place-final-codex.ps1', 'evidence1-hyperv-start-final-codex.ps1', 'evidence1-hyperv-copy-final-codex.ps1'];
      const dependencyPreflight = `function H([string]$p){$s=[IO.File]::OpenRead($p);try{$h=[Security.Cryptography.SHA256]::Create();try{return([BitConverter]::ToString($h.ComputeHash($s))-replace'-','').ToLowerInvariant()}finally{$h.Dispose()}}finally{$s.Dispose()}};$deployed=${psQuote(deployed)};$manifest=Get-Content -LiteralPath (Join-Path $deployed 'evidence1-host-elevated-runner-manifest.json') -Raw|ConvertFrom-Json;$hashes=@{};foreach($entry in @($manifest.scripts)+@($manifest.support_files)){$hashes[[string]$entry.name]=[string]$entry.sha256};$dependencyMap=@{${psQuote(entrypoints[0])}=@('evidence1-final-codex-host-contract.psm1');${psQuote(entrypoints[1])}=@('evidence1-final-codex-host-contract.psm1','evidence1-live-handoff-contract.psm1');${psQuote(entrypoints[2])}=@('evidence1-final-codex-copy-contract.psm1','evidence1-validation-ops.psm1','evidence1-final-codex-host-contract.psm1')};$imports=0;$parseErrors=0;foreach($name in @(${entrypoints.map(psQuote).join(',')})){$path=Join-Path $deployed $name;$tokens=$null;$errors=$null;$null=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors);$parseErrors+=$errors.Count;foreach($leaf in @($dependencyMap[$name])){$dependency=Join-Path $deployed $leaf;if(-not(Test-Path -LiteralPath $dependency -PathType Leaf)){throw 'snapshot_dependency_missing'};$actual=H $dependency;if($actual-cne$hashes[$leaf]){throw 'snapshot_dependency_hash_mismatch'};Import-Module $dependency -Force -DisableNameChecking;$imports++}};$canonical=Assert-E1FinalCanonicalRepository ${psQuote(repo)} ${psQuote(head)} ${psQuote(tree)};@{parse_errors=$parseErrors;imports=$imports;canonical=$canonical;entrypoints=3}|ConvertTo-Json -Compress`;
      const compatibleDependencyPreflight = dependencyPreflight
        .replace('function H([string]$p){', 'function Get-TestSha { param([string]$p) ')
        .replace('$dependencyMap=@{', "$hashes['evidence1-validation-ops.psm1']=$manifest.process_module_sha256;$dependencyMap=@{")
        .replace('$actual=H $dependency', '$actual=Get-TestSha $dependency');
      for (const executable of ['powershell.exe', 'pwsh.exe']) {
        expect(await psJsonAsync(compatibleDependencyPreflight, executable)).toEqual({ parse_errors: 0, imports: 6, canonical: repo, entrypoints: 3 });
      }
      const stagedPilot = join(deployed, 'node-runtime', 'docs', 'audits', 'evidence1-codex-pilot-describe.mjs');
      const stagedScan = join(deployed, 'node-runtime', 'docs', 'audits', 'evidence1-codex-publication-scan.mjs');
      expect(JSON.parse((await execFileAsync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL(`file:///${stagedPilot.replaceAll('\\', '/')}`).href)})`], { encoding: 'utf8' })).stdout || '{}')).toEqual({});
      const clean = Array.from({ length: 8 }, (_, i) => join(root, `clean-${i}.json`)); clean.forEach((path, i) => writeFileSync(path, JSON.stringify({ schema: 1, value: i })));
      const scanResult = await execFileAsync(process.execPath, [stagedScan, ...clean.flatMap((path) => ['--file', path])], { encoding: 'utf8' });
      expect(JSON.parse(scanResult.stdout).files_scanned).toBe(8);
    } finally {
      if (deployed && /^C:\\ProgramData\\KmpEval\\Evidence1ElevatedRunner\\Evidence1SnapshotFixture-[0-9a-f]{64}-[0-9a-f]{32}$/i.test(deployed)) rmSync(deployed, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  // Proves execFileAsync (the helper the test above now uses throughout) genuinely doesn't block
  // the worker's event loop, the same way evidence1-validation-ops.test.js:130 proves it for its
  // own ps() helper: a 25ms JS timer only gets a chance to fire during the awaited 150ms subprocess
  // call if the event loop stays free while that call is in flight. A synchronous equivalent
  // (execFileSync) would freeze the whole process for the call's duration, and the timer would
  // never be observed as fired by the time this checks it.
  it.skipIf(process.platform !== 'win32')('keeps the worker event loop responsive while a PowerShell subprocess executes', async () => {
    let timerObserved = false;
    const timer = setTimeout(() => { timerObserved = true; }, 25);
    try {
      const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Milliseconds 150; Write-Output done'], { encoding: 'utf8', windowsHide: true });
      expect(result.stdout.trim()).toBe('done');
      expect(timerObserved).toBe(true);
    } finally { clearTimeout(timer); }
  });

  it.skipIf(process.platform !== 'win32')('rejects a weak elevated deployment DACL using the production validator', () => {
    const fn = extractPsFunction(read('evidence1-host-elevated-runner.ps1'), 'Assert-E1RunnerProtectedAcl');
    const result = psJson(`${fn};$sid='S-1-5-21-1-2-3-4';$admin=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544');$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18');$user=[Security.Principal.SecurityIdentifier]::new($sid);function New-TestAcl([bool]$weak){$a=[Security.AccessControl.DirectorySecurity]::new();$a.SetOwner($admin);$a.SetAccessRuleProtection((-not$weak),$false);$i=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit';foreach($pair in @(@($system,[Security.AccessControl.FileSystemRights]::FullControl),@($admin,[Security.AccessControl.FileSystemRights]::FullControl),@($user,[Security.AccessControl.FileSystemRights]::ReadAndExecute))){$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($pair[0],$pair[1],$i,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))|Out-Null};return $a};$script:fake=New-TestAcl $false;function Get-Acl{return $script:fake};$valid=$false;try{Assert-E1RunnerProtectedAcl 'fixture' $sid $true;$valid=$true}catch{};$script:fake=New-TestAcl $true;$weakBlocked=$false;try{Assert-E1RunnerProtectedAcl 'fixture' $sid $true}catch{$weakBlocked=$_.Exception.Message-ceq'elevated_runner_deployment_acl_invalid'};@{valid=$valid;weak_blocked=$weakBlocked}|ConvertTo-Json -Compress`);
    expect(result).toEqual({ valid: true, weak_blocked: true });
  });

  it('passes absolute node-runtime directory paths to the deployment ACL validator', () => {
    const runner = read('evidence1-host-elevated-runner.ps1');
    expect(runner).toContain("Get-ChildItem -LiteralPath $nodeRoot -Directory -Force -Recurse | ForEach-Object { $_.FullName }");
    expect(runner).not.toContain('Assert-E1RunnerProtectedAcl ([string]$directory)');
  });

  it.skipIf(process.platform !== 'win32')('uses a fresh unpredictable deployment root instead of a preseedable deterministic path', () => {
    const fn = extractPsFunction(read('evidence1-host-elevated-runner-install.ps1'), 'New-E1InstallDeploymentRoot');
    const sha = 'a'.repeat(64); const base = 'C:\\ProgramData\\KmpEval\\Evidence1ElevatedRunner';
    const result = psJson(`function Fail([string]$Message){throw $Message};${fn};$one=New-E1InstallDeploymentRoot ${psQuote(base)} 'Evidence1CodexElevatedRunner' '${sha}';$two=New-E1InstallDeploymentRoot ${psQuote(base)} 'Evidence1CodexElevatedRunner' '${sha}';$preseed=Join-Path ${psQuote(base)} ('Evidence1CodexElevatedRunner-'+'${sha}');@{distinct=$one-cne$two;avoids_preseed=$one-cne$preseed-and$two-cne$preseed;shape=$one-cmatch'[0-9a-f]{32}$'-and$two-cmatch'[0-9a-f]{32}$'}|ConvertTo-Json -Compress`);
    expect(result).toEqual({ distinct: true, avoids_preseed: true, shape: true });
  });

  it.skipIf(process.platform !== 'win32')('bounds the pinned runner blob before parsing and reaps the Git producer', () => {
    const root = mkdtempSync('C:\\kmp-eval\\scratch\\e1-runner-blob-bound-');
    try {
      const repo = join(root, 'repo'); const audits = join(repo, 'docs', 'audits'); mkdirSync(audits, { recursive: true });
      writeFileSync(join(audits, 'evidence1-host-elevated-runner.ps1'), `#${'x'.repeat(1_048_576)}\n`);
      writeFileSync(join(audits, 'evidence1-validation-ops.psm1'), '');
      const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
      git('init'); git('config', 'user.email', 'evidence@example.invalid'); git('config', 'user.name', 'Evidence Test'); git('add', '.'); git('commit', '-m', 'oversize runner fixture');
      const installer = join(root, 'installer.ps1');
      writeFileSync(installer, read('evidence1-host-elevated-runner-install.ps1').replace('#Requires -RunAsAdministrator', '# fixture validates the pre-elevation blob bound'));
      const report = join(root, 'oversize-report.json');
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installer,
        '-TaskName', 'Evidence1OversizeFixture', '-RunnerPath', join(audits, 'evidence1-host-elevated-runner.ps1'),
        '-QueueRoot', join(root, 'queue'), '-AllowedRoot', audits, '-ReportPath', report], { encoding: 'utf8', windowsHide: true });
      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain('canonical runner blob exceeds parse bound');
      expect(existsSync(report)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it('pins every trusted tree lookup to the single captured source commit', () => {
    const installer = read('evidence1-host-elevated-runner-install.ps1');
    const captured = installer.slice(installer.indexOf('$sourceGitCommit='));
    expect(captured).toContain('[Management.Automation.Language.Parser]::ParseInput($runnerSourceText');
    expect(captured).not.toContain('::ParseFile($RunnerPath');
    expect(captured.indexOf('$runnerSourceText=Get-E1InstallGitBlobText')).toBeLessThan(captured.indexOf('::ParseInput($runnerSourceText'));
    expect(captured).toContain('"${sourceGitCommit}:$relative"');
    expect(captured).toContain('diff --quiet $sourceGitCommit -- @trustedRepoPaths');
    expect(captured).toContain('Write-E1InstallGitBlob $git.Source $sourceRepoRoot $trustedBlobMap[$relative]');
    expect(captured).toContain('Write-E1InstallGitBlob $git.Source $sourceRepoRoot $trustedBlobMap[$name]');
    expect(captured).not.toContain('[IO.File]::Copy(');
    expect(captured).not.toContain('"HEAD:');
  });

  it.skipIf(process.platform !== 'win32').each(['powershell.exe', 'pwsh.exe'])('rejects a dirty canonical worktree under %s', (shell) => {
    // Canonical scratch root, not tmpdir(): hosted Windows runners expose TEMP through a
    // short-name alias (RUNNER~1) that these scripts' canonical-path checks reject.
    mkdirSync('C:\\kmp-eval\\scratch', { recursive: true });
    const root = mkdtempSync('C:\\kmp-eval\\scratch\\e1-final-canonical-repo-');
    try {
      const repo = join(root, 'repo'); const audits = join(repo, 'docs', 'audits'); mkdirSync(audits, { recursive: true });
      const source = read('evidence1-final-codex-host-contract.psm1').replace('C:\\kmp-eval\\agentic-eval-codex-runtime', repo);
      const modulePath = join(audits, 'evidence1-final-codex-host-contract.psm1'); writeFileSync(modulePath, source); writeFileSync(join(repo, 'anchor.txt'), 'clean');
      const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
      git('init'); git('config', 'user.email', 'evidence@example.invalid'); git('config', 'user.name', 'Evidence Test'); git('add', '.'); git('commit', '-m', 'test fixture');
      const head = git('rev-parse', 'HEAD'); const tree = git('rev-parse', 'HEAD^{tree}');
      const clean = psJson(`Import-Module ${psQuote(modulePath)} -Force; $ok=$false;try{$null=Assert-E1FinalCanonicalRepository ${psQuote(repo)} ${psQuote(head)} ${psQuote(tree)};$ok=$true}catch{};@{ok=$ok}|ConvertTo-Json -Compress`, shell);
      expect(clean).toEqual({ ok: true });
      const allowed = join(repo, 'tools', 'runs', `evidence1-codex-pilot-${randomUUID()}`); mkdirSync(allowed, { recursive: true }); writeFileSync(join(allowed, 'summary.json'), '{}');
      const recoveryClean = psJson(`Import-Module ${psQuote(modulePath)} -Force; $ok=$false;try{$null=Assert-E1FinalCanonicalRepository ${psQuote(repo)} ${psQuote(head)} ${psQuote(tree)} -AllowedDirtyPaths @(${psQuote(allowed)});$ok=$true}catch{};@{ok=$ok}|ConvertTo-Json -Compress`, shell);
      expect(recoveryClean).toEqual({ ok: true });
      const unrelated = join(repo, 'unrelated.txt'); writeFileSync(unrelated, 'not allowed');
      const untrackedDirty = psJson(`Import-Module ${psQuote(modulePath)} -Force;$blocked=$false;try{$null=Assert-E1FinalCanonicalRepository ${psQuote(repo)} ${psQuote(head)} ${psQuote(tree)} -AllowedDirtyPaths @(${psQuote(allowed)})}catch{$blocked=$_.Exception.Message -ceq 'canonical_main_worktree_not_clean_or_pinned'};@{blocked=$blocked}|ConvertTo-Json -Compress`, shell);
      expect(untrackedDirty).toEqual({ blocked: true }); rmSync(unrelated);
      writeFileSync(join(repo, 'anchor.txt'), 'dirty');
      const dirty = psJson(`Import-Module ${psQuote(modulePath)} -Force; $blocked=$false;try{$null=Assert-E1FinalCanonicalRepository ${psQuote(repo)} ${psQuote(head)} ${psQuote(tree)} -AllowedDirtyPaths @(${psQuote(allowed)})}catch{$blocked=$_.Exception.Message -ceq 'canonical_main_worktree_not_clean_or_pinned'};@{blocked=$blocked}|ConvertTo-Json -Compress`, shell);
      expect(dirty).toEqual({ blocked: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32').each(['powershell.exe', 'pwsh.exe'])('rejects a coherent snapshot whose transitive dependency differs from the canonical repository under %s', (shell) => {
    const root = mkdtempSync(join(tmpdir(), 'e1-node-binding-'));
    try {
      const repo = join(root, 'repo'); const snapshot = join(root, 'snapshot'); const relative = 'tools/agentic-eval/schemas.mjs';
      const repoFile = join(repo, ...relative.split('/')); const snapshotFile = join(snapshot, ...relative.split('/'));
      mkdirSync(dirname(repoFile), { recursive: true }); mkdirSync(dirname(snapshotFile), { recursive: true });
      writeFileSync(repoFile, 'canonical\n'); writeFileSync(snapshotFile, 'canonical\n');
      const manifestPath = join(root, 'manifest.json'); writeFileSync(manifestPath, JSON.stringify({ node_files: [{ name: relative, sha256: hash(readFileSync(snapshotFile)) }] }));
      const modulePath = resolve(process.cwd(), 'docs/audits/evidence1-final-codex-host-contract.psm1');
      const result = psJson(`Import-Module ${psQuote(modulePath)} -Force;$m=Get-Content -LiteralPath ${psQuote(manifestPath)} -Raw|ConvertFrom-Json;$good=$false;try{$map=Assert-E1FinalNodeSnapshotBinding $m ${psQuote(snapshot)} ${psQuote(repo)};$good=$map.Count-eq 1}catch{};[IO.File]::WriteAllText(${psQuote(repoFile)},'different');$blocked=$false;try{$null=Assert-E1FinalNodeSnapshotBinding $m ${psQuote(snapshot)} ${psQuote(repo)}}catch{$blocked=$_.Exception.Message-ceq'snapshot_node_not_bound_to_canonical_repository'};@{good=$good;blocked=$blocked}|ConvertTo-Json -Compress`, shell);
      expect(result).toEqual({ good: true, blocked: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32').each(['powershell.exe', 'pwsh.exe'])('accepts historical v1 and sealed v2 runner manifests but rejects malformed v2 blobs under %s', (shell) => {
    const base = { kind: 'evidence1-host-elevated-runner-manifest', principal_sid: 'S-1-5-21-1-2-3-4', runner_sha256: 'a'.repeat(64), process_module_sha256: 'b'.repeat(64), scripts: [], support_files: [] };
    const v1 = { schema: 1, ...base, node_files: [{ name: 'tools/example.mjs', sha256: 'c'.repeat(64) }] };
    const v2 = { schema: 2, ...base, source_git_commit: 'd'.repeat(40), node_files: [{ name: 'tools/example.mjs', sha256: 'c'.repeat(64), blob_oid: 'e'.repeat(40) }] };
    const bad = structuredClone(v2); bad.node_files[0].blob_oid = 'invalid';
    const modulePath = resolve(process.cwd(), 'docs/audits/evidence1-final-codex-host-contract.psm1');
    const result = psJson(`Import-Module ${psQuote(modulePath)} -Force;$v1=${psQuote(JSON.stringify(v1))}|ConvertFrom-Json;$v2=${psQuote(JSON.stringify(v2))}|ConvertFrom-Json;$bad=${psQuote(JSON.stringify(bad))}|ConvertFrom-Json;$one=$false;$two=$false;$blocked=$false;$historicalLiveBlocked=$false;$otherRevisionBlocked=$false;try{$one=Assert-E1FinalRunnerManifest $v1}catch{};try{$two=Assert-E1FinalRunnerManifest $v2}catch{};try{$null=Assert-E1FinalRunnerManifest $bad}catch{$blocked=$_.Exception.Message-ceq'snapshot_node_manifest_invalid'};try{$null=Assert-E1FinalRunnerManifest $v1 ('d'*40)}catch{$historicalLiveBlocked=$_.Exception.Message-ceq'snapshot_source_commit_mismatch'};try{$null=Assert-E1FinalRunnerManifest $v2 ('f'*40)}catch{$otherRevisionBlocked=$_.Exception.Message-ceq'snapshot_source_commit_mismatch'};@{v1=$one;v2=$two;bad_blob_blocked=$blocked;historical_live_blocked=$historicalLiveBlocked;other_revision_blocked=$otherRevisionBlocked}|ConvertTo-Json -Compress`, shell);
    expect(result).toEqual({ v1: true, v2: true, bad_blob_blocked: true, historical_live_blocked: true, other_revision_blocked: true });
    expect(read('evidence1-hyperv-place-final-codex.ps1')).toContain('Assert-E1FinalRunnerManifest $snapshotManifest $binding.harness_commit');
    expect(read('evidence1-hyperv-copy-final-codex.ps1')).toContain('Assert-E1FinalRunnerManifest $snapshotManifest $HarnessCommit');
    const live = read('evidence1-codex-live-launch.ps1');
    expect(live).toContain("$manifest.schema-notin@(1,2)");
    expect(live).toContain("@('blob_oid','name','sha256')");
    expect(live).toContain('Assert-NodeRuntimeSnapshot $NodeRuntimeManifestPath $NodeRuntimeManifestSha256 $harnessSha');
  });

  it('requires fresh readiness and both remote-auth providers after NotBefore', () => {
    const script = read('evidence1-hyperv-start-final-codex.ps1');
    expect(script).toContain('Assert-Evidence1LiveHandoffEvidence');
    expect(script).toContain('Assert-Evidence1DualRemoteAuthCanary');
    expect(script).toContain('$hostAuth.remote_auth_canary');
    expect(script).toContain('guest_remote_auth_blob_does_not_match_host_wrapper');
    expect(script).toContain("-ExpectedClaudeVersion '2.1.238'");
    expect(script).toContain("-ExpectedCodexVersion '0.154.0'");
    expect(script.indexOf('Assert-Evidence1LiveHandoffEvidence')).toBeLessThan(script.indexOf('Start-VM -Name $vm.Name'));
    expect(script.indexOf('Write-E1FinalCreateNewJson $ReportPath')).toBeLessThan(script.indexOf('Start-VM -Name $vm.Name'));
    expect(script.indexOf('New-E1FinalOperationReservation -ReportPath $TerminalReportPath')).toBeLessThan(script.indexOf('Start-VM -Name $vm.Name'));
    expect(script).toContain('PlacementReportSha256');
    expect(script).toContain("throw 'placement_report_changed_before_start'");
    expect(script).toContain("throw 'final_codex_graceful_shutdown_timeout_no_copy'");
    expect(script).toContain("'evidence1-hyperv-copy-final-codex.ps1'");
    expect(script).toContain('BindingSha256=$BindingSha256');
  });

  it('derives the guest Live VM identity from the hash-bound campaign binding', () => {
    const script = read('evidence1-codex-live-launch.ps1');
    expect(script).toContain("$liveBinding = Get-Content -LiteralPath $CampaignBindingPath -Raw | ConvertFrom-Json -ErrorAction Stop");
    expect(script).toContain("$boundVmName = [string]$liveBinding.vm_name");
    expect(script).toContain("$boundVmId = ([string]$liveBinding.vm_id).ToLowerInvariant()");
    expect(script).not.toContain('$boundVmName=[string]$readiness.vm_name');
    expect(script.indexOf('$liveBinding = Get-Content')).toBeLessThan(script.indexOf("$actualVmId = [string](Get-ItemPropertyValue"));
  });

  it('can retire this exact zero-session guest-readiness binding failure', () => {
    const script = read('evidence1-hyperv-retire-preflight-failed-final-codex.ps1');
    expect(script).toContain("'readiness_vm_binding_missing_before_provider_spawn'");
    expect(script).toContain("'runtime_dependency_missing_before_provider_spawn'");
    expect(script).toContain("'offline_runtime_preflight_failed_before_provider_spawn'");
    expect(script).toContain("@('offline-runtime-preflight.json','offline-runtime-preflight.stderr.log','dry-run.stdout.json','dry-run.stderr.log')");
    expect(script).toContain("inference_sessions_consumed");
    expect(script).toContain("provider_sessions_consumed=0");
    expect(script).toContain("throw 'provider_boundary_crossed'");
    expect(script).toContain('Complete-E1FinalFileMove');
    expect(script).toContain('Copy-E1FinalVerifiedThenRemove');
    expect(script).toContain("throw 'preflight_failure_directory_state_invalid'");
    expect(script).toContain('$custodyFiles=@(if(Test-Path -LiteralPath $custody -PathType Container)');
    expect(script).toContain('$archivedCustodyFiles=@(if(Test-Path -LiteralPath $custodyArchive -PathType Container)');
    expect(read('evidence1-final-codex-host-contract.psm1')).toContain("throw 'retirement_custody_copy_hash_mismatch'");
    expect(script).not.toContain("Move-Item -LiteralPath $custody -Destination");
  });

  it('can retire a campaign that crossed the start boundary but never reached guest execution', () => {
    const script = read('evidence1-hyperv-retire-unexecuted-final-codex.ps1');
    expect(script).toContain("'host_power_loss_before_guest_execution_boundary',");
    expect(script).toContain("'guest_interactive_logon_never_observed_before_guest_execution_boundary'");
    expect(script).toContain("[string]$FailureReasonCode = 'host_power_loss_before_guest_execution_boundary'");
    expect(script).toContain('reason_code = $FailureReasonCode');
    expect(script).toContain('$requiredHostStartPaths');
    expect(script).toContain("evidence1-final-codex-start\\$campaignId.reserved.json");
    expect(script).toContain("evidence1-final-codex-start\\$campaignId.terminal.json");
    expect(script).toContain("throw 'expected_host_start_evidence_missing'");
    expect(script).toContain("throw 'campaign_copy_evidence_exists'");
    expect(script).toContain("evidence1-final-codex-copy-reports\\$campaignId.reserved.json");
    expect(script).toContain("evidence1-final-codex-copy-journals\\$campaignId");
    expect(script).toContain("evidence1-final-codex-private\\$campaignId");
    expect(script).toContain("tools\\runs\\evidence1-codex-pilot-$campaignId");
    expect(script).toContain("throw 'guest_execution_boundary_evidence_exists'");
    expect(script).toContain("Join-Path $runDir 'group.claim.json'");
    expect(script).toContain("Join-Path $runDir 'slots'");
    expect(script).toContain("provider_sessions_consumed = 0");
    expect(script).toContain('start_reservation_present = $true');
    expect(script).toContain('guest_execution_boundary_crossed = $false');
    expect(script).toContain("throw 'guest_campaign_archive_already_exists'");
    expect(script).toContain("throw 'partial_placement_state_missing'");
    expect(script).toContain("throw 'guest_startup_archive_already_exists'");
    expect(script).toContain('Evidence1FinalCodex.vbs');
    expect(script).toContain("Assert-Hash $archivedGlobalClaim $GlobalAuthorizationClaimSha256 'archived_global_claim_hash_mismatch'");
    expect(script).not.toContain("throw 'campaign_start_or_copy_evidence_exists'");
  });

  it.skipIf(process.platform !== 'win32')('resumes verified retirement file transfers without overwriting evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'e1-final-retirement-files-'));
    try {
      const source = join(root, 'source.json'); const destination = join(root, 'destination.json');
      const moveSource = join(root, 'move-source.json'); const moveDestination = join(root, 'move-destination.json');
      writeFileSync(source, 'receipt'); writeFileSync(moveSource, 'terminal');
      const modulePath = resolve(process.cwd(), 'docs/audits/evidence1-final-codex-host-contract.psm1');
      const result = psJson(`Import-Module ${psQuote(modulePath)} -Force;Copy-E1FinalVerifiedThenRemove ${psQuote(source)} ${psQuote(destination)};[IO.File]::WriteAllText(${psQuote(source)},'receipt');Copy-E1FinalVerifiedThenRemove ${psQuote(source)} ${psQuote(destination)};Complete-E1FinalFileMove ${psQuote(moveSource)} ${psQuote(moveDestination)} $true;Complete-E1FinalFileMove ${psQuote(moveSource)} ${psQuote(moveDestination)} $true;[IO.File]::WriteAllText(${psQuote(moveSource)},'collision');$collision=$false;try{Complete-E1FinalFileMove ${psQuote(moveSource)} ${psQuote(moveDestination)} $true}catch{$collision=$_.Exception.Message-ceq'retirement_split_file_state'};@{source=(Test-Path ${psQuote(source)});destination=[IO.File]::ReadAllText(${psQuote(destination)});move_source=(Test-Path ${psQuote(moveSource)});move_destination=[IO.File]::ReadAllText(${psQuote(moveDestination)});collision=$collision}|ConvertTo-Json -Compress`);
      expect(result).toEqual({ source: false, destination: 'receipt', move_source: true, move_destination: 'terminal', collision: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('copies only bounded allowlisted zero-session pre-provider evidence', () => {
    const script = read('evidence1-hyperv-copy-final-codex-preflight-diagnostic.ps1');
    expect(script).toContain("'offline-runtime-preflight.json','offline-runtime-preflight.stderr.log'");
    expect(script).toContain("'dry-run.stdout.json','dry-run.stderr.log'");
    expect(script).toContain("throw 'preflight_diagnostic_file_invalid'");
    expect(script).toContain('[long]$file.Length-gt 1048576');
    expect(script).toContain("inference_sessions_consumed");
    expect(script).toContain('provider_sessions_consumed=0');
    expect(script).toContain("throw 'provider_boundary_crossed_not_preflight_only'");
  });

  it('contains the guest process tree in a kill-on-close Job Object with a hard timeout', () => {
    const script = read('evidence1-final-codex-guest-wrapper.ps1');
    expect(script).toContain('Invoke-E1OwnedProcess');
    expect(script).toContain('PROC_THREAD_ATTRIBUTE_JOB_LIST');
    expect(script).not.toContain('.ArgumentList');
    expect(script).not.toContain('Start-Process');
    expect(script).toContain("$reason='timeout_job_tree_terminated'");
    expect(script).toContain("throw 'run_terminal_or_claim_already_exists_no_respawn'");
    expect(script).toContain('publication_manifest_sha256');
    expect(script).toContain('campaign_custody_sha256');
    expect(script).toContain('shutdown.exe');
    expect(script.indexOf('$s.Flush($true)')).toBeLessThan(script.indexOf('shutdown.exe'));
    expect(script).toContain('evidence1-final-codex-terminal-claim');
    expect(script).toContain('terminal_claim_sha256');
    expect(script).toContain('Assert-E1WrapperRuntimePath');
    expect(script.indexOf('Assert-E1WrapperRuntimePath $runtimePath')).toBeLessThan(script.indexOf('$terminalClaimStream='));
    expect(script.indexOf('$terminalClaimStream=')).toBeLessThan(script.indexOf("$result=Invoke-E1OwnedProcess"));
    expect(script.indexOf('Import-Module $validationModule')).toBeLessThan(script.indexOf('$terminalClaimStream='));
  });

  it.skipIf(process.platform !== 'win32')('durably claims the guest terminal before provider invocation and burns a crash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'e1-final-terminal-crash-'));
    try {
      const fixture = writeGuestWrapperFixture(root); const claim = join(fixture.ops, `${fixture.runId}.terminal.claim.json`); const terminal = join(fixture.ops, `${fixture.runId}.terminal.json`);
      const child = spawn('powershell.exe', fixture.args, { windowsHide: true, stdio: 'ignore' }); const deadline = Date.now() + 15_000;
      while ((!existsSync(claim) || !existsSync(fixture.invokeMarker)) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
      expect(existsSync(claim), existsSync(fixture.errorMarker) ? readFileSync(fixture.errorMarker, 'utf8') : `claim missing; terminal=${existsSync(terminal)}`).toBe(true); expect(existsSync(fixture.invokeMarker), existsSync(fixture.errorMarker) ? readFileSync(fixture.errorMarker, 'utf8') : `invoke marker missing; terminal=${existsSync(terminal)}`).toBe(true); child.kill(); await new Promise((done) => child.once('exit', done));
      expect(existsSync(terminal)).toBe(false);
      try { execFileSync('powershell.exe', fixture.args, { windowsHide: true, stdio: 'ignore' }); } catch {}
      expect(readFileSync(fixture.invokeMarker, 'utf8').trim().split(/\r?\n/)).toHaveLength(1);
      const value = JSON.parse(readFileSync(claim, 'utf8')); expect(value).toMatchObject({ kind: 'evidence1-final-codex-terminal-claim', run_id: fixture.runId, retry_count: 0, replacement_or_respawn_authorized: false });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 40_000);

  it.skipIf(process.platform !== 'win32')('refuses a colliding guest terminal claim without invoking the provider', async () => {
    const root = mkdtempSync(join(tmpdir(), 'e1-final-terminal-collision-'));
    try {
      const fixture = writeGuestWrapperFixture(root); const claim = join(fixture.ops, `${fixture.runId}.terminal.claim.json`); writeFileSync(claim, '{}');
      const child = spawn('powershell.exe', fixture.args, { windowsHide: true, stdio: 'ignore' }); await new Promise((done) => child.once('exit', done));
      expect(existsSync(fixture.invokeMarker)).toBe(false); expect(existsSync(join(fixture.ops, `${fixture.runId}.terminal.json`))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 40_000);

  it.skipIf(process.platform !== 'win32')('uses the PS5.1-compatible atomic Job List helper and cleans a detached descendant', () => {
    const root = mkdtempSync(join(tmpdir(), 'e1-final-wrapper-job-'));
    const fixture = join(root, 'fixture.cjs');
    writeFileSync(fixture, `const {spawn}=require('node:child_process');\nconst child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); child.unref(); process.stdout.write(String(child.pid)); process.exit(1);\n`);
    try {
      const modulePath = resolve(process.cwd(), 'docs/audits/evidence1-validation-ops.psm1');
      const stdout = join(root, 'stdout.txt'); const stderr = join(root, 'stderr.txt');
      const result = psJson(`Import-Module ${psQuote(modulePath)} -Force -DisableNameChecking; $r=Invoke-E1OwnedProcess ${psQuote(process.execPath)} @(${psQuote(fixture)}) ${psQuote(root)} ${psQuote(stdout)} ${psQuote(stderr)} 10; $pidValue=[int]([IO.File]::ReadAllText(${psQuote(stdout)})); @{ exit_code=$r.ExitCode; timed_out=$r.TimedOut; cleanup_ok=$r.CleanupOk; child_alive=($null -ne (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) } | ConvertTo-Json -Compress`, 'powershell.exe');
      expect(result).toEqual({ exit_code: 1, timed_out: false, cleanup_ok: true, child_alive: false });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 40_000);

  it('copies custody privately and exposes a closed eight-file public set without sidecars/raw', () => {
    const script = read('evidence1-hyperv-copy-final-codex.ps1');
    expect(script).toContain("$privateRoot = 'C:\\kmp-eval\\scratch\\evidence1-final-codex-private'");
    expect(script).toContain("$publicRoot = 'C:\\kmp-eval\\agentic-eval-codex-runtime\\tools\\runs'");
    expect(script).toContain('Assert-E1NoReparseTree');
    expect(script).toContain('Complete-E1TwoDirectoryTransaction');
    expect(script).toContain('Validate the complete guest closed set before either host staging directory exists');
    expect(script).toContain("raw_published=$false");
    expect(script).toContain("sidecars_published=$false");
    expect(script).toContain("private_custody_outside_repo=$true");
    expect(script).toContain("Assert-PublicClosedSet $guestPublic $manifest $manifestSha256 'guest_public'");
    expect(script).toContain("Assert-PublicClosedSet $publicStage $manifest $manifestSha256 'copied_public'");
    expect(script).toContain("throw 'terminal_custody_hash_mismatch'");
    expect(script).toContain("throw 'publication_manifest_record_invalid'");
    expect(script).toContain('Assert-E1FinalNodeSnapshotBinding $snapshotManifest');
    expect(script.indexOf('Assert-E1FinalNodeSnapshotBinding $snapshotManifest')).toBeLessThan(script.indexOf('Write-E1FinalCreateNewJson $ReportPath'));
    expect(script.indexOf('Write-E1FinalCreateNewJson $ReportPath')).toBeLessThan(script.indexOf('$vm = Get-VM'));
    expect(script).toContain('-JournalPath $JournalPath');
    expect(script).toContain('Invoke-E1TwoDirectoryRecovery');
    expect(script).toContain('Assert-E1CopyRecoveryReservation');
    expect(script).toContain('Assert-E1CopyCompletionReport');
    expect(script).toContain('RecoveryReservationSha256');
    expect(script).toContain('Assert-E1GuestTerminalChain');
    expect(script).toContain('-ExpectedBindingSha256 $BindingSha256');
    expect(script).toContain('binding_sha256=$BindingSha256');
    const copyContract = read('evidence1-final-codex-copy-contract.psm1');
    expect(copyContract).toContain("throw 'campaign_custody_group_claim_hash_mismatch'");
    expect(copyContract).toContain("throw 'campaign_custody_slot_claim_hash_mismatch'");
    expect(script).toContain("throw 'campaign_custody_artifact_hash_mismatch'");
    expect(script).toContain("$claimStage=Join-Path $privateStage 'operational-claims'");
    const launcher = read('evidence1-codex-live-launch.ps1');
    expect(launcher).toContain("kind = 'evidence1-final-codex-publication-manifest'; campaign_id = $binding.campaign_id; binding_sha256 = $CampaignBindingSha256");
    expect(launcher).toContain("Copy-Item -LiteralPath (Join-Path $custodyFull 'publication-manifest.json') -Destination (Join-Path $stage 'manifest.json')");
    expect(script).toContain("@($terminalClaimPath,'guest-terminal.claim.json')");
  });

  it.skipIf(process.platform !== 'win32')('recovers after the publisher process is killed between no-replace renames', async () => {
    const root = mkdtempSync(join(tmpdir(), 'e1-final-copy-txn-'));
    try {
      const privateOut = join(root, 'private.out'); const publicOut = join(root, 'public.out'); const privateStage = `${privateOut}.staging-${'a'.repeat(32)}`; const publicStage = `${publicOut}.staging-${'b'.repeat(32)}`; const journal = join(root, 'txn'); const signal = join(root, 'paused.json');
      mkdirSync(privateStage); mkdirSync(publicStage); writeFileSync(join(privateStage, 'a'), 'a'); writeFileSync(join(publicStage, 'b'), 'b');
      const modulePath = resolve(process.cwd(), 'docs/audits/evidence1-final-codex-copy-contract.psm1');
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `Import-Module ${psQuote(modulePath)} -Force; Complete-E1TwoDirectoryTransaction -PrivateStage ${psQuote(privateStage)} -PrivateDestination ${psQuote(privateOut)} -PublicStage ${psQuote(publicStage)} -PublicDestination ${psQuote(publicOut)} -JournalPath ${psQuote(journal)} -TestPauseAfterPrivateRenamePath ${psQuote(signal)} | Out-Null`], { windowsHide: true, stdio: 'ignore' });
      const deadline = Date.now() + 15_000;
      while (!existsSync(signal) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
      expect(existsSync(signal)).toBe(true); child.kill(); await new Promise((done) => child.once('exit', done));
      const result = psJson(`Import-Module ${psQuote(modulePath)} -Force; $r=Invoke-E1TwoDirectoryRecovery -JournalPath ${psQuote(journal)} -ExpectedPrivateDestination ${psQuote(privateOut)} -ExpectedPublicDestination ${psQuote(publicOut)}; @{state=$r.state;private_out=(Test-Path ${psQuote(privateOut)});public_out=(Test-Path ${psQuote(publicOut)});private_stage=(Test-Path ${psQuote(privateStage)});public_stage=(Test-Path ${psQuote(publicStage)});complete=(Test-Path ${psQuote(`${journal}.complete.json`)});private_marker=(Test-Path ${psQuote(join(privateOut, '.evidence1-copy-transaction.json'))});public_marker=(Test-Path ${psQuote(join(publicOut, '.evidence1-copy-transaction.json'))})}|ConvertTo-Json -Compress`);
      expect(result).toEqual({ state: 'complete', private_out: true, public_out: true, private_stage: false, public_stage: false, complete: true, private_marker: false, public_marker: false });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 40_000);

  it.skipIf(process.platform !== 'win32').each(['private', 'public'])('the real copy entrypoint recovers after a kill following the %s rename', async (rename) => {
    // Canonical scratch root, not tmpdir(): hosted Windows runners expose TEMP through a
    // short-name alias (RUNNER~1) that these scripts' canonical-path checks reject.
    mkdirSync('C:\\kmp-eval\\scratch', { recursive: true });
    const root = mkdtempSync(join('C:\\kmp-eval\\scratch', `e1-final-copy-entry-${rename}-`));
    try {
      const fixture = writeCopyRecoveryEntrypointFixture(root); const campaignId = randomUUID();
      const privateOut = join(fixture.privateRoot, campaignId); const publicOut = join(fixture.publicRoot, `evidence1-codex-pilot-${campaignId}`);
      const privateStage = `${privateOut}.staging-${'a'.repeat(32)}`; const publicStage = `${publicOut}.staging-${'b'.repeat(32)}`; const journal = join(fixture.journalRoot, campaignId); const signal = join(root, `${rename}.paused.json`);
      mkdirSync(privateStage); mkdirSync(publicStage); writeFileSync(join(privateStage, 'private.json'), '{}'); writeFileSync(join(publicStage, 'summary.json'), '{}');
      const pauseArg = rename === 'private' ? '-TestPauseAfterPrivateRenamePath' : '-TestPauseAfterPublicRenamePath';
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `Import-Module ${psQuote(fixture.module)} -Force;$null=Complete-E1TwoDirectoryTransaction -PrivateStage ${psQuote(privateStage)} -PrivateDestination ${psQuote(privateOut)} -PublicStage ${psQuote(publicStage)} -PublicDestination ${psQuote(publicOut)} -JournalPath ${psQuote(journal)} ${pauseArg} ${psQuote(signal)}`], { windowsHide: true, stdio: 'ignore' });
      const deadline = Date.now() + 15_000; while (!existsSync(signal) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
      expect(existsSync(signal)).toBe(true); child.kill(); await new Promise((done) => child.once('exit', done));
      const report = join(fixture.reportRoot, `${campaignId}.reserved.json`); const completion = join(fixture.reportRoot, `${campaignId}.terminal.json`); const pathHash = (value) => hash(Buffer.from(resolve(value), 'utf8'));
      const bindingSha = '9'.repeat(64); const reservation = { schema: 1, kind: 'evidence1-final-codex-copy-reservation', campaign_id: campaignId, harness_commit: fixture.head, harness_tree: fixture.tree, binding_sha256: bindingSha, private_destination_sha256: pathHash(privateOut), public_destination_sha256: pathHash(publicOut), journal_path_sha256: pathHash(journal), completion_report_path_sha256: pathHash(completion), retry_count: 0, replacement_authorized: false, respawn_authorized: false, reserved_at_utc: new Date().toISOString() };
      const reservationBytes = Buffer.from(`${JSON.stringify(reservation)}\n`); writeFileSync(report, reservationBytes); const reservationSha = hash(reservationBytes);
      const result = psJson(`& ${psQuote(fixture.script)} -CampaignId ${psQuote(campaignId)} -PrivateOutDir ${psQuote(privateOut)} -PublicOutDir ${psQuote(publicOut)} -ReportPath ${psQuote(report)} -CompletionReportPath ${psQuote(completion)} -JournalPath ${psQuote(journal)} -HarnessCommit ${psQuote(fixture.head)} -HarnessTree ${psQuote(fixture.tree)} -BindingSha256 ${psQuote(bindingSha)} -CanonicalRepositoryRoot ${psQuote(fixture.repo)} -RecoveryReservationSha256 ${psQuote(reservationSha)} -RecoveryOnly|Out-Null;@{private=(Test-Path -LiteralPath ${psQuote(privateOut)});public=(Test-Path -LiteralPath ${psQuote(publicOut)});private_stage=(Test-Path -LiteralPath ${psQuote(privateStage)});public_stage=(Test-Path -LiteralPath ${psQuote(publicStage)});completion=(Test-Path -LiteralPath ${psQuote(completion)})}|ConvertTo-Json -Compress`);
      expect(result).toEqual({ private: true, public: true, private_stage: false, public_stage: false, completion: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);

  it.skipIf(process.platform !== 'win32').each(['powershell.exe', 'pwsh.exe'])('rejects an empty completed journal under %s', (shell) => {
    const root = mkdtempSync(join(tmpdir(), 'e1-final-copy-corrupt-complete-'));
    try {
      const privateOut = join(root, 'private.out'); const publicOut = join(root, 'public.out');
      const privateStage = `${privateOut}.staging-${'a'.repeat(32)}`; const publicStage = `${publicOut}.staging-${'b'.repeat(32)}`; const journal = join(root, 'txn');
      mkdirSync(privateStage); mkdirSync(publicStage); writeFileSync(join(privateStage, 'a'), 'a'); writeFileSync(join(publicStage, 'b'), 'b');
      const modulePath = resolve(process.cwd(), 'docs/audits/evidence1-final-codex-copy-contract.psm1');
      psJson(`Import-Module ${psQuote(modulePath)} -Force; $null=Complete-E1TwoDirectoryTransaction -PrivateStage ${psQuote(privateStage)} -PrivateDestination ${psQuote(privateOut)} -PublicStage ${psQuote(publicStage)} -PublicDestination ${psQuote(publicOut)} -JournalPath ${psQuote(journal)};@{ok=$true}|ConvertTo-Json -Compress`, shell);
      writeFileSync(`${journal}.complete.json`, '');
      const result = psJson(`Import-Module ${psQuote(modulePath)} -Force;$blocked=$false;try{$null=Invoke-E1TwoDirectoryRecovery -JournalPath ${psQuote(journal)} -ExpectedPrivateDestination ${psQuote(privateOut)} -ExpectedPublicDestination ${psQuote(publicOut)}}catch{$blocked=$_.Exception.Message -ceq 'copy_transaction_state_invalid'};@{blocked=$blocked}|ConvertTo-Json -Compress`, shell);
      expect(result).toEqual({ blocked: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 40_000);

  it.skipIf(process.platform !== 'win32')('cryptographically binds recovery to its reservation and rejects an invalid existing completion', () => {
    // Canonical scratch root, not tmpdir(): hosted Windows runners expose TEMP through a
    // short-name alias (RUNNER~1) that these scripts' canonical-path checks reject.
    mkdirSync('C:\\kmp-eval\\scratch', { recursive: true });
    const root = mkdtempSync('C:\\kmp-eval\\scratch\\e1-final-copy-reservation-');
    try {
      const report = join(root, 'reserved.json'); const completion = join(root, 'terminal.json'); const journal = join(root, 'txn'); const privateOut = join(root, 'private.out'); const publicOut = join(root, 'public.out'); const campaignId = randomUUID();
      const pathHash = (value) => hash(Buffer.from(resolve(value), 'utf8'));
      const harnessCommit = 'a'.repeat(40); const harnessTree = 'b'.repeat(40); const bindingSha = 'c'.repeat(64);
      const reservation = { schema: 1, kind: 'evidence1-final-codex-copy-reservation', campaign_id: campaignId, harness_commit: harnessCommit, harness_tree: harnessTree,
        binding_sha256: bindingSha, private_destination_sha256: pathHash(privateOut), public_destination_sha256: pathHash(publicOut), journal_path_sha256: pathHash(journal), completion_report_path_sha256: pathHash(completion),
        retry_count: 0, replacement_authorized: false, respawn_authorized: false, reserved_at_utc: new Date().toISOString() };
      const bytes = Buffer.from(`${JSON.stringify(reservation)}\n`); writeFileSync(report, bytes); const reservationSha = hash(bytes);
      const journalCompleteSha = '1'.repeat(64);
      const terminal = { schema: 1, kind: 'evidence1-final-codex-copy-terminal', verdict: 'PASS', campaign_id: campaignId, binding_sha256: bindingSha,
        reservation_sha256: reservationSha, journal_complete_sha256: journalCompleteSha, recovered: true,
        private_custody_outside_repo: true, public_destination_inside_repo: true, create_new_rename: true,
        public_files: 8, raw_published: false, sidecars_published: false };
      writeFileSync(completion, `${JSON.stringify(terminal)}\n`);
      const modulePath = resolve(process.cwd(), 'docs/audits/evidence1-final-codex-copy-contract.psm1');
      const valid = psJson(`Import-Module ${psQuote(modulePath)} -Force;$bound=$false;$validCompletion=$false;$wrongHash=$false;$wrongIdentity=$false;$wrongBinding=$false;try{$null=Assert-E1CopyRecoveryReservation -ReportPath ${psQuote(report)} -ExpectedSha256 ${psQuote(reservationSha)} -CampaignId ${psQuote(campaignId)} -PrivateDestination ${psQuote(privateOut)} -PublicDestination ${psQuote(publicOut)} -JournalPath ${psQuote(journal)} -CompletionReportPath ${psQuote(completion)} -ExpectedHarnessCommit ${psQuote(harnessCommit)} -ExpectedHarnessTree ${psQuote(harnessTree)} -ExpectedBindingSha256 ${psQuote(bindingSha)};$bound=$true}catch{};try{$null=Assert-E1CopyCompletionReport -CompletionReportPath ${psQuote(completion)} -CampaignId ${psQuote(campaignId)} -ReservationSha256 ${psQuote(reservationSha)} -JournalCompleteSha256 ${psQuote(journalCompleteSha)} -ExpectedBindingSha256 ${psQuote(bindingSha)};$validCompletion=$true}catch{};try{$null=Assert-E1CopyRecoveryReservation -ReportPath ${psQuote(report)} -ExpectedSha256 ${psQuote('0'.repeat(64))} -CampaignId ${psQuote(campaignId)} -PrivateDestination ${psQuote(privateOut)} -PublicDestination ${psQuote(publicOut)} -JournalPath ${psQuote(journal)} -CompletionReportPath ${psQuote(completion)} -ExpectedHarnessCommit ${psQuote(harnessCommit)} -ExpectedHarnessTree ${psQuote(harnessTree)} -ExpectedBindingSha256 ${psQuote(bindingSha)}}catch{$wrongHash=$true};try{$null=Assert-E1CopyRecoveryReservation -ReportPath ${psQuote(report)} -ExpectedSha256 ${psQuote(reservationSha)} -CampaignId ${psQuote(campaignId)} -PrivateDestination ${psQuote(privateOut)} -PublicDestination ${psQuote(publicOut)} -JournalPath ${psQuote(journal)} -CompletionReportPath ${psQuote(completion)} -ExpectedHarnessCommit ${psQuote('c'.repeat(40))} -ExpectedHarnessTree ${psQuote(harnessTree)} -ExpectedBindingSha256 ${psQuote(bindingSha)}}catch{$wrongIdentity=$true};try{$null=Assert-E1CopyRecoveryReservation -ReportPath ${psQuote(report)} -ExpectedSha256 ${psQuote(reservationSha)} -CampaignId ${psQuote(campaignId)} -PrivateDestination ${psQuote(privateOut)} -PublicDestination ${psQuote(publicOut)} -JournalPath ${psQuote(journal)} -CompletionReportPath ${psQuote(completion)} -ExpectedHarnessCommit ${psQuote(harnessCommit)} -ExpectedHarnessTree ${psQuote(harnessTree)} -ExpectedBindingSha256 ${psQuote('f'.repeat(64))}}catch{$wrongBinding=$true};@{bound=$bound;valid_completion=$validCompletion;wrong_hash=$wrongHash;wrong_identity=$wrongIdentity;wrong_binding=$wrongBinding}|ConvertTo-Json -Compress`);
      expect(valid).toEqual({ bound: true, valid_completion: true, wrong_hash: true, wrong_identity: true, wrong_binding: true });
      writeFileSync(completion, '{}');
      const invalid = psJson(`Import-Module ${psQuote(modulePath)} -Force;$badCompletion=$false;try{$null=Assert-E1CopyCompletionReport -CompletionReportPath ${psQuote(completion)} -CampaignId ${psQuote(campaignId)} -ReservationSha256 ${psQuote(reservationSha)} -JournalCompleteSha256 ${psQuote(journalCompleteSha)} -ExpectedBindingSha256 ${psQuote(bindingSha)}}catch{$badCompletion=$true};@{bad_completion=$badCompletion}|ConvertTo-Json -Compress`);
      expect(invalid).toEqual({ bad_completion: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('accepts only an exact externally hash-bound guest terminal chain', () => {
    const root = mkdtempSync(join(tmpdir(), 'e1-final-terminal-chain-valid-'));
    try {
      const fixture = guestTerminalChainFixture(); const payload = join(root, 'payload.json'); writeFileSync(payload, JSON.stringify(fixture));
      const modulePath = resolve(process.cwd(), 'docs/audits/evidence1-final-codex-copy-contract.psm1');
      const result = psJson(`Import-Module ${psQuote(modulePath)} -Force;$p=Get-Content -LiteralPath ${psQuote(payload)} -Raw|ConvertFrom-Json;$ok=$false;try{$null=Assert-E1GuestTerminalChain -Terminal $p.terminal -TerminalClaim $p.claim -CampaignCustody $p.custody -CampaignId $p.campaignId -TerminalClaimSha256 $p.claimSha -CampaignCustodySha256 $p.custodySha -PublicationManifestSha256 $p.manifestSha -ExpectedBindingSha256 $p.claim.binding_sha256;$ok=$true}catch{};@{ok=$ok}|ConvertTo-Json -Compress`);
      expect(result).toEqual({ ok: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('rejects a junction campaign directory before reading group or slot claims', () => {
    const root = mkdtempSync(join(tmpdir(), 'e1-final-guest-claims-reparse-'));
    try {
      const target = join(root, 'real-campaign'); mkdirSync(target); const fixture = guestTerminalChainFixture();
      const groupBytes = Buffer.from('group claim'); writeFileSync(join(target, 'group.claim.json'), groupBytes); fixture.custody.group_claim_sha256 = hash(groupBytes);
      for (const entry of fixture.custody.slot_and_plan_claims) {
        const slot = join(target, 'slots', String(entry.order_index)); mkdirSync(slot, { recursive: true });
        const bytes = Buffer.from(`${entry.order_index}:${entry.name}`); writeFileSync(join(slot, entry.name), bytes); entry.sha256 = hash(bytes);
      }
      const alias = join(root, 'campaign-alias'); symlinkSync(target, alias, 'junction'); const payload = join(root, 'custody.json'); writeFileSync(payload, JSON.stringify(fixture.custody));
      const modulePath = resolve(process.cwd(), 'docs/audits/evidence1-final-codex-copy-contract.psm1');
      const result = psJson(`Import-Module ${psQuote(modulePath)} -Force;$c=Get-Content -LiteralPath ${psQuote(payload)} -Raw|ConvertFrom-Json;$valid=$false;$blocked=$false;try{$null=Assert-E1GuestClaimTree -GuestRunDir ${psQuote(target)} -CampaignCustody $c;$valid=$true}catch{};try{$null=Assert-E1GuestClaimTree -GuestRunDir ${psQuote(alias)} -CampaignCustody $c}catch{$blocked=$_.Exception.Message-ceq'copy_reparse_path_rejected'};@{valid=$valid;blocked=$blocked}|ConvertTo-Json -Compress`);
      expect(result).toEqual({ valid: true, blocked: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32').each(['claim_schema', 'claim_extra', 'terminal_missing_schema', 'terminal_schema', 'terminal_extra', 'cross_binding', 'external_binding', 'self_hash', 'identity_minimal', 'identity_extra', 'identity_type', 'wrong_order', 'claims_empty', 'claim_nested_extra', 'claim_duplicate_hash', 'artifacts_empty', 'artifact_duplicate', 'artifact_noncanonical'])('rejects malformed or cross-bound guest terminal chain: %s', (mutation) => {
    const root = mkdtempSync(join(tmpdir(), 'e1-final-terminal-chain-invalid-'));
    try {
      const fixture = guestTerminalChainFixture();
      if (mutation === 'claim_schema') fixture.claim.schema = 999;
      if (mutation === 'claim_extra') fixture.claim.extra = true;
      if (mutation === 'terminal_missing_schema') delete fixture.terminal.schema;
      if (mutation === 'terminal_schema') fixture.terminal.schema = 999;
      if (mutation === 'terminal_extra') fixture.terminal.extra = true;
      if (mutation === 'cross_binding') fixture.custody.binding_sha256 = 'f'.repeat(64);
      if (mutation === 'external_binding') fixture.expectedBindingSha = 'f'.repeat(64);
      if (mutation === 'self_hash') fixture.terminal.campaign_custody_sha256 = fixture.claimSha;
      if (mutation === 'identity_minimal') fixture.custody.identity = { campaign_id: fixture.campaignId };
      if (mutation === 'identity_extra') fixture.custody.identity.extra = true;
      if (mutation === 'identity_type') fixture.custody.identity.sessions_executed = '6';
      if (mutation === 'wrong_order') fixture.custody.identity.slot_order = ['A', 'B', 'A', 'B', 'A', 'B'];
      if (mutation === 'claims_empty') fixture.custody.slot_and_plan_claims = [];
      if (mutation === 'claim_nested_extra') fixture.custody.slot_and_plan_claims[0].extra = true;
      if (mutation === 'claim_duplicate_hash') fixture.custody.slot_and_plan_claims[1].sha256 = fixture.custody.slot_and_plan_claims[0].sha256;
      if (mutation === 'artifacts_empty') fixture.custody.artifacts = [];
      if (mutation === 'artifact_duplicate') fixture.custody.artifacts[1].record_path = fixture.custody.artifacts[0].record_path;
      if (mutation === 'artifact_noncanonical') fixture.custody.artifacts[0].record_path = 'C:\\custody\\nested\\..\\record-0.json';
      const payload = join(root, 'payload.json'); writeFileSync(payload, JSON.stringify(fixture)); const modulePath = resolve(process.cwd(), 'docs/audits/evidence1-final-codex-copy-contract.psm1');
      const result = psJson(`Import-Module ${psQuote(modulePath)} -Force;$p=Get-Content -LiteralPath ${psQuote(payload)} -Raw|ConvertFrom-Json;$expected=if($p.expectedBindingSha){$p.expectedBindingSha}else{$p.claim.binding_sha256};$blocked=$false;try{$null=Assert-E1GuestTerminalChain -Terminal $p.terminal -TerminalClaim $p.claim -CampaignCustody $p.custody -CampaignId $p.campaignId -TerminalClaimSha256 $p.claimSha -CampaignCustodySha256 $p.custodySha -PublicationManifestSha256 $p.manifestSha -ExpectedBindingSha256 $expected}catch{$blocked=$true};@{blocked=$blocked}|ConvertTo-Json -Compress`);
      expect(result).toEqual({ blocked: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('never overwrites an existing destination', () => {
    const root = mkdtempSync(join(tmpdir(), 'e1-final-copy-no-overwrite-'));
    try {
      const ps = join(root, 'private.stage'); const us = join(root, 'public.stage'); const po = join(root, 'private.out'); const uo = join(root, 'public.out');
      mkdirSync(ps); mkdirSync(us); mkdirSync(uo); writeFileSync(join(uo, 'sentinel'), 'keep');
      const modulePath = resolve(process.cwd(), 'docs/audits/evidence1-final-codex-copy-contract.psm1');
      const result = psJson(`Import-Module ${psQuote(modulePath)} -Force; $blocked=$false;try{Complete-E1TwoDirectoryTransaction -PrivateStage ${psQuote(ps)} -PrivateDestination ${psQuote(po)} -PublicStage ${psQuote(us)} -PublicDestination ${psQuote(uo)} -JournalPath ${psQuote(join(root, 'txn'))}|Out-Null}catch{$blocked=$true};@{blocked=$blocked;sentinel=[IO.File]::ReadAllText(${psQuote(join(uo, 'sentinel'))});private_out=(Test-Path ${psQuote(po)})}|ConvertTo-Json -Compress`);
      expect(result).toEqual({ blocked: true, sentinel: 'keep', private_out: false });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32')('rejects a reparse point anywhere in a staged copy tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'e1-final-copy-reparse-'));
    try {
      const stage = join(root, 'stage'); const target = join(root, 'target'); mkdirSync(stage); mkdirSync(target);
      symlinkSync(target, join(stage, 'junction'), 'junction');
      const modulePath = resolve(process.cwd(), 'docs/audits/evidence1-final-codex-copy-contract.psm1');
      const result = psJson(`Import-Module ${psQuote(modulePath)} -Force; $blocked=$false; try { Assert-E1NoReparseTree ${psQuote(stage)} | Out-Null } catch { $blocked=($_.Exception.Message -ceq 'copy_reparse_tree_rejected') }; @{ blocked=$blocked } | ConvertTo-Json -Compress`);
      expect(result).toEqual({ blocked: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32').each(['powershell.exe', 'pwsh.exe'])('rejects a reparse point used as a transaction journal file under %s', (shell) => {
    const root = mkdtempSync(join(tmpdir(), 'e1-final-copy-journal-reparse-'));
    try {
      const privateOut = join(root, 'private.out'); const publicOut = join(root, 'public.out'); const journal = join(root, 'txn'); const target = join(root, 'prepared-target.json');
      writeFileSync(target, `${JSON.stringify({ schema: 1, kind: 'evidence1-final-codex-copy-transaction', transaction_id: randomUUID(), private_stage: `${privateOut}.staging-${'a'.repeat(32)}`, private_destination: privateOut, private_tree_sha256: '1'.repeat(64), public_stage: `${publicOut}.staging-${'b'.repeat(32)}`, public_destination: publicOut, public_tree_sha256: '2'.repeat(64), prepared_at_utc: new Date().toISOString() })}\n`);
      symlinkSync(target, `${journal}.prepared.json`, 'file');
      const modulePath = resolve(process.cwd(), 'docs/audits/evidence1-final-codex-copy-contract.psm1');
      const result = psJson(`Import-Module ${psQuote(modulePath)} -Force;$blocked=$false;try{$null=Invoke-E1TwoDirectoryRecovery -JournalPath ${psQuote(journal)} -ExpectedPrivateDestination ${psQuote(privateOut)} -ExpectedPublicDestination ${psQuote(publicOut)}}catch{$blocked=$_.Exception.Message -ceq 'copy_transaction_file_reparse_rejected'};@{blocked=$blocked}|ConvertTo-Json -Compress`, shell);
      expect(result).toEqual({ blocked: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('captures and binds the exact guest auth blob rather than hashing the host wrapper', () => {
    const capture = read('evidence1-hyperv-capture-final-codex-auth-blob.ps1');
    const placement = read('evidence1-hyperv-place-final-codex.ps1');
    const handoff = read('evidence1-live-handoff-contract.psm1');
    expect(capture).toContain('$hostReport.remote_auth_canary');
    expect(capture).toContain('Assert-Evidence1LiveHandoffEvidence');
    expect(capture).toContain('[IO.FileMode]::CreateNew');
    expect(capture).toContain('$stream.Write($guestBytes');
    expect(capture.indexOf('New-E1FinalOperationReservation')).toBeLessThan(capture.indexOf('Mount-VHD'));
    expect(handoff).toContain("'readiness_sha256','account_binding_sha256','remote_auth_canary','model_pair','privacy'");
    expect(handoff).toContain("@('canonical-auth-canary','paired-model-availability-canary')");
    expect(handoff).toContain("'dual auth host report.account_binding_sha256'");
    expect(placement).toContain("@('remote-auth-canary.json',$RemoteAuthCanarySha256)");
    expect(placement).toContain('remote_auth_blob_sha256=$RemoteAuthCanarySha256');
    let binding; try { binding = read('evidence1-new-final-codex-binding.ps1'); } catch { binding = null; }
    const launcher = read('evidence1-codex-live-launch.ps1');
    if (binding !== null) expect(binding).toContain("guest_readiness_sha256=$guestReadinessSha");
    expect(launcher).toContain('$bindingPreflight.guest_readiness_sha256 -cne $readinessSha256');
  });

  it('resolves the mounted Windows volume without requiring a drive letter', () => {
    const contract = read('evidence1-final-codex-host-contract.psm1');
    const placement = read('evidence1-hyperv-place-final-codex.ps1');
    const copy = read('evidence1-hyperv-copy-final-codex.ps1');
    const capture = read('evidence1-hyperv-capture-final-codex-auth-blob.ps1');
    expect(contract).toContain('function Get-E1FinalMountedWindowsRoot');
    expect(contract).toContain(".StartsWith('\\\\?\\Volume{'");
    expect(contract).toContain("Windows\\System32\\Config\\SYSTEM");
    expect(contract).toContain("'Get-E1FinalMountedWindowsRoot'");
    for (const source of [placement, copy, capture]) {
      expect(source).toContain('Get-E1FinalMountedWindowsRoot $mount');
      expect(source).not.toContain('Where-Object DriveLetter');
    }
    expect(placement).toContain('Add-PartitionAccessPath');
    expect(placement).toContain('-AssignDriveLetter');
    expect(placement).toContain('Remove-PartitionAccessPath');
    expect(placement.indexOf('Remove-PartitionAccessPath')).toBeLessThan(placement.lastIndexOf('Dismount-VHD'));
    expect(placement).toContain("$root=([string]$windowsPartition.DriveLetter)+':\\'");
  });

  it('publication scan accepts an exact clean set and rejects raw/private fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'e1-publication-'));
    try {
      const files = Array.from({ length: 8 }, (_, i) => join(root, `${i}.json`));
      files.forEach((file, i) => writeFileSync(file, JSON.stringify({ schema: 1, value: i })));
      const script = join(process.cwd(), 'docs', 'audits', 'evidence1-codex-publication-scan.mjs');
      const args = files.flatMap((file) => ['--file', file]);
      expect(JSON.parse(execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' })).files_scanned).toBe(8);
      writeFileSync(files[3], JSON.stringify({ schema: 1, transcript: 'secret' }));
      expect(() => execFileSync(process.execPath, [script, ...args], { stdio: 'pipe' })).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
