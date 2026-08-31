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

Use `evidence1-hyperv-read-wet-forensics-direct.ps1` through the same elevated client. Its only
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
The reader verifies VM identity, the terminal marker's anchors and the captured stdout hash;
reads only those two fixed wet artifacts; and returns numeric facts and closed error/reason
counts. It never reads model artifacts or stderr, starts product/Gradle/Claude, or writes guest
files. Local outputs are new `FORENSIC-<id>.json` files under the dedicated
`hyperv-read-wet-forensics-direct` scratch directory. Originals are never overwritten.

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
