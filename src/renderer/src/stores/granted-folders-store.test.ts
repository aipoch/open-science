import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GrantedLocalRoot } from '../../../shared/local-fs'
import { createInitialGrantedFoldersState, useGrantedFoldersStore } from './granted-folders-store'

const createRoot = (overrides: Partial<GrantedLocalRoot> = {}): GrantedLocalRoot => ({
  id: 'root-1',
  path: '/Users/roxi/data',
  name: 'data',
  access: 'ro',
  ...overrides
})

const setLocalFsApi = (api: Partial<Window['api']['localFs']>): void => {
  ;(globalThis as unknown as { window: { api: { localFs: unknown } } }).window = {
    api: { localFs: api }
  } as never
}

describe('granted-folders-store', () => {
  beforeEach(() => {
    useGrantedFoldersStore.setState(createInitialGrantedFoldersState())
  })

  it('refresh stores the granted roots returned by the API', async () => {
    const roots = [createRoot()]
    setLocalFsApi({ listGrantedRoots: vi.fn().mockResolvedValue(roots) })

    const returned = await useGrantedFoldersStore.getState().refresh()

    expect(returned).toEqual(roots)
    expect(useGrantedFoldersStore.getState().roots).toEqual(roots)
    expect(useGrantedFoldersStore.getState().loaded).toBe(true)
  })

  it('grant stores the updated list returned by the API', async () => {
    const updated = [
      createRoot(),
      createRoot({ id: 'root-2', path: '/data/shared', name: 'shared' })
    ]
    const grantRoot = vi.fn().mockResolvedValue(updated)
    setLocalFsApi({ grantRoot })

    await useGrantedFoldersStore.getState().grant('/data/shared', 'rw')

    expect(grantRoot).toHaveBeenCalledWith({ path: '/data/shared', access: 'rw' })
    expect(useGrantedFoldersStore.getState().roots).toEqual(updated)
  })

  it('grant keeps the previous list when the API rejects', async () => {
    const existing = [createRoot()]
    useGrantedFoldersStore.setState({ roots: existing, loaded: true })
    setLocalFsApi({ grantRoot: vi.fn().mockRejectedValue(new Error('out of scope')) })

    await expect(useGrantedFoldersStore.getState().grant('/etc', 'ro')).rejects.toThrow(
      'out of scope'
    )
    expect(useGrantedFoldersStore.getState().roots).toEqual(existing)
  })

  it('setAccess stores the updated list returned by the API', async () => {
    const updated = [createRoot({ access: 'rw' })]
    const setGrantedRootAccess = vi.fn().mockResolvedValue(updated)
    setLocalFsApi({ setGrantedRootAccess })

    await useGrantedFoldersStore.getState().setAccess('root-1', 'rw')

    expect(setGrantedRootAccess).toHaveBeenCalledWith({ id: 'root-1', access: 'rw' })
    expect(useGrantedFoldersStore.getState().roots).toEqual(updated)
  })

  it('remove stores the updated list returned by the API', async () => {
    const removeGrantedRoot = vi.fn().mockResolvedValue([])
    setLocalFsApi({ removeGrantedRoot })
    useGrantedFoldersStore.setState({ roots: [createRoot()], loaded: true })

    await useGrantedFoldersStore.getState().remove('root-1')

    expect(removeGrantedRoot).toHaveBeenCalledWith({ id: 'root-1' })
    expect(useGrantedFoldersStore.getState().roots).toEqual([])
  })

  it('does not let a stale refresh overwrite a newer grant result', async () => {
    let resolveRefresh: ((roots: GrantedLocalRoot[]) => void) | undefined
    const staleRefresh = new Promise<GrantedLocalRoot[]>((resolve) => {
      resolveRefresh = resolve
    })
    const granted = [
      createRoot(),
      createRoot({ id: 'root-2', path: '/data/shared', name: 'shared' })
    ]
    setLocalFsApi({
      listGrantedRoots: vi.fn(() => staleRefresh),
      grantRoot: vi.fn().mockResolvedValue(granted)
    })

    const refresh = useGrantedFoldersStore.getState().refresh()
    await useGrantedFoldersStore.getState().grant('/data/shared', 'rw')
    resolveRefresh?.([createRoot()])
    await refresh

    expect(useGrantedFoldersStore.getState().roots).toEqual(granted)
  })

  it('does not restore a revoked root when an older refresh finishes last', async () => {
    const older = Promise.withResolvers<GrantedLocalRoot[]>()
    const newer = Promise.withResolvers<GrantedLocalRoot[]>()
    setLocalFsApi({
      listGrantedRoots: vi
        .fn()
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(newer.promise)
    })

    const firstRefresh = useGrantedFoldersStore.getState().refresh()
    const secondRefresh = useGrantedFoldersStore.getState().refresh()
    newer.resolve([])
    await secondRefresh
    older.resolve([createRoot()])
    const returned = await firstRefresh

    expect(useGrantedFoldersStore.getState().roots).toEqual([])
    expect(returned).toEqual([])
  })
  it.each([false, true])(
    'preserves the accepted cache when the newest refresh fails and an older read succeeds (loaded=%s)',
    async (loaded) => {
      const older = Promise.withResolvers<GrantedLocalRoot[]>()
      const accepted = loaded ? [createRoot({ id: 'accepted' })] : []
      useGrantedFoldersStore.setState({ roots: accepted, loaded })
      setLocalFsApi({
        listGrantedRoots: vi
          .fn()
          .mockReturnValueOnce(older.promise)
          .mockRejectedValueOnce(new Error('offline'))
      })
      const first = useGrantedFoldersStore.getState().refresh()
      await expect(useGrantedFoldersStore.getState().refresh()).rejects.toThrow('offline')
      older.resolve([createRoot()])
      expect(await first).toBe(accepted)
      expect(useGrantedFoldersStore.getState().roots).toBe(accepted)
      expect(useGrantedFoldersStore.getState().loaded).toBe(loaded)
    }
  )

  it('finishes each removal before submitting the next so removed roots stay absent', async () => {
    const a = createRoot({ id: 'a' })
    const b = createRoot({ id: 'b' })
    let authority = [a, b]
    const releaseFirst = Promise.withResolvers<void>()
    const firstStarted = Promise.withResolvers<void>()
    const removeGrantedRoot = vi.fn(async ({ id }: { id: string }) => {
      authority = authority.filter((root) => root.id !== id)
      const snapshot = [...authority]
      if (id === a.id) {
        firstStarted.resolve()
        await releaseFirst.promise
      }
      return snapshot
    })
    setLocalFsApi({ removeGrantedRoot })
    useGrantedFoldersStore.setState({ roots: authority, loaded: true })

    const first = useGrantedFoldersStore.getState().remove(a.id)
    const second = useGrantedFoldersStore.getState().remove(b.id)
    await firstStarted.promise
    const callsBeforeRelease = removeGrantedRoot.mock.calls.length
    releaseFirst.resolve()
    expect(await first).toEqual([b])
    expect(await second).toEqual([])
    expect(removeGrantedRoot.mock.calls).toEqual([[{ id: a.id }], [{ id: b.id }]])
    expect(useGrantedFoldersStore.getState().roots).toEqual(authority)
    expect(authority).toEqual([])
    expect(callsBeforeRelease).toBe(1)
  })

  it('orders grant, access change and removal together and publishes before the next call', async () => {
    const granted = createRoot()
    const writable = createRoot({ access: 'rw' })
    const grantReply = Promise.withResolvers<GrantedLocalRoot[]>()
    const grantStarted = Promise.withResolvers<void>()
    const grantRoot = vi.fn(() => {
      grantStarted.resolve()
      return grantReply.promise
    })
    const setGrantedRootAccess = vi.fn(async () => {
      expect(useGrantedFoldersStore.getState().roots).toEqual([granted])
      return [writable]
    })
    const removeGrantedRoot = vi.fn(async () => {
      expect(useGrantedFoldersStore.getState().roots).toEqual([writable])
      return []
    })
    setLocalFsApi({ grantRoot, setGrantedRootAccess, removeGrantedRoot })

    const first = useGrantedFoldersStore.getState().grant(granted.path, 'ro')
    const second = useGrantedFoldersStore.getState().setAccess(granted.id, 'rw')
    const third = useGrantedFoldersStore.getState().remove(granted.id)
    await grantStarted.promise
    expect(setGrantedRootAccess).not.toHaveBeenCalled()
    expect(removeGrantedRoot).not.toHaveBeenCalled()
    grantReply.resolve([granted])
    expect(await first).toEqual([granted])
    expect(await second).toEqual([writable])
    expect(await third).toEqual([])
    expect(setGrantedRootAccess).toHaveBeenCalledWith({ id: granted.id, access: 'rw' })
    expect(removeGrantedRoot).toHaveBeenCalledWith({ id: granted.id })
    expect(useGrantedFoldersStore.getState().roots).toEqual([])
  })

  it.each(['reject', 'throw'] as const)(
    'preserves the failed caller error and processes the next mutation after %s',
    async (failure) => {
      const existing = [createRoot()]
      const error = new Error('permission denied')
      const grantRoot = vi.fn(() => {
        if (failure === 'throw') throw error
        return Promise.reject(error)
      })
      const removeGrantedRoot = vi.fn(async () => {
        expect(useGrantedFoldersStore.getState().roots).toBe(existing)
        return []
      })
      setLocalFsApi({ grantRoot, removeGrantedRoot })
      useGrantedFoldersStore.setState({ roots: existing, loaded: true })
      const failed = useGrantedFoldersStore.getState().grant('/data/new', 'ro')
      const rejection = expect(failed).rejects.toBe(error)
      const next = useGrantedFoldersStore.getState().remove(existing[0].id)
      await rejection
      expect(await next).toEqual([])
      expect(grantRoot).toHaveBeenCalledTimes(1)
      expect(removeGrantedRoot).toHaveBeenCalledTimes(1)
      expect(useGrantedFoldersStore.getState().roots).toEqual([])
    }
  )

  it('fences a refresh started while a mutation waits in the queue', async () => {
    const firstReply = Promise.withResolvers<GrantedLocalRoot[]>()
    const secondReply = Promise.withResolvers<GrantedLocalRoot[]>()
    const secondStarted = Promise.withResolvers<void>()
    const staleRead = Promise.withResolvers<GrantedLocalRoot[]>()
    const root = createRoot()
    const writable = createRoot({ access: 'rw' })
    setLocalFsApi({
      grantRoot: vi.fn(() => firstReply.promise),
      setGrantedRootAccess: vi.fn(() => {
        secondStarted.resolve()
        return secondReply.promise
      }),
      listGrantedRoots: vi.fn(() => staleRead.promise)
    })
    const first = useGrantedFoldersStore.getState().grant(root.path, 'ro')
    const second = useGrantedFoldersStore.getState().setAccess(root.id, 'rw')
    const refresh = useGrantedFoldersStore.getState().refresh()
    firstReply.resolve([root])
    await first
    await secondStarted.promise
    secondReply.resolve([writable])
    await second
    staleRead.resolve([])
    expect(await refresh).toEqual([writable])
    expect(useGrantedFoldersStore.getState().roots).toEqual([writable])
  })
})
