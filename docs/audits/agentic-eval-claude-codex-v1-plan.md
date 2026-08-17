# Agentic-eval multi-runtime foundation v1 plan

> Status: approved direction, implementation not started.
> Maintainer scope decision: Claude Code and Codex CLI only for v1. GitHub
> Copilot CLI and Google Antigravity CLI are contract-audited future adapters,
> not v1 implementations. API-only agents are explicitly out of scope.
> Planning evidence includes the focused Windows and macOS coverage-budget
> canaries through PR #435 (squash `3190cde27eaa706302f0aee0a948d3d4e6809a1f`).
> This document does not authorize live sessions, raw-transcript reads, merges,
> or changes to `PINNED_SKILL_SHA`.

## 1. Objective

Evolve `tools/agentic-eval/` from a robust Claude Code-specific evaluation
harness into a small, explicit two-runtime harness that can answer two
separate questions:

1. Within the same runtime, model, CLI version, platform, and execution
   profile, what changes when the `kmp-test-runner` skill is present?
2. For runtimes that support both profiles, what changes when the agent runs
   under the current strict command policy versus a safely isolated environment
   without the harness command allowlist?

The v1 deliverable supports Claude Code and Codex CLI. Adding or removing a
model for either supported runtime must be a validated configuration change,
not a new launcher/parser implementation.

The design is constrained by the separate
[`agentic-eval-runtime-capability-audit-2026-08-17.md`](agentic-eval-runtime-capability-audit-2026-08-17.md),
which also screens Copilot, Antigravity, legacy Gemini CLI, and Microsoft agent
surfaces. Vendor names never create adapters by themselves.

## 2. Why this is a separate train

The existing canaries are valid evidence for their declared scope: Claude Code
under the harness's strict policy. They are not invalidated or retrospectively
regraded by this work.

They also expose the next methodology question. In the focused coverage-budget
canaries, the no-skill arm was structurally accepted but heavily constrained by
policy denials. That is useful evidence about the strict-policy environment, but
it does not establish how an unguided agent behaves when it can explore freely.
The new execution-profile axis addresses that external-validity gap without
weakening or rewriting the existing strict-policy corpus.

The current harness is not runtime-neutral merely because it accepts
`--model`. Its launcher constructs Claude Code arguments; its preflight invokes
`claude auth status`; its parser consumes Claude stream-json events; its skill
proof depends on Claude plugin and `Skill` events; and its integrity/audit path
depends on Claude PreToolUse hook decisions. These are good runtime-specific
contracts and must be preserved behind an adapter, not generalized by renaming
Claude fields.

## 3. Scope

### In scope

- Claude Code and Codex CLI as explicit runtime adapters.
- `current-skill` and `no-skill` conditions for both runtimes.
- `strict-policy-v1` and `sandboxed-unrestricted-v1` execution profiles.
- Runtime-reported native token usage, with missing dimensions represented as not
  recorded rather than zero.
- Runtime-neutral bytes, wall-clock, command/tool-call, retry, success, and
  grading metrics.
- Prospective run-record schema v6; historical v3/v4/v5 records remain frozen.
- Runtime/model registry and capability validation.
- Offline fake-CLI and golden-transcript tests for every runtime/profile path.
- Contract-conformance tests proving Copilot and Antigravity requirements do
  not require changes to the core contract, without implementing either adapter.
- Focused Windows-then-macOS live pilots under separate explicit authorization.

### Out of scope for v1

- GitHub Copilot CLI and Google Antigravity CLI implementation.
- Legacy Gemini CLI, Microsoft AI Shell, Microsoft Foundry hosted agents, and
  Microsoft Conductor as runtime adapters.
- Direct Anthropic/OpenAI API adapters.
- A runtime/model leaderboard or claims that one runtime is generally better.
- Converting runtime-native tokens into a supposedly universal token unit.
- Retrospective mutation or regrading of committed records and sidecars.
- A full-corpus multi-runtime run before the focused pilot passes.
- Any live runtime invocation in CI.
- Any unrestricted execution on a normal maintainer workstation.

## 4. Terminology and experimental axes

The following axes are independent and must never be overloaded:

| Axis | v1 values | Meaning |
|---|---|---|
| Runtime | `claude-code`, `codex-cli` | Agent loop, tools, permissions, skills, and event protocol |
| Model | Registry entry scoped to a runtime | Requested/resolved model identity |
| Model vendor | Runtime-reported or registry-expected data | Never an adapter discriminator |
| Skill condition | `current-skill`, `no-skill` | Presence of the pinned skill snapshot |
| Execution profile | `strict-policy-v1`, `sandboxed-unrestricted-v1` | Command-control and isolation contract |
| Platform | `windows`, `macos` | Host platform; never pooled silently |

`no-skill` means the skill is technically absent, not that the prompt asks the
agent to pretend it is absent. `sandboxed-unrestricted-v1` means the harness
command allowlist is absent inside a disposable containment boundary. It never
means unrestricted access to the maintainer's normal host.

The required v1 capability matrix is deliberately not a forced Cartesian
product:

| Runtime | `strict-policy-v1` | `sandboxed-unrestricted-v1` |
|---|---|---|
| Claude Code | Required | Required |
| Codex CLI | Optional, only with equivalent auditable control | Required |

This supports a same-profile Claude-vs-Codex descriptive comparison and a
within-Claude policy-effect comparison without pretending that Claude hooks and
Codex sandbox controls are equivalent. A future runtime-neutral command broker
may add strict Codex support, but it is not a v1 prerequisite.

## 5. Architecture decisions

### ADR-1: runtime adapter, not a universal event format

Add a narrow runtime boundary and keep runtime-specific protocol parsing
inside it. Normalize only the evidence the core actually consumes.

Proposed layout:

```text
tools/agentic-eval/runtimes/
  contract.mjs
  registry.json
  claude-code.mjs
  codex-cli.mjs

tools/agentic-eval/execution-profiles/
  contract.mjs
  strict-policy-v1.mjs
  sandboxed-unrestricted-v1.mjs
```

The adapter contract is:

```js
{
  id,
  protocolVersion,
  capabilities,
  probeInstallation(context),
  preflight(context),
  prepareIsolatedHome(context),
  prepareSkillDelivery(context),
  buildInvocation(context),
  collectObservationSources(context),
  normalizeObservations(sources, context),
  redactRuntimeDiagnostics(value)
}
```

The core receives a canonical condition result containing process outcome,
structured transcript status, correlated tool attempts/results, terminal shell
evidence, usage, skill-state evidence, and dispatch accounting. It does not
receive raw Claude or Codex events.

Rejected alternative: one large parser with runtime conditionals. That would
spread runtime drift through lifecycle, integrity, audit, and graders, making a
new model easy to add but a new runtime dangerous to remove.

### ADR-2: execution profile is independent of runtime

An execution profile owns:

- profile ID, version, and content hash;
- command-control mode;
- containment requirement and attestation;
- network mode;
- environment/secret allowlist;
- expected dispatch-accounting strategy;
- profile-specific integrity gates.

Runtime adapters translate that contract into runtime-specific invocation
settings. The core validates the resulting accounting against the selected
profile.

`strict-policy-v1` freezes the existing Claude hook behavior. Codex support for
this profile is not assumed: it must either implement an equivalently auditable
broker or declare the capability unsupported. Unsupported combinations fail at
dry-run/preflight and consume zero sessions.

`sandboxed-unrestricted-v1` removes the harness command allowlist but retains
tool-call/result correlation and complete command accounting. Policy fields are
`not_applicable`, never fabricated as allow decisions and never counted as zero
denials from a policy that did not run.

### ADR-3: safe isolation is a hard prerequisite

The current policy hook explicitly is not an OS/filesystem sandbox. Therefore a
no-policy run may proceed only in a disposable VM, disposable dedicated runner,
or equivalently reviewed external containment boundary with:

- no maintainer data mounted;
- a campaign-specific workspace as the only writable project surface;
- no ambient secrets beyond the minimum runtime credential;
- a documented network mode;
- disposable HOME/user state;
- rollback or destruction after evidence preservation;
- an isolation attestation recorded in the run metadata.

Runtime flags such as a built-in workspace sandbox are defense in depth, not a
substitute for the common external boundary. If a runtime cannot authenticate
and operate under this contract without exposing a normal user home, the
profile is blocked for that runtime. Never use a dangerous permission bypass
on the normal host.

### ADR-4: CLI ecological validity, APIs later

v1 evaluates the actual CLIs because skill discovery, tool availability,
permissions, event streams, and command execution are part of the behavior we
want to measure. API-only agents would be a different benchmark and must not be
pooled with CLI runs.

### ADR-5: prospective schema v6, frozen history

New runtime-neutral records use schema v6. Existing v3/v4/v5 records and v1/v2
accepted-audit sidecars continue to validate byte-for-byte under frozen
dispatch. Absence of a new metric in historical evidence renders as `not
recorded`, never zero.

The v6 record adds these canonical groups:

```json
{
  "agent_runtime": {
    "runtime_id": "claude-code|codex-cli",
    "cli_version": "exact string",
    "model_requested": "exact string",
    "model_resolved": "exact string or null",
    "model_vendor_expected": "anthropic|openai|google|microsoft|other|null",
    "model_vendor_observed": "exact runtime value or null"
  },
  "execution_profile": {
    "id": "strict-policy-v1|sandboxed-unrestricted-v1",
    "sha256": "profile hash",
    "isolation_kind": "exact enum",
    "isolation_attestation_sha256": "hash or null",
    "network_mode": "exact enum"
  },
  "skill_observation": {
    "delivery_mode": "runtime-specific closed enum",
    "availability": {
      "status": "observed-present|observed-absent|not-observable",
      "evidence_kind": "runtime-specific closed enum"
    },
    "activation": {
      "status": "confirmed|indirect|not-observed|not-observable",
      "evidence_kind": "runtime-specific closed enum"
    },
    "source_sha": "pin or null"
  },
  "usage": {
    "source": "runtime-reported|offline-estimate|not-recorded",
    "input": null,
    "cached_input": null,
    "cache_write": null,
    "output": null,
    "reasoning_output": null
  }
}
```

The exact allowed enums are locked by the schema PR. No generic `tokens_total`
is derived by adding dimensions whose runtime/model semantics differ.

If accepted sidecars need runtime/profile fields, introduce sidecar schema v3
with frozen v1/v2 validation. Do not add optional unvalidated fields to v2.

### ADR-6: model registry is configuration, not branching code

`runtimes/registry.json` and `models/registry.json` are validated and contain
only stable execution
metadata:

- runtime ID;
- model ID;
- expected model vendor, when known;
- enabled flag;
- optional default reasoning mode;
- required adapter capabilities;
- declared usage dimensions.

It does not contain credentials. It does not calculate cost from a mutable
undated price table. Adding/removing a model for an existing runtime is a
registry-only change plus validation tests. The adapter must not switch on model
names except where a documented runtime capability genuinely differs.

### ADR-7: comparisons are partitioned before aggregation

Hard aggregation keys are at least:

- runtime ID;
- model requested/resolved;
- expected/observed model vendor when available;
- runtime CLI version;
- execution-profile ID/hash;
- platform;
- run-record schema;
- skill source SHA;
- scenario/corpus version;
- harness and project commits.

The primary effect is `current-skill - no-skill` within one complete partition.
Runtime-native token counts are shown in runtime/model-specific columns and may
not be ranked as if they shared a tokenizer or hidden prompt. Cross-runtime tables
may compare success, wall-clock, commands, tool calls, and output bytes
descriptively, while preserving separate native-token columns.

## 6. Integrity model

### Universal gates

Every accepted cell, regardless of runtime/profile, proves:

- runtime preflight succeeded before session spend;
- process was not terminated and produced a supported terminal result;
- structured transcript parsed without unaccounted malformed events;
- every relevant tool call has a correlated result or a closed, recognized
  pre-dispatch outcome;
- every shell attempt is present in canonical dispatch accounting;
- terminal evidence is selected deterministically;
- existing scenario graders consume only normalized observed evidence;
- privacy/redaction and artifact binding pass;
- runtime, model, profile, platform, commits, and skill identity are bound to
  the record and sidecar.

### Runtime-capability gates

Skill activation is not forced into false equivalence:

- Claude may provide confirmed plugin/`Skill` event evidence.
- Codex must first be characterized against its pinned CLI version.
- If Codex proves availability but not activation, record `available-only`.
- A metric that is not observable cannot be required for acceptance and cannot
  be presented as false or zero.

### Profile gates

`strict-policy-v1` keeps per-attempt policy decisions and the current
biconditional dispatch invariants.

`sandboxed-unrestricted-v1` requires the isolation attestation plus complete
runtime-derived command/result accounting. It must reject any missing attempt
even though no allow/deny hook exists. A missing policy decision is valid only
when the selected profile declares policy `not_applicable`; it is never a
fallback from a broken strict-policy capture.

## 7. Token and cost contract

For each accepted record, capture:

1. runtime-reported usage dimensions exactly as exposed;
2. stdout/stderr/tool-result byte counts as the runtime-neutral context proxy;
3. wall-clock, turns, tool calls, shell calls, test invocations, and retries;
4. optional offline canonical text-volume estimate, clearly labelled as an
   estimate and never as billable tokens;
5. runtime-reported cost or AI units only when directly exposed and bound to a
   dated runtime contract.

Never infer zero for an unavailable token dimension. Never infer cost from a
current web price during aggregation of historical records. If a future cost
snapshot is added, it is a separate dated artifact and results retain both the
native usage and snapshot identity.

Reports lead with task success and integrity. Token deltas are secondary and
reported within runtime/model partitions. A Claude-with-skill run must never be
compared causally with a Codex-no-skill run.

## 8. Execution protocol for every phase

These controls are part of the plan, not optional ceremony.

### Entry gate

Before each PR:

1. fetch with prune and record exact `origin/develop` SHA and tree;
2. create a new branch and worktree from that exact remote SHA, never from a
   campaign/evidence worktree or the dirty main checkout;
3. prove the new worktree is clean and the requested branch/path did not already
   exist;
4. inventory and hash the main checkout's pre-existing WIP, stash list, campaign
   worktrees, committed evidence counts, and every explicitly protected path;
5. run only the phase's named baseline tests and record exact counts;
6. hard stop on base drift, unexplained baseline failure, missing evidence,
   unexpected worktree dirt, or an unavailable required tool.

Do not update a branch from `develop` mid-phase. If the base moves and branch
protection later requires an update, use a separate administrative rebase with
blob/patch identity proof and re-audit the new HEAD before merge.

### Implementation discipline

- One phase, branch, worktree, PR, and behavioral objective at a time.
- Production changes use RED -> GREEN tests. A RED test must fail for the named
  missing contract, not through an unrelated earlier assertion.
- Do not weaken historical tests, re-grade committed evidence, or edit a fixture
  to match a bug. A fixture may change only when primary producer code proves
  its old shape impossible; document that proof.
- No raw transcript access unless a later user message authorizes exact files
  and exact fields. Committed records/sidecars and production code come first.
- No vendor CLI invocation in an offline code PR. Fake binaries and sanitized
  golden fixtures are the only CI dependencies.
- No subagent may mutate the branch. A read-only adversarial review is allowed
  after GREEN, but every finding must be reproduced independently before action.
- Do not fix adjacent backlog items, historical prose, or unrelated test noise.
  Record a verified out-of-scope issue in `BACKLOG.md` only when the phase
  already owns that file or a separate docs-only change was explicitly approved.
- Any new field is closed-schema and versioned. Never rely on unknown-field
  warnings or optional extras as a contract.

### Exit gate

Every code PR must pass its focused suite, the full `agentic-eval-*` suite,
corpus validation, `validate-plugin`, `decouple-audit`, line-ending and
executable-fixture checks, `git diff --check`, and a privacy/path sweep. Run
full `npm test` whenever shared parser, launcher, schema, aggregate/analyze, or
command-classification code changes. Run `local-ci` once only when the phase
changes process execution, platform behavior, packaging, or CI-sensitive shell
boundaries; report a pre-approved byte-identical carve-out as a carve-out, never
as a pass.

Before push, prove the diff contains only phase-owned paths and zero
`tools/runs/**` evidence unless it is an explicitly authorized evidence PR.
Use one initial CI snapshot and stop. Merge requires fresh green required checks,
zero unresolved actionable threads, exact audited HEAD, `MERGEABLE/CLEAN`, user
authorization, squash tree-identity proof, scoped branch/worktree cleanup, and
byte-for-byte WIP preservation.

### Evidence-phase boundary

An evidence campaign starts only from a merged, pinned harness SHA and a dated
runbook. Stage A is zero-live and must prove identity, auth, isolation, dry-run
cardinality, baseline reconciliations, and artifact absence. Stage B requires a
later exact authorization with a maximum session count. No retry, replacement,
respawn, raw read, matrix concurrency, or platform continuation is implicit.
Stage C may write only the predeclared records, sidecars, and report, then opens
one evidence PR and stops before merge.

## 9. Implementation train

Each code PR is offline and contains no canary evidence. Each evidence PR is
data/report only and contains no harness change. Do not combine adjacent phases
to save PR count.

### PR 1 - freeze the runtime contract and current Claude behavior

Suggested title: `test(agentic-eval): freeze runtime and profile contracts`

- Land this ADR/plan, its dated runtime-capability audit, and the three matching
  backlog entries. Align only the active normative sections of
  `docs/agentic-usage-measurement.md`; preserve historical reports as historical
  facts and label obsolete future sketches instead of silently rewriting them
  as implemented behavior.
- Add characterization assertions only where the current suite lacks an exact
  extraction oracle. Reuse the existing public seams; do not export production
  internals just to make a test convenient.
- Add no behavior change, production refactor, schema change, CLI flag, model
  registry, runtime adapter, evidence file, raw read, or live session.

The characterization inventory is closed for this PR:

| Contract to freeze | Production source | Existing proof to retain | Missing exact assertion to add |
|---|---|---|---|
| Claude base invocation and A/B delta | `condition-launcher.mjs` | condition delta, forbidden flags, spawn behavior | one literal full-array assertion covering order, defaults, and supplied values |
| Auth preflight | `auth-preflight.mjs` | exact argv/env/cwd/timeout and all four closed failure codes | none unless the implementation audit demonstrates a concrete uncovered output shape |
| Sanitized Claude JSONL wire shape | `stream-parser.mjs` plus the two existing `agentic-eval-stream-*.jsonl` fixtures | parser, skill, hook, token helpers individually | one literal structural summary per fixture: event count, init identity fields, result fields, skill proof, hook counts, tool counts, and exact four usage values |
| Dispatch accounting | `dispatch-accounting.mjs` and `accepted-run-audit.mjs` | per-attempt allow/deny/pre-dispatch/unaccounted negatives and sidecar validation | none; cite the existing discriminating tests in the PR body instead of duplicating them |
| Run record v5 | `cli.mjs` and `schemas.mjs` | full CLI fake-E2E plus schema validation | literal schema/version, top-level-field, and token-subfield inventories using existing test fixtures; expected values must not be derived from the implementation list under test |
| Accepted audit sidecar v2 | `accepted-run-audit.mjs` | builder, validator, record cross-validation, historical v1 dispatch, literal top-level inventory | literal summary and tool-call field inventories using the existing synthetic builder path |
| Failure signatures | `cell-integrity.mjs`, auth tests, CLI fake-E2E | auth, malformed stream, termination, missing result, pre-inference failure | none unless the inventory finds an actually untested named signature |

This is characterization, not a behavioral TDD change: the new tests should be
GREEN against the unmodified production code. Do not manufacture RED by
temporarily weakening production. They are discriminating only when their
expected arrays/objects are literal, closed, and independently sourced from the
already-sanitized fixtures or documented current schema, rather than generated
from the value being asserted.

Exit: the current Claude strict-policy path is locked strongly enough that a
subsequent extraction can prove equivalence. The focused characterization set,
full `agentic-eval-*` suite, corpus validation, and light gates pass; the diff
contains only the predeclared docs/tests/backlog paths and zero production or
`tools/runs/**` changes.

### PR 2 - extract the Claude runtime adapter

Suggested title: `refactor(agentic-eval): isolate Claude Code runtime`

- Move Claude launcher/auth/parser/usage/skill/diagnostic behavior behind the
  adapter contract.
- Add contract-conformance fixtures for two synthetic future runtimes shaped
  like Copilot (multi-source telemetry/hooks) and Antigravity (typed step stream,
  soft permission denial). These fixtures test capabilities and normalized
  outcomes; they are not product adapters and execute no vendor CLI.
- Keep `claude-code + strict-policy-v1` as the default when flags are omitted.
- Preserve current argv, env, records, sidecars, gates, dry-run count, and
  aggregate/analyze output for schema <=5.
- Use fake-Claude E2E fixtures; zero live sessions.

Exit: all historical tests and golden fixtures are unchanged, and runtime
conditionals do not leak into lifecycle/core graders.

### PR 3 - add v6 records, registry, and runtime-aware reporting

Suggested title: `feat(agentic-eval): add runtime-neutral run records`

- Add `--runtime` and `--execution-profile` with closed registry validation.
- Do not retain `--provider` as an alias: the term is reserved for a backend
  model service when a runtime reports one.
- Implement schema v6 and, only if required, accepted-sidecar v3.
- Partition aggregate/analyze by all keys in ADR-7.
- Render missing historical metrics as `not recorded`.
- Keep old records and reconciliations unchanged.
- Add config-only model enable/disable tests.

Exit: Claude can produce a v6 record offline through fake fixtures while the
committed historical corpus validates unchanged.

### PR 4 - add `sandboxed-unrestricted-v1` for Claude

Suggested title: `feat(agentic-eval): add isolated unrestricted profile`

- First characterize the least-privileged non-interactive Claude invocation in
  a disposable environment. Do not assume a permission flag.
- Implement the profile, isolation-attestation schema, and no-hook dispatch
  accounting.
- Dry-run must report runtime/profile and exact maximum live-session spend.
- Add adversarial tests proving missing accounting cannot pass merely because
  policy is not applicable.

Hard stop: if safe isolation or deterministic non-interactive execution cannot
be demonstrated, do not ship the profile and do not run it on either normal
host.

### Evidence 1 - focused Claude 2x2 pilot

- Scenario: `coverage-threshold-failure` only.
- Conditions: two skill states x two execution profiles.
- Repetitions: 4 per condition.
- Balanced four-condition order, not four independent shuffles.
- Windows first; macOS only after Windows evidence is audited and merged.
- Separate authorization cap: 16 sessions per runtime/platform campaign.
- No retries, replacements, or pooling with historical canaries.

Exit: structurally accepted evidence under both profiles, or an incident that
demonstrates the unrestricted profile is not yet trustworthy. Behavioral
failure is data; harness-integrity failure blocks promotion.

### PR 5 - characterize and implement Codex CLI

Suggested title: `feat(agentic-eval): add Codex CLI runtime`

- Pin and record an exact Codex CLI version per platform.
- Characterize auth/preflight, non-interactive JSONL, command/result
  correlation, model identity, usage dimensions, termination, and skill
  delivery/observability before designing the parser.
- Any characterization invocation that reaches a model is live spend and needs
  an explicit bounded authorization; help/version/auth-only probes are zero-live.
- Implement fake-Codex fixtures and the same adapter contract.
- Do not change scenario graders to accommodate runtime-specific prose. Normalize
  terminal command evidence before grading.
- Support only execution-profile combinations whose capabilities pass dry-run.

Hard stop: if the pinned Codex CLI cannot provide a stable structured transcript
or complete command/result accounting, mark the adapter experimental and do not
admit its records to benchmark aggregation.

### Evidence 2 - focused Codex skill pilot

Run `current-skill` vs `no-skill` under `sandboxed-unrestricted-v1`: 4 repeats
per condition, 8 sessions on Windows and, after audit, 8 on macOS. Prompts,
scenario, source commits, skill pin, cache policy, and reporting contract match
the corresponding Claude profile. Runtime CLI and runtime-native model remain
separate partition keys.

If Codex characterization independently demonstrates an auditable equivalent
for `strict-policy-v1`, add it as a separately reviewed capability and authorize
the additional 8 sessions per platform. Do not make that optional extension a
condition for completing v1.

### Full corpus gate

Do not authorize a full corpus until both focused runtimes pass structural
acceptance on both platforms and the reporting layer has survived an
independent audit.

At two repeats, the required full v1 capability matrix would cost:

```text
Claude: 6 scenarios x 2 skill states x 2 profiles x 2 repeats x 2 platforms = 96
Codex:  6 scenarios x 2 skill states x 1 profile  x 2 repeats x 2 platforms = 48
Required total = 144 live sessions
```

Optional strict-policy Codex support would add 48, producing a 192-session
maximum. Neither number is a target to spend early.

## 10. Focused pilot accounting

The Claude 2x2 pilot costs:

```text
1 scenario x 2 skill states x 2 profiles x 4 repeats
  = 16 sessions per runtime/platform
```

The required Codex pilot costs:

```text
1 scenario x 2 skill states x 1 profile x 4 repeats
  = 8 sessions per platform
```

The required focused v1 pilot therefore costs 48 fresh sessions: 16 Claude + 8
Codex on each of Windows and macOS, split into four separately authorized
campaigns. Optional strict Codex support would add 16 and raise the maximum to
64. Existing strict Claude canaries are historical context only; reusing them
inside the new factorial would mix harness/schema/protocol generations.

Reports must separate:

- process/matrix executions;
- cell respawns or replacements;
- in-session test-invocation retries;
- runtime turns/tool calls;
- native usage dimensions.

## 11. Test strategy

Every implementation PR includes:

- runtime contract tests run against all registered adapters;
- fake-CLI subprocess E2E for success, auth failure, malformed JSONL,
  termination, missing tool result, unavailable usage, and unsupported
  capability;
- golden normalization fixtures that contain no private data;
- schema freeze tests for every historical version;
- aggregate/analyze partition tests preventing runtime/profile pooling;
- model-registry validation and duplicate-ID rejection;
- skill-isolation tests for both runtimes;
- profile tests proving strict-policy and no-policy accounting cannot be
  confused;
- privacy and path-containment tests;
- existing `agentic-eval-*` suite and repository light gates.

Live runtime CLIs are never required by CI. CI uses only fake fixtures. A live
characterization or canary is a separately authorized evidence campaign.

## 12. Acceptance criteria for v1

v1 is complete only when:

- Claude Code and Codex CLI both implement the same adapter contract;
- default Claude strict-policy behavior remains backward compatible;
- adding/removing a model is registry-only;
- schema v6 validates runtime/profile/skill/usage provenance without optional
  unknown fields;
- historical committed records and sidecars remain unchanged and valid;
- no-policy records prove external isolation and complete dispatch accounting;
- unavailable metrics render as not recorded;
- aggregate/analyze cannot pool incompatible partitions;
- focused Windows and macOS pilots exist for both runtimes under
  `sandboxed-unrestricted-v1`, plus Claude under `strict-policy-v1`;
- no report claims cross-runtime token equivalence or statistical reliability
  from four repetitions;
- implementation docs and the agentic-usage methodology agree.

## 13. Effort estimate

Engineering effort, excluding CI wait time, live model latency, and review
rounds:

| Work | Estimate |
|---|---:|
| Contract/ADR and Claude characterization | 1-2 days |
| Claude adapter extraction | 3-5 days |
| Schema v6, registry, aggregation/reporting | 2-4 days |
| Safe unrestricted profile | 3-5 days |
| Codex characterization and adapter | 3-5 days |
| Focused campaign runbooks/reports | 2-3 days |
| Total | 14-24 focused engineering days |

Calendar expectation with review and the deliberate Windows-then-macOS gates:
approximately 3-5 weeks. The first useful milestone, Claude plus the execution
profile axis, should arrive earlier and is independently valuable.

## 14. Post-v1 runtime and model extension protocol

This section is a planned extension path, not v1 scope and not authorization to
install a CLI or spend a live session. Copilot and Antigravity are candidate
runtimes. Microsoft MAI and Google Gemini are candidate model profiles.

### E0 - refresh the zero-live readiness snapshot

Run after v1 acceptance, independently for each candidate and against an exact
date and installable version. No model prompt is allowed.

Mandatory pass gates:

1. exact package/binary version and integrity hash can be pinned on Windows and
   macOS;
2. auth status can be checked without inference;
3. non-interactive invocation and structured output are documented and exposed
   by the pinned binary;
4. exact model selection fails closed rather than silently using auto/default;
5. disposable runtime home and project-scoped skill presence/absence are
   mechanically achievable;
6. command/result correlation, terminal status, stderr, and usage can be
   represented by the frozen adapter contract;
7. raw tool parameters/results can remain local and redacted artifacts can be
   emitted without prompt or identity leakage;
8. the selected execution profile can be compiled without weakening its
   semantic requirements.

Any failed mandatory gate parks that runtime with a dated reason. Do not change
the core contract merely to make a candidate appear supported.

If both candidates pass, choose the first extension by evidence quality:
skill-state observability, dispatch-accounting completeness, stream stability,
cross-platform parity, and privacy surface. Copilot is the provisional first
extension because hooks plus OTel independently exercise multi-source
reconciliation. Antigravity may be selected first if its newer typed stream and
headless skill path characterize more cleanly. Vendor preference is not a
criterion.

### E1 - bounded live characterization

Characterize one runtime at a time in a fresh worktree and isolated toolchain.
Windows precedes macOS. The initial authorization ceiling is two live sessions
per platform:

1. `no-skill`, one benign evidence-capable command, clean completion;
2. `current-skill`, the same task family with the pinned skill delivered.

Policy-denial, malformed-stream, nonzero-tool, timeout, and termination shapes
use offline fixture CLIs unless the real product shape cannot otherwise be
known. Spending an additional product session requires a new authorization that
names the missing event and raises the cap explicitly. Raw output remains local;
only sanitized event-shape fixtures may enter a PR.

Hard stop on silent model fallback, uncorrelated tool results, unprovable
skill absence, contradictory observation sources, missing terminal usage with
no closed reason, or required access to the maintainer's normal HOME.

### E2 - one adapter PR

Implement exactly one runtime adapter. The PR contains production code,
fake-CLI E2E tests, sanitized golden fixtures, schema/registry changes only if
the frozen contract already permits them, and documentation. It contains no
live records or reports. Existing runtime outputs and historical
reconciliations must remain byte-equivalent.

For Copilot, reconcile primary JSONL, a sanitized `preToolUse` ledger, and OTel
usage without enabling prompt/tool-content telemetry. Treat hook timeout or a
missing ledger entry as integrity failure.

For Antigravity, require explicit `--model`, `stream-json`, a terminal
`result`, and complete `step_update` correlation. A headless soft permission
denial with process exit `0` is a dispatch outcome, never a successful command.

### E3 - focused adapter pilot

After the adapter PR is audited and merged, run
`coverage-threshold-failure`, `current-skill` versus `no-skill`, four repeats,
under `sandboxed-unrestricted-v1`: eight sessions on Windows and, only after
that evidence is merged, eight on macOS. A strict-policy profile is a separate
optional 16-session extension across both platforms and requires equivalent
auditable accounting; it is never inferred from similar-looking flags.

The maximum initial extension budget is therefore four characterization
sessions plus 16 focused-pilot sessions across both platforms. Each stage and
platform is separately authorized; the arithmetic is a ceiling, not advance
permission.

### E4 - model profiles after runtime acceptance

Add or remove a model through validated registry data only. Every profile pins
runtime ID/version, exact model slug, expected vendor, reasoning effort/context,
and supported usage dimensions. `auto` and implicit defaults are invalid.

- A Google-native experiment is `antigravity-cli` plus a pinned Gemini slug.
- A Gemini-via-GitHub experiment is `copilot-cli` plus a pinned Gemini slug and
  is a different runtime partition.
- A Microsoft-model experiment is `copilot-cli` plus a pinned MAI slug; it does
  not create a Microsoft adapter.

Each new model starts with a focused eight-session pilot per platform (four per
skill condition), Windows then macOS, under an already accepted profile. Do not
run multiple new models in the same campaign. Cross-model native token counts
remain descriptive because tokenizers, hidden context, cache semantics, and
billing units may differ even inside one runtime.

Indicative effort after v1, excluding CI wait and live-model latency:

| Extension work | Estimate |
|---|---:|
| E0 readiness refresh for both candidates | 1-2 days |
| E1 characterization for the selected runtime | 1-2 days |
| E2 adapter implementation and adversarial tests | 3-5 days |
| E3 runbooks, evidence, and audit | 1-2 days |
| First post-v1 runtime total | 6-11 focused engineering days |
| Additional model profile on an accepted runtime | 0.5-1 day plus its campaign |

The second future runtime should be cheaper only if it fits the frozen contract.
Do not budget away a contract mismatch by assuming reuse before E0.

## 15. Related follow-ups kept separate

- Investigate macOS canary run `f650117e`, whose terminal diagnosis matched but
  whose final answer lacked a well-formed result block. Start from committed
  record, sidecar, and grader code; raw remains separately authorized. This is
  a response-finalization issue, not a runtime-abstraction prerequisite.
- Study the strict-policy no-skill denial distribution as its own analysis. The
  unrestricted profile provides the missing comparison arm but must not be used
  to rewrite the historical strict-policy interpretation.
- Copilot and Antigravity remain parked until Claude + Codex v1 is stable and
  the maintainer explicitly promotes one candidate through E0. Legacy Gemini
  CLI, AI Shell, Foundry hosted agents, and Conductor stay screened out unless
  their product/runtime status materially changes.
