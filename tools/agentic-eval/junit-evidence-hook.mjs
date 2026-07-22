#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/junit-evidence-hook.mjs -- PostToolUse/PostToolUseFailure per-attempt JUnit
// evidence capture hook. Mirrors policy-hook.mjs's own pure-logic/thin-runAsHook split: this hook
// makes no permission decision at all (it is a pure observer, registered ADDITIONALLY to the
// existing sole PreToolUse policy-hook.mjs entry -- never a second PreToolUse hook, which would
// double countHookEvents' counts and break everyCallHooked/hookAccountingOk/realWorkOk).
//
// Confirmed via a raw (non-LLM-mediated) fetch of the official hooks reference: PostToolUse fires
// "after a tool completes successfully"; PostToolUseFailure fires "when a tool that started
// executing fails" and explicitly does not fire for a permission denial. Both carry tool_use_id.
// This hook treats both identically (the same capture logic for either event name) precisely
// because it is not pinned down from documentation alone which one Claude Code routes a failing
// (but successfully-executed) Bash command through -- correctness here does not depend on knowing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyBashCommand, isRelevantGradleInvocation } from './command-classify.mjs';
import { countEvidenceTaskJunit } from './junit-evidence.mjs';
import { sha256Hex, writeSidecarRecord } from './junit-evidence-io.mjs';

// 4 MiB -- deliberately far above policy-hook.mjs's MAX_STDIN_BYTES (64 KiB, sized for a bare
// command string). This hook's payload additionally carries the full tool_response/error, i.e. a
// real Gradle console log under this harness's own --console=plain/-q policy constraints.
export const MAX_STDIN_BYTES = 4 * 1024 * 1024;

function isEqualCanonical(a, b, pathImpl = path) {
  return pathImpl.relative(a, b) === '';
}

/** Reads and validates the env config this hook needs. Returns null (strict no-op) if the
 * mechanism is disabled for this condition (calibrate/smoke/no_applicable_tests never set these) or
 * if anything fails to resolve -- a hook that cannot safely resolve its own config must never guess. */
export function loadHookConfig(env = process.env) {
  const evidenceDirRaw = env.KMP_EVAL_JUNIT_EVIDENCE_DIR;
  const evidenceTask = env.KMP_EVAL_JUNIT_EVIDENCE_TASK;
  const allowedInvocationsRaw = env.KMP_EVAL_JUNIT_ALLOWED_INVOCATIONS;
  const expectedFixtureRootRaw = env.KMP_EVAL_EXPECTED_FIXTURE_ROOT;
  if (!evidenceDirRaw || !evidenceTask || !allowedInvocationsRaw || !expectedFixtureRootRaw) return null;
  // Accidental-misconfiguration hygiene (a stray symlink, a path-construction bug) -- not a claimed
  // security boundary against a malicious Gradle build, matching policy-hook.mjs's own documented
  // threat model ("NOT an OS/filesystem sandbox... execute[s] with full host permissions").
  let evidenceDirReal;
  let expectedFixtureRootReal;
  try {
    evidenceDirReal = fs.realpathSync(evidenceDirRaw);
    expectedFixtureRootReal = fs.realpathSync(expectedFixtureRootRaw);
  } catch {
    return null;
  }
  let allowedInvocations;
  try {
    allowedInvocations = JSON.parse(allowedInvocationsRaw);
  } catch {
    return null;
  }
  if (!Array.isArray(allowedInvocations)) return null;
  return { evidenceDirReal, evidenceTask, allowedInvocations, expectedFixtureRootReal };
}

/**
 * Pure-ish capture logic (the actual file I/O is real, but this function never touches
 * stdout/stderr and never throws) -- given a raw stdin string and an env source, performs the
 * capture when applicable. Returns nothing meaningful; the hook's own stdout is always empty
 * regardless of what happens here (see runAsHook). Directly unit-testable without spawning a
 * subprocess, mirroring policy-hook.mjs's decide().
 *
 * isPlanOnly is checked FIRST, before any file I/O -- a plan-only Gradle invocation never touches
 * the real task or its JUnit XML, so there is nothing to read. Any internal exception (a malformed
 * payload, an unexpected filesystem error) is caught and silently swallowed -- a capture failure
 * here surfaces later, downstream, as a missing evidence record (a harness-integrity concern), never
 * as a crash or a visible artifact in the measured agent's own session.
 */
export function captureEvidenceForEvent(raw, env = process.env) {
  try {
    if (Buffer.byteLength(raw, 'utf8') > MAX_STDIN_BYTES) return;
    const config = loadHookConfig(env);
    if (config == null) return;

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (payload == null || typeof payload !== 'object') return;
    if (payload.hook_event_name !== 'PostToolUse' && payload.hook_event_name !== 'PostToolUseFailure') return;
    if (payload.tool_name !== 'Bash') return;
    if (typeof payload.tool_use_id !== 'string' || payload.tool_use_id.length === 0) return;

    const command = payload.tool_input?.command;
    if (typeof command !== 'string' || command.length === 0) return;

    const classification = classifyBashCommand(command);
    if (classification.isPlanOnly) return;
    if (!isRelevantGradleInvocation(classification, config.allowedInvocations)) return;

    if (typeof payload.cwd !== 'string' || payload.cwd.length === 0) return;
    let cwdReal;
    try {
      cwdReal = fs.realpathSync(payload.cwd);
    } catch {
      return;
    }
    if (!isEqualCanonical(config.expectedFixtureRootReal, cwdReal)) return;

    // The single, bounded, sentinel-exception-guarded JUnit-XML pass -- see junit-evidence.mjs for
    // why this is genuinely one forEachJunitXml call, not the old three-walk relocation. Nothing
    // here bounds this call's own execution time (the hard timeout below only guards the stdin-read
    // phase, cleared before this ever runs) -- it doesn't need to, since the aggregate file-count/
    // byte caps already bound the WORK, not just the reported count.
    const result = countEvidenceTaskJunit(cwdReal, config.evidenceTask);
    const idHash = sha256Hex(payload.tool_use_id);
    writeSidecarRecord(
      path.join(config.evidenceDirReal, 'evidence'), idHash, { command, ...result },
      path.join(config.evidenceDirReal, 'anomalies'), 'duplicate_evidence_write',
    );
  } catch {
    // See doc comment above -- never let an unexpected internal error escape.
  }
}

// process.stdout.write() is asynchronous when stdout is a pipe (always true here), so calling
// process.exit() immediately after starting the write can truncate it before the OS has actually
// flushed -- the same class of bug policy-hook.mjs already fixed once for its own write-then-exit
// ordering. Writes a genuinely EMPTY string, never even "{}" -- exit 0 with no output at all is the
// documented "no decision to report" pattern, and this hook must never express any decision-control
// field the agent's own session could be influenced by.
function writeAndExit() {
  process.stdout.write('', () => process.exit(0));
}

function runAsHook() {
  let raw = '';
  let finished = false;
  let overflowed = false;
  const HARD_TIMEOUT_MS = 3000;
  const timer = setTimeout(() => {
    if (!finished) { finished = true; writeAndExit(); }
  }, HARD_TIMEOUT_MS);
  timer.unref?.();

  process.stdin.on('data', (chunk) => {
    if (overflowed) return;
    raw += chunk;
    if (Buffer.byteLength(raw, 'utf8') > MAX_STDIN_BYTES) {
      overflowed = true;
      if (!finished) { finished = true; clearTimeout(timer); writeAndExit(); }
    }
  });
  process.stdin.on('end', () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    captureEvidenceForEvent(raw);
    writeAndExit();
  });
  process.stdin.on('error', () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    writeAndExit();
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runAsHook();
