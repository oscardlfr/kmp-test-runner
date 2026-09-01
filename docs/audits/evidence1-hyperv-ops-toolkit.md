# Evidence1 Hyper-V Ops Toolkit

This toolkit exists to make the Evidence1 Windows runner repeatable from a host session without
turning the host into a general-purpose elevated shell. It does not authorize live sessions.

## Boundary

- The VM is still the isolation boundary for Evidence1 live execution.
- The host scripts update the harness, verify launch evidence, perform one controlled live handoff,
  validate the deterministic product wet gate and one-cell dry-run plans, read privacy-safe
  progress, or copy finalized operational artifacts.
- Raw transcript files and per-cell stderr transcript artifacts are never read by these scripts.
- Do not run another live campaign from this PR. Live execution still requires the separate literal
  authorization phrase after readiness has passed.

## Elevated Runner

Install the runner once from an elevated PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-install.ps1
```

After that, a non-elevated host session can queue only the allowlisted Evidence1 scripts:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-read-live-progress.ps1
```

The scheduled task runs as the interactive user with `RunLevel Highest`; it is intentionally not a
generic admin command runner. The allowlist is in
`docs/audits/evidence1-host-elevated-runner.ps1`, and defaults to the directory that contains the
runner itself.

The runner does not expose a generic VM stop command or the low-level autorun placement script.
The only allowlisted launch mutation is `evidence1-hyperv-start-authorized-live.ps1`, which owns the
whole transition and delegates internally to the placement script after every gate has passed.

## Post-Merge Validation Before Live

Follow [Evidence1 Post-Merge Validation](evidence1-post-merge-validation.md) for the Stage V
sequence and deployment custody. The explicit validation allowlist additions are:

- `evidence1-hyperv-verify-wet-gate-v2-direct.ps1`: one real product/Gradle invocation in the
  guest, with the exact coverage budget contract and a 300-second cap. It never runs Claude.
- `evidence1-hyperv-verify-canary-dryrun-v3-direct.ps1`: separate registered Product and
  FreeBaseline plans, one session each, without spawning agents or writing live records.
- `evidence1-hyperv-read-wet-forensics-direct.ps1`: read-only, hash-bound projection of an
  existing wet-gate marker and product JSON. No guest deployment, readiness refresh, retry,
  stderr or agent-artifact access. See the validation companion for original-subject anchors.

Readiness's eight-cell dry-run does not replace these stages. Updating the guest harness also
does not update the host task's allowlist: deploy the reviewed operational checkout to the
actual task action path while the task and queue are idle. Keep the trusted directory unchanged.

## Standard Retake Flow

### Dependency Cache Provisioning

If a preserved offline diagnostic proves missing dependencies, use
`evidence1-hyperv-provision-gradle-cache-direct.ps1` with the original
`TargetCommit`, `TargetTree`, `ExpectedReportSha256` and a new 32-hex
`ProvisionId`. This is an explicitly authorized provisioning operation, not a
retry of the diagnostic, V2, or a live cell. Never delete old attempt markers.

The operation holds the validation lease and snapshots source/record custody.
It warms the disposable guest Gradle home using the pinned source's aggregate
unit-test task and both Demo/Prod coverage-report tasks. Temporary HTTPS rules
are limited to the selected Java 21 executable and resolved public addresses of
Google Maven, Maven Central and the Gradle Plugin Portal (including its artifact
redirect host). These are IP restrictions, not hostname-level enforcement.
Default outbound blocking stays enabled; rules are removed and the original
firewall fingerprint is verified before certification.

Java and its child JVMs use an operation-local `jdk.net.hosts.file` containing
that exact address snapshot, supplied only around the contained Gradle process
via `JAVA_TOOL_OPTIONS`. The original process environment is restored, the
system hosts file is untouched, and TLS hostname/certificate checks remain on.
This closes the race between independent DNS resolutions and firewall IP rules.
The mechanism is documented for controlled testing by
[Oracle's Java networking guide](https://docs.oracle.com/en/java/javase/21/core/java-networking.html).

To inspect a completed provisioning operation, reuse its original arguments with
`-ReadDiagnostics`. This mode does not reserve or execute another operation,
compile, modify rules or alter VM topology. It verifies the saved log hashes and
returns closed connection/resolver counters only. Its separate read receipt does
not overwrite the warm/certify reports; no log text, URL, IP or credentials are
returned. Later resolver differences prove drift, not the historical peer IP.

Certification copies the complete allowed Gradle dependency cache, including
metadata, to a fresh directory and runs the same tasks from a fresh source clone
with `--offline` and every VM network adapter disconnected. It requires clean
process teardown and successful tasks; a cache miss is never readiness success.
Original source, harness records and prior failed receipts remain unchanged.

The host emits only closed structured receipts under its operational scratch
directory. No model is invoked and no agent raw transcript is opened. An
uncertain transport or firewall cleanup leaves the VM disconnected, with the
immutable topology journal retained. Do not reconnect until temporary rules are
confirmed removed and old execution cannot resume. A provisioning PASS does not
replace post-merge V1, V2, V3 or authentication checks.

1. Update the guest harness from the current target:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-update-harness-from-bundle.ps1 `
  -ScriptArgumentsJson '["-TargetCommit","<40-hex commit>","-TargetTree","<40-hex tree>"]'
```

`TargetCommit` and `TargetTree` must match. If omitted, the update script resolves `origin/develop`
after fetching.

2. Regenerate readiness in the VM:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-regenerate-readiness-direct.ps1 `
  -ScriptArgumentsJson '["-TargetCommit","<40-hex commit>","-TargetTree","<40-hex tree>"]'
```

3. Run the separately authorized remote-auth canary. It makes one minimal Claude request without
accessing a repository, skill, or tools. It deliberately does not use `--bare`, because bare mode
skips OAuth/keychain reads and cannot validate the interactive Claude login. Instead, it runs from
an empty temporary directory with only user settings, disables slash commands and built-in tools,
and forces an empty MCP configuration with `--strict-mcp-config`.
Its only durable output is a privacy-safe record: event counts, terminal flags, sanitized HTTP
statuses, and no raw model content. A successful
`claude auth status` alone is not sufficient because it only proves local credential presence.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-verify-guest-claude-auth-direct.ps1 `
  -ScriptArgumentsJson '["-RunRemoteAuthCanary","-RemoteAuthCanaryAuthorizationPhrase","<exact separately authorized canary phrase>"]'
```

The canary record expires after 30 minutes and is invalidated by credential-override environment
variables. Do not replace this step with an interactive-login artifact or a previous live result.

### Remote-auth recovery

If the local status passes but the remote canary returns `401`, treat the saved OAuth credential as
expired or revoked. Do not launch live and do not retry the canary before the operator renews the
interactive login. The allowlisted recovery sequence is:

1. `evidence1-hyperv-open-temporary-auth-egress.ps1` temporarily changes the guest firewall's
   outbound default to `Allow` and disables Edge QUIC. Before opening egress it arms a SYSTEM
   watchdog that restores outbound blocking after 15 minutes, including after a suspended guest
   resumes. Its report explicitly marks that readiness and live are forbidden until reseal.
2. `evidence1-hyperv-open-claude-login-interactive-task.ps1` starts the existing desktop launcher
   in the already logged-on `Evidence1` session. It never reads or enters credentials. The operator
   alone completes the browser authentication.
3. `evidence1-hyperv-open-vmconnect.ps1` exposes the guest desktop without injecting keys or text.
4. After the operator finishes, `evidence1-hyperv-run-network-seal-direct.ps1` stops the temporary
   auth processes, removes the interactive task, deploys the reviewed network-seal script and
   proves required Claude endpoints are reachable while unrelated destinations are blocked.
5. Regenerate readiness and run one fresh remote-auth canary. Only a passing fresh canary permits
   the separately authorized live handoff.

The recovery scripts persist only closed counts, booleans, task state and safe status codes. They
do not persist browser content, process command lines, resolved addresses, authentication identity,
tokens or error prose. A failed or interrupted reseal is a HARD STOP.

4. Start the authorized handoff only after readiness PASS, a fresh passing remote-auth canary, and
a fresh live authorization phrase. The state flow is deliberately singular:

`Running + verified -> Off -> Armed -> Running`

The coordinator verifies the exact commit/tree anchors, verifies prior-run terminal custody, asks
the guest to shut down through the normal Hyper-V integration path, stages one autorun while the
VHD is offline, and starts the VM again. It never uses `Stop-VM -TurnOff`, never falls back to a
hard power cut, and never replaces an existing autorun or run artifacts.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-start-authorized-live.ps1 `
  -ScriptArgumentsJson '["-ExpectedTargetCommit","<40-hex commit>","-ExpectedTargetTree","<40-hex tree>","-LiveAuthorizationPhrase","<literal authorization phrase>"]'
```

The command writes a privacy-safe handoff state record under
`C:\kmp-eval\scratch\hyperv-start-authorized-live`. Treat any state other than `started` as a HARD
STOP. Do not rerun the command to repair `stopping`, `off`, `armed`, or `failed`; inspect the state
and preserve custody first. A previous `started` handoff can be superseded only after
`evidence1-hyperv-copy-live-artifacts.ps1` has copied terminal custody for the same run id. That
custody is either a complete passing copy or the exact fail-closed incomplete-wrapper shape;
neither state authorizes a retry of the consumed arm.

5. Monitor progress without raw access:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-read-live-progress.ps1
```

6. If the progress summary is not enough, read bounded operational tails only:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-read-live-operational-tail.ps1
```

7. After the VM has stopped, copy terminal artifacts:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-copy-live-artifacts.ps1 `
  -ScriptArgumentsJson '["-ExpectedRunId","<run-guid>"]'
```

If the host restarted after a one-cell handoff and readiness later restarted the VM before
terminal custody was copied, use the same copy operation with `-GracefulShutdown`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File docs\audits\evidence1-host-elevated-runner-client.ps1 `
  -ScriptPath docs\audits\evidence1-hyperv-copy-live-artifacts.ps1 `
  -ScriptArgumentsJson '["-ExpectedRunId","<run-guid>","-GracefulShutdown"]'
```

This recovery is valid only when the current placement and handoff records identify that exact
run and PowerShell Direct can read a terminal wrapper or launcher record bound to the same arm,
single-session plan, and binding hash. The script reads only the two structured terminal JSON
files; it does not inspect process command lines, raw transcripts, stderr, prompts, or responses.
Only after that terminal proof does it publish `vm_shutdown_dispatch_pending`, request a normal
guest shutdown, publish `vm_shutdown_interrupted` after Hyper-V accepts the request, wait for
`Off`, and follow the existing read-only mount and copy path. Those two checkpoints distinguish
an interruption before dispatch from one after dispatch without claiming that shutdown completed.
It never uses `-TurnOff` or another hard-power fallback. A terminal
`canary_custody_incomplete` report closes the consumed attempt without authorizing a retry;
arbitrary failed copy reports still block V2 and later live work. Do not rerun an interrupted or
failed shutdown blindly: preserve its report and inspect the privacy-safe state first.
Pre-schema copy reports are archival input only. The copy script preserves one historical PASS
shape when its keys are exact, the VM and terminal are closed, and `raw_content_read` is exactly
`false`; its archive identity is the report SHA-256. It is never accepted as custody for a new
canary and every other legacy shape remains a HARD STOP.

## One-Cell Stage L

The standard eight-cell flow above remains available only under its own authorization.
For a registered single-cell canary, follow the separate
[Stage L contract](evidence1-post-merge-validation.md#stage-l-one-cell-handoff). The same host
handoff entrypoint accepts the following additional arguments as one complete set:

```powershell
-CanaryArm <product-or-free-baseline> -CanaryRunId <machine-generated-run-guid> `
  -WetReportPath <exact-passing-V2-host-report> -ExpectedWetReportSha256 <V2-sha256> `
  -DryReportPath <exact-passing-V3-host-report> -ExpectedDryReportSha256 <V3-sha256>
```

Continue supplying `ExpectedTargetCommit`, `ExpectedTargetTree`, and the NEW selected-arm
`LiveAuthorizationPhrase` obtained after V3. The stable phrase is documented in the contract;
UUIDs and hashes are machine-bound in immutable records, not part of the human phrase.
Neither generic engineering authorization nor the eight-session phrase authorizes this path.

V2/V3 report paths may use unique filenames under their existing host report roots. V1 uses
the canonical current readiness report. Original failed V2 reports and source files remain
intact; live materialization starts from a fresh pinned clone. The guest canary bundle under
`C:\Evidence1Ops\canary\<run-guid>` retains binding, report bytes and exclusive claims.
The host copy command requires that exact `ExpectedRunId` and checks staged-module hashes
on the mounted volume, not merely the host checkout. A copied terminal for another arm or
binding cannot close the attempt. Missing custody is not repaired by a new run.

Progress reads only a closed summary from the run-bound journal, including bounded pending
atomic publication. The canary never selects a newest journal, retries a cell, or promotes a
bare process exit to successful terminal custody. Primary and secondary failure diagnoses
are separate; raw exception text and per-cell transcript content are not projected.

## Disconnected Offline Diagnostic

This is an explicitly authorized diagnostic, not V2, a live canary, or a replacement
for any reserved attempt. Use the existing elevated client with
`evidence1-hyperv-probe-gradle-offline-direct.ps1` and these arguments:

```powershell
-TargetCommit <original-failed-V2-commit> -TargetTree <original-failed-V2-tree> `
  -ExpectedReportSha256 <preserved-host-V2-report-hash> -DisconnectNetwork
```

The host records an immutable recovery journal under
`C:\kmp-eval\scratch\hyperv-offline-isolation`, bound to the host, VM, original
subject and report hash. It disconnects the VM's existing adapters from their
switches, verifies their state before dispatch and while waiting, and uses
PowerShell Direct, which does not require networking. It never removes adapters,
changes firewall rules, opens repository egress, changes pins, or clears old attempts.
The guest independently rejects connected adapters and uses a copied dependency
cache and disposable source checkout for one offline Gradle invocation.

A managed owner thread holds the existing guest validation mutex across remote
calls, from pre-disconnect checks until verified restoration. This lease is
process-local, not a durable credential or crash-recovery claim. The immutable
host journal also blocks both offline dispatch modes after process loss, including
when no guest attempt marker was created. `isolated_on_return` reports final
observed disconnection separately from the pre-dispatch check; null means unknown.

Guest receipt schema 3 explicitly records `isolation_mode=vm-adapters-disconnected`
and `checks.network_disconnected`; `network_sealed` remains false. Historical
receipt schemas 1 and 2 retain their existing firewall-based meaning. The outer
schema 2 report records restoration separately from the Gradle result. A cache
miss is diagnostic evidence, never `validation_pass=true`.

After a completed invocation with confirmed cleanup, the host restores the exact
original switch GUID for each adapter, leaving originally disconnected adapters
disconnected. Transport loss, a guest timeout, uncertain cleanup, or changed
topology leaves the VM disconnected with `network_restore_required`. Do not rerun
the diagnostic. The same entrypoint's mutually exclusive `-RestoreNetwork` mode
restores from the preserved journal without dispatching anything and **requires
the VM to be Off**, excluding delayed dispatch by an old guest runspace. Recovery
does not shut down or restart the VM itself. Never hard-power-off an active run or
delete the journal to get another attempt. `-AuditNetwork` remains read-only.
Recovery binds the supplied original pins/report hash to the journal and does not
depend on the mutable wet-report file still being available.

## Verification

This toolkit is covered by `tests/vitest/evidence1-hyperv-ops-toolkit.test.js`, which checks:

- PowerShell parse health on Windows.
- No private host paths or stale SHA pins in the versioned ops scripts.
- Elevated runner allowlist remains narrow.
- The authorized live handoff owns the complete VM state transition without a hard-power fallback.
- Existing autoruns and uncopied prior-run artifacts fail closed instead of being replaced.
- Documentation preserves the no-live authorization boundary.
- A live launcher requires a recent privacy-safe remote-auth canary rather than treating local
  login state as proof of remote credential acceptance.
