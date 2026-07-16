// SPDX-License-Identifier: MIT
// Test helpers: normalize platform-specific spawn-call shapes.
// On Windows, lib/orchestrators/orchestrator-utils.js#spawnGradle uses one of
// three shapes depending on which branch is taken:
//
//  1. POSIX / non-.bat : spawn(gradlewPath, gradleArgs, opts)
//  2. Candidate A (Windows + JAR found): spawn(javaExe, ['-classpath', jar,
//       '-Dorg.gradle.appname=gradlew', 'GradleWrapperMain', ...gradleArgs], opts)
//  3. cmd.exe fallback (Windows + JAR absent): spawn(comspec,
//       ['/d', '/v:off', '/s', '/c', cmdLine], opts)
//     Note: /v:off was added in PR-25 — cmdLine is now at args[4] (after /c),
//     not args[3]. Use indexOf('/c') + 1 to find it robustly.
//
// These helpers give vitest assertions a unified view regardless of shape.

const SHELL_RE = /(^|[\\/])cmd(\.exe)?$/i;
const JAVA_RE = /(^|[\\/])java(\.exe)?$/i;
const GRADLE_MAIN = 'org.gradle.wrapper.GradleWrapperMain';

export function isGradleCall(call) {
  if (!call) return false;
  const cmd = String(call.cmd || '');
  if (/gradlew/i.test(cmd)) return true;
  if (SHELL_RE.test(cmd) && Array.isArray(call.args)) {
    return call.args.some(a => /gradlew/i.test(String(a)));
  }
  // Candidate A: java.exe -classpath <jar> ... GradleWrapperMain <gradleArgs>
  if (JAVA_RE.test(cmd) && Array.isArray(call.args)) {
    return call.args.includes(GRADLE_MAIN);
  }
  return false;
}

export function effectiveGradleArgs(call) {
  if (!call || !Array.isArray(call.args)) return [];
  if (/gradlew/i.test(String(call.cmd))) return call.args;
  // Candidate A: java.exe + GradleWrapperMain — args after the main class.
  if (JAVA_RE.test(String(call.cmd)) && call.args.includes(GRADLE_MAIN)) {
    return call.args.slice(call.args.indexOf(GRADLE_MAIN) + 1);
  }
  // cmd.exe fallback: find /c to locate cmdLine (robust to flag insertions
  // like /v:off that shift the position relative to a fixed index).
  const cIdx = call.args.indexOf('/c');
  let cmdLine = cIdx !== -1 ? (call.args[cIdx + 1] || '') : (call.args[3] || '');
  // Strip the outer wrap (first + last char if both `"`).
  if (cmdLine.startsWith('"') && cmdLine.endsWith('"')) {
    cmdLine = cmdLine.slice(1, -1);
  }
  // Now `"<gradlewPath>" arg1 arg2 ...` — strip the path token.
  let rest;
  if (cmdLine.startsWith('"')) {
    const closing = cmdLine.indexOf('"', 1);
    rest = closing === -1 ? '' : cmdLine.slice(closing + 1).replace(/^\s+/, '');
  } else {
    const idx = cmdLine.search(/\s/);
    rest = idx === -1 ? '' : cmdLine.slice(idx + 1);
  }
  if (!rest) return [];
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let mm;
  while ((mm = re.exec(rest)) !== null) {
    tokens.push(mm[1] !== undefined ? mm[1] : mm[2]);
  }
  return tokens;
}

export function isStopCall(call) {
  if (!isGradleCall(call)) return false;
  const args = effectiveGradleArgs(call).filter(a => !/^--console(=|$)/.test(String(a)));
  return args.length === 1 && args[0] === '--stop';
}
