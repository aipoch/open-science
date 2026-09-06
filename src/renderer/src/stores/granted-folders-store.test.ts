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
  it('preserves the accepted cache when the newest refresh fails and an older read succeeds', async () => {
    const older = Promise.withResolvers<GrantedLocalRoot[]>()
    const accepted = [createRoot({ id: 'accepted' })]
    useGrantedFoldersStore.setState({ roots: accepted, loaded: true })
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
  })
})
