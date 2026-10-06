import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { spawnGradle } from './orchestrator-utils.js';

const BEGIN = 'KMP_TEST_DEPENDENCIES_BEGIN';
const EDGE = 'KMP_TEST_DEPENDENCY\t';
const END = 'KMP_TEST_DEPENDENCIES_END';

// An init script reads Gradle's configured ProjectDependency objects. Parsing
// build files here would miss convention plugins and type-safe project accessors.
const PROBE_SCRIPT = `import org.gradle.api.artifacts.ProjectDependency
gradle.projectsEvaluated {
  println '${BEGIN}'
  gradle.rootProject.allprojects.each { project ->
    project.configurations.each { configuration ->
      configuration.dependencies.withType(ProjectDependency).each { dependency ->
        println '${EDGE}' + project.path + '\\t' + dependency.path
      }
    }
  }
  println '${END}'
}
`;

export function parseDependencyGraph(output, includedModules) {
  const known = new Set(includedModules.map((name) => `:${name}`));
  const reverse = new Map([...known].map((name) => [name, new Set()]));
  const start = output.indexOf(BEGIN);
  const finish = output.indexOf(END, start + BEGIN.length);
  if (start < 0 || finish < 0) return null;
  for (const line of output.slice(start + BEGIN.length, finish).split(/\r?\n/)) {
    if (!line.startsWith(EDGE)) continue;
    const fields = line.slice(EDGE.length).split('\t');
    if (fields.length !== 2) continue;
    const [dependent, dependency] = fields;
    if (known.has(dependent) && known.has(dependency) && dependent !== dependency) {
      reverse.get(dependency).add(dependent);
    }
  }
  return reverse;
}

export function expandDependents(changedModules, reverseGraph) {
  const directlyChanged = new Set(changedModules.map((name) => `:${name}`));
  const visited = new Set(directlyChanged);
  const pending = [...directlyChanged];
  while (pending.length) {
    const dependency = pending.shift();
    for (const dependent of reverseGraph.get(dependency) || []) {
      if (visited.has(dependent)) continue;
      visited.add(dependent);
      pending.push(dependent);
    }
  }
  return [...visited].filter((name) => !directlyChanged.has(name))
    .map((name) => name.slice(1)).sort();
}

export function probeDependents({ projectRoot, includedModules, changedModules, spawn, env }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kmp-test-dependencies-'));
  const initScript = path.join(dir, 'probe.gradle');
  try {
    writeFileSync(initScript, PROBE_SCRIPT, 'utf8');
    const gradlew = path.join(projectRoot, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
    const result = spawnGradle(spawn, gradlew,
      ['--no-configuration-cache', '--console=plain', '--init-script', initScript, 'help', '--quiet'],
      { cwd: projectRoot, encoding: 'utf8', env });
    if (result?.error || result?.status !== 0) {
      return { error: result?.error?.message || result?.stderr || `Gradle exited ${result?.status ?? 'unknown'}` };
    }
    const graph = parseDependencyGraph(result.stdout || '', includedModules);
    if (!graph) return { error: 'Gradle dependency probe did not emit a complete graph' };
    return { modules: expandDependents(changedModules, graph) };
  } catch (error) {
    return { error: error.message };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
