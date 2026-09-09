import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('overlapping authoritative updates', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('refreshes remote runtime policy when reopening the panel', async () => {
    const { useRuntimeSettingsStore: store } = await import('./runtime-settings-store')
    const { NotebookRuntimeSettingsModule } =
      await import('../../../main/settings/notebook-runtime-settings')
    let authority = { agentEnvironmentCreationEnabled: true }
    const owner = new NotebookRuntimeSettingsModule({
      getSettings: async () => authority,
      setAgentEnvironmentCreationEnabled: async (enabled: boolean) => {
        authority = { agentEnvironmentCreationEnabled: enabled }
        return authority
      }
    } as never)
    store.setState({
      envs: null,
      enablement: {},
      loaded: false,
      checkedAt: null,
      busy: false,
      error: null,
      packageCounts: {},
      packageCountsLoaded: {}
    })
    const getPolicy = vi.fn(() => owner.getAgentEnvironmentCreationEnabled())
    vi.stubGlobal('window', {
      api: {
        runtime: {
          listEnvironments: async () => ({ python: [], r: [] }),
          getEnablement: async () => ({ enabled: {}, installAuthorized: {} }),
          getAgentEnvironmentCreationEnabled: getPolicy
        }
      }
    })
    await store.getState().load()
    await owner.setAgentEnvironmentCreationEnabled(false)
    await store.getState().load()
    expect(await owner.getAgentEnvironmentCreationEnabled()).toBe(false)
    expect(store.getState().agentEnvironmentCreationEnabled).toBe(false)
    expect(getPolicy).toHaveBeenCalledTimes(2)
    await store.getState().recheck()
    expect(store.getState().agentEnvironmentCreationEnabled).toBe(false)
  })
})

it('keeps discovery from restoring a policy superseded during Recheck', async () => {
  let finishDiscovery!: (value: {
    python: DiscoveredInterpreter[]
    r: DiscoveredInterpreter[]
  }) => void
  let changed!: () => void
  let policy = true
  const runtime = {
    listEnvironments: vi
      .fn()
      .mockResolvedValueOnce({ python: [], r: [] })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishDiscovery = resolve
          })
      ),
    getEnablement: vi.fn().mockResolvedValue(enablement),
    getAgentEnvironmentCreationEnabled: vi.fn(async () => policy),
    onPolicyChanged: vi.fn((listener) => {
      changed = listener
      return () => undefined
    })
  }
  setRuntimeApi(runtime)
  await useRuntimeSettingsStore.getState().load()
  const remove = useRuntimeSettingsStore.getState().listen()
  const checking = useRuntimeSettingsStore.getState().recheck()
  await Promise.resolve()
  policy = false
  changed()
  await useRuntimeSettingsStore.getState().refreshPolicy()
  finishDiscovery({ python: [], r: [] })
  await checking
  remove()
  expect(useRuntimeSettingsStore.getState().agentEnvironmentCreationEnabled).toBe(false)
  expect(runtime.listEnvironments).toHaveBeenCalledTimes(2)
})

it('keeps a failed discovery visible when a slower policy read succeeds', async () => {
  let finish!: (value: boolean) => void
  setRuntimeApi({
    listEnvironments: vi.fn().mockRejectedValue(new Error('discovery failed')),
    getEnablement: vi.fn().mockResolvedValue(enablement),
    getAgentEnvironmentCreationEnabled: vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        })
    )
  })
  await expect(useRuntimeSettingsStore.getState().load()).rejects.toThrow('discovery failed')
  finish(true)
  await Promise.resolve()
  await Promise.resolve()
  expect(useRuntimeSettingsStore.getState().error).toBe('Could not load runtimes.')
})

it('retains a newer policy refresh error when older discovery completes', async () => {
  let finish!: (value: { python: DiscoveredInterpreter[]; r: DiscoveredInterpreter[] }) => void
  let changed!: () => void
  const policy = vi
    .fn()
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockRejectedValue(new Error('offline'))
  setRuntimeApi({
    listEnvironments: vi
      .fn()
      .mockResolvedValueOnce({ python: [], r: [] })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      ),
    getEnablement: vi.fn().mockResolvedValue(enablement),
    getAgentEnvironmentCreationEnabled: policy,
    onPolicyChanged: vi.fn((listener) => {
      changed = listener
      return () => undefined
    })
  })
  await useRuntimeSettingsStore.getState().load()
  const remove = useRuntimeSettingsStore.getState().listen()
  const checking = useRuntimeSettingsStore.getState().recheck()
  await Promise.resolve()
  await Promise.resolve()
  changed()
  await expect(useRuntimeSettingsStore.getState().refreshPolicy()).rejects.toThrow('offline')
  finish({ python: [], r: [] })
  await checking
  remove()
  expect(useRuntimeSettingsStore.getState().error).toBe('Could not load runtimes.')
})

it.each([false, true])(
  'preserves discovery failures during policy refresh (cached: %s)',
  async (cached) => {
    const listEnvironments = vi.fn().mockResolvedValue({ python: [], r: [] })
    setRuntimeApi({
      listEnvironments,
      getEnablement: vi.fn().mockResolvedValue(enablement),
      getAgentEnvironmentCreationEnabled: vi.fn().mockResolvedValue(true)
    })
    if (cached) await useRuntimeSettingsStore.getState().load()
    listEnvironments.mockRejectedValue(new Error('discovery failed'))
    await expect(useRuntimeSettingsStore.getState().recheck()).rejects.toThrow('discovery failed')
    await useRuntimeSettingsStore.getState().refreshPolicy()
    expect(useRuntimeSettingsStore.getState().error).toBe('Could not load runtimes.')
    if (cached) {
      await useRuntimeSettingsStore.getState().load()
      expect(useRuntimeSettingsStore.getState().error).toBe('Could not load runtimes.')
    }
    listEnvironments.mockResolvedValue({ python: [], r: [] })
    await useRuntimeSettingsStore.getState().recheck()
    expect(useRuntimeSettingsStore.getState().error).toBeNull()
  }
)

it('clears a recovered policy read failure without repeating discovery', async () => {
  const policy = vi.fn().mockResolvedValue(true)
  const discovery = vi.fn().mockResolvedValue({ python: [], r: [] })
  setRuntimeApi({
    listEnvironments: discovery,
    getEnablement: vi.fn().mockResolvedValue(enablement),
    getAgentEnvironmentCreationEnabled: policy
  })
  await useRuntimeSettingsStore.getState().load()
  policy.mockRejectedValueOnce(new Error('offline'))
  await expect(useRuntimeSettingsStore.getState().refreshPolicy()).rejects.toThrow('offline')
  expect(useRuntimeSettingsStore.getState().error).toBe('Could not load runtimes.')
  await useRuntimeSettingsStore.getState().refreshPolicy()
  expect(useRuntimeSettingsStore.getState().error).toBeNull()
  expect(discovery).toHaveBeenCalledOnce()
})

it('preserves discovery failure when a failed policy read later recovers', async () => {
  const policy = vi.fn().mockResolvedValue(true)
  setRuntimeApi({
    listEnvironments: vi.fn().mockRejectedValue(new Error('discovery failed')),
    getEnablement: vi.fn().mockResolvedValue(enablement),
    getAgentEnvironmentCreationEnabled: policy
  })
  await expect(useRuntimeSettingsStore.getState().load()).rejects.toThrow('discovery failed')
  policy.mockRejectedValueOnce(new Error('offline'))
  await expect(useRuntimeSettingsStore.getState().refreshPolicy()).rejects.toThrow('offline')
  await useRuntimeSettingsStore.getState().refreshPolicy()
  expect(useRuntimeSettingsStore.getState().error).toBe('Could not load runtimes.')
})

it('preserves a newer operation error when a policy read recovers', async () => {
  const policy = vi.fn().mockResolvedValue(true)
  setRuntimeApi({ getAgentEnvironmentCreationEnabled: policy })
  policy.mockRejectedValueOnce(new Error('offline'))
  await expect(useRuntimeSettingsStore.getState().refreshPolicy()).rejects.toThrow('offline')
  useRuntimeSettingsStore.getState().setError('Could not register interpreter.')
  await useRuntimeSettingsStore.getState().refreshPolicy()
  expect(useRuntimeSettingsStore.getState().error).toBe('Could not register interpreter.')
})
