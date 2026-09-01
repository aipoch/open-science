import { beforeEach, describe, expect, it, vi } from 'vitest'

const { realpathSyncMock } = vi.hoisted(() => ({ realpathSyncMock: vi.fn() }))

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  realpathSync: realpathSyncMock
}))

import { DEFAULT_PY_ENV, envPrefix, pythonBin } from './runtime-paths'
import { managedDefaultRuntimeIdentities } from './runtime-target'

describe('managed default Runtime identities', () => {
  beforeEach(() => {
    realpathSyncMock.mockReset()
  })

  it('retains both canonical and raw interpreter identities after uninstall', () => {
    const runtimeRoot = '/data/runtime'
    const platform = 'win32'
    const prefix = envPrefix(runtimeRoot, DEFAULT_PY_ENV, platform)
    const rawRuntimeId = pythonBin(prefix, platform)
    const canonicalRuntimeId = `${rawRuntimeId}.canonical`
    realpathSyncMock.mockReturnValue(canonicalRuntimeId)

    expect(managedDefaultRuntimeIdentities(runtimeRoot, 'python', platform)).toEqual([
      { prefix, runtimeId: canonicalRuntimeId },
      { prefix, runtimeId: rawRuntimeId }
    ])
  })

  it('does not duplicate an interpreter whose canonical and raw identities match', () => {
    const runtimeRoot = '/data/runtime'
    const platform = 'linux'
    const prefix = envPrefix(runtimeRoot, DEFAULT_PY_ENV, platform)
    const runtimeId = pythonBin(prefix, platform)
    realpathSyncMock.mockReturnValue(runtimeId)

    expect(managedDefaultRuntimeIdentities(runtimeRoot, 'python', platform)).toEqual([
      { prefix, runtimeId }
    ])
  })
})
