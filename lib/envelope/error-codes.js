// SPDX-License-Identifier: MIT
// lib/envelope/error-codes.js — error code discriminators for kmp-test
// envelopes. Scans stdout+stderr for known failure signatures and pushes
// structured errors[] entries with a `code` field. Specific codes always
// supplement the generic BUILD FAILED message — agents can prefer the coded
// entry.

// Error-code discriminators: scan stdout+stderr for known failure signatures
// and push structured errors[] with a `code` field. Specific codes always
// supplement the generic BUILD FAILED message — agents can prefer the coded
// entry.
//
// `opts.probeFailed` (boolean, default false): pass `true` when the run's
// ProjectModel carries a `probeFailure` with `recovered === false` (a
// gradle-tasks probe that never recovered, so dispatch fell back to static
// task-name guessing). Every `task_not_found` entry pushed in that case gains
// `probe_failed: true`, so an agent reading a bare `task_not_found` can tell
// "the probe told us the real task graph and this task genuinely doesn't
// exist" apart from "we never saw the real task graph and guessed wrong."
export function applyErrorCodeDiscriminators(stdout, stderr, state, opts = {}) {
  const all = stdout + '\n' + stderr;

  // task_not_found — Bug B' (KMP androidLibrary{} DSL has no
  // connectedDebugAndroidTest task)
  const taskMatch = all.match(/Cannot locate tasks? that match[^\n]*/i);
  if (taskMatch) {
    const entry = {
      code: 'task_not_found',
      message: taskMatch[0].trim(),
    };
    if (opts.probeFailed) entry.probe_failed = true;
    state.errors.push(entry);
  }

  // unsupported_class_version — Bug F (kotlinx-benchmark JmhBytecodeGeneratorWorker
  // requires JDK 21+; common when project toolchain is JDK 17)
  const ucvDetailed = all.match(/UnsupportedClassVersionError[^\n]*?class file version (\d+)[^\n]*?(?:up to|runtime)[^\n]*?(\d+)[^\n]*/i);
  if (ucvDetailed) {
    state.errors.push({
      code: 'unsupported_class_version',
      message: ucvDetailed[0].trim(),
      class_file_version: +ucvDetailed[1],
      runtime_version: +ucvDetailed[2],
    });
  } else {
    const ucvLoose = all.match(/UnsupportedClassVersionError[^\n]*/i);
    if (ucvLoose) {
      state.errors.push({
        code: 'unsupported_class_version',
        message: ucvLoose[0].trim(),
      });
    }
  }

  // instrumented_setup_failed — android emulator/device couldn't host
  // instrumented tests (apk install, manifest mismatch, etc.)
  const isfMatch = all.match(/(?:Failed to install instrumentation[^\n]*|INSTRUMENTATION_RESULT[^\n]*shortMsg[^\n]*)/i);
  if (isfMatch) {
    state.errors.push({
      code: 'instrumented_setup_failed',
      message: isfMatch[0].trim(),
    });
  }

  // no_test_modules — wrapper script discovered no modules matching the
  // filter. Either the project has no test source sets (e.g. a sample app
  // with only `composeApp` that itself has no tests), the user's
  // `--module-filter` excluded everything, or `--test-type` filtered out
  // every module (UX-2: starting with v0.7.x the wrapper words this case
  // as "No modules support the requested --test-type=<X>"). Discriminates
  // the most common parse-gap cause; surfaced from v0.6.1 stress test
  // against Nav3Guide-scenes and kmp-production-sample.
  const noModulesMatch = stdout.match(/^\[ERROR\] No modules (?:found matching filter|support the requested)[^\n]*/m);
  if (noModulesMatch) {
    state.errors.push({
      code: 'no_test_modules',
      message: noModulesMatch[0].trim(),
    });
  }
}
