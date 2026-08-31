import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PermissionGrantSnapshot } from '../../../shared/permission-grants'
import { usePermissionGrantsStore } from './permission-grants-store'

const snapshot: PermissionGrantSnapshot = {
  version: 1,
  incompleteStores: [],
  missingDefaultGlobalGrantCount: 1,
  grants: [
    {
      id: 'grant-1',
      revision: 1,
      family: 'local_compute',
      capabilityKind: 'execution',
      capabilityLabel: 'Shell',
      scopeKind: 'global',
      scopeLabel: 'Global'
    }
  ],
  counts: { all: 1, global: 1, project: 0, session: 0 }
}

const setPermissionApi = (api: Partial<Window['api']['permissions']>): void => {
  ;(globalThis as unknown as { window: { api: { permissions: unknown } } }).window = {
    api: { permissions: api }
  } as never
}

beforeEach(() => {
  usePermissionGrantsStore.setState({
    ...snapshot,
    status: 'ready',
    loadedAt: null,
    error: undefined,
    undo: undefined,
    undoQueue: [],
    isRestoring: false,
    restoreDefaultsState: 'idle'
  })
})

describe('permission grants store', () => {
  it('reuses a snapshot for 60 seconds and supports an event-driven forced refresh', async () => {
    const list = vi.fn().mockResolvedValue(snapshot)
    setPermissionApi({ list })

    await usePermissionGrantsStore.getState().load()
    await usePermissionGrantsStore.getState().load()
    await usePermissionGrantsStore.getState().load({ force: true })

    expect(list).toHaveBeenCalledTimes(2)
  })

  it('optimistically removes a row and records the durable Undo receipt', async () => {
    let resolveMutation: ((result: unknown) => void) | undefined
    setPermissionApi({
      revoke: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveMutation = resolve
          })
      ) as never
    })

    const pending = usePermissionGrantsStore.getState().revoke(snapshot.grants)
    expect(usePermissionGrantsStore.getState().grants).toEqual([])

    resolveMutation?.({
      grants: [],
      counts: { all: 0, global: 0, project: 0, session: 0 },
      conflicts: [],
      receipt: { undoToken: 'undo-1', expiresAt: Date.now() + 8_000, revokedCount: 1 }
    })
    await pending

    expect(usePermissionGrantsStore.getState().undo).toMatchObject({
      token: 'undo-1',
      messageKey: 'Revoked {{family}} · {{capability}}',
      messageParams: { family: 'Local compute', capability: 'Shell' },
      translatedMessageParams: ['family', 'capability']
    })
  })

  it('reports the exact successful subset when a batch has a revision conflict', async () => {
    const second = { ...snapshot.grants[0], id: 'grant-2', revision: 2 }
    setPermissionApi({
      revoke: vi.fn().mockResolvedValue({
        ...snapshot,
        conflicts: [{ id: 'grant-2', reason: 'stale' }],
        receipt: { undoToken: 'undo-partial', expiresAt: Date.now() + 8_000, revokedCount: 1 }
      })
    })

    await usePermissionGrantsStore.getState().revoke([snapshot.grants[0], second])

    expect(usePermissionGrantsStore.getState().undo).toMatchObject({
      messageKey:
        'Revoked {{family}} · {{capability}}; {{conflictCount}} changed before it could be revoked',
      messageParams: { family: 'Local compute', capability: 'Shell', conflictCount: 1 }
    })
  })

  it('rolls the optimistic removal back when persistence fails', async () => {
    setPermissionApi({ revoke: vi.fn().mockRejectedValue(new Error('database locked')) })

    await usePermissionGrantsStore.getState().revoke(snapshot.grants)

    expect(usePermissionGrantsStore.getState()).toMatchObject({
      grants: snapshot.grants,
      counts: snapshot.counts,
      status: 'error',
      error: 'database locked'
    })
  })

  it('does not resurrect a concurrently revoked grant when another revoke fails', async () => {
    const second = { ...snapshot.grants[0], id: 'grant-2', capabilityLabel: 'Python' }
    usePermissionGrantsStore.setState({
      ...snapshot,
      grants: [snapshot.grants[0], second],
      counts: { all: 2, global: 2, project: 0, session: 0 }
    })
    let rejectFirst: ((error: Error) => void) | undefined
    let resolveSecond: ((result: unknown) => void) | undefined
    setPermissionApi({
      list: vi.fn().mockResolvedValue({
        ...snapshot,
        version: 2,
        grants: [snapshot.grants[0]],
        counts: { all: 1, global: 1, project: 0, session: 0 }
      }),
      revoke: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectFirst = reject
            })
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveSecond = resolve
            })
        ) as never
    })

    const failed = usePermissionGrantsStore.getState().revoke([snapshot.grants[0]])
    const successful = usePermissionGrantsStore.getState().revoke([second])

    resolveSecond?.({
      ...snapshot,
      version: 2,
      grants: [snapshot.grants[0]],
      counts: { all: 1, global: 1, project: 0, session: 0 },
      conflicts: [],
      receipt: { undoToken: 'undo-2', expiresAt: Date.now() + 8_000, revokedCount: 1 }
    })
    await successful
    rejectFirst?.(new Error('database locked'))
    await failed

    expect(usePermissionGrantsStore.getState()).toMatchObject({
      version: 2,
      grants: [snapshot.grants[0]],
      counts: { all: 1, global: 1, project: 0, session: 0 },
      status: 'error',
      error: 'database locked'
    })
  })

  it('keeps an optimistic removal hidden when a list response races the revoke', async () => {
    let resolveMutation: ((result: unknown) => void) | undefined
    setPermissionApi({
      list: vi.fn().mockResolvedValue(snapshot),
      revoke: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveMutation = resolve
          })
      ) as never
    })

    const revoke = usePermissionGrantsStore.getState().revoke(snapshot.grants)
    await usePermissionGrantsStore.getState().load()
    expect(usePermissionGrantsStore.getState().grants).toEqual([])

    resolveMutation?.({
      ...snapshot,
      version: 2,
      grants: [],
      counts: { all: 0, global: 0, project: 0, session: 0 },
      conflicts: [],
      receipt: { undoToken: 'undo-race', expiresAt: Date.now() + 8_000, revokedCount: 1 }
    })
    await revoke

    expect(usePermissionGrantsStore.getState()).toMatchObject({ version: 2, grants: [] })
  })

  it('ignores an older successful revoke response that arrives after a newer snapshot', async () => {
    const second = { ...snapshot.grants[0], id: 'grant-2', capabilityLabel: 'Python' }
    usePermissionGrantsStore.setState({
      ...snapshot,
      grants: [snapshot.grants[0], second],
      counts: { all: 2, global: 2, project: 0, session: 0 }
    })
    let resolveFirst: ((result: unknown) => void) | undefined
    let resolveSecond: ((result: unknown) => void) | undefined
    setPermissionApi({
      revoke: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve
            })
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveSecond = resolve
            })
        ) as never
    })

    const first = usePermissionGrantsStore.getState().revoke([snapshot.grants[0]])
    const secondRevoke = usePermissionGrantsStore.getState().revoke([second])
    resolveSecond?.({
      ...snapshot,
      version: 3,
      grants: [],
      counts: { all: 0, global: 0, project: 0, session: 0 },
      conflicts: [],
      receipt: { undoToken: 'undo-new', expiresAt: Date.now() + 8_000, revokedCount: 1 }
    })
    await secondRevoke
    resolveFirst?.({
      ...snapshot,
      version: 2,
      grants: [second],
      counts: { all: 1, global: 1, project: 0, session: 0 },
      conflicts: [],
      receipt: { undoToken: 'undo-old', expiresAt: Date.now() + 8_000, revokedCount: 1 }
    })
    await first

    expect(usePermissionGrantsStore.getState()).toMatchObject({ version: 3, grants: [] })
  })

  it('updates an Undo item from the authoritative extended receipt', async () => {
    const expiresAt = Date.now() + 16_000
    const extendUndo = vi.fn().mockResolvedValue({
      undoToken: 'undo-1',
      expiresAt,
      revokedCount: 1
    })
    setPermissionApi({ extendUndo })
    usePermissionGrantsStore.setState({
      undo: { token: 'undo-1', expiresAt: Date.now() + 8_000, messageKey: 'Revoked Shell' }
    })

    await expect(usePermissionGrantsStore.getState().extendUndo('undo-1')).resolves.toBe(expiresAt)

    expect(extendUndo).toHaveBeenCalledWith({ undoToken: 'undo-1' })
    expect(usePermissionGrantsStore.getState().undo?.expiresAt).toBe(expiresAt)
  })

  it('dismisses an Undo item when its receipt can no longer be extended', async () => {
    setPermissionApi({ extendUndo: vi.fn().mockResolvedValue(undefined) })
    usePermissionGrantsStore.setState({
      undo: { token: 'undo-1', expiresAt: Date.now() + 8_000, messageKey: 'Revoked Shell' }
    })

    await expect(usePermissionGrantsStore.getState().extendUndo('undo-1')).resolves.toBeUndefined()

    expect(usePermissionGrantsStore.getState().undo).toBeUndefined()
  })

  it('restores a receipt once and clears the snackbar state', async () => {
    const restore = vi.fn().mockResolvedValue({ ...snapshot, conflicts: [] })
    setPermissionApi({ restore })
    usePermissionGrantsStore.setState({
      grants: [],
      counts: { all: 0, global: 0, project: 0, session: 0 },
      undo: { token: 'undo-1', expiresAt: Date.now() + 8_000, messageKey: 'Revoked Shell' }
    })

    await usePermissionGrantsStore.getState().restore()

    expect(restore).toHaveBeenCalledWith({ undoToken: 'undo-1' })
    expect(usePermissionGrantsStore.getState()).toMatchObject({
      grants: snapshot.grants,
      undo: undefined,
      isRestoring: false
    })
  })

  it('consumes consecutive revoke receipts FIFO while each receipt is still valid', async () => {
    const second = { ...snapshot.grants[0], id: 'grant-2', capabilityLabel: 'Python' }
    usePermissionGrantsStore.setState({
      ...snapshot,
      grants: [snapshot.grants[0], second],
      counts: { all: 2, global: 2, project: 0, session: 0 }
    })
    setPermissionApi({
      revoke: vi
        .fn()
        .mockResolvedValueOnce({
          ...snapshot,
          grants: [second],
          counts: { all: 1, global: 1, project: 0, session: 0 },
          conflicts: [],
          receipt: { undoToken: 'undo-1', expiresAt: Date.now() + 8_000, revokedCount: 1 }
        })
        .mockResolvedValueOnce({
          ...snapshot,
          grants: [],
          counts: { all: 0, global: 0, project: 0, session: 0 },
          conflicts: [],
          receipt: { undoToken: 'undo-2', expiresAt: Date.now() + 8_000, revokedCount: 1 }
        })
    })

    await usePermissionGrantsStore.getState().revoke([snapshot.grants[0]])
    await usePermissionGrantsStore.getState().revoke([second])

    expect(usePermissionGrantsStore.getState().undo?.token).toBe('undo-1')
    expect(usePermissionGrantsStore.getState().undoQueue.map((item) => item.token)).toEqual([
      'undo-2'
    ])
    usePermissionGrantsStore.getState().dismissUndo()
    expect(usePermissionGrantsStore.getState().undo?.token).toBe('undo-2')
  })

  it('keeps a failed restore actionable as Retry', async () => {
    setPermissionApi({ restore: vi.fn().mockRejectedValue(new Error('database locked')) })
    usePermissionGrantsStore.setState({
      undo: { token: 'undo-1', expiresAt: Date.now() + 8_000, messageKey: 'Revoked Shell' }
    })

    await usePermissionGrantsStore.getState().restore()

    expect(usePermissionGrantsStore.getState().undo).toMatchObject({
      token: 'undo-1',
      retry: true,
      messageKey: "Couldn't restore permission. Retry."
    })
  })

  it('explains when an owner disappeared before restore', async () => {
    setPermissionApi({
      restore: vi.fn().mockResolvedValue({
        ...snapshot,
        grants: [],
        counts: { all: 0, global: 0, project: 0, session: 0 },
        conflicts: [{ id: 'grant-1', reason: 'target-unavailable' }]
      })
    })
    usePermissionGrantsStore.setState({
      undo: { token: 'undo-1', expiresAt: Date.now() + 8_000, messageKey: 'Revoked Shell' }
    })

    await usePermissionGrantsStore.getState().restore()

    expect(usePermissionGrantsStore.getState().undo).toMatchObject({
      canRestore: false,
      messageKey: "Couldn't restore permission: owner no longer exists"
    })
  })

  it('does not let an older list response overwrite a newer snapshot', async () => {
    usePermissionGrantsStore.setState({ ...snapshot, version: 2 })
    setPermissionApi({
      list: vi.fn().mockResolvedValue({
        ...snapshot,
        version: 1,
        grants: [],
        counts: { all: 0, global: 0, project: 0, session: 0 }
      })
    })

    await usePermissionGrantsStore.getState().load()

    expect(usePermissionGrantsStore.getState()).toMatchObject({
      version: 2,
      grants: snapshot.grants
    })
  })

  it('restores missing defaults from the authoritative snapshot', async () => {
    const restored = {
      ...snapshot,
      version: 2,
      missingDefaultGlobalGrantCount: 0,
      restoredCount: 2
    }
    const restoreDefaults = vi.fn().mockResolvedValue(restored)
    setPermissionApi({ restoreDefaults })

    await usePermissionGrantsStore.getState().restoreDefaults()

    expect(restoreDefaults).toHaveBeenCalledOnce()
    expect(usePermissionGrantsStore.getState()).toMatchObject({
      version: 2,
      grants: snapshot.grants,
      missingDefaultGlobalGrantCount: 0,
      restoreDefaultsState: 'success'
    })
  })

  it('does not request a restore when every default is already present', async () => {
    const restoreDefaults = vi.fn()
    usePermissionGrantsStore.setState({ missingDefaultGlobalGrantCount: 0 })
    setPermissionApi({ restoreDefaults })

    await usePermissionGrantsStore.getState().restoreDefaults()

    expect(restoreDefaults).not.toHaveBeenCalled()
  })

  it('keeps restore defaults retryable after a persistence failure', async () => {
    setPermissionApi({
      restoreDefaults: vi.fn().mockRejectedValue(new Error('database locked'))
    })

    await usePermissionGrantsStore.getState().restoreDefaults()

    expect(usePermissionGrantsStore.getState()).toMatchObject({
      status: 'error',
      error: 'database locked',
      restoreDefaultsState: 'error'
    })
  })
})
