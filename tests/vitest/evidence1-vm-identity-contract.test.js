import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const run = (body) => execFileSync('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', body,
], { encoding: 'utf8', windowsHide: true }).trim();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'e1-vm-identity-')); roots.push(root);
  const vmRoot = join(root, 'hyperv'); const vmName = 'Evidence1-Runner-E2E';
  const profilePath = join(root, 'profile.json'); const inspectionPath = join(root, 'inspect.json');
  const credentialPath = join(root, 'credential.clixml'); writeFileSync(credentialPath, 'opaque-credential-fixture');
  const profile = {
    schema_version: 2, profile_id: 'evidence1-windows-hyperv-e2e-v1',
    vm: { name: vmName, root: vmRoot }, guest: { computer_name: 'Evidence1E2E', local_user: 'Evidence1E2E' },
  };
  writeFileSync(profilePath, JSON.stringify(profile));
  const inputLockSha = 'a'.repeat(64); const vmId = 'e994dba2-2d42-40e3-b9c9-466055705886';
  const inspection = {
    schema: 1, verdict: 'PASS', mode: 'InspectCreated', profile_id: profile.profile_id,
    generated_at_utc: '2026-09-13T23:13:33.089Z', profile_sha256: sha(profilePath),
    input_lock_sha256: inputLockSha, vm_id: vmId, vm_state: 'Off', vhd_partition_style: 'RAW',
    network_state: 'disconnected', original_iso_is_only_dvd: true, drift_fields: [], mutation_performed: false,
    inputs: { input_lock_sha256: inputLockSha }, inference_sessions_consumed: 0,
  };
  writeFileSync(inspectionPath, JSON.stringify(inspection));
  const custodyDir = join(vmRoot, vmName, 'custody'); mkdirSync(custodyDir, { recursive: true });
  const markerPath = join(custodyDir, 'windows-offline-apply-1.consumed.json');
  const marker = {
    schema: 1, profile_id: profile.profile_id, vm_id: vmId, profile_sha256: sha(profilePath),
    input_lock_sha256: inputLockSha, created_inspection_receipt_sha256: sha(inspectionPath),
    guest_credential_sha256: sha(credentialPath), consumed_at_utc: '2026-09-13T23:17:27.348Z', authorized_start_count: 1,
  };
  writeFileSync(markerPath, JSON.stringify(marker));
  return { profilePath, inspectionPath, credentialPath, markerPath, vmId, marker };
}

const modulePath = resolve('docs/audits/evidence1-vm-identity-contract.psm1');
describe.skipIf(process.platform !== 'win32')('Evidence1 canonical E2E VM identity contract', () => {
  it.each([
    ['caller-selected profile and fully self-consistent chain', (_f) => {}, 'vm_identity_profile_path_not_canonical'],
    ['inspection hash substitution in a caller-selected chain', (f) => { const marker = JSON.parse(readFileSync(f.markerPath)); marker.created_inspection_receipt_sha256 = 'b'.repeat(64); writeFileSync(f.markerPath, JSON.stringify(marker)); }, 'vm_identity_profile_path_not_canonical'],
    ['cross-VM custody in a caller-selected chain', (f) => { const marker = JSON.parse(readFileSync(f.markerPath)); marker.vm_id = '11111111-1111-4111-8111-111111111111'; writeFileSync(f.markerPath, JSON.stringify(marker)); }, 'vm_identity_profile_path_not_canonical'],
  ])('fails closed on %s', (_label, mutate, expected) => {
    const f = fixture(); mutate(f);
    const result = run(`Import-Module ${quote(modulePath)} -Force;$code='';try{$null=Get-Evidence1CanonicalE2EVmIdentity -ProfilePath ${quote(f.profilePath)} -CreatedInspectionReceiptPath ${quote(f.inspectionPath)} -GuestCredentialPath ${quote(f.credentialPath)}}catch{$code=$_.Exception.Message};$code`);
    expect(result).toBe(expected);
  });
});

describe('Evidence1 VM identity profile amendment source guards (WO-10a)', () => {
  const source = readFileSync(modulePath, 'utf8');
  const SEALED = '2d9bbe2b31b363197bdcc1e89292d21e7ad44a0f71ccc7627406d218cb7140b9';
  const CURRENT = 'c8330a3f68d2df456ce8b32a953942897edf8451d8f556c7eb3bb3de41d8f81f';

  it('keeps a closed amendment table with exactly one entry, from the sealed profile hash to the current one', () => {
    const table = source.match(/\$script:E1VmIdentityProfileAmendments = @\(([\s\S]*?)\n\)/);
    expect(table).not.toBeNull();
    const pairs = [...table[1].matchAll(/from_sha256 = '([0-9a-f]{64})'; to_sha256 = '([0-9a-f]{64})'/g)];
    expect(pairs.map((m) => [m[1], m[2]])).toEqual([[SEALED, CURRENT]]);
  });

  it('names the whole memory history of the profile in the table comment', () => {
    expect(source).toContain('8589934592');
    expect(source).toContain('91cb129');
    expect(source).toContain('07e5d1f');
    expect(source).toContain('12884901888');
  });

  it('binds the inspection receipt and the custody marker to the profile hash only through the amendment helper', () => {
    expect(source).toContain('Test-E1VmIdentityProfileBound ([string]$inspection.profile_sha256) ([string]$profileReceipt.sha256)');
    expect(source).toContain('Test-E1VmIdentityProfileBound ([string]$marker.profile_sha256) ([string]$profileReceipt.sha256)');
    expect(source).not.toMatch(/\$inspection\.profile_sha256 -cne \$profileReceipt\.sha256/);
    expect(source).not.toMatch(/\$marker\.profile_sha256 -cne \$profileReceipt\.sha256/);
    expect(source.match(/Test-E1VmIdentityProfileBound \(/g)?.length).toBe(2);
  });

  it('compares with exact (case-sensitive) operators, never with a hashtable lookup', () => {
    const helper = source.match(/function Test-E1VmIdentityProfileBound[\s\S]*?\n\}/);
    expect(helper).not.toBeNull();
    expect(helper[0]).toContain('-ceq');
    expect(helper[0]).not.toMatch(/ContainsKey|-match|-like/);
  });

  it('leaves the VM, input lock, receipt, marker and credential checks in place', () => {
    for (const code of ['vm_identity_hyperv_mismatch', 'vm_identity_custody_invalid', 'vm_identity_inspection_invalid', 'vm_identity_guest_credential_mismatch']) {
      expect(source).toContain(`throw '${code}'`);
    }
    expect(source).toContain('$marker.input_lock_sha256 -cne $inspection.input_lock_sha256');
    expect(source).toContain('$marker.created_inspection_receipt_sha256 -cne $inspectionReceipt.sha256');
  });
});

describe('Evidence1 VM identity rebinding source guards', () => {
  it('anchors the profile and private artifacts before consulting Hyper-V authority', () => {
    const source = readFileSync(modulePath, 'utf8');
    expect(source).toContain("'node-runtime\\tools\\evidence1\\provisioning\\evidence1-windows-hyperv-e2e-v1.json'");
    expect(source).toContain("'C:\\kmp-eval\\hyperv-e2e'");
    expect(source).toContain("Assert-E1VmIdentityPathInside $CreatedInspectionReceiptPath 'C:\\kmp-eval\\scratch'");
    expect(source).toContain('Get-VM -Name $vmName -ErrorAction Stop');
    expect(source).toContain("throw 'vm_identity_hyperv_mismatch'");
  });

  it('contains no operational fallback to the superseded VM UUID', () => {
    const oldId = '6e5848f5-37dd-4653-9f3d-df2871e6293a';
    const operationalFiles = [
      'docs/audits/evidence1-vm-identity-contract.psm1',
      'docs/audits/evidence1-hyperv-regenerate-readiness-direct.ps1',
      'docs/audits/evidence1-hyperv-verify-guest-dual-auth-direct.ps1',
      'docs/audits/evidence1-hyperv-start-dual-condition-canary.ps1',
      'docs/audits/evidence1-hyperv-start-final-codex.ps1',
      'docs/audits/evidence1-codex-live-launch.ps1',
      'tools/agentic-eval/final-campaign-control.mjs',
    ];
    for (const path of operationalFiles) { let text; try { text = readFileSync(resolve(path), 'utf8'); } catch { continue; } expect(text).not.toContain(oldId); }
  });
});
