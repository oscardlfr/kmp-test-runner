# Evidence1 Post-Merge Validation

This is the executable operational companion for Stage V of the success-recovery runbook.
It does not authorize live sessions. V1's eight-cell campaign dry-run is not a substitute for
V2 or V3. A PASS is valid only for the exact harness commit/tree, source commit, and isolation
attestation checked by the corresponding stage.

## Scope and Custody

- Leave unrelated worktrees and the maintainer's uncommitted VM toolkit unchanged.
- Merge through a PR to `develop`, with required CI passing, then record its full squash SHA
  and tree SHA. Never deploy a floating branch as measurement evidence.
- Do not change the product, skill pin, scenario, expected outcome, or grader to make a gate pass.
- Use PowerShell Direct through the existing elevated runner. Never type commands into a focused
  desktop window and never run the target Gradle project on the host.
- A validation failure is a HARD STOP. Retain its report; do not retry the wet gate automatically.
- No transcript, model prompt/response, credential value, or model stderr is needed by these gates.

## Install the Reviewed Operational Version

The scheduled task loads its runner script when started. Updating a different worktree does not
update the task's allowlist. Before replacing its deployed checkout:

1. Read the task action to identify its actual runner path and allowed root.
2. Verify the task is idle and both request and in-progress queues are empty.
3. Verify the deployed checkout is clean. Do not reset, clean, stash, or overwrite local changes.
4. Move that checkout to the reviewed squash commit, using a detached checkout. Verify its tree.
5. Verify the runner now explicitly allowlists the two Stage V validation entrypoints. Preserve
   the allowed directory, task identity, and queue root; do not add arbitrary script execution.

If a task must be installed at a new location, use the existing
`evidence1-host-elevated-runner-install.ps1` from an elevated session. Do not route installation
through a renamed allowlisted script or a generic privileged command. The non-elevated client
must use the allowed root in the installed task, not assume its current working directory.

The new validation module has an explicit LF rule in `.gitattributes`: its byte hash must
remain identical across host and guest checkouts with different `core.autocrlf` settings.

## Client Invocation

Resolve `$opsRoot` from the installed task's `AllowedRoot`, and set `$commit`/`$tree` to the
reviewed squash anchors. Use the existing client once per stage; inspect its terminal report
and stop on failure before issuing the next command. This example is for V2:

```powershell
$client = Join-Path $opsRoot 'evidence1-host-elevated-runner-client.ps1'
$arguments = @('-TargetCommit', $commit, '-TargetTree', $tree)
& $client -AllowedRoot $opsRoot `
  -ScriptPath (Join-Path $opsRoot 'evidence1-hyperv-verify-wet-gate-v2-direct.ps1') `
  -ScriptArguments $arguments -TimeoutMinutes 15
if ($LASTEXITCODE -ne 0) { throw 'HARD STOP: V2 failed; inspect its safe terminal report.' }
```

V3 uses the same arguments with `evidence1-hyperv-verify-canary-dryrun-v3-direct.ps1`, only
after V2 passes. For each V1 entrypoint, add `'-SourceRepoDir', $sourceRepo` to the arguments,
where `$sourceRepo` is the clean reviewed checkout, and use `-TimeoutMinutes 30`.
Neither validation entrypoint has an override to retry a consumed attempt.

## V1: Deploy and Refresh Readiness

Invoke `evidence1-hyperv-update-harness-from-bundle.ps1`, then
`evidence1-hyperv-regenerate-readiness-direct.ps1`, through
`evidence1-host-elevated-runner-client.ps1`. Supply the clean source checkout and exact
`TargetCommit`/`TargetTree` to both scripts. Check their terminal JSON reports.

Require the guest harness to match those anchors, the pinned target source to be clean, the
isolation attestation to be fresh, the restricted-network checks to pass, and the pinned runtime's
local auth check to pass. The existing full campaign dry-run remains an eight-cell readiness
check. It must not create live records.

Deployment checks tracked-file and index custody before checkout. It never restores edited
scenario fixtures to obtain a clean status; staged edits and concealed index entries stop it.
Its existing archive policy applies only to recognized untracked finalized artifacts.

For the target source, clean means unchanged tracked files and index, plus only the exact
bounded generated artifacts accepted by V2/V3's source inventory. Readiness fingerprints that
inventory and must leave it unchanged, including on its failure path. It must not delete the
previous wet gate's outputs, add ignore rules, or treat all of `.kmp-test-runner` as trusted.
This operational definition does not relax the CLI's separate clean source-donor requirement
for a live run.

Local `claude auth status` proves local credential presence only. A remote authentication
canary, when separately authorized, is a different gate. Neither is run by V2/V3.

## V2: One Deterministic Product Invocation

`evidence1-hyperv-verify-wet-gate-v2-direct.ps1` runs the product from the checked harness
commit inside the VM, against the pinned target source. The logical command is exactly:

```text
kmp-test parallel --json --project-root . --module-filter ":core:domain" --min-missed-lines 15
```

It does not use a possibly stale global product installation, run Claude, or repair the project.
Gradle can write build outputs and the product can write reports inside the guest. This is a
real wet gate, not a read-only or dry-run operation.

The source postflight distinguishes those writes from source edits. It inventories only the
product's model/task cache filenames and versioned/latest coverage Markdown reports under
`.kmp-test-runner`; other untracked files, links, lock/config files and unsupported output
directories fail closed. Tracked bytes, index entries, commit and tree must remain unchanged.
No `.gitignore`, Git exclude file or tracked source file is edited to hide generated output.
V3 accepts the existing allowed inventory from V2 but must leave it unchanged.
The exact empty `init-scripts` directory left by `cleanupInitScript` is also allowed;
no files or nested directories inside it are accepted. Interrupted or retained init-scripts
remain a custody failure, not ordinary cache data.

V2 prepares `JAVA_HOME` and `PATH` in the effective PowerShell Direct process, selecting the
installed Adoptium JDK 21 as readiness does. It verifies the selected executable with a bounded
`java -version` probe before consuming the wet-attempt marker. It rechecks evidence before the
product starts and restores the previous process environment afterward. An earlier session's
`java_present` observation alone is not proof of the current process toolchain.

The validator scopes `GRADLE_OPTS=-Dorg.gradle.daemon=false` to its product invocation and
restores the previous value afterward. This prevents a pre-existing reusable Gradle daemon
from doing the build outside the invocation's owned process tree. A disposable single-use
Gradle JVM remains subject to that tree's timeout. It does not stop unrelated Gradle daemons.
See [Gradle's daemon documentation](https://docs.gradle.org/current/userguide/gradle_daemon.html#sec:disabling_the_daemon).

| Field | Required value |
|---|---|
| `tool` | `kmp-test` |
| `tests.total / passed / failed` | `1 / 1 / 0` |
| `tests.individual_total` | `4` |
| `coverage.missed_lines` | `23` |
| `coverage.modules_contributing` | `1` |
| `coverage.module_buckets.with_data` | exactly `[":core:domain"]` |
| `errors` | exactly one `coverage_threshold_exceeded` |
| Error `threshold / missed_lines` | `15 / 23` |
| Product process and envelope exit code | `1` |
| Product wall time | at most 300 seconds |

A product exit code of 1 is expected here; it is not by itself a validation failure. The
validation script succeeds only when the entire contract matches. Timeout, missing fields,
wrong types, extra errors, stale anchors, or an unevaluable result fail closed. Preserve the
structured failure and investigate the product/toolchain; do not modify the grader or skill.

## V3: Two Independent One-Cell Plans

`evidence1-hyperv-verify-canary-dryrun-v3-direct.ps1` validates one Product plan and one
FreeBaseline plan for `coverage-threshold-failure-v2`. Both use the registered CLI planning
contract, not a slice of an eight-cell result.

The registered designs are `claude-product-canary-v1` and
`claude-free-baseline-canary-v1`. The CLI contract is:

```text
node tools/agentic-eval/cli.mjs run --scenario coverage-threshold-failure-v2 --source-repo-dir <isolated-source> --runtime claude-code --campaign-design <registered-canary-design> --seed 20260821 --max-budget-usd 2.00 --isolation-attestation-file <fresh-attestation> --dry-run
```

Use the operational V3 script for guest execution and report validation; the CLI spelling here
documents the actual interface. Neither `--repeats` nor an ad hoc arm selector is needed.

Each plan must contain exactly one session with the pinned harness/source/scenario, the fresh
attestation binding, and the expected condition/product-access mode. Product uses
`current-skill` with `product-assisted`; FreeBaseline uses `no-skill` with
`free-baseline-no-product`. Both retain `sandboxed-unrestricted-v1`.

This stage must spawn no agent and write no live run record. A valid plan proves planning and
preflight checks, not a successful benchmark result or successful runtime authentication.

## Handoff and Failure Rules

### Preserve Independent Operational Failures

New validation reports use operational schema 2. `failure_code` remains the terminal summary;
`failures.primary`, `failures.postflight`, `failures.persistence` and `failures.transport`
independently retain closed error codes. A failed product check must not erase a later custody
failure, and a write failure must never leave the returned result marked as passed.

`processes.product`, `processes.product_dry_plan` and `processes.free_baseline_dry_plan` retain
only `exit_code`, `wall_seconds`, `timed_out` and `cleanup_ok` when those observations exist.
Unavailable observations remain null. These are operational process facts, not product outcomes
or agent metrics. Schema 1 remains accepted without inventing these new fields or rewriting
historical files. Safe validation rejects extra keys, free text and coerced numeric/enum values.

### Read an Existing Failed Wet Gate

For `source_artifacts` before a wet attempt, use
`evidence1-hyperv-read-source-inventory-direct.ps1` through the same elevated client with the
current guest `TargetCommit`/`TargetTree`. This separate read needs no fresh readiness and must
run before any repair or new deployment to preserve the failed subject. Update only the idle
host reader checkout first. It validates VM identity and repository anchors, inspects metadata
twice, and returns fixed counts plus an opaque metadata hash. It never reads source/cache/report
contents, descends into unknown directories, or starts product/Gradle/Claude. It writes only a
new host `hyperv-read-source-inventory-direct/INVENTORY-<id>.json`; no guest files are changed.
Names, paths, timestamps and free text are not exported. A successful read is explicitly
`validation_pass: false`: it is not a source-integrity or readiness PASS, and a metadata hash
is not a content-custody proof. Unknown entries require investigation, never blanket acceptance.
The collector refreshes enumerated `FileSystemInfo` metadata before hashing: enumeration can
return a cached directory timestamp even without an intervening write. This preserves the
strict two-snapshot comparison without sleeps, retries or omitted metadata fields. See
[Microsoft's LastWriteTimeUtc caching contract](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesysteminfo.lastwritetimeutc).

Use `evidence1-hyperv-read-wet-forensics-direct.ps1` through the same elevated client. Its required
arguments are the original `TargetCommit`, original `TargetTree`, and `ExpectedReportSha256`
(the SHA-256 of the existing host `HYPERV-VERIFY-WET-GATE-V2-DIRECT.json`). Verify that hash
before submitting the request. This is an explicit read operation, not a retry switch.

```powershell
$arguments = @('-TargetCommit', $originalCommit, '-TargetTree', $originalTree,
  '-ExpectedReportSha256', $originalReportHash)
& $client -AllowedRoot $opsRoot `
  -ScriptPath (Join-Path $opsRoot 'evidence1-hyperv-read-wet-forensics-direct.ps1') `
  -ScriptArguments $arguments -TimeoutMinutes 5
```

Update only the idle, clean HOST operational checkout to the reviewed reader version. Do NOT
deploy a new harness to the guest, refresh readiness, modify source, remove markers or repin
the historical attempt to read it. Historical freshness is not execution authorization.
By default, the reader verifies VM identity, the terminal marker's anchors and the captured stdout hash;
reads only those two fixed wet artifacts; and returns numeric facts and closed error/reason
counts. It never reads model artifacts or stderr, starts product/Gradle/Claude, or writes guest
files. Local outputs are new `FORENSIC-<id>.json` files under the dedicated
`hyperv-read-wet-forensics-direct` scratch directory. Originals are never overwritten.

If those structured codes cannot explain a failed deterministic V2, append
`-IncludeGradleDiagnostics` to the argument array. This explicitly enables a bounded read of
the fixed sibling `wet-v2-<original-commit>.stderr.txt`, ONLY after the original failed marker
and product stdout have been verified. This file is the no-agent product/Gradle stderr, not
an agent transcript. No arbitrary log path is accepted. The reader accepts at most 1 MiB of
strict UTF-8 and exports only a closed map of per-line signature counts, never messages,
URLs, commands, paths, exception names, or captures. Zero counts mean no recognized signature,
not proof of absence. Multiple signatures may describe the same failure; they are not a
root-cause verdict or a count of distinct failures.

The nested Gradle summary now uses schema 2; historical nested schema 1 remains valid
with its exact original keys. Schema 2 adds separate socket-permission, socket-error and
filesystem-denial counters, plus fixed public repository families (Google, Maven Central,
Gradle plugin portal and distributions). These are signature observations only, not proof
that the current firewall caused an error. The legacy `file_permission` counter also matches
generic socket permission messages and must NOT be interpreted as filesystem denial by itself.
Repository families require a failed GET/HEAD and an exact HTTPS hostname boundary; no URL
or artifact coordinate is exported. All historical marker/hash/no-rerun checks still apply.
Windows NIO can report socket denial as `Permission denied: getsockopt` without printing
the exception class. This signature is included alongside `connect`; see the OpenJDK
[Windows socket error mapping](https://github.com/openjdk/jdk21u/blob/master/src/java.base/windows/native/libnet/net_util_md.c)
and [NIO socket calls](https://github.com/openjdk/jdk21u/blob/master/src/java.base/windows/native/libnio/ch/Net.c).

Opt-in reports use forensic schema 2 and add `gradle_diagnostics`,
`gradle_stderr_read_requested: true`, and `hashes.gradle_stderr_sha256` on success.
`stderr_read` is true after a validated receipt, false before remote dispatch, or null if
transport cannot establish whether the read occurred. The stderr digest is captured AT READ
TIME and checked again with the marker/stdout; it is not a historical execution-time digest.
This read does not run Gradle, repair the attempt, refresh readiness, or authorize a rerun.
The default schema 1 behavior and its two-file boundary remain unchanged.

The summary distinguishes missing, null, invalid and recorded values. Unrecognized codes map
to `unknown`; arbitrary error messages/commands/paths are not copied. A schema 1 historical
process exit, duration or secondary postflight exception remains `not-recorded`, since it
cannot be recovered from boolean checks. Newer records may carry those facts independently.
The `module_target` check in historical validation reports binds the PowerShell module file,
not the coverage target; the latter is checked by `with_data`.

Record V1, V2, and V3 independently as `passed`, `failed`, or `not run`, with the matching
commit/tree and report hashes. Never call Stage V complete because readiness alone passed.

Stop on an active run, unknown prior state, unreviewed script version, anchor/attestation drift,
wet-gate failure, or a canary plan with any session count other than one. Do not overwrite a
failed wet-gate record, rerun a consumed invocation, or replace an agent session.

Only after V1-V3 pass may Stage L be considered with its separately required authorization.
The existing eight-session live launcher must not be used as a substitute for a one-cell canary.
Before any future Stage L launch, verify that its operational launcher explicitly supports the
registered canary design and enforces the one-session authorization, progress, and custody
contract. This document does not claim that an eight-session launcher satisfies that contract.

The currently installed Stage L path still has these concrete dependencies:

- `evidence1-stageb-live-launch.ps1` fixes the eight-cell design, the historical scenario, and
  the eight-cell readiness fingerprint. Changing the registry alone does not change them.
- `evidence1-hyperv-start-authorized-live.ps1` and the placement script require the eight-session
  authorization and do not propagate a canary arm.
- The live handoff does not yet consume the V2/V3 reports. A future canary handoff must bind
  those passing reports to the same anchors and attestation, and retain prior-run custody.
- Real CLI execution also checks that its materialization source is clean, unlike a dry-run.
  The allowed V2 output inventory is not a waiver of that separate live-source hygiene gate.
  Resolve source custody explicitly in the future Stage L handoff without deleting failed
  validation evidence or hiding files through ignore rules.

Do not edit those launch contracts incidentally while validating Stage V. Their implementation
and regression tests must be reviewed before Stage L, with one-session authorization and no
fallback to the full matrix. Remote authentication must then be refreshed under its own gate.

## Prevention

Before accepting any future runbook as executable, map every step to a versioned command,
its accepted parameters, a meaningful automated test, and its output validator. Missing
capabilities are implementation prerequisites, not surprises deferred to post-merge validation.

Windows process containment is checked against Microsoft's
[Job Objects documentation](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).
Timeout cleanup must cover the invocation's descendants without terminating unrelated host or
guest work. A terminal PASS must be persisted only after postflight custody and anchor checks,
never immediately after the product process exits.

## Offline Cache Diagnostic (Not V2)

After a preserved V2 dependency-resolution failure, the optional
`evidence1-hyperv-probe-gradle-offline-direct.ps1` entrypoint distinguishes an
explicit offline cache miss from other Gradle failures. It accepts only the failed
V2 `-TargetCommit`, `-TargetTree`, and `-ExpectedReportSha256`. Run it through the
existing elevated-runner client, with a transport timeout of at least 16 minutes.
This is a single diagnostic dispatch, not a retry of V2 and not a live session.

The entrypoint verifies the VM identity, a sealed outbound firewall and absence of
agent/Java processes. It preserves the failed V2 files and source checkout, creates
an independent clone at the scenario's fixed source commit, and copies only Gradle
dependency artifacts/metadata plus the pinned wrapper distribution into a new home.
It excludes ambient init scripts, properties, credentials, daemon state, locks and
build-output caches. No firewall rule is changed. The original home is never used
as the Gradle execution home.

One bounded raw Gradle invocation requests `:core:domain:test` and both demo/prod
unit coverage report tasks with `--offline --no-daemon --no-build-cache`. A guest
receipt under `scratch/gradle-offline-probe-<target-commit>/PROBE.json` reserves the
attempt before dispatch; its directory must not be removed to retry. Host receipts
use unique filenames under `scratch/hyperv-probe-gradle-offline-direct/`.

Only closed codes/counts, process observations and byte hashes leave the guest.
Diagnostic Gradle stdout/stderr stay in the attempt directory, never mixed with
agent transcripts. `offline_cache_incomplete` requires an explicit offline cache
miss diagnostic. Other failures remain `inconclusive`. `offline_tasks_completed`
means the requested task invocation exited successfully, not that the benchmark
contract or exact coverage/test counts passed: `validation_pass` remains false.
V1-V3 and the live gates remain mandatory and unchanged.

Do not enable repository access automatically after a miss. A preparation phase
with narrowly scoped repository access is a separate isolation decision. A future
qualified shared cache must be verified for both arms; this diagnostic's mutable
home is not a qualified benchmark seed.

References: [Gradle dependency caching](https://docs.gradle.org/current/userguide/dependency_caching.html)
documents offline resolution and copying the dependency cache without lock files
or `gc.properties`. The probe deliberately uses a separate full build, not a
mock of dependency resolution or an empty Gradle dry run.
