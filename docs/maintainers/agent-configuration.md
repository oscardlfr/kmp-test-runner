# Agent configuration governance

This repository keeps one portable instruction source and thin tool-specific
adapters. The goal is to give every coding agent the same durable constraints
without loading release history or rarely relevant procedures at startup.

## Configuration map

| Surface | Purpose | Loading policy |
|---|---|---|
| `AGENTS.md` | Canonical cross-agent rules | Every repository task |
| `CLAUDE.md` | Claude Code compatibility adapter | Imports `AGENTS.md`; no duplicated policy |
| `.claude/rules/*.md` | File-specific implementation constraints | Only when matching paths are read |
| `.skills/kmp-test-runner/` | Consumer workflow for using `kmp-test` | On demand through Agent Skills/plugin discovery |
| `PRODUCT.md` | Stable product strategy | Product/architecture decisions only |
| `CONTRIBUTING.md` | Human and agent contribution workflow | Branch/PR work only |
| `BACKLOG.md` | Current queue plus historical planning record | Prioritization and scoped backlog work |
| `CHANGELOG.md` | Release chronology and migrations | Release/user-visible change work |

Imports still consume startup context, so `CLAUDE.md` imports only the canonical
root file. Multi-step runbooks and path-specific constraints stay out of both
always-loaded files.

## Memory policy

Project memory is durable documentation, not a transcript of a session.

- A repeated, project-wide correction becomes a concise `AGENTS.md` rule.
- A repeated correction that applies to a file family becomes a path-scoped
  rule.
- A stable architectural decision belongs in `PRODUCT.md` or a focused ADR.
- A release/user migration belongs in `CHANGELOG.md`.
- Prioritization and unfinished work belong in `BACKLOG.md` or an issue.
- Temporary progress, command output, dated handoffs, and working hypotheses
  stay in the task, pull request, or ignored local files.

Do not commit `.claude/agent-memory/`, `.Codex/memory/`, session summaries, or
dated "current state" blocks. They become stale without an owner and consume
context in every future session.

## Role policy

The repository does not maintain aliases for generic roles already supplied by
agent runtimes. A project-owned subagent is justified only when it has all of:

1. A project-specific responsibility that cannot be expressed as a rule or
   reusable skill.
2. A bounded tool/permission contract.
3. A named owner and removal condition.
4. A validator/test that proves the definition remains loadable.

Until such a role is intentionally introduced, files under `.claude/agents/`
and `.Codex/agents/` are treated as obsolete configuration. GSD-internal roles
remain outside native repository workflows unless a user explicitly invokes
GSD.

## Changing the configuration

1. Put the rule in the narrowest applicable surface from the table above.
2. Remove superseded or contradictory text in the same change.
3. Run `rtk node tools/validate-agent-config.mjs`.
4. Run the focused Vitest validator suite, then the normal gate for any code or
   CI paths touched.
5. Explain context-size or loading-behavior changes in the pull request.

The zero-dependency validator enforces size budgets, the canonical import,
path-scoped rule frontmatter, link safety, absence of temporal snapshots or
private-memory references in live workflow configuration, and the retired
role/memory directories. CI runs it inside the existing
`skills-validate` required check.
