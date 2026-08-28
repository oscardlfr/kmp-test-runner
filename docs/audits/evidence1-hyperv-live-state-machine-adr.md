# Evidence1 Hyper-V Live Handoff State Machine

## Status

Accepted for the offline operations toolkit. This decision does not authorize or execute live
sessions.

## Context

Evidence1 readiness and remote-auth verification require a running guest. Safe VHD mutation
requires an off guest. The earlier toolkit exposed autorun placement directly, required the VM to
already be off, and removed stale live files. That left the shutdown transition outside the
versioned workflow and made it possible to replace an armed or incomplete run.

The live authorization contract also prohibits retries, replacements, and respawns. Operational
convenience therefore cannot silently clean up or recreate a run after a partial handoff.

## Decision

Use one allowlisted privileged coordinator,
`evidence1-hyperv-start-authorized-live.ps1`, for the complete transition:

`Running + verified -> Off -> Armed -> Running`

Before mutation it must validate:

- the exact live authorization phrase;
- fresh readiness evidence bound to the requested full commit and tree SHAs;
- the canonical VM, source commit, Claude version, session count, and attestation location;
- a fresh, passing, privacy-safe remote-auth canary produced after readiness;
- copied terminal custody for any previous placement, bound to the same prior run id; and
- an initial VM state of `Running`.

The coordinator then requests a normal guest shutdown with `Stop-VM` and a bounded wait. It has no
automatic hard-power fallback. Once the VM is `Off`, it invokes the internal placement script,
records the new run id as `armed`, starts the VM, and records `started` only after Hyper-V reports
`Running`.

The low-level placement script is not exposed through the elevated-runner allowlist. It refuses an
existing `Evidence1RunLive.cmd` unless the file is bound to the same prior run id whose terminal
custody has already been copied; a proven-consumed entry is archived rather than deleted. Existing
operational artifacts follow the same rule and move to a run-scoped archive. The script never
overwrites those artifacts as part of a new launch.

## Invariants

| Invariant | Enforcement |
| --- | --- |
| One launch mutation entry point | Only the coordinator is allowlisted |
| No hard power cut in normal flow | No `-TurnOff` or forced-stop fallback |
| No run replacement | Existing autorun is a HARD STOP |
| No evidence overwrite | Prior artifacts require closed custody and are archived by run id |
| Exact source binding | Readiness host and guest commit/tree must match requested anchors |
| Exact campaign binding | VM, source, Claude, session count, and attestation path are fixed |
| Fresh remote access proof | Passing canary is bounded by age and must postdate readiness |
| Privacy-safe host state | Handoff records contain anchors, states, run ids, booleans, and codes only |
| No implicit retry | Interrupted/nonterminal handoff records block another launch |

## Failure And Recovery

Any failure leaves a privacy-safe handoff record with the last phase and exits nonzero. Operators
must not rerun automatically:

- `validated` or `stopping`: inspect VM state and the shutdown job outcome.
- `off`: confirm no autorun was staged before deciding how to recover.
- `armed`: preserve the VHD and startup entry; this is an authorized run that has not been proven
  consumed.
- `failed`: use `failure_kind` plus VM state to classify the interruption without opening raw
  model output.
- `started`: monitor by run id, then copy terminal custody after the guest stops.

A hard shutdown is an explicit incident response outside this coordinator, never an automatic
continuation of the live workflow.

## Alternatives Rejected

- **Standalone allowlisted stop script:** permits state mutation without tying it to evidence,
  authorization, placement, and restart.
- **`Stop-VM -TurnOff` or automatic force fallback:** risks guest/VHD corruption and hides a failed
  graceful-shutdown boundary.
- **Keep direct autorun placement:** allows callers to bypass prerequisite and custody checks.
- **Delete stale files on every placement:** converts an interrupted authorized run into an
  untracked replacement.

## Consequences

The workflow is intentionally stricter and may stop for manual incident review. In exchange, every
normal launch has one state machine, one run identity, explicit prior-run custody, and a reproducible
failure point. Post-launch progress and artifact-copy scripts remain read-only with respect to model
content.
