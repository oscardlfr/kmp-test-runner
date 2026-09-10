# Evidence1 Windows setup

Evidence1 is the repository's Windows/Hyper-V implementation of the
`sandboxed-unrestricted-v1` external-isolation profile. This document describes
how to build the environment from official installation media without
pretending that authentication or machine provisioning is fully automated.

The existing operational scripts assume a specific audited deployment profile.
They parameterize commit/tree anchors and several artifact locations, but some
VM identities, guest identities, directory roots, scenario pins, runtime
versions, and safety boundaries remain fixed in code. A new machine must either
reproduce that profile exactly or first land a reviewed parameterization change
with equivalent fail-closed tests. Do not search-and-replace those constants in
an operational checkout immediately before a live run.

## What is and is not portable

- The Node.js agentic harness is portable across supported operating systems.
- `strict-policy-v1` can run wherever the enabled runtime adapter and project
  toolchain work; accepted Windows and macOS campaigns exist.
- `sandboxed-unrestricted-v1` is portable only as a contract: the operator must
  supply an external sandbox and a valid attestation.
- Evidence1's supplied backend is Windows-only. It uses Hyper-V, PowerShell
  Direct, Windows Firewall, Task Scheduler, VMConnect, checkpoints, and VHD
  offline custody.
- A Windows guest hosted by Parallels, VMware, UTM, or another macOS hypervisor
  is not Evidence1 today. Supporting one requires a reviewed backend for VM
  lifecycle, transport, network sealing, one-use handoff, and disk custody.

## Host prerequisites

- A supported Windows edition with Hyper-V enabled and hardware virtualization
  available. Confirm current requirements in Microsoft's
  [Hyper-V system requirements](https://learn.microsoft.com/windows-server/virtualization/hyper-v/system-requirements-for-hyper-v-on-windows).
- Administrator access for initial Hyper-V and scheduled-runner installation.
- Enough local disk for the base VHDX, checkpoints, source clones, Gradle caches,
  and immutable evidence receipts.
- PowerShell 7 and Windows PowerShell where required by the audited scripts.
- Git and Node.js 18 or newer in the host operational checkout.
- A dedicated, clean operational checkout at the exact reviewed commit.
- A separate scratch root outside every git repository for credentials,
  attestations, reports, handoff records, and raw captures.

Do not place the scratch root under cloud synchronization, source control, a
shared team directory, or a path writable by unrelated users.

## 1. Obtain and verify Windows media

Download Windows installation media only from Microsoft. The current public
options are the [Windows 11 Enterprise Evaluation Center](https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise)
and the [Windows 11 ISO download page](https://www.microsoft.com/en-us/software-download/windows11).
Evaluation terms and available versions can change; record the page, edition,
architecture, language, download date, filename, byte size, and SHA-256 used for
the build.

Compute the digest locally before mounting the ISO:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath <downloaded-iso>
```

Store the ISO inventory locally. A public setup report may contain the edition,
architecture, date, byte size, and hash, but never a user-specific path.

## 2. Create the dedicated Hyper-V guest manually

Create a Generation 2 Windows VM with Secure Boot and a virtual TPM when the
selected Windows release requires them. Allocate resources appropriate for a
large Android/Gradle build; record CPU count, startup/dynamic memory settings,
disk capacity, virtual-switch identity, firmware settings, VM generation, and
the resulting Hyper-V VM ID in the local provisioning inventory.

Install Windows from the verified ISO and create one dedicated local guest
account. Use the computer and VM identities required by the audited deployment
profile. Complete Windows Update, then remove the ISO and any general-purpose
shared folders or clipboard/file-transfer integrations not required by the
contract.

The repository does not currently ship a safe generic `create-evidence1-vm`
command. This is a documented manual boundary, not an omitted one-liner.

## 3. Install the guest toolchain

Install and record exact versions of:

- Git;
- Node.js compatible with `package.json`;
- the JDK required by the pinned Android project and the Evidence1 validators;
- Android SDK packages required by the pinned scenario project;
- the enabled agent runtime CLI;
- PowerShell and Hyper-V integration services needed for PowerShell Direct.

The committed operational scripts may pin stricter runtime/JDK versions than
the product itself. Read the exact target checkout before installing. A version
that is merely “newer” is not automatically equivalent when readiness expects
an exact runtime identity.

Do not install `kmp-test-runner` globally for the free-baseline environment.
Evidence1 deploys the pinned harness/product bundle and materializes independent
workspaces; a stray executable on `PATH` can contaminate the baseline.

## 4. Prepare source, cache, and isolation state

Prepare two independent clean sources:

1. the `kmp-test-runner` operational checkout at the exact commit/tree to be
   evaluated;
2. the public scenario project at the commit declared in its scenario JSON.

Warm dependencies only through the reviewed cache-provisioning workflow. A
normal developer Gradle home can contain credentials, init scripts, project
state, and mutable build outputs and is not a qualified benchmark seed. The
Evidence1 provisioning modules copy only allowed dependency-cache structures,
exclude credentials and daemon state, and certify the result offline with the
VM network disconnected.

Generate the external-isolation attestation locally and keep it outside git.
The attestation must bind the external sandbox, network mode, source/harness
anchors, and validity window expected by readiness. Merely setting
`--execution-profile sandboxed-unrestricted-v1` does not create or prove this
state.

## 5. Install the constrained elevated runner

The scheduled runner allows a non-elevated operator shell to request only the
reviewed Evidence1 entrypoints. From an elevated PowerShell in the clean
operational checkout:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  docs\audits\evidence1-host-elevated-runner-install.ps1
```

Inspect the generated installation report locally. Confirm that the scheduled
task action points to the reviewed checkout and that its allowlist does not
expose a generic elevated shell. Updating the guest harness does not update this
host task automatically.

## 6. Perform interactive runtime authentication

OAuth/browser authentication cannot be made non-interactive without changing
its security model. The operator performs it inside the dedicated guest:

1. Use the reviewed temporary-auth-egress entrypoint. It opens a bounded window,
   arms a watchdog, and records only privacy-safe endpoint checks.
2. Use the reviewed login-task entrypoint to open the runtime's interactive
   login in the already logged-on guest desktop.
3. Open VMConnect through the reviewed viewer entrypoint and complete the login
   manually. Automation must never type, read, or copy credentials.
4. Run the reviewed network-reseal entrypoint immediately after login. It closes
   temporary processes, restores the restricted policy, and validates the seal.
5. Regenerate readiness and, when explicitly authorized, run one remote-auth
   canary from an empty directory with no repository, skill, or tools.

A local `auth status` result proves credential presence only. The remote canary
proves that the stored login can complete one bounded request at that moment.
Neither is a permanent guarantee; the live handoff requires a fresh passing
auth report.

An optional offline checkpoint may preserve the authenticated tool state, but
it contains sensitive account state. Keep the VHDX/checkpoint local, access
controlled, and excluded from backups or sharing unless the same secret-handling
policy applies. Never publish or distribute an authenticated VM image.

## Secrets and local-only artifacts

Never commit, attach to a PR, paste into an issue, or include in a public report:

- OAuth tokens, API keys, refresh tokens, cookies, or runtime credential files;
- exported `PSCredential`/CLIXML, DPAPI material, Keychain data, or browser
  profiles;
- authenticated VHDX files or checkpoints;
- isolation-attestation secrets or measurement-scope HMAC keys;
- raw prompts, responses, structured transcripts, stderr, or tool output;
- local absolute paths, account names, machine names, IP addresses, private
  repository names, or private module names.

Public evidence is limited to sanitized run records, accepted-run sidecars,
closed reason/status codes, counts, durations, hashes, public aliases, and
reviewed aggregates.

## Ready-for-validation checklist

- Host and guest identities match the reviewed deployment profile.
- ISO provenance and VM configuration are recorded locally.
- Harness and source checkouts are clean and pinned by commit and tree.
- Runtime, Node, JDK, Gradle wrapper, and Android SDK probes pass.
- Qualified Gradle cache certification passes with network disconnected.
- External-isolation attestation is fresh and stored outside git.
- Guest network is sealed after interactive authentication.
- No product executable or marker leaks into the source-only baseline.
- Elevated runner is installed from the exact reviewed checkout.
- Previous live handoffs have complete terminal custody.

Only then continue to [Evidence1 live canary](evidence1-live-canary.md).
