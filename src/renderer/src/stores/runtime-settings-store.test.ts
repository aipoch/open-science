import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DiscoveredInterpreter, RuntimeEnablement } from '../../../shared/notebook-runtime'
import { useRuntimeSettingsStore } from './runtime-settings-store'

const python: DiscoveredInterpreter = {
  language: 'python',
  provenance: 'app-managed',
  envId: 'managed-python',
  interpreterPath: '/data/runtime/python',
  label: 'Python',
  runnable: true
}
const enablement: RuntimeEnablement = { enabled: {}, installAuthorized: {} }

const setRuntimeApi = (runtime: Partial<Window['api']['runtime']>): void => {
  ;(globalThis as unknown as { window: { api: { runtime: unknown } } }).window = {
    api: { runtime }
  } as never
}

beforeEach(() => {
  useRuntimeSettingsStore.setState({
    envs: null,
    enablement: {},
    agentEnvironmentCreationEnabled: true,
    loaded: false,
    checkedAt: null,
    busy: false,
    error: null,
    packageCounts: {},
    packageCountsLoaded: {}
  })
})

describe('runtime settings store', () => {
  it('records a safe load error while preserving the original rejection', async () => {
    const diagnostic = new Error('SQLITE_BUSY while reading /private/data/runtimes.db')
    setRuntimeApi({
      listEnvironments: vi.fn().mockRejectedValue(diagnostic),
      getEnablement: vi.fn().mockResolvedValue(enablement),
      getAgentEnvironmentCreationEnabled: vi.fn().mockResolvedValue(true)
    })

    await expect(useRuntimeSettingsStore.getState().load()).rejects.toBe(diagnostic)

    expect(useRuntimeSettingsStore.getState().error).toBe('Could not load runtimes.')
  })

  it('retains discovery and package counts across later panel loads', async () => {
    const runtime = {
      listEnvironments: vi.fn().mockResolvedValue({ python: [python], r: [] }),
      getEnablement: vi.fn().mockResolvedValue(enablement),
      getAgentEnvironmentCreationEnabled: vi.fn().mockResolvedValue(true),
      listPackageCounts: vi.fn().mockResolvedValue({ [python.envId]: 42 })
    }
    setRuntimeApi(runtime)

    await useRuntimeSettingsStore.getState().load()
    await vi.waitFor(() =>
      expect(useRuntimeSettingsStore.getState().packageCounts).toEqual({
        [python.envId]: 42
      })
    )
    await useRuntimeSettingsStore.getState().load()

    expect(runtime.listEnvironments).toHaveBeenCalledOnce()
    expect(runtime.getEnablement).toHaveBeenCalledTimes(2)
    expect(runtime.listPackageCounts).toHaveBeenCalledOnce()
    expect(useRuntimeSettingsStore.getState().checkedAt).not.toBeNull()
  })

  it('forces discovery and clears secondary counts on Recheck', async () => {
    const runtime = {
      listEnvironments: vi.fn().mockResolvedValue({ python: [python], r: [] }),
      getEnablement: vi.fn().mockResolvedValue(enablement),
      getAgentEnvironmentCreationEnabled: vi.fn().mockResolvedValue(false),
      listPackageCounts: vi
        .fn()
        .mockResolvedValueOnce({ [python.envId]: 1 })
        .mockResolvedValueOnce({ [python.envId]: 2 })
    }
    setRuntimeApi(runtime)
    await useRuntimeSettingsStore.getState().load()
    await vi.waitFor(() =>
      expect(useRuntimeSettingsStore.getState().packageCounts).toEqual({
        [python.envId]: 1
      })
    )
    useRuntimeSettingsStore.setState({ checkedAt: 1 })

    await useRuntimeSettingsStore.getState().recheck()
    await vi.waitFor(() =>
      expect(useRuntimeSettingsStore.getState().packageCounts).toEqual({
        [python.envId]: 2
      })
    )

    expect(runtime.listEnvironments).toHaveBeenCalledTimes(2)
    expect(runtime.listPackageCounts).toHaveBeenCalledTimes(2)
    expect(useRuntimeSettingsStore.getState().agentEnvironmentCreationEnabled).toBe(false)
    expect(useRuntimeSettingsStore.getState().checkedAt).toBeGreaterThan(1)
  })
})
