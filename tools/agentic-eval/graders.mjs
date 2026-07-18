#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/graders.mjs -- deterministic, index-returning graders and first-useful-
// signal predicates. Pure functions over already-parsed events/result text -- never an LLM
// judge (no extra Claude calls, no added cost/nondeterminism to grading itself).
//
// Graders return {matched: boolean, reason: string} (never throw); first-useful-signal
// predicates return an event INDEX (or null), never a timestamp -- stream-parser.mjs's
// deriveFirstUsefulSignalMs() is the only place an index becomes a millisecond value.

function textContainsAll(text, patterns) {
  if (typeof text !== 'string') return false;
  return patterns.every((p) => (p instanceof RegExp ? p.test(text) : text.includes(p)));
}

/** Grader factory: expected outcome is "the final result text contains all of these patterns". */
export function makeTextContainsGrader(patterns) {
  return function grade(resultEvent) {
    const text = resultEvent?.result;
    const matched = textContainsAll(text, patterns);
    return { matched, reason: matched ? 'result text contains all expected patterns' : 'result text missing one or more expected patterns' };
  };
}

/** First-useful-signal factory: first event (assistant tool_use OR user tool_result) whose
 * serialized content matches any of the given patterns. Returns an event index, never a ms value. */
export function makeFirstMatchSignalPredicate(patterns) {
  return function findSignal(events) {
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      let haystack = null;
      if (ev.type === 'assistant') haystack = JSON.stringify(ev.message?.content ?? '');
      else if (ev.type === 'user') haystack = JSON.stringify(ev.message?.content ?? '');
      if (haystack == null) continue;
      if (patterns.some((p) => (p instanceof RegExp ? p.test(haystack) : haystack.includes(p)))) {
        return { type: ev.type, index: i };
      }
    }
    return null;
  };
}

// Registry: scenario_id -> {grade, findSignal}. Scenario JSON files reference their id here;
// this keeps grading logic centralized and testable with synthetic fixtures, independent of
// the corpus content itself.
const REGISTRY = new Map();

export function registerGrader(scenarioId, { grade, findSignal }) {
  REGISTRY.set(scenarioId, { grade, findSignal });
}

export function getGrader(scenarioId) {
  const entry = REGISTRY.get(scenarioId);
  if (entry == null) throw new Error(`No grader registered for scenario "${scenarioId}"`);
  return entry;
}

registerGrader('kampkit-android-host-test-discovery', {
  grade: makeTextContainsGrader([/host-?test/i, /pass|fail/i]),
  findSignal: makeFirstMatchSignalPredicate([/host-?test/i, /testAndroidHostTest/]),
});
registerGrader('kampkit-no-applicable-tests', {
  grade: makeTextContainsGrader([/no.*test|nothing.*test|zero.*test/i]),
  findSignal: makeFirstMatchSignalPredicate([/no_test_modules|no.*test/i]),
});
registerGrader('nowinandroid-core-common', {
  grade: makeTextContainsGrader([/core:common|core-common/i, /pass|fail/i]),
  findSignal: makeFirstMatchSignalPredicate([/core:common|core-common/i]),
});
registerGrader('deterministic-unit-test-failure', {
  grade: makeTextContainsGrader([/fail/i]),
  findSignal: makeFirstMatchSignalPredicate([/fail/i, /error/i]),
});
registerGrader('coverage-threshold-failure', {
  grade: makeTextContainsGrader([/coverage/i, /threshold|below|missed/i]),
  findSignal: makeFirstMatchSignalPredicate([/coverage/i]),
});
registerGrader('changed-module-verification', {
  grade: makeTextContainsGrader([/changed/i, /module/i]),
  findSignal: makeFirstMatchSignalPredicate([/changed/i]),
});

export { REGISTRY };
