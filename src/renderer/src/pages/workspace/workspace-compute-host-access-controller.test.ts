import { afterEach, vi, describe, expect, it } from 'vitest'

import type { PersistedChatSession } from '../../../../shared/session-persistence'
import { createWorkspaceComputeHostAccessController } from './workspace-compute-host-access-controller'

describe('workspace Compute Host access controller', () => {
  it('moves a new-Session host through Hidden, Available and multi-Selected states', () => {
    let enabledProviderIds: string[] = []
    let selectedProviderIds: string[] = []
    const controller = (): ReturnType<typeof createWorkspaceComputeHostAccessController> =>
      createWorkspaceComputeHostAccessController({
        activeSession: undefined,
        newConversationEnabledComputeHosts: enabledProviderIds,
        newConversationSelectedComputeHosts: selectedProviderIds,
        setNewConversationEnabledComputeHosts: (update) => {
          enabledProviderIds = update(enabledProviderIds)
        },
        setNewConversationSelectedComputeHosts: (update) => {
          selectedProviderIds = update(selectedProviderIds)
        },
        setError: () => undefined
      })

    controller().setHostEnabled('ssh:alpha', true)
    controller().setHostEnabled('ssh:beta', true)
    expect(enabledProviderIds).toEqual(['ssh:alpha', 'ssh:beta'])
    expect(selectedProviderIds).toEqual([])

    controller().setHostSelected('ssh:alpha', true)
    controller().setHostSelected('ssh:beta', true)
    expect(selectedProviderIds).toEqual(['ssh:alpha', 'ssh:beta'])

    controller().setHostEnabled('ssh:alpha', false)
    expect(enabledProviderIds).toEqual(['ssh:beta'])
    expect(selectedProviderIds).toEqual(['ssh:beta'])

    controller().setHostEnabled('ssh:alpha', true)
    expect(enabledProviderIds).toEqual(['ssh:beta', 'ssh:alpha'])
    expect(selectedProviderIds).toEqual(['ssh:beta'])

    controller().setHostSelected('ssh:gamma', true)
    expect(enabledProviderIds).toEqual(['ssh:beta', 'ssh:alpha', 'ssh:gamma'])
    expect(selectedProviderIds).toEqual(['ssh:beta', 'ssh:gamma'])
  })
})

describe('overlapping authoritative updates', () => {
  afterEach(() => vi.unstubAllGlobals())

  const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((a) => {
      resolve = a
    })
    return { promise, resolve }
  }

  it('preserves newer host authority after a delayed command reply', async () => {
    const { useSessionStore: store, createInitialSessionState } =
      await import('../../stores/session-store')
    const { createWorkspaceComputeHostAccessController } =
      await import('./workspace-compute-host-access-controller')
    store.setState(createInitialSessionState())
    const initial: PersistedChatSession = {
      id: 'sync-session',
      projectId: 'p',
      title: 'Session',
      cwd: '/fixture',
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      enabledComputeHosts: [],
      selectedComputeHosts: []
    }
    store.setState({ sessions: [initial] } as never)
    const rpc = deferred<typeof initial>()
    const setError = vi.fn()
    vi.stubGlobal('window', { api: { compute: { hostEnabledSet: () => rpc.promise } } })
    createWorkspaceComputeHostAccessController({
      activeSession: initial,
      newConversationEnabledComputeHosts: [],
      newConversationSelectedComputeHosts: [],
      setNewConversationEnabledComputeHosts: vi.fn(),
      setNewConversationSelectedComputeHosts: vi.fn(),
      setError
    } as never).setHostEnabled('ssh:lab', true)
    const old = { ...initial, revision: 2, updatedAt: 2, enabledComputeHosts: ['ssh:lab'] }
    // Same projection used by useLifecycleSync; remote client has since disabled this host.
    store.getState().applyDurableSessionProjection({
      source: initial,
      session: { ...initial, revision: 3, updatedAt: 3 },
      mode: 'compute-host-access-authority'
    } as never)
    rpc.resolve(old)
    await rpc.promise
    await Promise.resolve()
    expect(store.getState().sessions[0]).toMatchObject({
      revision: 3,
      updatedAt: 3,
      enabledComputeHosts: []
    })
  })
})
