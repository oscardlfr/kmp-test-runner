// SPDX-License-Identifier: MIT
// Resolve the runner-owned artifact tree independently of Gradle's build/.
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';

export const DEFAULT_OUTPUT_DIR = '.kmp-test-runner';
export const OUTPUT_ROOT_ENV = 'KMP_TEST_OUTPUT_ROOT_RESOLVED';
const MARKER = '.kmp-test-runner-output-root.json';

export function defaultOutputRoot(projectRoot) {
  return path.join(path.resolve(projectRoot), DEFAULT_OUTPUT_DIR);
}

function projectIdentity(projectRoot) {
  let canonical;
  try { canonical = realpathSync.native(projectRoot); }
  catch { canonical = path.resolve(projectRoot); }
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  return createHash('sha256').update(canonical).digest('hex');
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function extractOutputDir(args) {
  const rest = [];
  const errors = [];
  let value = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== '--output-dir' && !arg.startsWith('--output-dir=')) {
      rest.push(arg);
      continue;
    }
    const candidate = arg === '--output-dir' ? args[++i] : arg.slice('--output-dir='.length);
    if (!nonEmpty(candidate) || candidate.startsWith('--')) {
      errors.push({ code: 'invalid_flag_value', flag: '--output-dir', message: '--output-dir requires a non-empty path' });
      if (arg === '--output-dir' && candidate?.startsWith('--')) i--;
    } else {
      value = candidate;
    }
  }
  return { args: rest, value, errors };
}

export function resolveOutputRoot(projectRoot, { cli = null, config = null, env = process.env } = {}) {
  const selected = nonEmpty(cli)
    ?? nonEmpty(env?.KMP_TEST_OUTPUT_DIR)
    ?? nonEmpty(config?.defaults?.outputDir)
    ?? DEFAULT_OUTPUT_DIR;
  const root = path.resolve(projectRoot, selected);
  validateOutputRoot(projectRoot, root);
  return root;
}

function validateOutputRoot(projectRoot, root) {
  const project = path.resolve(projectRoot);
  // clean and sweep operate on named children of this root; prohibit roots
  // whose children could be real project data, and Gradle-owned build trees.
  const relative = path.relative(project, root);
  const ancestor = path.relative(root, project);
  const prohibited = [os.homedir(), os.tmpdir(), process.env.SystemRoot, process.env.WINDIR]
    .filter(Boolean).map(p => path.resolve(p));
  const same = (a, b) => process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (same(root, path.parse(root).root) || prohibited.some(p => same(root, p))
      || !relative || (ancestor !== '' && !path.isAbsolute(ancestor) && !ancestor.startsWith(`..${path.sep}`) && ancestor !== '..')
      || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && relative.split(path.sep).includes('build'))) {
    throw new Error(`unsafe output root: ${root} (choose a dedicated directory outside Gradle build/)`);
  }
}

function validateExistingAncestor(projectRoot, root) {
  let ancestor = root;
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  // Resolve the closest existing ancestor before mkdirSync. A symlinked
  // parent can otherwise redirect creation into the project or a system dir.
  const projected = path.resolve(realpathSync.native(ancestor), path.relative(ancestor, root));
  validateOutputRoot(projectRoot, projected);
}

export function outputRootFor(projectRoot, env = process.env) {
  const resolved = nonEmpty(env?.[OUTPUT_ROOT_ENV]);
  return resolved ? path.resolve(resolved) : resolveOutputRoot(projectRoot, { env });
}

// A custom path may already contain user data. Never treat its generic
// logs/cache/reports children as ours unless this exact project owns it.
export function assertOutputRootOwned(projectRoot, root, { create = false } = {}) {
  validateOutputRoot(projectRoot, path.resolve(root));
  validateExistingAncestor(projectRoot, root);
  if (create) mkdirSync(root, { recursive: true });
  if (!existsSync(root)) return;
  if (lstatSync(root).isSymbolicLink()) throw new Error(`output root is a symlink: ${root}`);
  validateOutputRoot(projectRoot, realpathSync.native(root));
  if (path.resolve(root) === defaultOutputRoot(projectRoot)) return;
  const markerPath = path.join(root, MARKER);
  const identity = projectIdentity(projectRoot);
  if (existsSync(markerPath)) {
    let marker;
    try { marker = JSON.parse(readFileSync(markerPath, 'utf8')); }
    catch { throw new Error(`output root ownership marker is invalid: ${markerPath}`); }
    if (marker.project_id !== identity || marker.schema !== 1) {
      throw new Error(`output root belongs to a different project: ${root}`);
    }
    return;
  }
  if (!create) throw new Error(`output root has no ownership marker: ${root}`);
  if (readdirSync(root).length > 0) throw new Error(`output root contains unrelated data: ${root}`);
  try {
    writeFileSync(markerPath, JSON.stringify({ schema: 1, project_id: identity }) + '\n', { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assertOutputRootOwned(projectRoot, root);
  }
}
