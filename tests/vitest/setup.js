// Patch Module._load to intercept child_process require() from CJS modules.
// vi.mock('node:child_process') does NOT intercept require() inside CJS files —
// Module._load does. The mock function is stored on globalThis for test access.
import { vi, beforeEach, afterEach } from 'vitest'
import Module from 'node:module'

const _origLoad = Module._load.bind(Module)

beforeEach(() => {
  const mockFn = vi.fn().mockReturnValue({ status: 0 })
  globalThis.__spawnSyncMock = mockFn

  Module._load = function (request, parent, isMain) {
    if (request === 'node:child_process' || request === 'child_process') {
      return { spawnSync: mockFn }
    }
    return _origLoad(request, parent, isMain)
  }
})

afterEach(() => {
  Module._load = _origLoad
  delete globalThis.__spawnSyncMock
})
