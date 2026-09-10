import { afterEach, describe, expect, it, vi } from 'vitest';

const runUpdateMock = vi.hoisted(() => vi.fn(async () => ({
  envelope: { update: { action: 'check-only' } },
  exitCode: 0,
})));

vi.mock('../../lib/orchestrators/update-orchestrator.js', () => ({
  runUpdate: runUpdateMock,
  formatUpdateText: vi.fn(() => ''),
}));

import { run } from '../../lib/commands/update.js';
import { ASYNC_DEFERRED } from '../../lib/envelope/exit-codes.js';

describe('update command dispatch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runUpdateMock.mockClear();
  });

  it('forwards the globally consumed --force flag to the update orchestrator', async () => {
    vi.spyOn(process, 'exit').mockImplementation(() => undefined);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    expect(run({ args: ['--check'], jsonMode: false, force: true })).toBe(ASYNC_DEFERRED);

    await vi.waitFor(() => expect(runUpdateMock).toHaveBeenCalledOnce());
    expect(runUpdateMock.mock.calls[0][0].args).toEqual(['--check', '--force']);
  });

  it('forwards --dry-run so update rejects it instead of installing', async () => {
    vi.spyOn(process, 'exit').mockImplementation(() => undefined);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    expect(run({ args: [], jsonMode: false, dryRun: true })).toBe(ASYNC_DEFERRED);

    await vi.waitFor(() => expect(runUpdateMock).toHaveBeenCalledOnce());
    expect(runUpdateMock.mock.calls[0][0].args).toEqual(['--dry-run']);
  });
});
