import { vi, describe, it, expect, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BIN_PATH  = path.resolve(__dirname, '../../bin/kmp-test.js')
const req       = createRequire(import.meta.url)

// ─── helpers ──────────────────────────────────────────────────────────────────

async function runBin(argv, platform = 'linux', cwdOverride = '/fake/cwd') {
  const mockSpawnSync = globalThis.__spawnSyncMock

  const origArgv  = process.argv
  const origExit  = process.exit
  const origCwd   = process.cwd

  const stderrChunks = []
  const stdoutChunks = []
  const origStderrWrite = process.stderr.write.bind(process.stderr)
  const origStdoutWrite = process.stdout.write.bind(process.stdout)
  process.stderr.write = (s) => { stderrChunks.push(String(s)); return true }
  process.stdout.write = (s) => { stdoutChunks.push(String(s)); return true }

  process.argv = ['node', 'kmp-test.js', ...argv]
  process.cwd  = () => cwdOverride

  const origDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  try {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true, enumerable: true, writable: false })
  } catch (_) {
    // Node 24 may not allow redefining platform — fall back to stubbing via object spread
  }

  let exitCode
  process.exit = (code) => {
    exitCode = code ?? 0
    throw new Error('EXIT:' + code)
  }

  // Clear require cache so the module re-executes and picks up the patched Module._load
  delete req.cache[BIN_PATH]

  try {
    req(BIN_PATH)
  } catch (e) {
    if (typeof e?.message === 'string' && e.message.startsWith('EXIT:')) {
      exitCode = Number(e.message.slice(5))
    } else {
      throw e
    }
  } finally {
    process.argv  = origArgv
    process.exit  = origExit
    process.cwd   = origCwd
    process.stderr.write = origStderrWrite
    process.stdout.write = origStdoutWrite
    if (origDescriptor) {
      try {
        Object.defineProperty(process, 'platform', origDescriptor)
      } catch (_) {}
    }
    delete req.cache[BIN_PATH]
  }

  return {
    exitCode,
    stderr: stderrChunks.join(''),
    stdout: stdoutChunks.join(''),
    mock: mockSpawnSync,
  }
}

// ─── suite ────────────────────────────────────────────────────────────────────

describe('bin/kmp-test.js — subcommand dispatch', () => {

  it('a: parallel on linux invokes run-parallel-coverage-suite.sh', async () => {
    const { mock } = await runBin(['parallel', '--project-root', '/tmp/x'])
    expect(mock).toHaveBeenCalledWith(
      'bash',
      expect.arrayContaining([expect.stringContaining('run-parallel-coverage-suite.sh')]),
      expect.anything()
    )
  })

  it('b: changed on linux invokes run-changed-modules-tests.sh', async () => {
    const { mock } = await runBin(['changed', '--project-root', '/tmp/x'])
    expect(mock).toHaveBeenCalledWith(
      'bash',
      expect.arrayContaining([expect.stringContaining('run-changed-modules-tests.sh')]),
      expect.anything()
    )
  })

  it('c: android on linux invokes run-android-tests.sh', async () => {
    const { mock } = await runBin(['android', '--project-root', '/tmp/x'])
    expect(mock).toHaveBeenCalledWith(
      'bash',
      expect.arrayContaining([expect.stringContaining('run-android-tests.sh')]),
      expect.anything()
    )
  })

  it('d: benchmark on linux invokes run-benchmarks.sh', async () => {
    const { mock } = await runBin(['benchmark', '--project-root', '/tmp/x'])
    expect(mock).toHaveBeenCalledWith(
      'bash',
      expect.arrayContaining([expect.stringContaining('run-benchmarks.sh')]),
      expect.anything()
    )
  })

  it('a-win32: parallel on win32 invokes run-parallel-coverage-suite.ps1', async () => {
    // First call = pwsh probe (returns status 0), second = actual script
    globalThis.__spawnSyncMock
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0 })
    const { mock } = await runBin(['parallel', '--project-root', '/tmp/x'], 'win32')
    const scriptCall = mock.mock.calls.find(
      call => call[1]?.some(a => typeof a === 'string' && a.includes('run-parallel-coverage-suite.ps1'))
    )
    expect(scriptCall).toBeTruthy()
  })

  it('e: coverage subcommand injects --skip-tests before --project-root', async () => {
    const { mock } = await runBin(['coverage', '--project-root', '/tmp/x'])
    const call = mock.mock.calls.find(
      c => c[1]?.some(a => typeof a === 'string' && a.endsWith('.sh'))
    )
    expect(call).toBeTruthy()
    const args = call[1]
    const skipIdx = args.indexOf('--skip-tests')
    const rootIdx = args.indexOf('--project-root')
    expect(skipIdx).toBeGreaterThanOrEqual(0)
    expect(skipIdx).toBeLessThan(rootIdx)
  })

  it('e-win32: coverage on win32 also injects --skip-tests', async () => {
    globalThis.__spawnSyncMock
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0 })
    const { mock } = await runBin(['coverage', '--project-root', '/tmp/x'], 'win32')
    const call = mock.mock.calls.find(
      c => c[1]?.some(a => typeof a === 'string' && a.endsWith('.ps1'))
    )
    expect(call).toBeTruthy()
    expect(call[1]).toContain('--skip-tests')
  })

  it('f: --project-root supplied is passed through verbatim, not duplicated', async () => {
    const { mock } = await runBin(['parallel', '--project-root', '/my/project'])
    const call = mock.mock.calls.find(
      c => c[1]?.some(a => typeof a === 'string' && a.endsWith('.sh'))
    )
    expect(call).toBeTruthy()
    const args = call[1]
    const count = args.filter(a => a === '--project-root').length
    expect(count).toBe(1)
    expect(args[args.indexOf('--project-root') + 1]).toBe('/my/project')
  })

  it('g: no --project-root in argv → inserted with process.cwd() value', async () => {
    const { mock } = await runBin(['parallel'], 'linux', '/the/cwd')
    const call = mock.mock.calls.find(
      c => c[1]?.some(a => typeof a === 'string' && a.endsWith('.sh'))
    )
    expect(call).toBeTruthy()
    const args = call[1]
    const rootIdx = args.indexOf('--project-root')
    expect(rootIdx).toBeGreaterThanOrEqual(0)
    expect(args[rootIdx + 1]).toBe('/the/cwd')
  })

  it('h: unknown subcommand exits with code 2 and stderr contains "unknown subcommand"', async () => {
    const { exitCode, stderr } = await runBin(['notacommand'])
    expect(exitCode).toBe(2)
    expect(stderr).toContain('unknown subcommand')
  })

  it('i: --help exits 0 and does NOT spawn any script', async () => {
    const { exitCode, mock } = await runBin(['--help'])
    expect(exitCode).toBe(0)
    const scriptCall = mock.mock.calls.find(
      c => c[1]?.some(a => typeof a === 'string' && (a.endsWith('.sh') || a.endsWith('.ps1')))
    )
    expect(scriptCall).toBeUndefined()
  })

  it('j: --version exits 0 and prints semver version string', async () => {
    const { exitCode, stdout } = await runBin(['--version'])
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/\d+\.\d+\.\d+/)
  })

  it('k: child process exit code 42 is propagated to process.exit(42)', async () => {
    globalThis.__spawnSyncMock.mockReturnValue({ status: 42 })
    const { exitCode } = await runBin(['parallel', '--project-root', '/tmp/x'])
    expect(exitCode).toBe(42)
  })
})
