# Agentic-eval runtime capability audit

> Date: 2026-08-17.
> Scope: Claude Code, Codex CLI, GitHub Copilot CLI, Google Antigravity
> CLI, and candidate screening for the legacy Google Gemini CLI and Microsoft
> agent surfaces.
> Purpose: derive the multi-runtime architecture before implementation.
> This is a documentation and zero-live audit. It authorizes no installation,
> authentication change, model invocation, raw-transcript read, or benchmark.

## Executive conclusion

The harness needs a runtime adapter. It does not need a model adapter.

Claude Code, Codex CLI, Copilot CLI, and Antigravity CLI are agent runtimes.
Each owns a different invocation protocol, tool surface, skill-discovery mechanism,
permission system, structured event stream, and usage-reporting contract. A
model is a configuration selected inside a runtime. Copilot makes this
distinction unavoidable because one Copilot CLI version can route a pinned
Claude, GPT, Gemini, or MAI model without changing its tools, hooks, skills, or
session protocol. Antigravity likewise exposes Gemini and Claude model slugs
behind one `agy` runtime. Codex distinguishes its CLI runtime from configurable
`model_provider` and model settings.

There is no fifth `microsoft-cli` adapter to invent. GitHub Copilot CLI is the
qualifying Microsoft/GitHub coding-agent runtime; a Microsoft MAI model is a
model profile under that adapter. Microsoft AI Shell is archived, Foundry's
`azd ai agent` commands run user-authored hosted-agent projects rather than one
canonical coding-agent harness, and Microsoft Conductor is an orchestration
layer over other runtimes. Treating any of those as an equivalent fifth
runtime would change the experiment instead of extending it.

The clean v1 architecture is therefore:

```text
scenario/core lifecycle
  + runtime adapter          (Claude Code, Codex CLI, Copilot CLI, Antigravity CLI)
  + execution profile       (strict policy, isolated unrestricted)
  + model profile           (runtime-scoped data, never executable code)
  + observation sources     (primary JSONL plus optional telemetry/hook ledger)
```

The first implementation remains Claude Code + Codex CLI. Copilot and
Antigravity are audited now so that the contracts do not accidentally encode
either initial runtime's private shape. Their adapters are later, independently
promoted phases. Google and Microsoft model profiles do not create adapters.

## Evidence sources and local state

Primary documentation reviewed:

- [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- [Codex CLI command reference](https://developers.openai.com/codex/cli/reference)
- [Codex skills reference](https://developers.openai.com/codex/skills)
- [Codex configuration reference](https://developers.openai.com/codex/config-reference)
- [Copilot CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- [Copilot CLI programmatic reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference)
- [Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
- [Copilot CLI skills reference](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills)
- [Antigravity CLI overview](https://antigravity.google/docs/cli/overview)
- [Antigravity CLI headless reference](https://antigravity.google/docs/cli/headless/)
- [Antigravity CLI permissions reference](https://antigravity.google/docs/cli/permissions/)
- [Antigravity CLI plugins and skills](https://antigravity.google/docs/cli/plugins/)
- [Gemini CLI individual-account transition notice](https://github.com/google-gemini/gemini-cli/discussions/28017)
- [Microsoft AI Shell status](https://github.com/PowerShell/AIShell)
- [Microsoft Conductor](https://github.com/microsoft/conductor)
- [Microsoft Foundry local hosted-agent reference](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/run-hosted-agent-locally)

Zero-live local probes on 2026-08-17:

| Runtime | Local result |
|---|---|
| Claude Code | installed, `2.1.233` on this Windows PATH |
| Codex CLI | installed, `0.94.0` on this Windows PATH |
| Copilot CLI | not installed |
| Antigravity CLI (`agy`) | not installed |
| Legacy Gemini CLI | not installed |
| Microsoft AI Shell / Conductor | not installed |

These local versions are not benchmark pins. The completed Windows and macOS
canaries discussed by this plan used isolated Claude Code `2.1.227`
toolchains; the ambient Windows `2.1.233` above must not be substituted for
that provenance. Likewise, the local Codex version must not be assumed to
match the current documented event contract. Every runtime needs an isolated,
integrity-checked campaign toolchain.

## Capability matrix

`Documented` means the public primary reference defines the capability.
`Characterize` means the capability exists, but the exact machine-readable
shape needed by this harness is not a stable documented schema and must be
captured against a pinned CLI before implementation.

| Capability | Claude Code | Codex CLI | Copilot CLI | Antigravity CLI |
|---|---|---|---|---|
| Non-interactive execution | Documented `-p` | Documented `exec` | Documented `-p` | Documented `-p` |
| Primary structured stream | `stream-json` | `exec --json` JSONL | `--output-format=json` JSONL | `--output-format stream-json` NDJSON |
| Exact line/event schema for harness | Existing production parser | Characterize pinned version | Characterize pinned version | Documented closed event vocabulary; characterize pinned version |
| Explicit model selection | `--model` | `--model`/config | `--model`; `auto` also exists | `--model`; unknown slugs fail in headless mode |
| Multiple model vendors in one runtime | No normal v1 need | Configurable providers exist | Yes, first-class supported models | Yes, documented Gemini and Claude slugs |
| Project skill discovery | Plugin/skill surface | `.agents/skills` | `.github/.agents/.claude` skills | Project plugins/skills; exact path and precedence must be characterized |
| First-class skill tool | Yes in current harness | Not guaranteed in JSONL | Documented `skill` tool | Slash-command/skill expansion in headless mode |
| Skill availability proof | Strong init/plugin proof | Not currently guaranteed | Must characterize stream/plugin listing | Init advertises tools, not necessarily skill catalogue |
| Skill activation proof | Strong correlated `Skill` call/result | Likely indirect unless runtime adds event | Hook/JSONL/OTel path; characterize | Explicit slash expansion is possible; autonomous activation still characterize |
| Pre-tool policy hook | Existing Claude hook | Capability not assumed | Documented `preToolUse` hook | Permission rules/plugins; do not assume hook parity |
| Fine-grained tool allow/deny | Claude tool rules/hooks | Approval/sandbox/rules | `available`, `allow`, and `deny` tools | Persistent scoped permission rules |
| Native OS sandbox | Runtime/version dependent | Documented workspace sandbox | Experimental local sandbox | Documented `--sandbox` |
| Usage in primary stream | Existing result usage | Turn-completion usage; characterize aborts | JSONL shape not enough; OTel documented | Input/output/thinking/cache/total in result |
| Stable telemetry side channel | No v1 need | App-server/OTel options may evolve | Documented OTel GenAI spans/metrics | Not required by documented primary stream |
| Runtime-reported cost | Existing Claude result when present | Not assumed | Documented OTel cost and AI units | Not documented in headless result |

## Runtime findings

### Claude Code

The current harness already has a mature Claude contract:

- non-interactive `claude -p` with `stream-json` and verbose hook events;
- exact model argument;
- plugin snapshot delivery through `--plugin-dir`;
- init-time plugin/skill availability and correlated `Skill` invocation proof;
- PreToolUse policy decisions bound per shell attempt;
- result-event usage extraction;
- auth preflight and platform-specific environment isolation.

This is the reference implementation to freeze before extraction. It must not
be rewritten into generic names first and tested later. Characterization tests
must lock current argv, event fixtures, hook accounting, skill evidence, token
dimensions, and failure signatures, then the adapter extraction must preserve
them.

Main limitation: the current launcher, parser, integrity gates, sidecar, and
schema all expose Claude concepts directly. `--model` changes a Claude model;
it is not a runtime abstraction.

### Codex CLI

The official CLI supports stable non-interactive `codex exec`, JSONL output,
explicit model selection, approval policy, and sandbox modes. Skills use the
open Agent Skills layout and are discovered from repository `.agents/skills`
locations. Config separates the runtime from `model_provider`, model, reasoning
effort, and sandbox/approval settings.

Important limitations for the eval:

1. The structured stream must be characterized against the exact pinned CLI.
   The harness needs command start/completion, cwd, exit status, output,
   termination, final answer, and usage correlation, not just valid JSONL.
2. The public `exec --json` contract does not currently guarantee an init frame
   listing every offered tool and skill. Skill absence/availability therefore
   cannot be copied from Claude's plugin proof.
3. Skill activation may only be indirectly observable, for example through the
   runtime reading the skill file. Such evidence must be labelled indirect, not
   promoted to a confirmed `Skill` invocation.
4. Interrupted turns may not carry the same usage completeness as clean turn
   completion. Missing usage remains null with a reason.
5. The Windows and macOS sandbox implementations are not assumed equivalent.

Codex is still a good second implementation: it forces the core to support a
runtime with strong command/usage telemetry but weaker skill-catalog
observability.

### GitHub Copilot CLI

Copilot is architecturally informative even before implementation:

- programmatic `-p` mode and `--output-format=json` JSONL;
- explicit `--model`, with multiple model vendors behind the same CLI;
- explicit `--available-tools`/`--excluded-tools` and
  `--allow-tool`/`--deny-tool` controls;
- project skills from `.github/skills`, `.agents/skills`, and `.claude/skills`;
- a documented `skill` tool;
- `preToolUse` hooks that can allow, deny, or modify calls, including
  Claude-compatible `PreToolUse` matcher/payload mode;
- documented OTel `invoke_agent`, `chat`, and `execute_tool` spans with requested
  model, provider name, input/output/cache tokens, turns, cost, AI units, tool
  call IDs, and success;
- optional OS-level sandboxing, currently documented as experimental.

This suggests a future Copilot adapter can be high quality, but it also exposes
four traps:

1. The docs guarantee JSONL output but do not publish a complete stable schema
   for every output line consumed by this harness. Characterization is required.
2. OTel tool arguments/results require content capture. Content capture is off
   by default and would create a larger privacy surface. v1 should use OTel
   without content for usage/turn/tool counts and obtain command evidence from
   the primary stream or a narrowly sanitized hook ledger.
3. `--model=auto` makes model identity an uncontrolled treatment. Benchmark
   configurations must reject auto-selection and record requested plus resolved
   model/vendor when exposed.
4. Copilot `preToolUse` command-hook crashes fail closed, but hook timeouts fall
   through to normal permission handling. A strict-policy profile must treat a
   hook timeout or missing ledger event as harness-integrity failure even if the
   runtime later executes the tool.

Copilot is not installed locally, so no empirical claim about its exact JSONL,
exit behavior, auth command, skill event, or OTel file shape is made here.

### Google Antigravity CLI

Google's current consumer-facing terminal runtime is Antigravity CLI (`agy`),
not Gemini CLI. Google stopped serving Gemini CLI requests for individual
Google AI Pro, Ultra, and free-tier accounts on 2026-06-18 and directed those
users to Antigravity CLI. Gemini CLI remains relevant only for enterprise
licenses and API-key users. A new adapter should target the current runtime
rather than encode a product already split by account class.

Antigravity CLI v1.1.13 documentation makes it a credible future adapter:

- headless `-p` execution with separate stdout/stderr;
- `json` and strongly typed `stream-json` output;
- one `init`, zero or more `step_update`, and one terminal `result` event;
- tool steps with canonical name, parameters, output, and structured error;
- exact model slug selection, explicit reasoning effort, and nonzero failure
  instead of silent fallback for an unknown model in headless mode;
- input, output, thinking, cache-read, and total token fields;
- scoped permission rules, a documented sandbox flag, and a bounded print
  timeout;
- project plugins/skills and skill expansion in print mode.

It also sharpens four contract requirements:

1. A permission-denied tool can be a soft denial while the process still exits
   `0`. Process success is therefore never dispatch success.
2. The primary stream includes command parameters and outputs. Raw storage and
   redaction must follow the same non-committable privacy tier as Claude raw,
   not the sanitized accepted record.
3. The `init.model` field is present only when model override is used. Every
   benchmark invocation must supply `--model`; the adapter must not accept an
   implicit default.
4. The structured stream and headless skill behavior were introduced recently
   (v1.1.8/v1.1.9). Exact package/binary hashes and golden characterization are
   mandatory; documentation at `latest` is not a benchmark pin.

Antigravity is not installed locally. No empirical claim is made about auth,
Windows/macOS parity, exact skill precedence, autonomous skill activation,
permission-ledger persistence, or whether sandbox attestation is sufficient for
`sandboxed-unrestricted-v1`.

### Google Gemini CLI screening

Gemini CLI itself has an excellent headless JSONL contract and remains open
source, but it is not the default Google candidate for this benchmark. Its
individual-account service path is discontinued and its supported enterprise
and API-key modes would introduce account-class or API-auth treatments that do
not match the current desktop campaigns. Keep `gemini-cli` as a documented
legacy candidate only. Reconsider it if an explicitly scoped enterprise/API
benchmark is approved; never alias it to `antigravity-cli`, because their event,
permission, skill, and authentication contracts differ.

### Microsoft ecosystem screening

Microsoft contributes one qualifying runtime and several non-equivalent
surfaces:

- **GitHub Copilot CLI qualifies.** It is already the audited `copilot-cli`
  runtime. Its current model catalogue includes Microsoft's
  `mai-code-1-flash`, so a Microsoft-model experiment is a model-profile change
  under the Copilot adapter.
- **AI Shell does not qualify.** Microsoft marks it unmaintained and archived
  from an engineering standpoint as of 2026-01. It is interactive-first and is
  not an acceptable new benchmark dependency.
- **Microsoft Foundry does not qualify as one canonical coding runtime.** `azd
  ai agent run/invoke` hosts and invokes a user-authored agent project through
  its declared protocol. The agent loop, tools, prompt, and model are project
  code, so comparing it with Claude Code would compare a bespoke agent
  implementation, not merely another runtime.
- **Microsoft Conductor is a useful design prior, not an eval target.** It is a
  multi-agent workflow orchestrator over Copilot, Claude, and other providers.
  Putting it in front of this harness would add its own retries, validation,
  tools, usage accounting, and workflow semantics. Its explicit provider
  capability descriptors support this plan's capability-driven design, but an
  adapter for Conductor would measure Conductor plus its inner runtime.

There is therefore no `microsoft-cli` runtime ID. If Microsoft later ships a
maintained local coding-agent CLI with pinned model selection, structured
tool/result events, isolated skill delivery, and complete usage, it enters the
same characterization gate as any other new runtime.

### Candidate disposition

| Candidate | Classification | Plan status |
|---|---|---|
| Claude Code | Qualifying runtime | v1 reference adapter |
| Codex CLI | Qualifying runtime | v1 second adapter |
| GitHub Copilot CLI | Qualifying runtime | post-v1 candidate |
| Google Antigravity CLI | Qualifying runtime | post-v1 candidate |
| Google Gemini CLI | Legacy/special-account runtime | screened out of normal path |
| Microsoft MAI | Model family, not runtime | future Copilot model profile |
| Microsoft AI Shell | Archived runtime | rejected |
| Microsoft Foundry hosted agents | User-authored agent platform | separate experiment |
| Microsoft Conductor | Multi-runtime orchestrator | design prior, not adapter target |

## Derived architecture

### Runtime adapter, not provider adapter

Use these IDs:

```text
claude-code
codex-cli
copilot-cli
antigravity-cli
```

A runtime adapter owns only runtime protocol behavior:

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
  redactDiagnostics(value)
}
```

It does not contain scenario grading and does not branch on every model ID.

### Model profile, not model adapter

A model profile is validated data scoped to a runtime:

```json
{
  "runtime_id": "copilot-cli",
  "model_id": "exact CLI model string",
  "routing_mode": "pinned",
  "model_vendor_expected": "anthropic|openai|google|microsoft|other|null",
  "reasoning_effort": "exact value or null",
  "context_tier": "exact value or null",
  "required_capabilities": []
}
```

`auto` routing and implicit defaults are invalid for benchmark evidence. The
registry is an experiment
allowlist, not a claim that an account is entitled to every listed model.
Preflight verifies availability without silently substituting another model.

The same model vendor may appear under multiple runtimes. For example,
`model_vendor_expected: google` can mean a Gemini model under Copilot CLI or
Antigravity CLI. Those are different runtime partitions and must never be
pooled. `model_vendor_expected: microsoft` currently means an MAI model under
Copilot CLI, not a Microsoft runtime adapter.

### Capability-driven core

Each adapter declares closed capabilities, for example:

```text
structured_stream
command_result_correlation
skill_availability_exact
skill_activation_exact
skill_activation_indirect
pre_tool_policy
native_sandbox
usage_input_output
usage_cache
usage_reasoning
reported_cost
```

Capabilities are enums/booleans validated at adapter registration. Core gates
ask whether a selected campaign requires a capability. They never infer support
from a method returning null.

### Observation sources and reconciliation

A runtime may provide more than one source:

- primary JSONL transcript;
- hook decision ledger;
- provider telemetry (for example Copilot OTel);
- process stdout/stderr and exit metadata.

The adapter normalizes them, but the accepted sidecar records source-level
hashes and reconciliation. Secondary telemetry may corroborate a primary stream;
it may not silently repair a contradiction. A disagreement is an incident.

### Skill observation is two independent claims

Do not keep one overloaded `skill_invoked` boolean in the new schema.

```json
{
  "availability": {
    "status": "observed-present|observed-absent|not-observable",
    "evidence_kind": "closed runtime-specific enum"
  },
  "activation": {
    "status": "confirmed|indirect|not-observed|not-observable",
    "evidence_kind": "closed runtime-specific enum"
  }
}
```

`current-skill` requires delivery and the strongest proof the runtime claims to
support. `no-skill` requires isolated delivery absence. A runtime that cannot
observe availability may still be usable only if absence is mechanically
proven by an isolated home/project layout and the limitation is explicit.

### Execution profiles compile through capabilities

An execution profile defines semantic requirements. A runtime-specific compiler
produces flags, hooks, config, and expected ledgers. Unsupported combinations
fail during dry-run/preflight with zero model sessions.

The strict-policy decision engine may be shared as pure logic, but runtime hook
I/O wrappers remain separate. Copilot's Claude-compatible hook payload is a
useful bridge, not proof of identical timeout, ordering, or event semantics.

## Required characterization before each adapter

Characterization is its own bounded phase and produces sanitized golden
fixtures before production parser code.

### Zero-live probes

- install exact runtime package into a campaign-specific toolchain;
- hash package root and platform binaries;
- version/help/config-schema capture;
- auth-status/preflight that does not send a prompt;
- enumerate model-selection and profile flags;
- prove isolated HOME/config directories;
- dry-run the planned argv when supported.

### Bounded live characterization

Requires a separate authorization per runtime/platform. Minimum cells:

1. no-skill, one benign shell command, clean completion;
2. current-skill, same prompt, skill-relevant task;
3. policy denial/pre-dispatch block where supported;
4. controlled nonzero tool result;
5. timeout/termination using a fixture runtime where a real paid termination is
   unnecessary.

Only the first two need real inference unless a product event cannot otherwise
be characterized. Raw content remains local; sanitized fixtures retain event
types, correlation IDs, status enums, usage keys, and redacted command shape.

### Hard stops

- structured output lacks stable command/result correlation;
- requested model cannot be proven or the runtime silently substitutes `auto`;
- isolated skill presence/absence cannot be established;
- no-policy operation requires exposing the normal maintainer HOME;
- telemetry requires committing raw prompts/tool content;
- runtime version differs across repetitions;
- a secondary source contradicts the primary stream.

## Planning consequence

The Claude+Codex v1 plan must use runtime terminology and the
capability/observation contracts above. Its production scope remains two
runtimes and its live-session budgets do not increase.

After v1, extensions are promoted independently:

1. refresh the zero-live source audit and select exact installable versions;
2. score Copilot and Antigravity against the frozen adapter contract;
3. characterize only the selected runtime on Windows, then macOS;
4. implement one adapter PR with fake/golden fixtures;
5. run one focused skill/no-skill campaign before adding any second model;
6. add model profiles, including Gemini or MAI, as registry-only changes after
   the owning runtime has passed structural acceptance.

Copilot is the provisional first extension because its hooks and telemetry offer
the strongest independent test of the observation-source contract. Antigravity
may overtake it if its recently added stream remains stable and its skill and
permission evidence characterize more cleanly. The choice is made by the
readiness score at promotion time, not by vendor preference.

This avoids over-generalizing around Claude, prematurely implementing four
runtimes before the two-runtime core is proven, and conflating a model vendor
with the software that actually runs the agent loop.
