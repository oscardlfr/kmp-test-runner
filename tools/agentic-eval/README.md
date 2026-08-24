# tools/agentic-eval — reproducible skill evaluation harness

Reusable tooling that proves, technically, whether Claude Code's Skill-matching mechanism
invokes the `kmp-test-runner` skill under controlled conditions. This is a **foundation**, not
a benchmark: no results are published here, and the full corpus is not executed by this PR. See
[`docs/agentic-usage-measurement.md`](../../docs/agentic-usage-measurement.md) for the broader
methodology this implements a piece of.

**Scope note:** an earlier version of this PR also included six scenario definitions, a grader
registry, and a natural-trigger corpus-probe path. Two independent review passes found the
scenario/grader layer incomplete (missing fixtures, non-reproducible mutations, grading via
broad keyword matching rather than structured evidence) and found several real correctness bugs
in the foundation layer itself. This PR was narrowed to the foundation only — launcher, policy,
parser, privacy, schema, lifecycle, and a genuinely-passing calibration/smoke acceptance gate.
Scenario/grader completeness is tracked as a follow-up (see BACKLOG.md).

## Why this exists

Two prior measurement rounds in this repo (`tools/runs/agentic-usage-pilot-2026-07-17/`,
`tools/runs/agentic-usage-benchmark-v2-2026-07-17/`) never made the skill technically absent in
their "no-skill" condition — they prompt-instructed the agent to *pretend* it didn't exist — and
never observed a real `Skill` tool-invocation event; "skill used" was inferred by grepping
shell-command text for `kmp-test`. This harness closes both gaps with technical isolation and a
real event-level invocation proof — including the outcome of that invocation, not just its
presence (see "Attempted vs. confirmed invocation" below).

## Conditions

- **`no-skill`** — the skill is technically absent (proven via the `init` event's `plugins[]`
  array being empty, not asserted from flag choice).
- **`current-skill`** — the skill is loaded via `--plugin-dir` from a git-archive snapshot of a
  pinned commit (configured by `PINNED_SKILL_SHA` in `tools/agentic-eval/cli.mjs`), never the live
  working tree, so the evaluated skill content can't silently drift.
- **`candidate-skill`** — accepted as a future path in the schema; `condition-launcher.mjs`
  throws a clear, typed error if selected. Not implemented here.

Both conditions receive byte-identical argv, environment, and policy configuration — the *only*
difference is the presence of `--plugin-dir`. `condition-launcher.mjs`'s `buildConditionArgv()`
enforces this mechanically (condition A's argv is an exact prefix of condition B's; B's only
suffix is `['--plugin-dir', <snapshot>]`).

## Attempted vs. confirmed invocation

A `Skill` `tool_use` block proves the model *tried* to invoke a skill — it does not prove the
invocation succeeded. On a real captured no-skill transcript, the model calls `Skill` with
`{skill: "kmp-test-runner"}` anyway (the prompt asked for it directly), gets back
`<tool_use_error>Unknown skill: kmp-test-runner</tool_use_error>` with `is_error:true` on the
correlated `tool_result` (matched by `tool_use_id`), and tells the user the skill doesn't exist.
`stream-parser.mjs`'s `findSkillInvocation()` reports this correctly via two separate fields:

- `skill_invocation_attempted` — at least one matching `Skill` `tool_use` block was found,
  regardless of outcome.
- `skill_invoked` — ANY matching attempt's own `tool_result` was found and was **not** an error.
  Never assumed true from a tool_use block alone, and never assumed true when no result exists yet.

`findSkillInvocation()` scans the WHOLE transcript, not just the first matching call — an earlier
version returned on the first match, so a failed-then-retried-successfully invocation was
incorrectly reported as unconfirmed (only the failed first attempt was ever considered). Both
fields are aggregated across every matching call by name: `attempted` is true iff at least one
exists at all; `invoked` is true iff any of them succeeded, regardless of order.

An earlier version of this harness only checked for the `tool_use` block, so a no-skill run's
record could show `skill_available:false` and `skill_invoked:true` in the *same record* —
directly self-contradictory. `schemas.mjs` now also rejects that combination at the schema level
(`skill_invoked:true` requires `skill_invocation_attempted:true`).

### Skill identity vs. wire representation

The harness's target skill is a *logical* identity — `(pluginName, skillName)`, both currently
`kmp-test-runner` for this repo's own plugin — kept as two separate constants
(`TARGET_PLUGIN_NAME`/`TARGET_SKILL_NAME` in `cli.mjs`) even though their literal values coincide.
On the *wire*, a Skill `tool_use`'s `input.skill` string can address that same logical skill two
ways: its bare skill name (the historical form every fixture originally assumed was the only one),
or Claude Code's plugin-namespaced form `${pluginName}:${skillName}` — the canonical addressing
scheme for any plugin-loaded skill, confirmed live 2026-07-22 when a real Claude Code 2.1.217
session invoked this harness's own target skill via `kmp-test-runner:kmp-test-runner`.
`stream-parser.mjs`'s `isTargetSkillReference()` is the one place that decides the match: a
closed, exact-string allowlist of precisely those two forms, deliberately never a
prefix/suffix/namespace-pattern match — a foreign namespace, a *different* skill from the *same*
plugin, a casing/whitespace variant, or a doubled/nested namespace are never accepted. Its own two
identity parameters (`pluginName`, `skillName`) are never derived from one another — the canonical
namespaced form is built from both, never assumed by doubling either one on itself. Every
invocation-matching consumer (`findSkillInvocation()`, `findForeignSkillUses()`/
`classifyForeignSkillUses()`) takes both parameters for the same reason; `isSkillAvailable()`/
`hasExpectedPluginProfile()` take only `pluginName`, since they check the init event's plugin
manifest (`plugins[].name`) — a genuinely plugin-only identity, never a skill-invocation match.

### Result-aware FOREIGN skill classification (scenario only)

The same attempted/confirmed distinction applies to a `Skill` call that does not match the target
skill identity (see "Skill identity vs. wire representation" above) — `stream-parser.mjs`'s
`classifyForeignSkillUses()` (a thin wrapper around
`findForeignSkillUses()`, mirroring `findBashToolUsesWithResults()`'s identical correlation
pattern) classifies each foreign call as one of three states, never conflated:

- **rejected** — a real, correlated `tool_result` with `is_error:true` (the "Unknown skill" shape).
- **confirmed** — a real, correlated `tool_result` with `is_error:false` — including when
  `is_error` is absent from the `tool_result` entirely, which per the documented `tool_result`
  contract also means success, not an unknown/incomplete state.
- **missing/incomplete** — no correlated `tool_result` found anywhere in the transcript at all
  (`resultIsError:null`) — a broken capture, not a demonstrated outcome either way.

For a **scenario**'s naturally-prompted transcript, a REJECTED foreign attempt is measured agent
behavior, not contamination — the model exploring what's available and getting told "no" is not
evidence-contamination the way a CONFIRMED foreign invocation is. `calibration`/`smoke` keep their
original, unrelaxed contract unchanged (`findForeignSkillUses()`, plain and argument-only, still
fails on ANY foreign call regardless of outcome) — their explicit-invocation prompts don't carry
the same "the agent is naturally exploring" premise a scenario prompt does, and relaxing them
would need its own independently-argued case. See "Run kinds" below for exactly how this changes
`scenarioCellIntegrityOk()`'s checks, and "Rejected-run diagnostics" for what gets recorded when a
matrix is rejected anyway.

## Run kinds

- **`calibration`** — explicit-invocation only (the prompt directly asks for the skill by name).
  Proves invocation *mechanics*: the current-skill condition (B) must show a full, confirmed
  invocation (`available:true`, `attempted:true`, `invoked:true`) — no relaxation there. The
  no-skill condition (A) must show `available:false` and, always, `invoked:false` — but whether it
  *attempted* the call first is not required: a model correctly recognizing the skill isn't in its
  available tool list and not trying it at all is just as legitimate isolation proof as trying it
  and getting `Unknown skill` back (both real, observed shapes — see "Attempted vs. confirmed
  invocation" above). `attempted` must still be a genuine observation, though (`true` or `false`,
  never `null`/unknown — an incomplete capture must not silently pass). Both conditions must also
  have produced a real `init` event (`initOk` — a session with no `init` event at all is a
  broken/incomplete capture, not legitimately-observed "unavailable" data), and both conditions'
  own `result` event must read `subtype:'success'` **and** `is_error:false` (not `is_error` alone
  — a session cut short by, say, the budget cap reports a distinct `subtype` — confirmed
  `'error_max_budget_usd'` — that isn't necessarily paired with `is_error:true`, so `is_error`
  alone doesn't prove a genuine, uninterrupted completion), and neither condition may contain a
  `Skill` call targeting anything other than `kmp-test-runner` (`skillSelectionOk` — closes a real
  evidence-contamination bypass an independent review pass found: without it, a transcript that
  called an entirely unrelated skill would show `attempted:false`/`invoked:false` for
  `kmp-test-runner` — the same shape the relaxed no-skill contract above legitimately tolerates —
  and pass unnoticed). A calibration failure is rejected validation, not benchmark evidence;
  investigate harness, setup, and model behavior before retrying — it is not automatically a
  harness bug.
- **`smoke`** — one bounded scenario, both conditions, through the real CLI end-to-end. Proves
  the pipeline works with **equivalent real diagnostic work in both arms** — not just skill
  availability. `smokeHardGate()` requires, in *both* conditions: skill availability matches
  expectation (A:false, B:true), a real `init` event was produced, the process completed
  normally with a zero exit code, its own `result` event reads `subtype:'success'` **and**
  `is_error:false`, every Bash call reached the policy hook (`hookAccountingOk`),
  `hook_call_count >= 1` **and** `hook_deny_count === 0` **and** the hook's own allow-count
  matches its call-count exactly — not merely "zero denies" — so a malformed, unparseable hook
  decision (neither an explicit allow nor a deny) can't silently pass (`realWorkOk`), and the
  Bash calls are EXACTLY the expected multiset — `kmp-test doctor --json` and `kmp-test describe
  --json`, each tokenized (quote-aware, via `policy-hook.mjs`'s own `tokenize()`) and matched
  exactly once, each with its own correlated non-error result, with no other Bash call present at
  all (`exactCommandsOk`). An earlier version matched with unanchored regexes and no `--json`
  requirement — a real adversarial probe showed this could be satisfied by a bare
  `kmp-test doctor` (contradicting smoke's own prompt) or even an unrelated
  `kmp-test doctor-evil-subcommand` (the old `\bdoctor\b` pattern's word boundary matched a
  hyphen-adjacent suffix too). Finally, a transcript with zero malformed lines
  (`cleanTranscriptOk`). It deliberately does **not** require the skill to actually trigger in
  condition B — whether it triggers naturally on smoke's prompt is an open question for a future
  corpus-probe run, not something smoke should presuppose. An earlier, open-ended smoke prompt
  drove the agent toward general exploration (`ls`/`pwd`/`git status`/`find`) that the policy
  hook correctly denies by design — 11/13 and 6/6 real calls were denied in that run, meaning
  smoke never actually exercised real diagnostic work despite passing its (much narrower) old
  gate. The current prompt names the exact two read-only commands to run, removing the need to
  explore.
- **`scenario`** — produced by the `run` subcommand: `run --scenario <id> --source-repo-dir
  <local-clone> --seed <n> [--repeats <n>] [--model <name>] [--dry-run]`. Unlike
  `calibration`/`smoke`, a scenario run executes a full `2×repeats`-cell matrix (both conditions,
  `repeats` times each, counterbalanced via `randomizer.mjs`'s `buildConditionOrders` — a
  guaranteed split across repetitions, not merely a shuffle that's unbiased only in expectation)
  against one scenario from `corpus/scenarios/` and grades each condition's transcript with
  `graders.mjs`'s 8 structured, evidence-anchored checks (never a free-text keyword scan — see
  `graders.mjs`'s own header comment for why that design was rejected once already). The final
  `KMP_EVAL_RESULT` block check (`final_answer_consistent_with_evidence`) is compared against the
  terminal attempt's own observed module/outcome_kind/counts, never against the scenario's expected
  answer directly -- a deliberately separate question from whether that observed evidence was
  itself correct for the scenario (`authoritative_target_matches_expected`/
  `authoritative_outcome_matches_expected`, both compared against the scenario). An agent can
  honestly report a wrong-for-the-scenario result and still satisfy the final-answer check. That
  canonicalization step also validates a specific, enumerated set of internal-coherence properties
  on the terminal evidence before trusting it -- among them, subcommand/exit-code/execution-mode
  agreement, counter arithmetic (e.g. a JUnit result whose own passed/failed don't sum to its
  total), and a coverage claim's own module attribution -- rather than accepting any well-formed-
  looking shape at face value; this is a checked set, not a claim of exhaustive coverage against
  every possible contradiction. For a
  `tests_executed`/`tests_failed` scenario (both represent a genuine test execution, just with a
  different real outcome), target-module identity (`authoritative_target_matches_expected`)
  resolves the condition's own `--module-filter` argument through the exact same `matchModuleFilter`
  function (`lib/orchestrators/module-filter.js`) the real CLI dispatch itself uses — never a second,
  independently-maintained comparison — so an agent correctly targeting a nested module via a short
  substring filter or an anchored glob grades identically to one using the exact module path.
  `no_applicable_tests` deliberately keeps plain exact-string equality instead: its envelope carries
  no module data at all (`modules[]` is required empty for that outcome), so there is nothing to
  corroborate a loose filter against, and it stays fail-closed. `--seed` is always required and never
  auto-generated, so a `--dry-run` preview can never silently diverge from the real run it
  previews, and any run is exactly reproducible from its own recorded evidence. `--repeats`
  defaults to 4 (even, counterbalance-capable by construction); any other positive integer up to
  `MAX_REPEATS` (20) is a valid, explicit choice for development/debugging, just not
  `benchmark_eligible`-capable unless even (see below) — the cap exists because each repetition
  spawns 2 live Claude sessions once `run` is pointed at a real `claude` binary, so an unbounded
  value would let a single typo (`--repeats 100` for `--repeats 10`) silently authorize hundreds
  of live sessions; `--dry-run`'s own output states `total_live_sessions` explicitly.
  `--dry-run` prints the fully resolved execution plan and returns before touching
  `--source-repo-dir` or spawning Claude. Without `--measurement-scope-file`, this is a genuine
  zero-subprocess preview; if that flag IS supplied, `--dry-run` does invoke `git` subprocesses —
  exclusively to validate the supplied scope file (see "Measurement scope" below) — but still
  never touches `--source-repo-dir` and never spawns Claude. A real run first verifies
  `--source-repo-dir`'s own
  `origin` remote matches the scenario's declared `project_url`, its working tree is clean, and
  the scenario's pinned commit resolves inside it — before any git worktree is ever created from
  it. `scenarioHardGate()` (harness-integrity only, deliberately never the scenario OUTCOME —
  a wrong answer, a policy denial, or a legitimate timeout are all valid negative results) blocking
  on ANY one cell fails the **whole matrix's** promotion; there is no partial write. Before that
  final gate is even reached, each cell is ALSO checked locally, immediately after it runs
  (`cellTranscriptIntegrityOk()`) — a local failure stops the matrix from spawning any further live
  session, rather than running every planned cell only to reject the whole batch at the end; see
  "Rejected-run diagnostics" below for exactly what changes (`matrix_complete`,
  `ambient_profile_matrix_ok`) when this happens.

  **How `hookAccountingOk` is proven differs by run kind, and is selected explicitly (never
  inferred).** `cellTranscriptIntegrityOk()` takes a **required** `requireDispatchAccounting` flag —
  there is no default, and an omitted or non-boolean value yields `hookAccountingOk:false` rather
  than quietly selecting the weaker proof.
  Calibrate/smoke pass `false` and keep the historical aggregate proof (`everyCallHooked`): *every*
  Bash call reached the policy hook, full stop — those run kinds have no per-attempt decision
  channel, so nothing finer is derivable there. The scenario matrix and `scenarioCellIntegrityOk()`
  pass `true` and require the canonical per-`tool_use_id` dispatch accounting
  (`dispatch-accounting.mjs`), where a Bash call is `hook_evaluated`, `pre_dispatch_blocked`, or
  `unaccounted`, and **any** unaccounted call fails the cell. Scenario runs admit exactly one
  additional case: a **recognized Claude Code pre-dispatch tool block**, where Claude Code refused
  the call at its own tool layer before dispatching `PreToolUse:Bash`, so no hook could ever have
  run and nothing reached a shell. Every other Bash call must still be hook-evaluated. A recognized
  pre-dispatch block is **not** a policy-hook deny: a deny is the hook working as intended and is
  recorded as such (`hook_deny_count`), whereas a pre-dispatch block never produced a policy
  decision at all. The matcher is a closed, exact-shape check over the product's own strings
  (`isRecognizedPreDispatchBlock`, `stream-parser.mjs`) — never a substring or prefix match — and
  anything that diverges from it falls through as `unaccounted` and fails closed. Widening the
  recognized set requires fresh real product evidence, not inference from a neighbouring case.

  The accounting also cross-checks the two independent channels against each other: hook ids must be
  unique and their started/response sets identical, the hook-pair count must equal the
  hook-evaluated count, and the stream's own allow/deny totals must equal the decision map's. An
  on-disk decision sidecar therefore can never stand in for a hook event pair that is missing from
  the transcript, nor the reverse. One consequence worth knowing: a missing or incoherent decision
  sidecar for a call whose hook events ARE present is now caught here, during fail-fast, rather than
  later by `junitCaptureCompleteOk` — the rejection is the same, it just happens before any further
  live session is spawned. `junitCaptureCompleteOk` keeps its own independent reach over the Gradle
  *evidence* half of the same capture mechanism, which fail-fast cannot preempt. Each cell
  otherwise records its own real, non-null `success`/`expected_outcome_matched` (via
  `gradeScenarioCondition`), `grading_checks` (the full per-check detail), `test_invocations_total`/
  `retries` (derived from the same attempt list grading itself built), and `cache_state:'cold'`
  (every cell gets a pristine project + `GRADLE_USER_HOME` baseline — no dependency prewarming, see
  "Materialization and cleanup" below).

  `benchmark_eligible:true` depends **only** on protocol/integrity completeness, **never** on
  whether the agent's answer was correct: the matrix is genuinely complete (an identity proof over
  `(repetition_index, condition)` pairs, not a count), every cell's harness integrity held, every
  record's grading actually executed with real non-null `success`/`expected_outcome_matched`
  booleans, and the realized starting-condition counts are exactly equal across the batch — an odd
  `--repeats`, or any other imbalance, can never be eligible by construction.

  `scenarioCellIntegrityOk()`'s own `skillSelectionOk` is **result-aware**
  (`classifyForeignSkillUses()`, see "Result-aware FOREIGN skill classification" above), splitting
  the old single check into two: `skillSelectionOk` now fails only on a CONFIRMED foreign
  invocation (a REJECTED attempt no longer blocks promotion), and a new, separate
  `foreignSkillToolResultsCompleteOk` fails on a missing/incomplete foreign result — deliberately
  **not** delegated to the neighboring timeout-tolerant `toolResultsCompleteOk` (which can excuse
  exactly one incomplete tool_use if it's the chronologically last one before a genuine timeout) —
  a foreign Skill call's own incompleteness fails closed unconditionally, with no timeout
  exception. Every accepted record (any run_kind, schema v3+) also carries a `foreign_skill_summary:
  {rejected, confirmed, incomplete}` field — categorized counts only, never the raw skill name —
  so a rejected-but-harmless foreign attempt on an otherwise-clean, ACCEPTED cell still leaves a
  real trace of having happened, instead of disappearing the moment it stops being treated as
  contamination.

  **Ambient-skill-profile tolerance.** A real live scenario run's `no-skill` cells were wrongly
  rejected for a CONFIRMED invocation of Claude Code's own bundled `run` skill — present in the
  init event's `skills[]` array identically regardless of `--plugin-dir` (see "Skill identity vs.
  wire representation" above), not third-party contamination. `skillSelectionOk` tolerates a
  CONFIRMED non-target Skill call **only** when its exact `skillArg` was advertised in the
  matrix-WIDE consensus ambient profile: `scenarioHardGate()` computes, for every cell,
  `computeAmbientSkillProfile()` (`stream-parser.mjs`) — a strict, **condition-aware** parse/
  validation of that cell's own `skills[]`. `no-skill` must show **zero** target references at
  all (bare or namespaced) — not merely zero CONFIRMED invocations; an anomalous advertisement
  with no invocation is real contamination `noSkillSafetyOk` (which only checks actual invocation)
  and `pluginProfileOk` (which only checks `plugins[]`, never `skills[]`) cannot catch on their
  own. `current-skill` may show at most one target representation (either wire form), stripped
  before computing the ambient set; more than one simultaneous representation (both forms at once)
  is a duplicate LOGICAL identity and fails closed regardless of condition. Once the target
  identity is resolved per cell, every cell's REMAINING (ambient) set must agree EXACTLY with
  every other cell's. Never a hardcoded `'run'` exception: any bundled skill name is tolerated
  identically, as long as it is genuinely shared. Three new named checks make every failure mode
  independently diagnosable: `ambientSkillProfileOk` (this cell's own `skills[]` failed to parse
  structurally), `targetSkillAmbientIdentityOk` (the target's own presence/absence or duplication
  doesn't match this condition), and `ambientProfileMatrixOk` (the SAME matrix-wide consensus
  boolean, threaded into every cell — deliberately reuses the existing per-cell aggregation/
  atomic-promotion machinery unchanged rather than adding only a separate top-level field, so a
  genuine mismatch fails the whole batch exactly like any other integrity defect, and
  `rejection-diagnostics.mjs`'s "some cell must show a real failure" invariant is satisfied for
  free — `ambientProfileMatrixOk` is *also* returned as its own top-level field on
  `scenarioHardGate()`'s result specifically so a caller building rejection diagnostics can record
  it directly). `scenarioHardGate()` itself fails closed (never throwing) unless both its
  `records`/`conditionResults` arguments are non-empty arrays of exactly equal length. An
  unadvertised, malformed, or missing/incomplete foreign Skill use still fails closed exactly as
  before — only a genuinely shared, confirmed ambient capability is now tolerated.
  `calibrationHardGate()`/`smokeHardGate()` gained the identical `ambientSkillProfileOk`/
  `targetSkillAmbientIdentityOk` checks too (a missing/malformed `skills[]` was previously
  completely unchecked there, silently producing a "verified empty" ambient profile even when the
  underlying data was genuinely unknown) — their own zero-tolerance `skillSelectionOk` is
  otherwise entirely unaffected; this tolerance mechanism itself remains scenario-only.

  Every record (any run_kind, schema v4+) also carries an `ambient_skill_profile: {count,
  scope_id, fingerprint_hmac}` field — never the raw names. The fingerprint is **keyed**
  (`fingerprintAmbientSkillNames()`, HMAC-SHA256), not a bare content hash: an earlier unkeyed
  `SHA256(names)` design was directly demonstrated to be reversible by dictionary attack against
  the small, guessable universe of real Claude Code skill names (pseudonymization, not
  anonymization). `generateAmbientProfileScope()` (`cli.mjs`) generates ONE random 32-byte key plus
  one opaque `scope_id` (a UUID) per harness invocation — shared by every cell that invocation
  produces (so a matrix's own cells remain comparable to each other) and the key is **never
  persisted anywhere**, only its resulting digests are recorded. Two records' fingerprints are
  comparable **only** when their `scope_id`s match (i.e. only within the same invocation) — a
  different `scope_id` means the comparison is meaningless regardless of what the fingerprints
  look like, which is exactly why `scope_id` (not just the fingerprint) is itself part of the
  Fairness Contract's partition key (below). See "Schemas" and "Fairness Contract" below.

  **Longitudinal aggregation is addressed via an optional, local measurement-scope file** (this
  was previously an open, deliberately-unaddressed limitation of the per-invocation ephemeral key
  described above -- it no longer is). Supplying no `--measurement-scope-file` preserves the
  per-invocation ephemeral key exactly as described above, byte-for-byte -- every fresh
  `calibrate`/`smoke`/`run` invocation still starts its own unrelated comparability island by
  default, which remains correct and sufficient for a one-shot canary. For a *publishable,
  repeated* measurement program, `--measurement-scope-file <path>` (backed by `scope init --out
  <path>`) supplies a stable, non-secret-identified (`scope_id`) key instead, so independent
  invocations sharing the same scope file remain comparable. See "Measurement scope" below for
  the full creation/reuse/rotation/privacy contract.

  **JUnit-evidence attribution, per attempt, keyed by `tool_use_id`.** A `tests_executed`/
  `tests_failed` scenario condition can involve **multiple Bash attempts** (a first, wrong/failed try; a
  corrected retry). Earlier, JUnit-XML evidence for the raw-Gradle path was captured **once per
  condition, after every attempt had already run**, then handed identically to every
  Gradle-classified attempt during grading — a pooled snapshot that could never say *which*
  attempt actually produced it, and a genuinely ambiguous case (two policy-allowed producers) could
  only be resolved by rejecting the whole condition outright. `junit-evidence.mjs`'s
  `attributeCondition()` replaces this with real per-attempt correlation:
  - **Decision records** (`decisions/<sha256(tool_use_id)>.json = {decision, command, reason_code?}`),
    written by `policy-hook.mjs`'s existing `decide()` result via `recordDecisionSideEffect()` --
    `reason_code` is an additive, closed diagnostic code for policy-denial analysis; no JUnit XML
    is read here at all.
  - **Evidence records** (`evidence/<sha256(tool_use_id)>.json = {command, status, junit?, reason?}`),
    written by a new, additive `junit-evidence-hook.mjs`, registered on `PostToolUse`/
    `PostToolUseFailure` (matcher `Bash`) — the only two new hook registrations this mechanism
    needs, and registered **conditionally**: `condition-launcher.mjs`'s `buildPolicySettingsFile()`
    only adds them when the scenario's `outcome_kind` is `tests_executed`, `tests_failed`, or
    `coverage_threshold_exceeded` (`matrix-runner.mjs`'s `isJunitEvidenceOutcome`) -- `parallel`
    genuinely runs tests for the coverage outcome too, so a Gradle attempt's own corroborating
    contract needs real JUnit XML to verify against, exactly like the other two "ran" outcomes; for
    `calibrate`/`smoke`/`no_applicable_tests` the produced `settings.json` is byte-for-byte
    identical to before this mechanism existed, so those paths spawn no extra hook subprocess and
    carry no extra `hook_started`/`hook_response` transcript lines. `status` is one of `'ok'`
    (with `{total,passed,failed}`), `'no_xml'` (the walk found nothing — a legitimate,
    non-integrity observation), or `'integrity_error'` (real XML that isn't trustworthy: a genuine
    `<skipped>` testcase this evidence path can't correctly count, an oversized/unreadable file, or
    the aggregate capture bounds were exceeded) — never "well-formed XML," since this evidence path
    is a regex-based extraction contract, not a full XML validator. The underlying read
    (`countEvidenceTaskJunit()`) is genuinely single-pass (one `forEachJunitXml` call; an aggregate
    cap can only stop that function's own visitor by throwing a private sentinel, since
    `forEachJunitXml` ignores whatever its visitor returns), bounded by two fixed, documented
    limits: **2000 files** and **64 MiB** aggregate bytes per capture (twice
    `lib/parsers/junit-xml.js`'s own 32 MiB per-file cap — sized to catch "many small files whose
    total is huge," the gap the per-file guard alone can't close).
  - **A transcript-grounded concurrency proof, not a filesystem lock.** `bashResults[i].index` is
    the containing `assistant` event's own array index — two Bash calls dispatched in the *same*
    turn share it, and Claude Code cannot generate a second assistant turn with new tool calls
    before the first turn's own tool results are back, so different-index attempts are always
    safely sequential relative to each other. Grouping *relevant*, `decision:'allow'` attempts by
    `.index` and flagging any group of more than one is a proof, not an inferred-from-order guess —
    two clean, SEQUENTIAL retries (different index) now correctly attribute and pass; only a
    genuine same-turn dispatch trips the whole-condition `ambiguous_junit_evidence` error.
  - **Relevance is `allowed_invocations` membership, never an exact `evidence_task` match** — a
    policy-permitted Gradle lifecycle alias (e.g. `:app:test` when `evidence_task` is
    `:app:testDebugUnitTest`) still counts, since real Gradle behavior prints the underlying leaf
    task's own status line as part of its dependency chain regardless of which allowed invocation
    the agent actually typed. The XML itself is still always read from `evidence_task`'s own
    directory — this only decides which commands are *tracked*.
  - **A whole-condition instrumentation-integrity scan, across every relevant attempt — not just
    `terminal`.** This is deliberately unlike `parallelEvidenceMalformed` (below), which describes
    the *product's* own evidence quality and is correctly superseded by a later clean retry: a
    missing/broken *capture mechanism* on an EARLIER attempt (a decision record that never got
    written, a Gradle attempt whose evidence capture silently failed) can corrupt
    `test_invocations_total`/`retries`/`first_useful_signal_ms` — all computed across every
    attempt — even when the attempt that ends up `terminal` looks completely clean. Surfaced as
    `junit_evidence_capture_incomplete`, independent of `ambiguous_junit_evidence` and of
    `unreliable_gradle_junit_evidence` (an allowed Gradle attempt's own evidence read as
    `integrity_error`) — each is its own `scenarioCellIntegrityOk` check
    (`junitCaptureCompleteOk`/`junitEvidenceOk`/`junitSkipEvidenceOk`) so a caller can tell exactly
    which failed. The **only** tolerance: for the single *last* relevant attempt, when the
    condition was terminated by a genuine timeout, a record that is entirely **absent** is
    tolerated — a duplicate-write anomaly tombstone, an incoherent decision value, a command
    cross-check mismatch, or an `integrity_error` status on that same attempt all still block
    unconditionally, timeout or not.
  - **A duplicate sidecar write (a real, reachable case: which of `PostToolUse`/
    `PostToolUseFailure` a non-zero-exit Bash command routes through is not pinned down from
    documentation alone, and this mechanism treats both identically) fails closed, never silently
    overwrites.** `junit-evidence-io.mjs`'s `writeSidecarRecord()` detects the collision via the
    same atomic `promoteTargetsAtomically` primitive every other evidence write in this harness
    already uses; on collision its PRIMARY recovery is to remove the pre-existing, now-ambiguous
    target outright (the worst case becomes "no record at all," unconditionally flagged
    `junit_evidence_capture_incomplete` by every reader) — an `anomalies/<id>.json` tombstone is
    then written as a best-effort diagnostic on top, never the other way around: even if that
    tombstone write ALSO fails (its own target already occupied by an unrelated collision, a real
    case since decision- and evidence-collisions share one tombstone path keyed only by
    `tool_use_id`), the target removal above has already made the outcome safe.

  **Accepted-run observability: post-signal metrics + a committed structural audit sidecar.**
  Raw stream-json transcripts live only under the gitignored `raw/` subdirectory — once that
  transcript is gone (a fresh clone, a pruned local disk), nothing previously let a reader confirm
  what a record's own timing/order claims actually rested on. Schema **v5** adds four new
  `{value,reason}` nullable metrics to every record, and every accepted **scenario** record gets one
  companion structural sidecar committed alongside it.

  The four new metrics, all anchored to the SAME boundary `gradeScenarioCondition()` already
  computes — `firstUsefulSignalEventIndex`, the authoritative `user.tool_result` event that first
  satisfied the scenario's expected outcome (never the *terminal* attempt, which can be a later,
  possibly-wrong retry; see `terminalAuthoritativeEventIndex` below):
  - **`post_signal_ms`** — monotonic process-completion time (`spawnCondition()`'s new
    `endedHrtimeNs`, captured immediately before resolving on both its `error` and `close` paths)
    minus the signal event's own monotonic receipt time (`derivePostSignalMs()`,
    `stream-parser.mjs` — the exact sibling of `deriveFirstUsefulSignalMs()`, same single-subtraction
    discipline, never wall-clock `Date` values). Fails closed to `null` for a missing event, a
    non-bigint receipt/end time, or an end time earlier than the event.
  - **`post_signal_tool_calls`** — every tool-use block (any kind: Bash, Skill, or an unexpected
    tool) whose own **dispatching** assistant-event index is strictly greater than the signal's
    result-event index. A call dispatched *before* the signal but whose own result arrives *after*
    it is **not** post-signal work — classified by when it was DISPATCHED, never by when its result
    landed, matching `post_signal_ms`'s own dispatch-time framing.
  - **`policy_denials_before_first_signal`** / **`policy_denials_after_first_signal`** — every
    denied Bash attempt (`resolveDecisions()`'s own `'deny'`), split by the identical boundary and
    the identical dispatch-time rule — a denial in the SAME assistant turn as the eventual
    signal-producing call classifies as *before*, even though its own result may arrive later.

  All four are `null` with the exact reason `"no first useful signal boundary"` when
  `firstUsefulSignalEventIndex` is `null` (nothing to anchor a boundary to at all), and `null` with a
  run-kind-specific reason for `calibration`/`smoke` (no scenario grader ever applies to those run
  kinds). A real, non-null value requires both a real boundary AND a scenario record.

  **The structural sidecar** (`tools/agentic-eval/accepted-run-audit.mjs`) is a *second*,
  independently-derived, privacy-safe view of the exact same transcript a scenario record's own
  metrics were computed from — reproducible, from committed artifacts alone, without the raw
  transcript ever being available. It is **structural, never content-bearing**: every `tool_calls[]`
  entry is a closed-vocabulary category —
  `tool_kind` (`target-skill|non-target-skill|kmp-test|gradle|other-bash|unexpected-tool`),
  `operation` (the specific ALLOWED kmp-test subcommand/Gradle-task-membership bucket, or `"other"`
  — never the raw subcommand/task/module value itself unless it's already a member of the record's
  own `policy_allowed_*` list, and even then only that allowed value, never an arbitrary one),
  `plan_only`, `policy_decision` (`allow|deny|missing|not-applicable`), `result_status`
  (`success|error|missing`), `phase` (`pre-signal|produced-signal|post-signal|no-signal`), and — in
  schema 2 and 3 — `dispatch_status`
  (`hook_evaluated|pre_dispatch_blocked|unaccounted|not_applicable`) — plus
  each entry's own `tool_use_event_index`/`tool_result_event_index` (integers, not timestamps) and a
  stable `ordinal` (`0..N-1`, transcript order, including multiple calls dispatched in one assistant
  turn). The sidecar's own `terminal_authoritative_event` comes directly from the grader's own
  additive `terminalAuthoritativeEventIndex` (never re-derived by parsing `grading_checks.detail` or
  guessing from the last Bash call) — genuinely distinct from `first_useful_signal_event` whenever
  more than one on-target attempt exists (terminal is the LAST on-target attempt; first-useful-signal
  is the EARLIEST correct one). The sidecar **never stores**: raw command strings or argv, module
  filters, task names, test filters, paths, cwd, environment variables, prompts, assistant text,
  reasoning, tool-result content, raw skill names, tool-use IDs (or their hashes), session IDs,
  usernames, repository URLs, or timestamps. A single sidecar is produced only for a scenario record
  that reaches the finalization path, and is written **only if the whole matrix passes and is
  promoted** — a rejected matrix (`scenarioHardGate()` failing) writes none of the three tiers
  (record, raw transcript, sidecar), exactly as before this PR.

  **Do not overclaim what the sidecar proves.** It proves the harness's own committed structural
  derivation of the transcript, and makes the specific post-signal/ordering/decision-classification
  facts a record's metrics rest on independently reproducible from committed artifacts — it does
  **not** independently prove the original raw transcript's own content, which was never committed
  in the first place and is not recoverable from the sidecar.

  **Schema versions, and the construction-time vs at-rest evidentiary boundary.** Three versions
  coexist: **v1** (frozen — the 92 historical committed sidecars), **v2** (frozen — the 64 committed
  sidecars written since, adding per-call `dispatch_status` and `summary.pre_dispatch_blocked_total`;
  both v1 and v2 still require literally `run_schema: 5`), and **v3** (current, for schema-v6
  records). Validation dispatches on the sidecar's own real version and fails closed on anything
  outside `{1, 2, 3}`; a record's `accepted_audit.schema` must equal the schema of the sidecar it
  points at, checked during cross-validation — a schema-v5 record accepts only sidecar schema 1 or
  2, a schema-v6 record accepts only sidecar schema 3 (never the reverse in either direction, so a
  future schema bump can never silently borrow the wrong version's shape). That equality was
  implicit while only one version existed and is now asserted per the compatible pair.

  **v3** conserves v2's `tool_calls`/`summary` shape verbatim (no re-litigating the
  `dispatch_status` contract below), requires literally `run_schema: 6`, and adds exactly one new
  top-level field: `run_provenance_sha256` — the canonical SHA-256 of an exact projection of the
  record (`schema`, `run_id`, `run_kind`, `condition`, `scenario_id`, `agent_runtime`,
  `execution_profile`, `skill_observation`, `platform`, `repo_commit`,
  `kmp_test_cli_source_sha`, `project_commit` — excluding the record's own `accepted_audit`
  pointer, to avoid a hashing cycle). The builder computes it once; the self-contained validator
  checks only its shape (a real lowercase 64-hex string); cross-validation recomputes it from the
  re-read record and requires exact equality — binding runtime, model, execution profile, platform,
  harness/project commits, and skill delivery/source/treatment identity to the sidecar in BOTH
  directions (record → sidecar hash, sidecar → recomputed provenance hash), the same role a
  content hash plays everywhere else in this harness.

  The boundary matters for what `dispatch_status: "pre_dispatch_blocked"` can be trusted to mean.
  At **construction** time `buildAcceptedRunAuditSidecar` consumes the canonical per-attempt map
  (`dispatchAccounting.dispatchStatusByAttempt`) as the *only* source of `dispatch_status` — it
  never re-derives a status from `decisionByAttempt`, so a sidecar built without that map reads
  every Bash call as `unaccounted` and cannot validate. Concretely, the guarantee is a three-link
  chain rather than an absolute "nobody can fabricate this": the label is produced once in
  `resolveDecisions` by the strict matcher, cross-checked in `dispatch-accounting.mjs` against the
  hook-event and decision channels, and re-checked for literal-shape coherence by the builder
  (which throws rather than emit a `pre_dispatch_blocked` entry whose transcript does not match).
  At **rest**,
  `validateAcceptedRunAuditSidecar` has only the sidecar, which carries none of those fields, so it
  cannot and does not attempt to prove the matcher matched. It enforces the closed *structural*
  contract only: `hook_evaluated` ⟺ `policy_decision` is `allow`/`deny`; `pre_dispatch_blocked` ⟺
  `policy_decision: "not-applicable"` **and** `result_status: "error"`; `unaccounted` ⟺
  `policy_decision: "missing"`; `not_applicable` ⟺ a non-Bash tool. A Bash call may use
  `not-applicable` **only** when its `dispatch_status` is `pre_dispatch_blocked` — for any other
  Bash entry it remains an error, exactly as in v1. `summary.policy_decisions_missing` counts only
  `unaccounted` calls, so the accepted-sidecar invariant (it must be exactly 0) still means "every
  Bash call's dispatch is accounted for", and a recognized pre-dispatch block — for which no policy
  decision was ever due — no longer reads as a capture failure that did not happen.

  **Binding and location.** Every schema-v5 scenario record carries
  `accepted_audit: {schema, relative_path, sha256}` — `relative_path` is always exactly
  `"audit/<run_id>.json"`, POSIX-style, derived from that same record's own `run_id` (rejected by the
  schema if it's an absolute path, contains a backslash, a traversal segment, or any other filename —
  `schemas.mjs`'s own closed-charset regex has no `/` or `\` in it at all, so a path can never escape
  via a crafted `run_id` either); `sha256` is the exact SHA-256 of the final, REDACTED sidecar text,
  computed once redaction has already run (never over the raw, pre-redaction object). Non-scenario
  records (`calibration`/`smoke`, any `run_kind` other than `scenario`) always carry
  `accepted_audit: null` — sidecars are a scenario-only concept, and the pair-based
  `writeRunRecordEvidence()` calibrate/smoke path is completely untouched by this PR: it writes no
  `audit/` directory at all.

  **Privacy and cross-validation order** (mirrors the existing record-redaction discipline exactly,
  one tier over): build the sidecar → validate the original object → run it through
  `assertCleanOrThrowObject()` field-by-field → validate the REDACTED object again (a replacement
  placeholder could still make a field the wrong type) → SHA-256 the exact final redacted text →
  attach that digest + the deterministic path to the run record → redact and revalidate the run
  record itself (the pre-existing cycle, unchanged) → cross-validate the final redacted record
  against the sidecar (`crossValidateAcceptedRunAuditAgainstRecord()` — identity fields
  `run_id`/`run_schema`/`run_kind`/`condition`/`scenario_id`/`first_useful_signal_event` and every
  metric total must agree). Any privacy, schema, digest, or cross-record failure at any step returns
  `{ok:false}` and writes **none** of the three tiers — never a partial promotion.

  **Transactional promotion.** `promoteTargetsAtomically()` (`evidence-io.mjs`) now accepts either a
  single directory or an array of directories to create (`raw/` and, for a scenario matrix, `audit/`
  too) — a conservative extension; every existing single-directory caller is unaffected. All `3×N`
  targets (N redacted records, N raw transcripts, N sidecars) for one matrix are promoted as ONE
  all-or-nothing batch: a collision or write/link failure on **any** target — including a sidecar —
  rolls back every FINAL-path target this invocation already linked, across all three tiers, before
  rethrowing. This inherits the exact same, already-accepted limits as every other write in this
  harness: exception-safe and collision-safe, but **not** crash-safe against a hard kill/power-loss
  between two sequential `linkSync` calls — that narrow window can still leave a `.tmp-<random>`
  file, or one of a logically-paired set of targets promoted without its siblings, on disk.

  **Offline validation** (`validate --run <path>`) is extended, not replaced: schemas 1-4 (and a
  schema-5 non-scenario record) get exactly the pre-existing record-only behavior. A schema-5
  scenario record ADDITIONALLY resolves `accepted_audit.relative_path` relative to the run record's
  OWN directory, requires the sidecar file to exist and parse, verifies its strict internal schema
  (`validateAcceptedRunAuditSidecar()`) and record coherence
  (`crossValidateAcceptedRunAuditAgainstRecord()`), and SHA-256s the exact file text against the
  record's own declared digest — every failure reported through the same `{errors,warnings}` JSON
  output and nonzero exit this command has always used. Both the run directory and the resolved
  sidecar path are `realpath`-resolved and containment-checked before either is ever read — a
  symlink planted at the (schema-guaranteed-safe-looking) sidecar path whose target resolves outside
  the run record's own directory is refused, never silently followed.

  `corpus/scenarios/` holds all six originally-sketched scenarios now (`kampkit-android-host-test-discovery`
  and `kampkit-no-applicable-tests`, both targeting KaMPKit commit
  `b3a7784fb969a8558b88c80674c8b596944cdab7` — the same commit the shipped `smoke` evidence uses;
  `nowinandroid-core-common` against a pinned NowInAndroid commit; `deterministic-unit-test-failure`
  — the first `tests_failed` scenario — against a different pinned NowInAndroid commit;
  `coverage-threshold-failure` — the first `coverage_threshold_exceeded` scenario — against
  NowInAndroid's `:core:domain` module, the same commit `nowinandroid-core-common` pins;
  `changed-module-verification` — the 6th and final scenario, requiring `kmp-test changed`
  specifically as terminal proof — against the same commit and module `nowinandroid-core-common`
  pins, via a pre-run `fixture_setup` mutation instead of being told the module outright). This
  PR itself adds zero live scenario records — every number in `corpus/scenarios/*.json` is
  independently re-verified via direct local CLI/Gradle execution (never through the `run` command,
  and never through a live Claude session). Live `run_kind:"scenario"` records for the two KaMPKit
  scenarios (and, separately, for `nowinandroid-core-common`) already exist under
  `tools/runs/agentic-eval-scenario/` from earlier canary work — `deterministic-unit-test-failure`,
  `coverage-threshold-failure`, and `changed-module-verification` have no live canary run yet.
- **`corpus-probe`** — accepted in the schema as a future `run_kind` value; not produced by
  anything in this PR.

`aggregate.mjs`/`schemas.mjs` refuse to fold any `benchmark_eligible:false` record into a
publishable aggregate, so nothing produced by `calibrate`/`smoke` (always `false`) can ever be
miscounted as measurement data. A `benchmark_eligible:true` scenario record is the first evidence
shape this harness can produce that is eligible for a future publishable aggregate — but this PR
itself never runs `run` against a live Claude session, so it commits none.

## No committable evidence before every gate passes

`cli.mjs`'s `finalizeAndWriteRecords()` is the **only** path that writes to a committable
`tools/runs/agentic-eval-<kind>/` directory, and it runs every gate in order before writing
anything:

1. Full schema validation (`validateRun`) on both ORIGINAL records.
2. A `dirty_measured_code` provenance check (see "Provenance" below) — fails closed, before
   anything else, if `bin`/`lib`/`scripts` carry uncommitted local modifications not reflected in
   the recorded `repo_commit`.
3. A **freshly recomputed** `policy_sha256` (via `computePolicySha256({fresh:true})`) matched
   against both records — catches evidence that has silently gone stale relative to the current
   `policy-hook.mjs` content, which a format-only check (`/^[0-9a-f]{64}$/`) can't detect.
4. The privacy fail-closed check (`assertCleanOrThrowObject` from `privacy.mjs`) — redacts each
   RAW record OBJECT field-by-field (`tools/lib/redact.mjs`'s `redactValue()`), on the actual
   (unescaped) string values, and only THEN runs the one-and-only `JSON.stringify()` on the
   already-redacted object. This ordering is what makes redaction reliable at all: an earlier
   version serialized first and redacted the resulting text, but `JSON.stringify()` doubles every
   backslash, which `PUBLIC_SHAPE_RULES`' `user_path_win` rule (written for a single literal
   backslash) then silently failed to match — a real Windows path survived completely intact.
   Redacting before the only serialization pass also makes a second, earlier bug class
   structurally impossible rather than merely detected: `JSON.stringify()` always correctly
   escapes whatever a replacement string contains (a raw newline included), so redacted output can
   no longer break JSON syntax the way the old serialize-then-redact-text order once could.
   **Verification uses `findLeaksInValue()` on the raw redacted object, never `findLeaks()` on the
   JSON-serialized text** — a private-patterns rule's own `replacement` string can itself be
   leak-shaped (e.g. a real Windows path instead of a placeholder token); `redactValue()` correctly
   substitutes it into the raw field, but a verification pass that then serialized the whole object
   before scanning would see that replacement's backslashes doubled by JSON escaping and silently
   miss it — confirmed empirically: `assertCleanOrThrowObject()` returned such a replacement
   completely intact under the old stringify-then-scan verification order. `findLeaksInValue()`
   mirrors `redactValue()`'s own recursive tree-walk, scanning each raw string value directly.
5. The redacted OBJECT is still re-validated against the schema — not because redaction can break
   JSON syntax anymore, but because a replacement placeholder could still make a field the wrong
   TYPE for its own domain (e.g. a boolean-context field replaced with a non-boolean string).
6. The run-kind's own hard acceptance predicate (see "Run kinds" above), evaluated against the
   ORIGINAL (pre-redaction) records — the gate's own checks never reference redaction-prone
   fields, and the pre-redaction data is the conceptually correct thing to gate on; redaction is
   a display/storage concern, not a data-correctness one.
7. The evidence directory PATH's own privacy check (`assertCleanOrThrow`, plain text — the path is
   a single string, never JSON-serialized) — verified BEFORE `writeRunRecordEvidence` is ever
   called, not after. An earlier version wrote all four files first and only checked the path
   afterward, so a private-patterns rule matching only the (possibly `KMP_EVAL_RUNS_ROOT`-
   overridden) runs-root path itself — never the record content, already verified clean in step 4
   — could report `{ok:false}` after real evidence was already committed to disk, contradicting
   this list's own "any failure writes nothing" guarantee.

Evidence writes (`writeRunRecordEvidence`) run two checks before touching anything:

1. **Raw-transcript destination safety** (`isRawDirSafeFromAccidentalCommit`) — runtime
   enforcement, not just the run record's own `raw_capture_location_overridden` disclosure (see
   `RUNS_ROOT_IS_DEFAULT`'s comment): disclosing a non-default root in the record doesn't itself
   stop an accidental `git add -A` from staging raw, unredacted transcripts. Verifies the `raw/`
   destination can never end up in a real commit — EITHER it's entirely outside this repo's
   worktree (`isWithinOrEqualCanonical`, realpath'd; git can never see it regardless of any
   gitignore rule), OR it's inside the worktree AND actually covered by `.gitignore`'s own
   raw-transcript glob, checked via `git check-ignore` against a representative file path inside
   `raw/` — never the bare directory, since `.gitignore`'s `**` glob only matches *contents* of
   `raw/`, not the directory path itself (confirmed empirically: `git check-ignore` on the bare
   directory exits 1/not-ignored, on a file inside it exits 0).
2. **No target already exists** — `run_id` embeds only an 8-hex-char slice of `randomUUID()`
   (~2^32 space, not the full 128 bits), so a collision isn't astronomically improbable across
   this harness's full lifetime of runs, and a silent `renameSync` overwrite followed by a later
   rollback could otherwise permanently delete genuine prior evidence with no trace it ever
   existed. Refuses before touching anything, including creating `outDir`/`raw/` themselves.

Both checks can throw; `finalizeAndWriteRecords()` wraps this call in its own `try`/`catch` so a
refusal here returns the same `{ok:false, reason}` shape as every other check in that function,
rather than propagating as an uncaught exception out of `cmdCalibrate`/`cmdSmoke` (neither of
which wrap their own `await finalizeAndWriteRecords(...)` call) — a real gap found while adding
check 1 above, verified by temporarily removing the `try`/`catch` and confirming a genuine
uncaught rejection resulted.

Past both checks, `writeRunRecordEvidence` writes all four files — two redacted records, two raw
transcripts — to `.tmp-<random>` paths first and only `renameSync` them into place once every
write has succeeded; if a failure occurs anywhere in that sequence, including partway through the
renames themselves, every FINAL-path file this call already renamed is rolled back (removed)
before rethrowing, so a partial pair (e.g. record A committed, record B missing) can never be
observed on disk.

Any failure returns `{ok:false, reason}` and writes nothing — verified directly:
`tests/vitest/agentic-eval-cli-integration.test.js` spawns real `node cli.mjs calibrate|smoke`
subprocesses against fake `claude` fixtures (`tests/fixtures/fake-claude-*/`) covering passing
scenarios (including both legitimate no-skill-arm shapes for calibration) and smoke's three
distinct failure scenarios (an unexpected tool invoked, all commands denied, a malformed
transcript line), asserting zero evidence files are written on every failure path.
Every subprocess this test file spawns is pointed at an isolated `KMP_EVAL_RUNS_ROOT` (a
fresh, per-test temp directory) instead of the real, shared `tools/runs/` tree — an earlier
version of this test file read/wrote/deleted directly under the real path, which would have
destroyed real committed evidence the moment any existed there.

`KMP_EVAL_RUNS_ROOT` is a **test-only escape hatch**, not a documented `calibrate`/`smoke` flag —
real invocations should never set it. Only the default `tools/runs/` root is covered by
`.gitignore`'s `tools/runs/agentic-eval-*/raw/**` pattern; a run captured under an overridden root
is NOT gitignore-protected. Rather than silently claiming the default (gitignored) location
regardless, `buildRunRecord()` checks whether `RUNS_ROOT` is actually the default and, if not,
replaces `raw_capture_location` with a generic, content-free placeholder (never the real override
path, which is an arbitrary local filesystem location and could itself be privacy-sensitive) and
adds a `raw_capture_location_overridden` entry to `errors[]` — verified by
`tests/vitest/agentic-eval-cli-integration.test.js`'s "discloses a non-default KMP_EVAL_RUNS_ROOT
honestly" tests (every subprocess this file spawns exercises this exact path) and by
`tests/vitest/agentic-eval-cli.test.js`'s equivalent default-root test (proving the literal
`tools/runs/...` path is only ever reported when it's actually true).

Redaction protects **both** the written file and stdout — `finalizeAndWriteRecords()` returns the
same redacted text it wrote to disk (parsed back, not the original in-memory record), and every
caller (`cmdCalibrate`/`cmdSmoke`) prints that redacted object, never the original. An earlier
version redacted only the file and printed the original, unredacted record to the terminal.

`cli.mjs`'s `parseArgs()` treats a flag with no value (or one immediately followed by another
flag, e.g. a trailing `--private-patterns-file` with nothing after it) as a hard parse error, not
a silently-`undefined` flag — this matters specifically for `--private-patterns-file`, where a
silently-ignored value previously meant private-pattern redaction was silently disabled and the
run still reported `privacy_status: 'public'` with no error at all.

`calibrationHardGate()`/`smokeHardGate()` are named, exported functions (not inline closures)
specifically so each sub-check (`availabilityOk`, `skillSelectionOk`, `pluginProfileOk`,
`pluginSnapshotBindingOk`, `processOk`, `resultOk`, `hookAccountingOk`, `toolResultsCompleteOk`,
`cleanTranscriptOk`, `transcriptStructureOk` -- shared by both gates -- calibration's own
`noSkillSafetyOk`/`currentInvocationOk`, and for smoke also `realWorkOk`, `exactCommandsOk`) can
be unit-tested in isolation with precise synthetic inputs — `tests/vitest/agentic-eval-hard-gates.test.js` flips
exactly one input per test and asserts exactly one named sub-check goes false while every other
named sub-check in the same failure-reason string stays true. This is deliberately a different
proof than the real-subprocess fake-`claude` fixtures in `agentic-eval-cli-integration.test.js`:
constructing a real subprocess transcript that fails *exactly* one sub-check and none of the
others is fragile in its own way (several real event shapes this would require, like a denied
command's own `tool_result` shape, aren't independently verified anywhere in this harness, so
fabricating one risks encoding an unverified guess as confirmed fact). Where a single fake-claude
scenario genuinely trips more than one sub-check at once — e.g. zero commands run at all fails
both `realWorkOk` and `exactCommandsOk`, since neither can be satisfied by zero commands — that's
disclosed as the same underlying fact tripping two named checks, not presented as single-cause
isolation.

## Rejected-run diagnostics

A hard-gate rejection (any run_kind) previously wrote **zero** evidence anywhere — nothing beyond
the terse stderr `reason` line, gone the moment the terminal/log is. `rejection-diagnostics.mjs`
closes that gap with a small, privacy-safe, three-tier record written at the exact point
`finalizeAndWriteRecords()`/`finalizeAndWriteMatrixRecords()` would otherwise just return
`{ok:false}` — kept in its own module (schema + construction + writing together), not `cli.mjs`,
both to avoid growing an already-large file further and because it needs the atomic-write
primitives `evidence-io.mjs` exports (see below) while `cli.mjs` needs to call *into* it — a
circular import either module living inside `cli.mjs` would create.

The third tier (raw transcripts, below) is a deliberate, narrowly-scoped **partial reversal** of
this module's own original "never the full raw transcript" decision — a real 2026-08 canary
rejected `noUnexpectedToolsOk` and the transcript that would have shown *which* tool, at *which*
index, only ever existed in memory (`spawnCondition()`'s own `rawStdout`) and was lost with the
process the moment rejection returned. The two structured tiers already told you a check named
`noUnexpectedToolsOk` failed; nothing told you why. Persisting the raw transcript on rejection
closes that specific gap without reopening the original privacy rationale for the two structured
tiers, which stay exactly as narrow as before.

- **Location**: `tools/runs/agentic-eval-rejected/` — deliberately not shaped like the real
  evidence directories (`agentic-eval-<run_kind>/`, keyed by the closed `RUN_KIND_VALUES` set,
  which never includes `'rejected'`), so `aggregate`/`validate` can never confuse a rejection
  record with real evidence. One file **per rejection** (a fresh, full `randomUUID()`
  `rejection_id`, not an 8-hex-char slice like `run_id`), not a shared append-only log — closer in
  nature to the real per-record evidence files than to `measurement-registry.jsonl`'s long-lived
  queryable-table use case, and closes a real partial-write concern a shared log would reopen.
- **Three tiers, same `rejection_id`, written as TWO INDEPENDENT atomic transactions**:
  1. **Committed** (`<rejection_id>.json`, genuinely **tracked in git** — not gitignored, unlike
     the two tiers below) carries only categorized `foreign_skill_summary` counts, `failed_checks`
     names, per-cell `unexpected_tool_uses_count`, and identity/provenance fields — never a raw
     skill/tool name or any transcript content.
  2. **Local structured detail** (`raw/<rejection_id>.json`, gitignored) is tier 1 plus
     `project_url` and, per cell, real `foreign_skill_names` and `unexpected_tools:
     [{name, event_index}]` plus a `transcript_filename` pointing at tier 3 — still no raw
     transcript *content*: a tool name here is treated as untrusted, arbitrary runtime input (not a
     closed vocabulary — it's whatever string the model happened to pass to a tool outside the
     allowlist), safe in this tier only because it goes through the same redaction pass as every
     other string field here and lives only in this gitignored tier.
  3. **Local raw transcripts** (`raw/transcripts/<rejection_id>/<captureOrdinal>-<sha256(run_id)>
     .jsonl`, gitignored, one file per EXECUTED cell) — byte-for-byte the same `rawStdout` capture
     the accepted path would have written, **never redacted** (same contract as any other `raw/`
     tier in this harness — safety comes from the gitignore-safety check below, not from
     sanitizing content). The filename is deliberately never the raw `run_id` (a charset-denylist
     regex over an untrusted string still admits Windows-reserved names like `CON`/`NUL`/`COM1`
     and segments ending in a dot) and never the schema's own `order_index` field (`null` for
     calibrate/smoke, so it can't serve this purpose for two of the three run kinds this covers) —
     `captureOrdinal` is a plain, caller-assigned, non-negative integer (0..N-1 among the cells
     EXECUTED in *this* rejection) and `sha256hex(run_id)` is always exactly 64 lowercase hex
     characters, so the resulting name can never collide with a reserved name, never contains a
     path separator, and never ends in a dot or space — `deriveTranscriptFilename()` is the single
     implementation of this derivation, shared by the writer and the local tier's own field.

  Persistence is two independent transactions, run in this order, **neither one's outcome ever
  blocking the other from being attempted**: `writeRejectionRawTranscripts()` (tier 3) first —
  minimal failure surface (a UUID-shaped `rejectionId` check, an exact-set/ordinal check, the same
  gitignore-safety proof every other `raw/` tier uses; no schema validation, no redaction, since raw
  content has neither) — then `writeRejectedRunDiagnostics()` (tiers 1+2, the full
  validate → redact → revalidate pipeline this module has always used for its structured tiers).
  Coupling these into one transaction would let a failure in the (more complex, more validated)
  structured-diagnostic layer cost the (simpler, more forensically important) raw evidence —
  precisely the "secondary layer blocks primary evidence" failure class the 2026-08 incident itself
  was, one level removed. Both tiers 1 and 2 stamp the *same* `raw_transcripts_persisted` boolean
  (tier 3's own outcome, known before tiers 1/2 are even built) so a reader never has to guess
  whether a `transcript_filename` points at a file that actually exists.

  All of `raw/<rejection_id>.json` and `raw/transcripts/**` are covered by the *existing*
  `.gitignore:` `tools/runs/agentic-eval-*/raw/**` rule (the `**` wildcard matches at arbitrary
  depth, confirmed empirically with `git check-ignore -v`) — no new `.gitignore` entry was needed
  for either. Only tier 1 (the top-level `<rejection_id>.json`) is genuinely tracked; the whole
  directory is **not** uniformly gitignored, unlike an earlier version of this note claimed.
- **Shape — schema is a genuine DISPATCH (`SUPPORTED_REJECTION_DIAGNOSTICS_SCHEMAS = [2, 3, 4]`),
  not a plain constant bump**: two real diagnostic files from the 2026-08 canary rejection itself
  are `schema:2` and are preserved, hashed, declared incident evidence outside this repo — a plain
  bump would make `validateRejectionRow()` call that very evidence "invalid." `validateRejectionRow()`
  still validates a `schema:2` row against its original, frozen shape (no
  `unexpected_tool_uses_count`/`matrix_complete`/etc. — and a v2 row may not even carry those keys,
  closed-key-set); `buildRejectionDiagnostics()` only ever *constructs* schema 3 or schema 4, never
  schema 2, and never via a bare `schema === LATEST_REJECTION_DIAGNOSTICS_SCHEMA` selector (see the
  schema-4 paragraph below for why). A
  `schema:3` row is `{schema, rejection_id, timestamp, run_kind, run_ids, model_requested,
  repo_commit, scenario_id, project_alias, project_commit, seed, policy_sha256, platform,
  privacy_status, cells, foreign_skill_summary, ambient_profile_matrix_ok, matrix_complete,
  planned_cell_count, executed_cell_count, raw_transcripts_persisted}` — the last four fields are
  new in schema 3 (see "Fail-fast" below for what `matrix_complete:false` means and how it changes
  `ambient_profile_matrix_ok`). Per-cell, schema 3 adds `unexpected_tool_uses_count` (the shared
  `cell-integrity.mjs` evaluation's own count — never reparsed by this module) alongside the
  pre-existing `run_id`/`condition`/`repetition_index`/`order_index`/`skill_source_sha`/
  `model_resolved`/`claude_code_version`/`failed_checks`/`foreign_skill_summary`/
  `ambient_skill_profile`. The single most important invariant `validateRejectionRow()` enforces on
  a `schema:3` row is a strict **biconditional**: `failed_checks.includes('noUnexpectedToolsOk')`
  if and only if `unexpected_tool_uses_count > 0` — this makes the 2026-08 incident's own exact
  shape (a rejection attributed to `noUnexpectedToolsOk` with zero recorded detail anywhere)
  structurally impossible to write again. `ambient_profile_matrix_ok` is `null` for
  calibration/smoke (no matrix/consensus concept applies to a plain A/B pair) or for a `schema:3`
  scenario row whose `matrix_complete` is `false` (a matrix fail-fast stopped early never actually
  evaluated a real cross-cell consensus — claiming one would be false, not merely imprecise); it's
  the real boolean `scenarioHardGate()` computed for any COMPLETE scenario batch — a batch-wide
  fact, distinct from any one cell's own data. The provenance fields mirror `buildRunRecord()`'s own
  field names exactly (read directly off the already-built records, never re-derived), each tied to
  the record's own `run_kind` rather than accepted in any shape unconditionally
  (`validateRejectionRow()` enforces this per run_kind, not just "null or a string"):
  - `calibration`: `project_alias` is the fixed literal `'calibration-project'`
    (`buildRunRecord()`'s own default, never null), `project_commit`/`seed` `null` (no external
    project or repetition concept applies).
  - `smoke`: `project_alias`/`project_commit` real, non-empty values (points at whatever project
    smoke actually ran against); `seed` `null` (no repetition concept applies).
  - `scenario`: `project_alias`/`project_commit` real, non-empty values; `seed` a real integer (the
    actual `--seed` used for that matrix).

  `project_url` is deliberately **not** in this list — see "Privacy" below. `cells` covers
  **every EXECUTED cell** in the rejected batch (not only the failing ones — a scenario matrix's
  "one bad cell blocks the whole batch" design makes every executed cell relevant context — and,
  for a fail-fast-stopped matrix, not the cells that were never spawned at all: see "Fail-fast"
  below) — each cell carries its
  own `run_id`/`condition`/`repetition_index`/`order_index` (both `null` for calibrate/smoke, both
  real non-negative integers for scenario — enforced *together*, tied to the record's own
  `run_kind`)/`skill_source_sha` (`null` for no-skill, the real SHA for current-skill)/
  `model_resolved`/`claude_code_version` (each `null` only when no init event was ever captured)/
  `failed_checks`/`foreign_skill_summary`/`ambient_skill_profile` (read directly off that cell's own
  already-built run record, `{count, scope_id, fingerprint_hmac}` — never the raw skill names,
  exactly like `foreign_skill_summary`'s existing precedent)/`unexpected_tool_uses_count`. The
  top-level `foreign_skill_summary` is always the
  field-by-field sum across `cells[]` — `validateRejectionRow()` enforces this, never letting it
  drift into an independent second source of truth — `run_ids` must always exactly equal the set of
  `cells[].run_id`, `executed_cell_count` must equal `cells.length`, and **at least one** cell must
  carry a non-empty `failed_checks`: a diagnostic
  whose cells are *all* `failed_checks:[]` records no cause anywhere and is itself rejected as
  malformed (a "rejection" with nothing to explain it isn't a real rejection — this also covers a
  fail-fast partial matrix, which can never legitimately exist without at least one cell's own
  local-integrity check having failed).
  `buildRejectionDiagnostics()` itself fails closed the same way: `runKind` must match every
  contributing record's own `run_kind`, and `failedChecksByRunId`/`unexpectedToolUsesCountByRunId`/
  `unexpectedToolsByRunId`/`captureOrdinalByRunId`'s keys must each exactly match
  `records[].run_id` (no missing key silently reading as "nothing failed/nothing unexpected here",
  no stale/extra key from a different batch) — and `assertUnexpectedToolCoherence()` additionally
  enforces, as a construction-time invariant (the local tier is never schema-validated against the
  closed committed shape, so this relationship has no other place to live), that
  `local.cells[i].unexpected_tools.length === committed.cells[i].unexpected_tool_uses_count` for
  every cell AND that `local.raw_transcripts_persisted === committed.raw_transcripts_persisted` —
  both tiers must stamp the identical tier-3 outcome, checked explicitly rather than merely trusted.
- **Shape — schema 4 (`sandboxed-unrestricted-v1` support)**: exclusive to a batch whose *every*
  record is `schema>=6` with `execution_profile.policy_mode === "not_applicable"` — no policy hook
  ever governed such a batch, so a real `policy_sha256` hash would misrepresent what happened.
  Schema 4 extends schema 3's own shape with exactly 3 new top-level fields —
  `execution_profile_id` (a lowercase slug), `policy_mode` (always exactly `"not_applicable"`),
  `isolation_attestation_sha256` (a real hex64 hash) — and requires `policy_sha256` to be *exactly*
  `null` instead of a real hash (never `""`/`0`/a synthetic hash). `buildRejectionDiagnostics()`
  dispatches per batch (never via `LATEST_REJECTION_DIAGNOSTICS_SCHEMA`, so a future `LATEST` bump
  can never silently redirect an unrelated, policy-required batch away from schema 3): every record
  policy-required (or `schema<6`) still builds schema 3, byte-identical to before this addition;
  every record `not_applicable` builds schema 4. The 3 new fields are copied *exclusively* from
  `records[].execution_profile` (never the live registry, never derived from `policy_sha256:null`,
  never a parallel caller-supplied parameter) — a batch that disagrees on any of the 3 (or mixes
  `schema<6` and `schema>=6` records, or policy-required and `not_applicable` records) fails closed
  with a specific reason, since one harness invocation always resolves exactly one execution
  profile for its whole batch. Schema 4 otherwise inherits schema 3's entire
  `matrix_complete`/`planned_cell_count`/`executed_cell_count`/`raw_transcripts_persisted`/
  per-cell `unexpected_tool_uses_count` contract unchanged — fail-fast partial-matrix support is
  orthogonal to `policy_mode`. Schemas 2 and 3 are both frozen going forward exactly as they were.
- **Privacy — `project_url`**: present in the **local-only** tier (top-level, batch-wide,
  alongside `project_alias`/`project_commit` in spirit) but deliberately **absent** from the
  committed tier — unlike `project_alias`/`project_commit`, which identify a project/revision
  without being a directly clickable/shareable link, a committed `project_url` would put a real
  external repository address into the same committed tier every other field here is
  safe-by-construction for.
- **Write ordering (tiers 1+2 only — see above for tier 3's own, separate transaction)**: validate
  the original object → validate the local tier's own shape (`validateRejectionLocalRow()`) →
  `assertUnexpectedToolCoherence()` → redact (`assertCleanOrThrowObject`) → validate the *redacted*
  object again → redact the local tier → re-validate the redacted local tier's shape → promote —
  the same validate-before-and-after-redaction discipline `finalizeAndWriteRecords()` itself uses
  for real evidence (see above), so a redaction rule that would corrupt a required field's
  shape is caught before promotion, not after.
- **Atomicity**: both transactions reuse `evidence-io.mjs`'s `promoteTargetsAtomically()` — the
  exact same exception-safe, collision-safe mechanism every other evidence write in this harness
  already uses (write-to-`.tmp-<random>`-then-`linkSync`, rolling back only what the current call
  itself created) — tier 3 promotes N transcript targets in one call, tiers 1+2 promote their own 2
  targets in a separate call. This is **not** crash-safe against a hard kill between two sequential
  `linkSync` calls within one of those two calls — a pre-existing, already-accepted property of the
  mechanism, not a new weakness; see `evidence-io.mjs`'s own doc comment for the precise contract.
- **Fail-fast (per-cell, before a matrix ever completes)**: after every executed cell (both the
  scenario-matrix loop and the calibrate/smoke pair), `cellTranscriptIntegrityOk()`
  (`cell-integrity.mjs`) evaluates the same 15 harness-integrity checks the final gate uses — no
  matrix-wide consensus, no already-built run record, no grading result, since none of those exist
  yet for a still-running matrix. On a local failure, the loop stops immediately, before spawning
  any further live Claude session, and the rejection diagnostic declares `matrix_complete:false`,
  `planned_cell_count` (how many cells the matrix would have run), and `executed_cell_count` (how
  many actually did) — `scenarioHardGate()` (and its own `ambient_profile_matrix_ok` computation)
  is **never invoked at all** on an incomplete matrix; computing or simulating a cross-cell
  consensus over cells that never ran would be a false claim, not merely an imprecise one, so
  `ambient_profile_matrix_ok` is always `null` here. When the cell that fails locally happens to be
  the matrix's own *last* planned cell, `executed_cell_count` naturally equals `planned_cell_count`
  by the time the loop's own break fires, `matrix_complete` is `true`, and the diagnostic goes
  through the ordinary complete-matrix path instead (a real `scenarioHardGate()` run, a real
  `ambient_profile_matrix_ok` boolean) — fail-fast's savings are prospective (it stops a *future*
  incident whose failing cell isn't the last one), not a claim that every rejection saves sessions.
- **Scope**: fires on the hard-gate-failure branch (for all three run kinds) AND on the fail-fast
  partial-matrix branch described above — not the other early-return reasons in either finalize
  function (schema-invalid, `dirty_measured_code`, `dirty_harness_tooling`, stale `policy_sha256`,
  privacy-check-throw). A failure in either of the two independent transactions is caught and
  surfaced as its own field (`rawTranscriptsWriteError`, `diagnosticsWriteError`) — neither one ever
  masks the original rejection reason or exit code, and neither one's failure prevents the other
  transaction from being attempted. On success, `cmdCalibrate`/`cmdSmoke`/`cmdRun` print each
  transaction's own outcome independently: how many raw transcripts were preserved and under which
  relative directory (or the error, if that transaction failed), and the structured diagnostic's own
  `rejection_id` and a path *relative to* `RUNS_ROOT` (e.g. `agentic-eval-rejected/<uuid>.json`,
  never an absolute filesystem path — safe to print without a further privacy pass) — a caller
  previously had no way to locate a successfully-written diagnostic short of listing the directory
  by hand, and no way to tell "raw preserved but diagnostic failed" apart from its own inverse.

## Materializer long paths, and the crash-safety journal

A 2026-08-10 canary incident found two related gaps, distinct from the rejected-run diagnostics
above: (1) `materialize.mjs`'s git operations had no long-path handling, so a *reused* scenario
worktree accumulating deep Gradle/Hilt/Kotlin build output across cells could fail Windows
`MAX_PATH` with `Filename too long` — confirmed both in `git clean -fdx` (the reuse-branch reset)
and in `removeScenarioWorktree`'s own teardown; and (2) an exception thrown **between cells** —
while materializing/resetting the *next* cell, or anywhere in a cell's own post-spawn processing —
discarded an already-completed, already-spawned live session with zero trace on disk, in any tier.
The rejected-run diagnostics above only ever fire for a *detected* hard-gate rejection on a
*fully-executed* matrix; neither an inter-cell exception nor a non-gate `{ok:false}` (sidecar/
schema/privacy/promotion-collision — all of which return `{ok:false, reason}` rather than throw)
was covered by any forensics mechanism before this.

**Long paths**: every git invocation in `materialize.mjs` is centralized through one command
builder that injects `-c core.longpaths=true` — scoped to that one subprocess call via git's own
`-c` flag, never touching `process.env` or any config file at system/global/local scope, so
`core.longpaths` never persists and no `GIT_CONFIG_*` variable ever reaches the measured
environment. `removeScenarioWorktree()` additionally verifies **two independent postconditions**
before considering a teardown complete — the directory is actually gone (via a new bounded-retry
`removeDirRobust()`, modeled on `lib/project/artifact-sweep.js`'s `renameWithRetrySync`, always
attempted regardless of whether `git worktree remove` itself succeeded) AND the worktree no longer
appears in `git worktree list --porcelain` — because either alone can be misleading. A `git
worktree add` rollback failure is now attached to the original error (`err.rollbackError`) instead
of silently discarded, closing the specific mechanism that left an orphaned scenario-worktree temp
directory behind during the incident.

**The journal**: a per-invocation write-ahead safety net, `durable-journal.mjs`'s
`createInvocationJournal()` is created by the command (`cmdRun`/`cmdCalibrate`/`cmdSmoke`) *before*
the first spawn, under `tools/runs/agentic-eval-journal/<invocation-id>/` (gitignored in full —
`.gitignore`'s `tools/runs/agentic-eval-journal/**`). Storage is immutable, single-purpose files —
never an append-only log, since `promoteTargetsAtomically` is a write-once/refuse-to-overwrite
primitive, not an append primitive: each transition is its own file under `events/`, each cell's
raw payload its own file under `raw/<cellOrdinal>.jsonl`. The transition state machine is closed
and enforced (an illegal transition throws immediately, so a wiring bug fails loudly during
development):

```text
planned -> spawn_started -> spawn_completed -> raw_persisted -> parsed -> evaluated
planned -> spawn_failed                                                    (terminal)
```

An `evaluated` transition may additionally carry `correlation_observability`, a closed schema
containing only the condition/profile enums, counts by tool kind, counts by dispatch/correlation
status, and a timeout-tolerance boolean. It deliberately cannot contain tool-use/result ids,
commands, paths, transcript or prompt/response content, or timestamps. The strict missing-result
count remains visible even when the existing timeout tolerance makes the effective gate complete;
the summary reports that distinction but does not change the gate verdict.

`spawn_started`/`spawn_failed` are determined from `condition-launcher.mjs`'s `spawnCondition`
gaining one optional `onSpawned` callback wired to the real `child.on('spawn')` event — which
performs **zero I/O and can never throw** (Node's EventEmitter dispatch does not protect a
listener from its own exception; a callback doing fallible I/O there could crash the whole harness
process while a live session is still running). It only sets a local `didSpawn` flag and
timestamp; the real journal write happens afterward, as ordinary `await`ed code inside a real
`try/catch`, immediately after `spawnCondition()` resolves and *before* any parsing — "the next
operation," verbatim. `spawn_failed` is a genuine terminal state (a spawn that never actually
started, e.g. `ENOENT`) — never conflated with `spawn_started` continuing normally, which would be
a lie about a process that never ran. `cellOrdinal` is stamped onto every `conditionResult` and is
what promotion-time raw read-back always keys off — never array position, never an assumed A/B
convention (the journal's 0=B/current-skill-then-1=A/no-skill ordinal assignment does not match
this codebase's historical `recordA`/`recordB` parameter ordering elsewhere; conflating the two
would silently swap two live sessions' transcripts).

**Incident finalization**: every risky operation tags its own thrown error with a closed phase
(`durable-journal.mjs`'s `AGENTIC_EVAL_INCIDENT_PHASES`: `acquiring_shared_resources`,
`materializing_cell`, `persisting_cell_journal`, `parsing_or_attributing_cell`,
`finalizing_matrix`) via `tagIncidentPhase()`, never clobbering a more precise inner tag. A single
shared finalizer, `incident-diagnostics.mjs`'s `finalizeIncident()`, is called from every command's
acquisition/execution catch, a **new** catch around grading/record-building/finalization (this
section used to be a bare `try {...} finally {...}` with no `catch` at all — an exception there,
ordinary application logic, would have escaped uncaught to `main()`'s own top-level handler,
reproducing the exact class of silent forensic loss this whole mechanism exists to close, one call
frame later), and the existing `if (!result.ok)` branch whenever `result.rejectionId == null` (a
non-gate failure, not the well-handled hard-gate rejection path above, which is untouched).
`finalizeIncident()` never trusts a caught exception's `.message` or `finalizeAndWrite*`'s own
`result.reason` as already safe — both are redacted through the same pipeline every other
committed artifact in this harness uses, falling back to one of a small closed set of reason codes
(never the raw text) if redaction can't guarantee cleanliness. It writes a committed diagnostic to
`tools/runs/agentic-eval-incident/<incident_id>.json` (real counts, phase, redacted reason,
already-safe provenance) and a gitignored local tier at `agentic-eval-incident/raw/<incident_id>
.json` (already covered by the existing `agentic-eval-*/raw/**` glob). When a raw payload might
not yet be durably in the journal (`phase === 'persisting_cell_journal'`), it also attempts an
**emergency raw fallback** — its own independent, best-effort local transaction, writing to
`agentic-eval-incident/raw/transcripts/<incident_id>/<cellOrdinal>.jsonl` — and reports the outcome
honestly (`emergency_raw_persisted: true|false`, `emergency_raw_write_error`), never assuming
success: if the same underlying failure that broke the primary journal write also breaks this
fallback, that is reported truthfully rather than silently claimed as preserved. Replaces the
previous unconditional `"...threw before any cell completed: ${err.stack || err.message}"` lines —
both the false claim (never checked how many cells actually ran) and the raw stack trace (which
can and does carry absolute paths) printed straight to stderr.

Incident schema 1 remains the byte-compatible shape for legacy callers and incidents without a
validated failed-cell summary. Schema 2 adds exactly one field, `failed_cell_correlation`, selected
by the failed cell ordinal from the journal and revalidated before and after redaction. A malformed
or non-evaluated summary fails closed to schema 1; arbitrary metadata is never copied through.

**Discard policy**: the journal is deleted (`promoteAndDiscard()`) only once the command has
proven the real evidence it was a safety net for is durably elsewhere — full acceptance, or a
hard-gate rejection whose own two-transaction forensics (above) provably persisted the *exact*
same cell set the journal itself captured (`writeRejectionRawTranscripts()` additionally returns a
`rawTranscriptsManifest` of exactly what it wrote, purely additive, so this comparison never needs
to re-read anything off disk). In every other outcome the journal is simply never deleted — its
continued presence on disk *is* the preservation. A discard failure itself is a
`reportCleanupFailures`-style warning only, never a command failure, since by the time it runs the
real evidence is already safe.

## Isolation

- **Environment**: `env-builder.mjs`'s `buildEvalEnv()` is allowlist-only, starting from the
  narrowest defensible set (OS essentials, PATH, locale, temp, Java, Android). `HOME`/
  `USERPROFILE`/`APPDATA` are *not* included — verified empirically that a real `claude -p`
  session authenticates fine without them (OAuth resolves via the OS credential store).
- **kmp-test pinning**: `path-shim.mjs` generates a PATH-prepended shim that invokes *this
  worktree's* `bin/kmp-test.js`, never a stray global install. The pinned path is single-quote
  escaped inside the generated shim (never double-quoted, which would let a `$`/backtick/`$(...)`
  in the worktree path get shell-expanded on every invocation).
- **kmp-test config isolation**: the shim — not the parent claude session's own environment —
  redirects `HOME`/`USERPROFILE` for the grandchild `node bin/kmp-test.js` process only, so
  `~/.kmp-test/config.json` can never affect either arm, while the parent session keeps its real
  profile for OAuth. `KMP_EVAL_TEMP_HOME` itself is wiped and recreated before **each** condition
  of a run-pair (not just allocated once) — otherwise whatever the first-run condition wrote
  there could leak into the second.
- **Command policy**: `policy-hook.mjs`, a `PreToolUse` hook, is the **sole** command-approval
  mechanism (an earlier `--allowedTools` pattern-list design was tested directly and found
  insufficient — see the PR description's evidence table). It's a narrow, explicit-grammar
  allowlist (not a denylist): only `kmp-test <allowed-subcommand>` and
  `<fixture-anchored-gradlew> <allowed-task>` shapes are approved, every path argument is
  resolved via `fs.realpathSync()` (never lexically inspected — closes shell/env-expansion,
  symlink/junction escapes, and PATH-order substitution), and policy configuration
  (`KMP_EVAL_ALLOWED_GRADLE_TASKS`, `KMP_EVAL_ALLOWED_KMPTEST_SUBCOMMANDS`,
  `KMP_EVAL_EXPECTED_FIXTURE_ROOT`) comes only from harness-controlled environment variables,
  never the hook's own stdin payload. `condition-launcher.mjs`'s `buildSharedEnv()` routes this
  policy config through `policy-config.mjs`'s own validator *before* it ever reaches the env
  object, so invalid grammar/duplicates/non-array input fail loudly at harness-construction time
  instead of surfacing only as an opaque runtime hook denial. The hook's own response is flushed
  (gated on `process.stdout.write()`'s completion callback) before the hook process exits —
  `process.exit()` immediately after starting a write can truncate it on a piped stdout. The one
  shell-operator exception is an exact terminal `2>&1` on an otherwise-valid `kmp-test` command:
  it only merges stderr into the already-captured stdout stream. It remains denied for Gradle and
  every other command, and pipes, chaining, file redirection, substitution, wrappers, embedded or
  repeated operators, and multiline commands remain fail-closed. Because the hook's source bytes
  feed `policy_sha256`, records produced with this grammar partition from earlier evidence rather
  than being aggregated as if their execution policy were identical.
- **Bash resolution**: every `bash -c` invocation in this harness (git/tar piping, the measured
  `claude` spawn) goes through `resolve-bash.mjs`'s `resolveBash()`. **On Windows specifically**,
  this never resolves to an ambiguous bare `'bash'`: PATH resolution of a bare `'bash'` is
  **not** unambiguous there — if WSL is installed, `System32\bash.exe` (a launcher into the WSL
  subsystem, with WSL's own path translation) can resolve ahead of Git for Windows' MSYS2
  `bash.exe` depending on PATH order — confirmed directly (this exact ambiguity broke 6 tests
  when the suite ran under a shell where System32 preceded Git's `bin/` on PATH). On Windows,
  `resolveBash()` checks well-known Git for Windows install locations first, falls back to
  deriving `bash.exe` from `where git`'s own install root, and supports an explicit
  `KMP_EVAL_BASH_PATH` override — it never silently falls back to an ambiguous bare `'bash'` on
  that platform. On POSIX, `resolveBash()` *does* return the bare string `'bash'` as-is — PATH
  resolution there has no WSL-style split to be ambiguous about, so the extra resolution logic
  is Windows-only.

**This is a verified command-policy boundary for a pinned, trusted fixture/scenario project —
not an OS/filesystem sandbox.** Once a command is approved, Gradle build-script code and
kmp-test itself execute with full host permissions. Acceptable specifically because
fixture/scenario projects are pinned, committed, and trusted; never claimed as a general
sandbox. No OS-level sandbox exists on native Windows. `schemas.mjs` accepts
`termination_reason: 'unsupported-platform-profile'` as a future graceful-degradation value (a
scenario that genuinely needs more than the hook's approved grammar allows should report this
instead of the hook's permissions being widened to force completion) — **stated precisely: no
code path in this PR actually produces that value today.** `condition-launcher.mjs`'s real
termination logic only ever assigns `null` (normal completion, any exit code), `'timeout'` (the
harness's own timer fired), or `'error'` (the process was killed by an external signal). Wiring
an actual graceful-degradation path is future work, not implemented here.

## Materialization and cleanup

Every fixture — calibration project, scenario project, or the skill snapshot itself — is
materialized into a fresh `os.tmpdir()`-rooted directory immediately before use (`materialize.mjs`),
never run in place inside this repo. For the two conditions of one run-pair, the same temp path
is reused, wiped, and re-populated from the pristine source between conditions — literally the
same cwd, never state leaking from one condition into the other. Same discipline for
`GRADLE_USER_HOME` (snapshotted once per run-pair, restored to that exact snapshot before each
condition — no dependency prewarming actually happens as of this PR; `runPrewarm` is an optional
hook a caller can supply, but `cli.mjs` doesn't supply one today, so the "snapshot" is of an
otherwise-empty directory).

`cli.mjs`'s `runConditionPair()` returns a `cleanup()` function the caller invokes from a
`finally` block on a **successful** resolution, removing every temp directory it created (shim,
skill snapshot, both of `materializeGradleUserHome`'s temp directories, `KMP_EVAL_TEMP_HOME`, the
generated `--settings` file's directory) and, for a scenario project specifically,
`materialize.mjs`'s `removeScenarioWorktree()` — a plain directory delete leaves the source
repo's `.git/worktrees/` metadata registered forever even after the directory is gone.

That returned `cleanup()` handle is **not** the only cleanup path. `runConditionPair()` accumulates
an internal list of cleanup steps as each resource is actually created (not all at once at the
end); if acquisition fails partway through — the skill-snapshot `git archive`/validation, either
condition's own `materializeFixture` call, or anything else before the function would otherwise
return — an internal `try`/`catch` runs every step queued so far before rethrowing, so a caller's
own `try { await runConditionPair(...) } finally { cleanup() }` was never the only thing standing
between a failure and a leak. Every individual `materialize.mjs` function has the equivalent
internal guard for whatever it creates before returning: `materializeSkillSnapshot()` for its temp
directory, `materializeCalibrationProject()` for its `mkdirSync`+`cpSync` pair (a `cpSync` failure
partway through previously left an empty or partially-copied `kmp-agentic-eval-calibration-*`
directory behind, confirmed as a real leak before this fix), `materializeScenarioProject()` for its
`git worktree add` (best-effort `removeScenarioWorktree()` on failure), and
`materializeGradleUserHome()` for both of its temp directories. This was a real gap found by an
independent review pass: previously the returned `cleanup()` was the *only* mechanism, and a
caller only ever receives it once `runConditionPair()` has already resolved successfully — a
failure inside the function itself (or inside any ONE of the materialize functions it calls) left
every resource created up to that point on disk permanently. A leftover git-worktree registration
from exactly this failure mode was found in the wild during that same review pass and has been
removed; `tests/vitest/agentic-eval-run-condition-pair.test.js` now drives the real function with
an injected mid-acquisition failure and asserts every temp resource created before the injection
point is gone afterward.

`runCleanup()` itself is best-effort — one queued step failing doesn't prevent the others from
still running — but it now returns the list of failures instead of only logging each one
individually and discarding the result: a caller could previously report overall success (a
passing gate, evidence written) while cleanup partially failed, with nothing surfaced beyond a
per-step `console.error` a log reviewer would have to already be looking for.
`cmdCalibrate`/`cmdSmoke` now print a single, clearly-labeled `WARNING:` line if `cleanup()`
reports any failures — never escalated into changing the command's own exit code (a temp-dir
cleanup race is a disk-hygiene concern, not evidence the run's own gate result or written evidence
is wrong), but never silent either.

Verified directly: `agentic-eval-cli-integration.test.js` asserts zero leftover temp directories
(via a `TEMP`/`TMP`/`TMPDIR`-redirected, test-exclusive tmp root — a global `os.tmpdir()` count is
not safe to assert against under concurrent test-file execution) and zero leftover `git worktree
list` entries after both a passing and a failing run.

## Usage

```bash
node tools/agentic-eval/cli.mjs --help
node tools/agentic-eval/cli.mjs calibrate            # explicit-invocation calibration, both conditions
node tools/agentic-eval/cli.mjs smoke --source-repo-dir <local-clone> --pinned-commit <sha>
node tools/agentic-eval/cli.mjs run --scenario <id> --source-repo-dir <local-clone> --seed <n>
                                     [--repeats <n>]  # full scenario matrix, --dry-run for a no-Claude-spawn preview
node tools/agentic-eval/cli.mjs corpus validate       # validates trigger-queries.json AND corpus/scenarios/*.json
node tools/agentic-eval/cli.mjs validate --run <path> # validates a run record; a schema-v5 scenario
                                                       # record also verifies its own committed audit/ sidecar
node tools/agentic-eval/cli.mjs aggregate --runs-dir <dir>
node tools/agentic-eval/cli.mjs analyze --runs-dir <dir>   # offline, axis-separated per-run + summary breakdown
```

Every subcommand's flags are validated against an explicit per-subcommand allowlist
(`SUBCOMMAND_SHAPES`) before it runs — an unrecognized flag, a duplicated flag, or an unexpected
extra positional argument is a hard error, not silently ignored. The process itself sets
`process.exitCode` rather than calling `process.exit()` directly, so a piped stdout's buffered
`console.log()` output (the JSON every subcommand prints) is never truncated by the process exiting
before that write actually flushes — the same class of bug this harness already fixed once in
`policy-hook.mjs`'s own write-then-exit ordering.

`calibrate`, `smoke`, and `run` all accept `--model <name>`, `--runtime <id>`, and
`--execution-profile <id>` (see "Runtime/model/execution-profile selection" under "Schemas"
below for the full registry-resolution contract — omitting all three reproduces today's single
enabled default), plus an optional
`--private-patterns-file <path>` — supplying the latter loads additional private-project
redaction rules (via `tools/lib/redact.mjs`'s `loadPrivateRules`) and marks the resulting
records `privacy_status: 'redacted-private'` instead of `'public'`. This harness's own usage today
(the synthetic calibration fixture, public KaMPKit, and public NowInAndroid) never supplies it. The file is loaded and
validated eagerly, before either condition's session runs — a missing or malformed patterns file
fails the command immediately rather than only surfacing after both sessions have already
completed. `cli.mjs`'s flag parsing requires an exact, known flag name per subcommand and rejects
a value-less or duplicated flag as a hard error — a typo like `--private-pattern-file` (missing
the `s`) is rejected outright rather than silently behaving as if no patterns file had been
supplied at all.

**`--private-patterns-file` protects committed EVIDENCE — it does not protect what Claude
receives during the live session itself.** Redaction runs on the serialized run record right
before it's written to disk (and printed to stdout); it has no effect on, and cannot retroactively
undo, whatever the `scenario`/`smoke` project's own files or command output exposed to the model
during the session. Pointing this harness at a private project requires separate, explicit
authorization for the live session to see that project's content in the first place — this flag
alone is not that authorization, and no scenario in this corpus (public KaMPKit, public
NowInAndroid, the synthetic calibration fixture) currently exercises a private project at all.

Raw transcripts always stay local under `tools/runs/agentic-eval-*/raw/` (gitignored). Only
sanitized, schema-valid, `findLeaks()`-clean run records are ever committed — and only once
`finalizeAndWriteRecords()`'s full gate sequence passes (see above).

## Schemas

Hand-rolled (`CURRENT_*_SCHEMA` int + `CANONICAL_FIELDS` array + `typeof`/enum/regex
validators), matching `tools/measurement-registry.mjs`'s existing convention — no JSON-schema
library exists anywhere in this repo's own code, so none is added here. Every legitimately-
nullable metric is `{value: T|null, reason: string|null}` — "never infer missing metrics, store
null with a reason" is enforced by the validator, not just a comment. Beyond the `{value,reason}`
shape, each nullable metric's *value* is also domain-checked once present (boolean for status
metrics, non-negative integer for counts/bytes, non-negative number for timings) — a
shape-valid-but-wrong value (e.g. `skill_invoked: {value: "false", reason: null}`, a string
instead of a boolean) previously passed validation silently.

Run-record schema is versioned per-field-list, dispatched by an explicit if-chain (never a bare
ternary, which silently falls an unrecognized/future schema number through to v1) —
`SUPPORTED_RUN_SCHEMAS` is every version `validateRun()` still accepts (so historical committed
records never need retroactive edits); `LATEST_RUN_SCHEMA` is what every subcommand stamps on new
records going forward. v2 added `grading_checks`/`repetition_index` (scenario-only); v3 adds
`foreign_skill_summary` — required, non-nullable, on **every** run_kind (not scenario-only, since
it's always computable from the transcript even when empty) — and every v2 semantic rule is
inherited via `>=` gates, not re-declared, so a v3 record can't silently skip validation a v2
record would have been subject to. **v4** adds `ambient_skill_profile: {count, scope_id,
fingerprint_hmac}` — mirrors `foreign_skill_summary` exactly (required, non-nullable, every
run_kind, every prior semantic rule inherited via `>=`) — a privacy-safe, invocation-scoped-keyed
summary of the init event's `skills[]` array (target identity stripped, see "Ambient-skill-profile
tolerance" above), never the raw skill names themselves. `scope_id` is a full UUID string;
`fingerprint_hmac` a lowercase 64-hex-char HMAC-SHA256 digest — both validated with the same
regexes `rejection_id`/`policy_sha256` already use elsewhere in this schema. **v5** (accepted-run
observability) adds four new post-signal `{value,reason}` metrics —
`post_signal_ms`/`post_signal_tool_calls`/`policy_denials_before_first_signal`/
`policy_denials_after_first_signal`, present (possibly `null`+reason) on **every** run_kind, exactly
like `ambient_skill_profile` — plus `accepted_audit` (a plain nullable structured field, never a
`{value,reason}` metric): `null` for every non-scenario record, and a required
`{schema, relative_path, sha256}` object for a scenario record, binding it to its own committed
structural audit sidecar. All five fields (and every prior schema's own semantic rules, inherited
via `>=`) are rejected as unrecognized/self-contradictory below v5, exactly like every earlier
version-introduced field. See "Accepted-run observability" above for the full metric/sidecar
contract.

**v6** (runtime-neutral records) adds four required, non-nullable groups on **every** run_kind —
`agent_runtime`, `execution_profile`, `skill_observation`, `usage` — reflecting a
registry-resolved runtime/model/execution-profile selection (`registries.mjs`) rather than a
hardcoded Claude Code assumption. `agent_runtime` carries `runtime_id`, `cli_version`,
`model_requested`/`model_resolved`, and `model_vendor_expected`/`model_vendor_observed`; for
`runtime_id: 'claude-code'`, `model_requested`/`model_resolved`/`cli_version` are required to
exactly mirror the record's own legacy `model_requested`/`model_resolved`/`claude_code_version`
fields (never a second, independently-drifting source of the same fact). `execution_profile`
carries `id`, `sha256` (the registry's own canonical execution-profile hash), `isolation_kind`,
`isolation_attestation_sha256`, `network_mode` — `strict-policy-v1`'s frozen registry semantics
require `isolation_attestation_sha256: null` (no attestation is ever required under it).
`skill_observation` carries `delivery_mode` (strictly gated by `condition` for claude-code —
`'none'` for no-skill, `'runtime-extension'` for current-skill), `availability`/`activation`
(each `{status, evidence_kind}`, structurally identical to — and required to cross-validate
against — the legacy `skill_available`/`skill_invoked` fields), `source_sha`, and
`treatment_size` (see "Treatment size" below). `usage` carries the four runtime-reported
dimensions (`input`/`cached_input`/`cache_write`/`output`), `reasoning_output` (always `null` for
Claude, which never reports it — never coerced to zero), `source`
(`'runtime-reported'`/`'not-recorded'`, real only when at least one dimension is a genuine
number), and `attributable_to_skill_load` (a separate `{status, dimensions, unit, reason}` group —
Claude never attributes usage to skill loading specifically in this PR, so `status` is always
`'not-recorded'` here, never inferred). All four groups (and every prior schema's own semantic
rules, inherited via `>=`) are rejected as unrecognized/self-contradictory below v6.

**Treatment size** (`skill_observation.treatment_size`) answers "what was made available to the
model", never "what the model actually loaded or read" — `snapshot_sha256`/`snapshot_bytes`/
`snapshot_file_count` are computed offline from Git objects (`input-artifacts.mjs`'s
`computeSkillSnapshotArtifact`, via `git ls-tree`, never touching checkout bytes) over the
materialized skill directory, and `prompt_sha256`/`prompt_bytes` identically for the scenario
prompt text (`computePromptArtifact`) — both are artifact-availability measurements, not proof of
model attention. For a no-skill condition, `snapshot_*` are `null` with
`absent_reason: 'condition-no-skill'` (the skill was never made available at all); the prompt
fields are still populated (a prompt is always sent, regardless of condition).

**Runtime/model/execution-profile selection** (`--runtime <id>`, `--execution-profile <id>` — new
flags on `calibrate`/`smoke`/`run` only, alongside the existing `--model <id>`) resolves against
three closed JSON registries (`runtimes/registry.json`, `models/registry.json`,
`execution-profiles/registry.json`) via `registries.mjs`'s `resolveSelection()`: omitting a flag
resolves to that registry's own documented default for the axis (model/execution-profile
resolution is scoped to whichever runtime was already resolved); an unknown, disabled, or
cross-runtime-incompatible id fails closed with a clear reason before any auth/materialize/spawn
ever happens — never a fuzzy match, never a silent fallback. Today's registries carry exactly one
enabled entry per axis (`claude-code` / `claude-sonnet-5` / `strict-policy-v1`), so omitting all
three flags reproduces the pre-registry default exactly.

**Adding a model or execution profile is a registry-only change ONLY when the adapter actually
supports the new entry's configuration** — every runtime adapter now implements two additional
gating methods, `supportsModelConfiguration(modelEntry)` and `supportsExecutionProfile(profileEntry)`
(`runtimes/contract.mjs`'s `ADAPTER_KEYS`), and `buildRegistries`/`resolveSelection` reject any
ENABLED entry the adapter itself reports `false` for. This closes a real gap: `buildInvocation`
only ever receives `{prompt, model, settingsPath}`, so a registry could previously describe a
model/profile configuration (e.g. `default_reasoning_mode:"max"`, or a profile requiring a
sandbox/restricted network/attestation) that was never actually applied, while a resulting record
still carried it as if it had been. Claude Code's own adapter accepts an additional model only
when `default_reasoning_mode` is `null` (`model_id` itself is genuinely registry-only — it is
passed literally to the CLI); it accepts exactly `strict-policy-v1`'s current shape as an
execution profile and rejects everything else, including a mutation of that same id and
`sandboxed-unrestricted-v1` — until a later PR adds real runtime-specific implementation for a
second profile and this adapter is deliberately widened, a differently-isolated profile can
describe its shape in the JSON registry (`enabled:false`, kept for history/future work) but is
never selectable.
`aggregate`/`analyze`/`validate`/`corpus`/`scope` never accept these flags — selection is a
per-run-command concern, not a reporting one.

## Fairness Contract

`aggregate.mjs`/`schemas.mjs` refuse to fold runs into one aggregate unless they agree on every
`HARD_PARTITION_FIELDS` key: `scenario_id`, `condition`, `family`, `run_kind`, `cache_state`,
`project_commit`, `model_resolved`, `platform`, `skill_source_sha`, `policy_sha256`,
`kmp_test_cli_source_sha`, `daemon_policy`, `env_allowlist_profile`, `policy_allowed_gradle_tasks`,
`policy_allowed_kmptest_subcommands`, `claude_code_version`, `schema`, `ambient_skill_profile`,
`agent_runtime`, `execution_profile`, `skill_treatment` —
beyond the original guards
(a re-pinned scenario commit, a different resolved model, host platform, skill snapshot,
policy-hook version, or harness code version), the next three guard against silently averaging
across a different environment-isolation profile or a materially different command-policy
CONFIGURATION — `policy_sha256` only captures `policy-hook.mjs`'s own source code, not the
caller-supplied allowed-task/subcommand lists it's configured with, which change what a run was
actually permitted to do just as materially as the hook's code does; `claude_code_version` guards
against silently averaging across a different Claude Code CLI release, which can change event
shapes or tool behavior independent of anything this harness itself controls — aggregation
additionally requires it to be a concrete, non-empty string (not just present), since two runs
both carrying `null` for an unknown CLI version can't be trusted to actually agree with one
another. `schema` guards against silently averaging a v2 record (no `foreign_skill_summary`)
together with a v3 one (has it) — different schema versions carry different measured fields, so
they're never comparable data by definition. `ambient_skill_profile` guards against silently
averaging two SAME-schema runs whose ambient capability profiles are not actually comparable —
including, specifically, two runs from DIFFERENT harness invocations: `scope_id` (part of this same
object) is a fresh, opaque, per-invocation value, so two records with different `scope_id`s can
never be folded together regardless of what their `fingerprint_hmac` happens to look like (the
fingerprint's own HMAC key is random and never persisted, so a match/mismatch across invocations
would be meaningless anyway — see "Ambient-skill-profile tolerance" above). A benchmark-eligible
scenario record with NO `ambient_skill_profile` at all (any schema below v4) is refused from
aggregation outright, exactly like the other completeness-matrix fields below — its ambient profile
is genuinely unknown, not "agreeing on absence" with another such record (a real, demonstrated gap:
two schema:3 records missing the field previously aggregated with zero errors, then failed
`validateAggregateGroupKey`'s own contract the moment the group was JSON-round-tripped, since an
`undefined` object value silently vanishes on serialization). `buildAggregateGroup()` also refuses,
as a general safety net, to return ANY group whose own key would contain an `undefined`
value for any `HARD_PARTITION_FIELDS` entry, for the identical round-trip reason.

**`agent_runtime`/`execution_profile`/`skill_treatment`** (schema v6, `run-record-view.mjs`) are
three further structural partition keys, each projected the SAME way for both `aggregate.mjs` and
`analysis.mjs` so neither module (nor a third) independently re-derives "legacy vs v6" logic.
`agent_runtime` is the full real object below (runtime ID, requested/resolved model,
expected/observed vendor, runtime CLI version — every one of these is its own independent guard,
so a Claude Code version bump or a different resolved model never silently averages with another
run's). `execution_profile`/`skill_treatment` are each a NARROWED projection —
`{id, sha256, isolation_kind, network_mode}` and `{delivery_mode, source_sha, treatment_size}`
respectively — deliberately excluding `isolation_attestation_sha256` and
`availability`/`activation`: attestation is real per-execution evidence, bound and validated
against the record, but can legitimately vary between cells under the same profile, so
partitioning by it would make aggregating repetitions impossible; availability/activation are
OBSERVED OUTCOMES (whether the skill actually loaded), never the treatment itself, and
partitioning by an outcome would introduce exactly the survivorship bias this Contract exists to
prevent. A record below schema v6 projects all three as the literal string `"not-recorded"`
(never `null`, never inferred from `claude_code_version` or hook/policy fields) — so a legacy and
a v6 record can never silently share a bucket merely by both lacking these fields. The two
`policy_allowed_*` fields (and now `ambient_skill_profile`) are arrays or plain objects;
`buildAggregateGroup()`'s mixing-check — and `aggregate.mjs`'s own bucketing key — both compare
them via `canonicalStructuredValue()` (`schemas.mjs`): a single, shared serializer that recursively
sorts object keys (arrays keep their own positional order) before `JSON.stringify()`, so two
structurally-identical values are treated as matching regardless of BOTH object-vs-reference
identity and key INSERTION order (a bare `JSON.stringify` is not canonical w.r.t. the latter — a
real gap this closes: two `ambient_skill_profile` objects with the same `{count, scope_id,
fingerprint_hmac}` values in a different key order previously landed in separate groups/buckets).
`CURRENT_AGGREGATE_SCHEMA` is **3** (was 1, then 2 when `group_key` gained
`ambient_skill_profile`; now 3 for the `agent_runtime`/`execution_profile`/`skill_treatment`
addition above) — versioned exactly like `LATEST_RUN_SCHEMA` is whenever a run record's own
shape changes; no historical committed aggregate-output files exist to preserve compatibility with
(aggregate output is always computed on demand, never persisted under `tools/runs/`). The bucket
key itself is built via `JSON.stringify()`
of the field-value array, not a plain `.join(' ')` — a space-join lets two runs whose field values
differ only in *where* a space falls collide into the same bucket key while their actual values
differ (e.g. `project_commit:'abc def', model_resolved:'x'` vs. `project_commit:'abc',
model_resolved:'def x'` both join to the same string); JSON encoding unambiguously delimits each
element regardless of its own content. Duplicate or empty `run_id` values are rejected before
counting, so a re-submitted run can't inflate `run_count`. Any `benchmark_eligible: false` record
is refused outright. `aggregateRuns()` also validates every record against the full run schema
before bucketing — a record that's partition-field-valid but broken elsewhere (e.g. a malformed
`tokens` object) is excluded and reported per-record, not silently folded into a group.

Schema validation is not limited to shape and enum membership: `exit_code` must be null or an
integer; `started_at`/`ended_at` must be valid ISO timestamps with `ended_at` never before
`started_at`; `wall_clock_ms` must be a non-negative finite number (never legitimately null, since
it's always computed from real timestamps); `hook_call_count`/`hook_deny_count` are each
validated UNCONDITIONALLY (not just when both happen to be present) as non-negative integers,
with the additional cross-field check (deny never exceeding call) applied only once both
individually pass — an earlier version's outer `!= null` guard on BOTH fields meant one field
being a wrong type (e.g. `hook_call_count: "bad"`) while the other was `null` skipped the entire
check block, silently accepting the malformed value; `policy_allowed_gradle_tasks`/
`policy_allowed_kmptest_subcommands` array elements must be non-empty strings; `errors[]` elements
must be objects; and `skill_invoked: true` is rejected outright unless
`skill_invocation_attempted: true` is also set (the schema-level enforcement of "Attempted vs.
confirmed invocation" above).

**Provenance**: every run record's `kmp_test_cli_version` (from this worktree's own
`package.json`), `kmp_test_cli_source_sha`/`repo_commit` (this worktree's own `git rev-parse
HEAD`, resolved fresh — not the pinned *skill* snapshot SHA, which is a separate field,
`skill_source_sha`), and `resolved_kmp_test_executable_path` are real, resolved values, cached
once per process. An earlier version of this harness left all three CLI-identity fields
permanently `null` and populated `repo_commit` with the pinned skill SHA instead of the harness's
own commit — silently correct only by coincidence when the checkout happened to sit exactly at
that pinned SHA, wrong the moment `develop` moved forward. `repo_commit` describes `HEAD`, which
can still differ from the exact bytes that executed if `bin/`/`lib/`/`scripts/` (the paths the
PATH shim's own execution can actually reach) carry uncommitted local modifications — checked via
`git status --porcelain` scoped to exactly those paths and reported as `errors[].code:
'dirty_measured_code'`. Unlike every other disclosed-only error, this one is **fail-closed**:
`finalizeAndWriteRecords()` refuses to write any evidence at all when it's present, rather than
silently letting the recorded SHA imply a codebase that isn't quite what actually ran. A second,
separate check covers `tools/agentic-eval/**`/`package.json` (`errors[].code:
'dirty_harness_tooling'`) and is always disclosed, but fail-closed only conditionally: blocking
applies only when `finalizeAndWriteRecords()` is writing to the default, committable `RUNS_ROOT`
(see `isRunsRootDefault`/`findBlockingHarnessToolingDirty`) — not blanket, because
`tools/agentic-eval/**` is necessarily in-flux during the harness's own active development. Tests
that exercise evidence-writing paths use isolated, non-default roots where required, so
unconditional blocking would make the harness structurally unable to ever produce evidence while
being developed or exercised by its own local test runs; some unit tests do intentionally exercise
the canonical default-root branch directly (they stop short of an actual write). A real
`calibrate`/`smoke` invocation producing official evidence, though, is held to the same clean-tree
discipline as `dirty_measured_code`: develop, commit, then run.

The `dirty_measured_code` fail-closed signal ALSO fires when the underlying git commands
themselves fail (git missing from PATH, a spawn error, or the worktree not being a git repository
at all) or when `git rev-parse HEAD` fails, leaving `repo_commit` null — an earlier version
collapsed "the git status command itself failed" into the exact same empty array as "genuinely
clean," reproduced by removing git from PATH entirely: `repo_commit` correctly came back `null`,
but both dirty-path lists came back empty too, meaning the fail-closed gate silently never fired
even though nothing had actually verified the tree. Both `measuredCodeCheckFailed` and
`harnessToolingCheckFailed` now distinguish "checked and found clean" from "could not check at
all," and an unknown result is treated with the same suspicion as a genuinely dirty one for the
measured-code (fail-closed) category — an unrecorded `repo_commit` is fundamentally
non-reproducible evidence regardless of which specific git call failed.
Evidence writes
(`writeRunRecordEvidence`) are atomic per file (write to a `.tmp-<random>` sibling, then rename
into place) so a mid-write failure can't leave a half-written record on disk, AND the whole
write-then-rename sequence for all four files (two records, two raw transcripts) is itself rolled
back on any failure partway through — see "No committable evidence before every gate passes"
above.

## Axis-separated analysis

`analyze --runs-dir <dir>` (`tools/agentic-eval/analysis.mjs`) is a deterministic, fully offline
command that separates what a single `benchmark_eligible`/`success` pair otherwise collapses
together, into 5 independent axes per run:

1. **target-skill activation** — `activation_expected` (`condition === 'current-skill'`),
   `target_skill_invoked`, `target_skill_invocation_ordinal`, `target_skill_attempt_ordinal`
2. **post-invocation execution** — `post_skill_tool_calls_total`, `post_signal_tool_calls`
3. **policy interaction** — `pre_skill_policy_denials`, `post_skill_policy_denials_total`
4. **authoritative evidence** — `terminal_authoritative_evidence_present`,
   `terminal_authoritative_evidence_well_formed`
5. **final task outcome** — `expected_outcome_matched`, `final_answer_consistent`, `success`

plus one closed-vocabulary `failure_class` per run (see below). It operates ONLY on already-
committed schema-v5-or-later `run_kind:'scenario'` records and their validated accepted-run-audit sidecars
— reusing `run-record-loader.mjs`'s `validateRunRecordFile()` as the ONLY gate for trusting a
file, exactly like `aggregate`/`validate` already do (that module also returns the sidecar's own
already-parsed object, so this command never re-opens the file a second time) — never a raw
transcript (this harness's raw captures are gitignored and never committed at all; `analyze`
doesn't read them even when they happen to exist locally), never a live Claude call, and no
subprocess/network access/filesystem write of any kind. A schema-valid record that is not
`schema >= 5` and `run_kind: 'scenario'` (a pre-v5 record, or a `calibration`/`smoke`/
`corpus-probe` record) is silently out of this command's domain — counted in
`summary.files_excluded_not_applicable`, never treated as an error, since it never had an
accepted-run-audit sidecar to read in the first place. A schema-valid, in-domain record whose own
`benchmark_eligible` is `false` is separately excluded (`summary.files_excluded_benchmark_
ineligible`) — mirroring `aggregate.mjs`'s Fairness Contract, which refuses a benchmark-ineligible
run outright; eligible and ineligible records are never pooled. `benchmark_eligible:true` alone
does not prove a record is complete enough to analyze — `validateRun()` does not itself require
`success`/`expected_outcome_matched` to be non-null for a schema-5 scenario record — so a record
additionally passes the SAME completeness matrix `aggregate.mjs`'s `buildAggregateGroup()`
enforces (the 7 provenance fields, `success`/`expected_outcome_matched` strictly boolean,
`ambient_skill_profile` well-shaped) before being analyzed; failing it is reported as a per-file
error (never a silent exclusion, since a benchmark-eligible record claiming completeness but
lacking it is an integrity problem with that file, unlike a legitimate ineligible result).

**Fail-closed, following `cmdAggregate`'s own precedent**: only regular files (never a directory
merely named `*.json/`) are listed, in sorted-filename order (deterministic regardless of the
filesystem's own `readdirSync` order); a file that fails `validateRunRecordFile` (malformed JSON,
schema violation, missing/invalid/tampered sidecar) is excluded from `per_run` and reported in
`errors[]`, and processing continues past it — one malformed sibling never aborts the whole batch.
`--runs-dir` itself is verified to be an existing, readable directory before any listing is
attempted — pointing it at a regular file or an unreadable path fails with the documented exit-1
contract, never an uncaught exception. A `run_id` that repeats across two files (a copy under a
different filename) is rejected on the second occurrence as a duplicate, never silently inflating
a group's counts. `errors[]` entries carry `file_index` (the file's 0-based sorted position — an
always-safe, content-free identifier) and `run_id`: `null` for any file that failed
`validateRunRecordFile` itself (an invalid file's own self-reported fields, including its run_id,
are never trustworthy enough to echo back), a real value only for a duplicate-run_id rejection
(the record there fully validated; only its uniqueness failed). The command exits `1` whenever
`errors.length > 0`, `0` otherwise (including a clean run that found zero applicable files).
Every file is accounted for exactly once: `files_seen === files_analyzed +
files_excluded_not_applicable + files_excluded_benchmark_ineligible + files_errored`.

**Per-run derivation.** Every skill-relative field is derived from the accepted-run-audit
sidecar's own `tool_calls[]` (never from a raw transcript, which this module never reads), with
BIDIRECTIONAL record↔sidecar coherence enforced before any of them are computed: `target_skill_
invoked:false` requires the sidecar to show ZERO confirmed (`tool_kind:'target-skill'`,
`result_status:'success'`) entries anywhere, and `target_skill_invoked:true` requires a confirmed
entry correlating to `skill_invocation_event.index` — and, whenever more than one confirmed entry
exists anywhere in the sidecar, that entry must be the ordinal-EARLIEST one, matching
`findSkillInvocation()`'s own documented "first confirmed match wins" contract (stream-parser.mjs)
— a record and sidecar that disagree on any of this fail closed (excluded from `per_run`, reported
in `errors[]`) rather than silently trusting one side. Every comparison here (and the pre/post-
skill partition below) uses the sidecar's own always-unique `ordinal`, never `tool_use_event_
index` — one assistant turn can dispatch several tool_use blocks sharing the same event index (the
sidecar schema only requires `ordinal` non-decreasing across such ties, never unique per event),
so `tool_use_event_index` alone cannot disambiguate which of several same-event entries is meant.
`target_skill_invocation_ordinal` is the sidecar's own GLOBAL, zero-based `tool_calls[].ordinal`
for that confirmed entry — the same convention the sidecar already uses for every other entry, so
a delayed activation (several unrelated calls first) is directly visible as ordinal 3, 4, ...
rather than collapsing to a constant. `target_skill_attempt_ordinal` is a SEPARATE,
1-based count of attempts at the target skill specifically (distinct question: "did it take
multiple tries at the skill itself" vs. "how much unrelated work happened first", the latter being
`pre_skill_tool_calls`). `post_skill_tool_calls_total`/`post_skill_policy_denials_total` are
ALWAYS populated once invoked, independent of whether any signal boundary exists — a failed run
that never reached a correct signal still reports real, non-null counts here; only the additional,
narrower `post_skill_tool_calls_through_signal`/`post_skill_policy_denials_through_signal` pair
(calls after invocation up to and including whichever attempt produced the signal — "through", not
"pre", since the signal-producing call itself is included) is `null` when there is no signal
boundary to bound it against. `terminal_authoritative_evidence_present` (from the sidecar's own
`terminal_authoritative_event != null`) and `terminal_authoritative_evidence_well_formed` (from
`grading_checks.value`'s `authoritative_evidence_well_formed` check) are deliberately DISTINCT —
an attempt can exist without being parseable, or never exist at all — and both are distinct again
from `first_useful_signal_present` (`first_useful_signal_event != null`), which additionally
requires CORRECTNESS, not just a well-formed attempt. Every skill-relative field is `null` only
when activation is not expected (`no-skill`/`candidate-skill` condition) — "never infer, never
guess": a condition where activation is out of scope has no invocation-relative boundary to split
calls around. `post_signal_tool_calls` is a direct passthrough of the run record's own schema-v5
field — it is NOT skill-relative (a `no-skill` condition run still has a real, meaningful value),
so it is never nulled by activation status.

**`failure_class`** is exactly one of `success`, `target-skill-not-invoked`,
`policy-denial-observed-without-terminal-evidence`, `no-authoritative-evidence`, `wrong-target`,
`outcome-mismatch`, `final-answer-mismatch`, `unclassified` — resolved by `classifyFailure()`'s
own explicit, unit-tested precedence (checked top to bottom, first match wins, so one run can
never receive two competing causes), and deliberately NON-CAUSAL throughout: every class describes
what was OBSERVED, never asserts an unproven cause. `success:true` always wins regardless of any
other signal; then, when activation was expected, a target skill never confirmed-invoked; then,
only when there is no USABLE terminal evidence at all (`terminal_authoritative_evidence_present`
AND `..._well_formed` both required), a policy denial observation (`hook_deny_count > 0` — named
`policy-denial-observed-without-terminal-evidence`, not "blocked", since this harness has no
attempt-level mechanism to prove the denial specifically CAUSED the absence of evidence); then the
evidence-chain checks in the same dependency order `graders.mjs`'s own checks 4/5/6/8 already
encode (`authoritative_target_matches_expected` → `authoritative_outcome_matches_expected` →
`final_answer_consistent_with_evidence`, each its own distinct class). A denial that happened but
did NOT prevent well-formed evidence from being produced is deliberately NOT treated as the cause
once usable evidence exists — verified directly against a real committed record
(`kampkit-android-host-test-discovery`): 4 policy denials occurred, but the run still produced
well-formed evidence for the WRONG module, so `wrong-target` is correctly reported, not the
policy-denial class. `outcome-mismatch` and `final-answer-mismatch` are two DISTINCT classes
(never folded together) precisely so a run with `expected_outcome_matched:true` can never be
labeled in a way that contradicts that field — only a `final_answer_consistent:false` on its own
produces `final-answer-mismatch`. `wrong-target` specifically means the grading check
`authoritative_target_matches_expected` failed (the terminal attempt targeted the wrong Gradle
module) — distinct from invoking a foreign Skill entirely, which collapses into
`target-skill-not-invoked` (the target skill genuinely was never confirmed either way).
`pre_skill_tool_calls` is intentionally never a `failure_class` input — it remains an independent,
always-visible field, never promoted into a causal label.

**Summary.** Runs are grouped by the FULL `HARD_PARTITION_FIELDS` tuple (the identical Fairness
Contract key `aggregate.mjs` already enforces, reused verbatim via `schemas.mjs`'s own
`canonicalStructuredValue` serializer) — `scenario_id` and `condition` are 2 of its 17 fields, so
"aggregate by scenario_id and condition" holds, while every OTHER field in that same tuple
(`schema`, `platform`, `skill_source_sha`, `model_resolved`, `policy_sha256`, ...) keeps a
differing schema/provenance run in its own separate group rather than silently pooled together.
Each group reports counts + rates (`target_skill_invoked_rate`, `terminal_authoritative_evidence_
present_rate`, `terminal_authoritative_evidence_well_formed_rate`, `expected_outcome_matched_
rate`, `success_rate` — `null`, never `NaN`, when the denominator is 0) plus `failure_class_counts`
and compact frequency-map distributions for `target_skill_invocation_ordinal`, `target_skill_
attempt_ordinal`, `pre_skill_tool_calls`, and `post_skill_tool_calls_total`. `analyze` never
computes a cross-condition comparison (e.g. a `current-skill`-vs-`no-skill` lift/delta) — each
condition's runs land in their own group, exactly like the Fairness Contract already treats
`condition` as a hard partition key; a `no-skill` run's own `success`/`failure_class` is still
real, individually meaningful data, never reinterpreted as an efficacy baseline to subtract from.

**Privacy.** Every LEAF value this module computes is a boolean, a non-negative integer, a
closed-vocabulary string, or `null` — never a raw command, tool input, path, or skill name, exactly
like the sidecar it reads (`accepted-run-audit.mjs`'s own "deliberately structural, never
content-bearing" design). `run_id` and `scenario_id` are the only free-form-looking strings
surfaced for a fully-validated record, and both are already treated as safe/loggable everywhere
else in this harness (`scenario_id` is a public, committed corpus identifier; a validated schema-5
scenario record's `run_id` is additionally charset-constrained by its own `accepted_audit.
relative_path` cross-check). An INVALID file's own content — including a tampered `run_id` — is
never echoed (see the fail-closed `errors[]` contract above). `group_key`, unlike every per-run
leaf value, DOES carry approved STRUCTURED metadata verbatim (the `policy_allowed_gradle_tasks`/
`policy_allowed_kmptest_subcommands` arrays, the `ambient_skill_profile` object) — pre-existing,
already-committed run-record configuration inherited via `HARD_PARTITION_FIELDS`, not raw commands
the agent ran, so this introduces no new exposure. As defense-in-depth beyond this module's own
structural design, `analyzeRunsDir`'s complete return value is passed through a final scan
(`tools/lib/redact.mjs`'s `PUBLIC_SHAPE_RULES`, via `privacy.mjs`) before being returned; a value
that still matches even after redaction — which nothing this module structurally emits should ever
do — withholds the entire batch rather than returning content that failed its own safety check.

**Schema v6 reporting fields.** Per-run entries and summary groups both gain `agent_runtime`,
`execution_profile`, `skill_observation`, and `usage` — the FULL real object for a schema-v6
record, or the literal `"not-recorded"` sentinel below v6 (never `null`, never inferred). Unlike
`aggregate.mjs`'s own group_key projection, `execution_profile`/`skill_observation` here are the
FULL objects (including `isolation_attestation_sha256` and `availability`/`activation`) — there is
no reason to hide them from a human-readable report the way there is for a bucketing key. A
schema-v6 record's `target_skill_invoked` is read from `skill_observation.activation.status`
(`'confirmed'` → `true`, `'not-observed'` → `false`, `'indirect'`/`'not-observable'` → `null`)
rather than the legacy `skill_invoked.value` — schema invariant 8 already requires the two to
agree for claude-code, so this is behavior-preserving today, and exists for forward compatibility
with a runtime whose activation is not simply boolean. Group summaries additionally report
`usage_source_counts` and 5 SEPARATE distributions — `usage_input_distribution`,
`usage_cached_input_distribution`, `usage_cache_write_distribution`, `usage_output_distribution`,
`usage_reasoning_output_distribution` — deliberately no summed total field anywhere: runtime-
native token counts are never rankable as if they shared a tokenizer or hidden prompt, so a single
combined number would misleadingly imply they are. `ANALYSIS_SCHEMA` is **2** (was 1) for this
shape change; bucketing/grouping is unchanged (still `HARD_PARTITION_FIELDS`, which itself gained
the 3 new structural keys — see "Fairness Contract" above, which `analyze` shares verbatim via
`run-record-view.mjs`'s `withPartitionView()`).

**Explicit limitation**: no timing metric is derived or reported anywhere in this command's output
— the committed schema-v5 sidecars carry event-INDEX ordering only, never per-event wall-clock
timestamps, so a duration between any two axis boundaries (e.g. "how long was the pre-skill
delay") cannot be honestly computed from what's on disk today. Only counts and closed-vocabulary
classifications are ever emitted.

## Measurement scope

`calibrate`/`smoke`/`run` each generate a fresh, random `{scope_id, key}` pair per invocation by
default (see "Ambient-skill-profile tolerance" above) — correct for a single invocation's own
internal fairness, but since `ambient_skill_profile` (which embeds `scope_id`) is a
`HARD_PARTITION_FIELDS` entry, two records from **different** invocations can never aggregate
together under that default, even when the underlying environment was genuinely identical. A
**measurement scope file** closes this gap: a local, secret, versioned file supplying a stable
`{scope_id, key}` pair that independent invocations can share.

**Creating one:**

```bash
node tools/agentic-eval/cli.mjs scope init --out <path>
```

Prints only `{scope_id, path}` — never the key. Recommend a path **outside any git
repository** as the simplest, safest default (no dependency on `.gitignore` correctness at all).
A path inside a repository is also accepted, but only if it is confirmed **both** untracked
**and** covered by that repository's own `.gitignore` — enforced at runtime (`git ls-files`/
`git check-ignore` against the actual containing repository, never assumed from the path's own
string shape), not merely a documented convention. Every indeterminate git outcome (git missing,
a spawn error, an unrecognized result) fails closed, never assumed safe. Creation is atomic and
exclusive: it refuses to overwrite an existing file, and on failure attempts to remove anything
this specific call created (the temp file always, plus the final path if the exclusive fallback
had already created it) — a best-effort rollback, not an unconditional guarantee: a rare secondary
failure during that cleanup itself (e.g. the filesystem becoming unwritable mid-operation) is
swallowed rather than masking the original error, so a partial artifact is not structurally
impossible in that narrow case. On POSIX (Linux/macOS) the file is created with mode `0600` (owner read/write only),
verified on disk before publishing; on Windows, Node cannot set POSIX permission bits or enforce
ACLs, so this is best-effort only there — no ACL guarantee is claimed.

**Reusing one:** pass the same file to any combination of `calibrate`/`smoke`/`run` via
`--measurement-scope-file <path>`. On POSIX, every load **re-verifies** the file's real, on-disk
mode is still exactly `0600` before its key is ever used — not just at creation time, since
permissions can loosen afterward through no fault of this module (a backup/restore, a different
tool, a manual copy). A mode of anything other than exactly `0600` (e.g. a world- or
group-readable `0644`), or a stat that can't be completed at all, fails closed — the same
"indeterminate is never treated as safe" discipline as the git-based path checks. On Windows this
re-verification is skipped for the identical reason creation-time enforcement is best-effort
there — no ACL guarantee is claimed or checked. For example:

```bash
node tools/agentic-eval/cli.mjs run --scenario <id> --source-repo-dir <clone> --seed <n> \
  --measurement-scope-file <path>
```

Every invocation that supplies the same file gets the identical `scope_id`/key, so their
resulting `ambient_skill_profile` fields agree — the stable scope makes `calibrate`/`smoke`/`run`
records **comparable** across independent invocations regardless of command. Actually folding
records together via `aggregate`, though, is narrower than "comparable": `aggregateRuns()` only
ever accepts `run_kind: 'scenario'` records with `benchmark_eligible: true` (see "Fairness
Contract" below) — `calibrate`/`smoke` are always `benchmark_eligible: false` by design
(foundation-harness runs proving the Skill mechanism invokes at all, never benchmark data) and
remain deliberately ineligible for aggregation, with or without a shared scope. For eligible
`scenario` records, `HARD_PARTITION_FIELDS` no longer separates them purely by invocation (still
split by `condition`, `scenario_id`, and every other Fairness Contract field exactly as before;
sharing a scope only removes the invocation-identity split, nothing else). Omitting the flag
preserves today's exact ephemeral, per-invocation behavior byte-for-byte.

**Rotating:** create a second file (`scope init --out <different-path>`) and point
`--measurement-scope-file` at it instead — a new, separate comparability scope. There is no
in-place "rotate" mutation of an existing file; a new file is a new scope by construction.

**Privacy:** the file's `hmac_key_base64` is secret — never printed, logged, committed, or passed
to a child Claude process (only used locally to compute `fingerprint_hmac`, exactly like the
ephemeral key already is). `scope_id` is not secret — it is already a schema-v4 record field
regardless of whether the scope is ephemeral or supplied. **Never commit a measurement scope
file** — keep it outside the repository, or in a path your `.gitignore` genuinely covers (both
enforced, not just advised, as described above).

**Load-time safety:** `--measurement-scope-file` is validated with the identical rigor as
`scope init`'s own target, applied to **both** the path as supplied and its realpath-resolved
destination — a symlink whose own location looks safe but resolves to a tracked file is
rejected, and (the reverse) a symlink that is itself tracked/unignored but resolves to an
otherwise-safe destination is also rejected. Every malformed-file class (missing file,
unparseable JSON, wrong schema value, invalid `scope_id`, non-canonical or wrong-length
`hmac_key_base64`, an unsafe path) fails closed before any Claude session spawns.

## Multi-profile campaigns

`run --campaign-design <id>` expands one scenario into a closed, pre-registered campaign plan
spanning **both** execution profile and skill condition in a single invocation — the offline
planning/execution machinery `scenario-campaign-plan.mjs` (a pure, dependency-free module) and
`matrix-runner.mjs`'s `runScenarioCampaign` add on top of the existing single-profile
`--execution-profile` matrix (`run --execution-profile <id>` keeps working completely unchanged;
see "Isolation" above for the profile registry itself).

The only supported design today is `claude-2x2-williams-v1`: a genuine 2×2 (execution profile ×
skill condition) design, 4 repetitions, 16 sessions total, expanded via a literal, pre-registered
4×4 Williams-style counterbalanced order — never shuffled, never dependent on `--seed` (the flag
is still required and recorded on every resulting record, for compatibility, but the campaign's
own dispatch order is fixed at design time):

```text
cell A = strict-policy-v1           / no-skill
cell B = strict-policy-v1           / current-skill
cell C = sandboxed-unrestricted-v1  / no-skill
cell D = sandboxed-unrestricted-v1  / current-skill

rep 0: A B D C
rep 1: B C A D
rep 2: C D B A
rep 3: D A C B
```

```bash
node tools/agentic-eval/cli.mjs run --scenario <id> --source-repo-dir <local-clone> --seed <n> \
  --campaign-design claude-2x2-williams-v1 \
  --isolation-attestation-file <path> \
  --dry-run
```

`--dry-run` prints all 16 planned cells (`order_index`, `repetition_index`, `campaign_cell_label`,
`condition`, `execution_profile_id`, plus each cell's own resolved `execution_profile_sha256` and,
for unrestricted cells, the same isolation-attestation fields a bare `--execution-profile
sandboxed-unrestricted-v1 --dry-run` already shows) and never spawns a live runtime/Claude session
— but, unlike the legacy path's bare (no-`--measurement-scope-file`) `--dry-run`, this is **not** a
zero-subprocess preview: because `claude-2x2-williams-v1` always includes
`sandboxed-unrestricted-v1` cells, isolation-attestation resolution always runs
`resolveHarnessProvenance()`'s real `git rev-parse HEAD` — exactly like a bare `--execution-profile
sandboxed-unrestricted-v1 --dry-run` already does today (see "Isolation" above) — plus the same
`git` subprocesses the legacy path's own scope-file validation invokes if `--measurement-scope-file`
is also supplied. `--campaign-design` is mutually exclusive with both
`--execution-profile` (the design resolves its own per-cell profiles) and `--repeats` (the design
fixes its own repeat count; `--repeats` is rejected outright when combined, even the "correct"
value). Because `claude-2x2-williams-v1` always includes `sandboxed-unrestricted-v1` cells,
`--isolation-attestation-file <path>` is always required — the identical attestation file used for
a bare unrestricted `run` (see "Isolation"), validated once and shared by every unrestricted cell
in the campaign; strict cells never consult it.

Execution acquires one independent shared-resource bundle (shim/skill-snapshot/Gradle-home/
settings/env) **per distinct execution profile** the plan uses, never one bundle reused across
profiles — a strict cell can never observe unrestricted resources or vice versa. Every per-cell
mechanic beyond that (spawn, transcript parsing, dispatch accounting, the integrity gate, journal
bookkeeping) reuses the exact same functions the legacy single-profile matrix already calls
(`runSingleCondition`, `cellTranscriptIntegrityOk`, `buildBashDispatchAccounting`,
`attributeCondition`) — never a second, independently-drifting execution path. A fail-fast stop
(any cell's own local integrity check fails) aborts the whole campaign immediately, in literal
dispatch order, exactly like the legacy matrix's own fail-fast — remaining cells are never spawned.

**Known limitation:** a campaign rejection (fail-fast or whole-matrix hard-gate) whose executed
cells span *both* execution profiles cannot yet produce a rich, structured rejection-diagnostics
file — `buildRejectionDiagnostics` (`rejection-diagnostics.mjs`) still assumes one execution
profile per whole batch (true by construction for the legacy matrix, not for a campaign). The
harness still fails closed with zero evidence promoted and a specific, privacy-safe reason — it
falls back to the same `finalizeIncident`/`reportIncident` path calibrate/smoke/run already use for
every other unexpected-shape failure. That incident now includes the failed cell's privacy-safe,
count-only correlation summary when available, but still does not claim the richer schema-v3/v4
rejection shape. See
`BACKLOG.md`'s "Mixed-profile campaign rejection diagnostics schema" entry.

This machinery is offline-only: no live Claude Code invocation, no `tools/runs/**` evidence, no
raw transcript access outside fake test fixtures. It exists to unblock a future, separately
authorized live pilot (see `docs/audits/agentic-eval-claude-codex-v1-plan.md`'s "Evidence 1"
section) — shipping it does not itself constitute running that pilot.

## Explicit limitations

- No full benchmark is executed by this PR; no performance claim is made — `run` itself is never
  invoked against a live Claude session here, so this PR commits zero scenario-run evidence.
- Public-project scenarios only; no private project is referenced.
- `candidate-skill` is schema-supported but not implemented.
- All 6 originally-sketched scenarios now exist in `corpus/scenarios/`
  (`kampkit-android-host-test-discovery`, `kampkit-no-applicable-tests` against KaMPKit;
  `nowinandroid-core-common`, `deterministic-unit-test-failure`, `coverage-threshold-failure`, and
  `changed-module-verification` against NowInAndroid) — the corpus is complete, 4 `train` / 2
  `held-out` (originally 3/3; `changed-module-verification` moved train<-held-out after its own
  0/2 canary-v3 result directly informed a skill-doc fix — see BACKLOG.md).
  `changed-module-verification` is the first (and, by its own contract's deliberate
  single-module scope, only) scenario requiring `kmp-test changed` — never `kmp-test parallel`,
  even with matching counts — as terminal proof, via a new, closed `fixture_setup` mechanism
  (`{operation:"append_comment", relative_path, expected_blob_oid}`) that mutates one
  pinned-blob-verified tracked file with a harness-constant, unstaged comment before each cell —
  never scenario-supplied content. Ground truth independently re-verified live 6x (3x `kmp-test
  changed`, 3x direct Gradle, cold `GRADLE_USER_HOME` + JDK 17 each) confirmed a real `changed`
  envelope carries **no top-level `parallel` key at all** (verified via a direct `hasOwnProperty`
  check on the raw JSON) and reports `changed.detected_modules` as bare, colon-less strings (e.g.
  `"core:common"`, never `":core:common"`) — both now pinned by a dedicated production-contract
  test (`agentic-eval-graders-production-contract.test.js`) that calls the real
  `changed-orchestrator.js` `runChanged()` directly, not just a hand-authored fixture. Disclosed,
  out-of-scope finding: `.skills/kmp-test-runner/references/workflows/changed.md`'s own illustrative
  envelope example is stale on this exact point (shows a `parallel:{}` block and a colon-prefixed
  `detected_modules` entry neither of which the real envelope carries) — `.skills/**` is untouched
  by this change; fixing that doc drift is separate follow-up work.
  `coverage-threshold-failure` covers the `coverage_threshold_exceeded` outcome_kind with a
  deliberately minimal, closed contract: it does not add a JaCoCo/Kover-XML evidence-attribution
  mechanism analogous to `junit-evidence.mjs` — a Gradle attempt can only ever corroborate its own
  ordinary test-task contract (`expected.gradle` reuses `tests_executed`'s own key set verbatim),
  never the coverage-threshold decision itself, which is a `kmp-test`-only concept with no raw
  Gradle equivalent.
  `corpus/trigger-queries.json` (the natural-trigger query set) remains separately in scope and is
  validated by the same `corpus validate` command. An earlier candidate module for this scenario,
  `:core:datastore`, was rejected after an adversarial review round: its `--module-filter`
  substring-collided with a sibling test-fixtures module (`:core:datastore-test`), which made the
  scenario operationally unreachable via the pinned skill's own ask-guard (see the routing blocker
  below) and let a real target-attribution gap in `computeKmpTestTargetMatch` go unnoticed. The
  final `:core:domain` candidate has zero substring collision with any other real module in this
  project.
- **Blocker fixed (`fix(skill): route test coverage gates through parallel`)** — pre-existing
  `.skills/**` documentation contradiction: `coverage.md` and `coverage-threshold-exceeded.md`'s
  zero-threshold guidance now agree with `coverage.md`'s own flags-table row that a `0` threshold
  disables the coverage gate, grounded in `coverage-orchestrator.js`'s `gateThreshold > 0` check
  (no brittle line numbers cited here — they drift on every subsequent doc edit, as this very
  reference did). Also fixed: `coverage.md`'s separate false
  claims (9 locations) that `coverage` dispatches `koverXmlReport`/`jacocoTestReport` report-
  generation gradle tasks or can produce `task_not_found` — it does neither; it only reads existing
  XML (missing XML → `no_xml`) and, separately, may run a cached, best-effort discovery probe
  unrelated to reports. `PINNED_SKILL_SHA` was unchanged by that fix; snapshot advancement and
  efficacy evaluation are handled by separate PRs.
- **Blocker fixed (`fix(skill): route test coverage gates through parallel`)** — skill routing
  gap: the live `.skills/kmp-test-runner/SKILL.md` Steps table now routes an explicit
  tests+missed-lines-budget ask ("run tests; missed lines under 100") to `kmp-test parallel
  --min-missed-lines <N>` (the only command that can produce a fresh `coverage_threshold_exceeded`
  decision), distinct from bare "run coverage". A context-free "with coverage" alone (no explicit
  test-execution intent) stays ambiguous and must ask, per the Decision protocol's existing rule —
  it is never silently routed to either command. The evaluator snapshot pinned by PR #416 includes
  this routing fix; this provenance statement makes no live-efficacy claim.
- The real end-to-end Claude Code `tool_result.content` shape for a live `kmp-test`/`gradle`
  invocation is still unconfirmed as of this PR — `graders.mjs`'s envelope extraction is
  defensively designed for that uncertainty (locates a parseable JSON substring within possibly-
  noisy content, never a bare whole-string parse) using real stdout captured from direct local CLI
  execution, but that is not the same thing as having observed a genuine live capture. Confirming
  it is exactly the job of a future live-validation PR, mirroring #373/#378 relative to #372.
- **Runtime-neutral records (this PR) is schema/registry/reporting scope only.**
  `schemas.mjs`'s own closed enums reserve `codex-cli` (as an `agent_runtime.runtime_id` value)
  and `sandboxed-unrestricted-v1` (as an `execution_profile.id` value) — so a FUTURE record could
  validly carry either — but neither is registered in `runtimes/registry.json` /
  `execution-profiles/registry.json` today (both files list exactly one entry each,
  `claude-code` / `strict-policy-v1`), neither has a concrete adapter
  (`ADAPTERS_BY_RUNTIME_ID` carries only `claude-code`), and `resolveSelection()` fails closed on
  either exactly like any other unregistered id — `--runtime codex-cli` /
  `--execution-profile sandboxed-unrestricted-v1` are rejected today, not silently accepted. A
  real Codex (or any other non-Claude) adapter, a real `sandboxed-unrestricted-v1` isolation
  implementation and its own registry entry, and this harness's own no-policy-hooks execution mode
  are all future PRs' scope, not authorized or implemented here — this PR's own fake-Claude E2E
  coverage never spawns a real vendor binary or touches the network for any of them.
- Wildcard support in `--module-filter`/`--test-filter` is out of scope for the policy hook's
  grammar in this PR (a shell could re-expand an unquoted wildcard after the hook approves it) —
  documented as a future grammar extension.
- No dependency prewarming happens for `GRADLE_USER_HOME` as of this PR (see "Materialization
  and cleanup" above) — the isolation guarantee (byte-identical reset between conditions) holds
  regardless, but real Gradle invocations inside a measured session will resolve dependencies
  from a cold cache every time.
- Whether a non-zero-exit Bash command routes through `PostToolUse` or `PostToolUseFailure` is not
  pinned down from documentation alone (see "JUnit-evidence attribution" above) — `junit-evidence-
  hook.mjs` treats both identically, and the design is robust either way (a genuine double-fire is
  caught via the shared `anomalies/` tombstone channel, never silently overwritten). Confirming
  precisely which event Claude Code actually dispatches requires a live capture, out of scope here.
- `docs/agentic-usage-measurement.md` is intentionally not edited by this PR even though its
  "Registry relationship" section is effectively fulfilled here — cross-linking it is reasonable
  follow-up, flagged in the PR body.
- `analyze` (see "Axis-separated analysis" above) never derives or reports a timing metric —
  committed schema-v5 sidecars carry event-index ordering only, never per-event wall-clock
  timestamps, so no honest duration exists to compute between any two axis boundaries.
