# Prepare Evidence1 on Windows

Evidence1 is the isolated Windows/Hyper-V environment used by the live Claude Code canary. This guide distinguishes the publicly documented setup from the parts still tied to the prepared lab VM.

## Reproducibility status

The current repository can revalidate and run a one-cell canary on the already prepared `Evidence1-Runner` VM. It does **not** yet contain an end-to-end provisioner that creates that VM from an ISO, installs every dependency, and parameterizes all machine-specific paths. Several operational scripts still bind to the VM name, pinned Claude Code version, source commit, attestation path, and `C:\kmp-eval` layout.

Therefore:

- repeatability on the prepared Evidence1 environment: supported and validated;
- clean-room creation from an ISO: manual procedure, not yet a one-command repository feature;
- VM images, Windows media, credentials, and auth state: never committed or redistributed.

## Host prerequisites

Use 64-bit Windows 10/11 Pro, Enterprise, or Education with Hyper-V and hardware virtualization; Windows Home does not include the Hyper-V role. Microsoft documents the required SLAT, VM monitor mode extensions, firmware virtualization, DEP, and memory requirements in [Hyper-V system requirements](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/host-hardware-requirements).

Keep Windows PowerShell 5.1 available: the bounded elevated runner and guest autorun intentionally invoke `powershell.exe`. Install PowerShell 7 (`pwsh`) as well for normal repository development and local validation. Run only the one-time runner installation from an elevated terminal; later operations go through its allowlisted client.

Enable Hyper-V using Microsoft's [installation guide](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/install-hyper-v), then reboot if requested. Confirm:

```powershell
systeminfo.exe
Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All
```

## Obtain Windows installation media

Download Windows 11 media only from Microsoft's [official Windows 11 download page](https://www.microsoft.com/en-us/software-download/windows11). The ISO option is explicitly suitable for creating a virtual machine. Record the selected edition/language and verify any checksum Microsoft publishes for that download. Do not place the ISO in this repository.

## Create the VM manually

Follow Microsoft's [Hyper-V virtual-machine guide](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/create-a-virtual-machine-in-hyper-v). For compatibility with Windows 11, use a Generation 2 VM, Secure Boot/TPM as required by the chosen image, sufficient RAM/disk, and a network adapter that can be detached or sealed before measurement.

The current operational scripts expect the VM name `Evidence1-Runner`. Changing it requires code changes today; it is not a documented runtime parameter.

Inside the guest, install and pin:

- Git;
- Node.js 18+;
- the JDK required by the pinned source project;
- Gradle dependencies/cache needed for the offline scenario;
- Claude Code `2.1.238` for the currently versioned contract;
- the pinned evaluation harness and source project at the expected commits.

Install these dependencies while ordinary setup networking is available, verify their versions, and then create the offline Gradle cache before applying the measurement seal. For the current prepared contract, Claude Code is installed with `npm install -g @anthropic-ai/claude-code@2.1.238`; a future contract must update the pin and its validation together.

Authenticate Claude only during the explicit authentication window. Never copy tokens, browser profiles, or credential stores into Git evidence.

## Establish host control and credentials

Clone this repository on the host, check out the exact harness commit, and install the narrow scheduled runner from an elevated Windows PowerShell window:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-install.ps1
```

The prepared scripts use PowerShell Direct and expect a DPAPI-bound guest credential at a fixed path. Create it interactively as the same Windows user that owns the scheduled runner; treat the resulting CLIXML as a secret and never commit or copy it to another account/machine:

```powershell
New-Item -ItemType Directory -Force -Path C:\kmp-eval\scratch\hyperv-create-runner | Out-Null
Get-Credential -Message 'Evidence1 guest account' |
  Export-Clixml -LiteralPath C:\kmp-eval\scratch\hyperv-create-runner\Evidence1-Runner.guest-credential.clixml
```

The allowlisted client, not a general administrative session, is the normal control surface:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-read-live-progress.ps1 `
  -ScriptArgumentsJson '["-ExpectedRunId","<run-guid>"]'
```

## Establish the evaluation layout

The existing scripts expect controlled directories below `C:\kmp-eval` for measurement scopes, attestation, scratch reports, staged harness bytes, and custody output. Use the versioned scripts under `docs/audits/`; do not improvise filenames or overwrite a failed report to make a later gate pass.

The current fixed guest paths are:

```text
C:\kmp-eval\agentic-evidence1-claude-2x2-windows-stage-b-readiness-v1
C:\kmp-eval\NowInAndroid-evidence1-coverage-threshold-windows-stageb-v1
C:\kmp-eval\measurement-scopes
C:\kmp-eval\scratch
```

Place clean detached clones at the first two paths, install harness dependencies with `npm ci`, and verify both `git rev-parse HEAD` and `git rev-parse HEAD^{tree}` against the chosen pins. `evidence1-hyperv-regenerate-readiness-direct.ps1` creates and validates the time-bounded isolation attestation under `measurement-scopes`; do not hand-author it. The cache-provisioning/recovery operations and network seal are stateful, fail-closed procedures documented in the [operations toolkit](../audits/evidence1-hyperv-ops-toolkit.md). Their prerequisites include prior receipts and hashes, so they are not a generic bootstrap command for a new VM.

Before live work, complete:

1. pinned source and harness placement;
2. Gradle cache provisioning and a successful offline dependency probe;
3. isolation attestation creation/review;
4. network seal;
5. V1 source/readiness validation;
6. V2 wet product gate;
7. V3 exact canary dry plan;
8. separate remote-auth freshness validation.

Take a named Hyper-V checkpoint only after base tools and dependency caches are known-good and before storing live auth state. Record the VM generation, Windows build, CPU/RAM/disk, virtual-switch topology, dependency versions, source/harness commit and tree hashes, and checkpoint name outside Git. A checkpoint is recovery infrastructure, not accepted benchmark evidence.

The executable order and failure rules are in [Evidence1 live canary](evidence1-live-canary.md).

## Known automation gap

A future functional change should introduce a reviewed provisioner with parameters for VM name, storage root, ISO path/hash, dependency versions, source/harness pins, and attestation location. It must be tested independently from this documentation/evidence change. Until then, this page is an honest manual preparation checklist, not a promise of push-button clean-room reproduction.
