import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TagSnapshot } from '../../../shared/tags'
import { createInitialTagState, useTagStore } from './tag-store'

const favoriteSnapshot = (revision = 1): TagSnapshot => ({
  revision,
  tags: [{ id: 'tag-favorite', systemKey: 'favorite', createdAt: 1, updatedAt: 1 }],
  assignments: []
})

const setTagsApi = (api: Partial<Window['api']['tags']>): void => {
  ;(globalThis as unknown as { window: { api: { tags: unknown } } }).window = {
    api: { tags: api }
  } as never
}

beforeEach(() => {
  useTagStore.setState(createInitialTagState())
})

describe('tag store', () => {
  it('removes failed pending intent without losing a newer loaded assignment', async () => {
    let reject!: (error: Error) => void
    const confirmed = {
      tagId: 'tag-favorite',
      resourceType: 'catalog.skill' as const,
      resourceId: 'confirmed',
      createdAt: 2
    }
    setTagsApi({
      setAssignment: vi.fn(
        () =>
          new Promise<TagSnapshot>((_, fail) => {
            reject = fail
          })
      ),
      snapshot: vi
        .fn()
        .mockResolvedValueOnce({ ...favoriteSnapshot(2), assignments: [confirmed] })
        .mockRejectedValueOnce(new Error('offline'))
    })
    useTagStore.setState({ ...favoriteSnapshot(1), status: 'ready' })
    const pending = useTagStore
      .getState()
      .setAssignment({ ...confirmed, resourceId: 'pending', assigned: true })
    const failed = expect(pending).rejects.toThrow('write failed')
    await useTagStore.getState().load()
    expect(useTagStore.getState().assignments.map((item) => item.resourceId)).toEqual([
      'confirmed',
      'pending'
    ])
    reject(new Error('write failed'))
    await failed
    expect(useTagStore.getState()).toMatchObject({ revision: 2, assignments: [confirmed] })
  })

  it.each(['success', 'failure'] as const)(
    'does not revive older same-resource intent after a newer success (%s)',
    async (outcome) => {
      let finish!: (snapshot: TagSnapshot) => void
      let reject!: (error: Error) => void
      setTagsApi({
        setAssignment: vi
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise<TagSnapshot>((resolve, fail) => {
                finish = resolve
                reject = fail
              })
          )
          .mockResolvedValueOnce(favoriteSnapshot(3)),
        snapshot: vi.fn().mockRejectedValue(new Error('offline'))
      })
      useTagStore.setState({ ...favoriteSnapshot(1), status: 'ready' })
      const reference = {
        tagId: 'tag-favorite',
        resourceType: 'catalog.skill' as const,
        resourceId: 'analysis'
      }
      const older = useTagStore.getState().setAssignment({ ...reference, assigned: true })
      const finished = outcome === 'failure' ? expect(older).rejects.toThrow('write failed') : older
      await useTagStore.getState().setAssignment({ ...reference, assigned: false })
      expect(useTagStore.getState().assignments).toEqual([])
      if (outcome === 'failure') reject(new Error('write failed'))
      else finish({ ...favoriteSnapshot(2), assignments: [{ ...reference, createdAt: 2 }] })
      await finished
      expect(useTagStore.getState()).toMatchObject({ revision: 3, assignments: [] })
    }
  )

  it.each([false, true])(
    'preserves newer pending assignment intent after older success (same resource: %s)',
    async (sameResource) => {
      const finish: Array<(snapshot: TagSnapshot) => void> = []
      setTagsApi({
        setAssignment: vi.fn(() => new Promise<TagSnapshot>((resolve) => finish.push(resolve)))
      })
      useTagStore.setState({ ...favoriteSnapshot(1), status: 'ready' })
      const first = {
        tagId: 'tag-favorite',
        resourceType: 'catalog.skill' as const,
        resourceId: 'analysis',
        createdAt: 2
      }
      const second = { ...first, resourceId: sameResource ? 'analysis' : 'other' }
      const a = useTagStore.getState().setAssignment({ ...first, assigned: true })
      const b = useTagStore.getState().setAssignment({ ...second, assigned: !sameResource })
      finish[0]({ ...favoriteSnapshot(2), assignments: [first] })
      await a
      const visible = useTagStore.getState().assignments.map((item) => item.resourceId)
      finish[1]({ ...favoriteSnapshot(3), assignments: sameResource ? [] : [first, second] })
      await b
      expect(visible).toEqual(sameResource ? [] : ['analysis', 'other'])
    }
  )

  it.each([false, true])(
    'rolls back only the failed relationship (same resource: %s)',
    async (sameResource) => {
      const reject: Array<(error: Error) => void> = []
      setTagsApi({
        snapshot: vi.fn().mockRejectedValue(new Error('read failed')),
        setAssignment: vi.fn(
          () =>
            new Promise<TagSnapshot>((_, fail) => {
              reject.push(fail)
            })
        )
      })
      useTagStore.setState({ ...favoriteSnapshot(1), status: 'ready' })
      const reference = {
        tagId: 'tag-favorite',
        resourceType: 'catalog.skill' as const,
        resourceId: 'analysis'
      }
      const first = useTagStore.getState().setAssignment({ ...reference, assigned: true })
      const firstFailed = expect(first).rejects.toThrow('first failed')
      const second = useTagStore.getState().setAssignment({
        ...reference,
        resourceId: sameResource ? 'analysis' : 'other',
        assigned: true
      })
      const secondFailed = expect(second).rejects.toThrow('second failed')
      reject[0]!(new Error('first failed'))
      await firstFailed
      expect(useTagStore.getState().assignments.map((item) => item.resourceId)).toEqual([
        sameResource ? 'analysis' : 'other'
      ])
      reject[1]!(new Error('second failed'))
      await secondFailed
      expect(useTagStore.getState().assignments).toEqual([])
    }
  )
  it('keeps a newer confirmed assignment when an older write and recovery read fail', async () => {
    let rejectOlder!: (error: Error) => void
    const pending = new Promise<TagSnapshot>((_, reject) => {
      rejectOlder = reject
    })
    const confirmed = {
      tagId: 'tag-favorite',
      resourceType: 'catalog.skill' as const,
      resourceId: 'confirmed',
      createdAt: 2
    }
    setTagsApi({
      snapshot: vi.fn().mockRejectedValue(new Error('read failed')),
      setAssignment: vi
        .fn()
        .mockReturnValueOnce(pending)
        .mockResolvedValueOnce({
          ...favoriteSnapshot(2),
          assignments: [confirmed]
        })
    })
    useTagStore.setState({ ...favoriteSnapshot(1), status: 'ready' })
    const older = useTagStore
      .getState()
      .setAssignment({ ...confirmed, resourceId: 'older', assigned: true })
    const failed = expect(older).rejects.toThrow('write failed')
    await useTagStore.getState().setAssignment({ ...confirmed, assigned: true })
    rejectOlder(new Error('write failed'))
    await failed
    expect(useTagStore.getState()).toMatchObject({
      revision: 2,
      assignments: [confirmed],
      status: 'error'
    })
  })

  it('keeps a confirmed rename when an older reorder and recovery read fail', async () => {
    let rejectReorder!: (error: Error) => void
    const pending = new Promise<TagSnapshot>((_, reject) => {
      rejectReorder = reject
    })
    const tag = {
      id: 'research',
      name: 'Research',
      iconKey: 'tag' as const,
      colorKey: 'blue' as const,
      createdAt: 1,
      updatedAt: 1
    }
    const confirmed = {
      ...favoriteSnapshot(2),
      tags: [...favoriteSnapshot().tags, { ...tag, name: 'Confirmed', updatedAt: 2 }]
    }
    setTagsApi({
      snapshot: vi
        .fn()
        .mockResolvedValueOnce(confirmed)
        .mockRejectedValueOnce(new Error('read failed')),
      reorder: vi.fn().mockReturnValue(pending)
    })
    useTagStore.setState({
      ...favoriteSnapshot(1),
      tags: [...favoriteSnapshot().tags, tag],
      status: 'ready'
    })
    const reorder = useTagStore.getState().reorder({ tagIds: [tag.id] })
    const failed = expect(reorder).rejects.toThrow('write failed')
    await useTagStore.getState().load()
    rejectReorder(new Error('write failed'))
    await failed
    expect(useTagStore.getState()).toMatchObject({ ...confirmed, status: 'error' })
  })
  it('preserves browser scroll when restoring the currently selected Tag', () => {
    useTagStore.setState({ browserSelectedId: 'tag-favorite', browserScrollTop: 240 })

    useTagStore.getState().setBrowserSelectedId('tag-favorite')
    expect(useTagStore.getState().browserScrollTop).toBe(240)

    useTagStore.getState().setBrowserSelectedId('tag-research')
    expect(useTagStore.getState().browserScrollTop).toBe(0)
  })

  it('hydrates the authoritative snapshot', async () => {
    setTagsApi({ snapshot: vi.fn().mockResolvedValue(favoriteSnapshot()) })

    await useTagStore.getState().load()

    expect(useTagStore.getState()).toMatchObject({
      status: 'ready',
      revision: 1,
      tags: [expect.objectContaining({ systemKey: 'favorite' })]
    })
  })

  it('replaces local state with each mutation result', async () => {
    const result: TagSnapshot = {
      ...favoriteSnapshot(2),
      tags: [
        ...favoriteSnapshot().tags,
        {
          id: 'tag-methods',
          name: 'Methods',
          iconKey: 'flask-conical',
          colorKey: 'green',
          createdAt: 2,
          updatedAt: 2
        }
      ]
    }
    const create = vi.fn().mockResolvedValue(result)
    setTagsApi({ create })

    await useTagStore
      .getState()
      .create({ name: 'Methods', iconKey: 'flask-conical', colorKey: 'green' })

    expect(create).toHaveBeenCalledWith({
      name: 'Methods',
      iconKey: 'flask-conical',
      colorKey: 'green'
    })
    expect(useTagStore.getState()).toMatchObject({ revision: 2, tags: result.tags })
  })

  it('does not let an older in-flight load overwrite a completed mutation', async () => {
    let resolveLoad: ((value: TagSnapshot) => void) | undefined
    const pendingLoad = new Promise<TagSnapshot>((resolve) => {
      resolveLoad = resolve
    })
    const mutationResult: TagSnapshot = {
      ...favoriteSnapshot(2),
      tags: [
        ...favoriteSnapshot().tags,
        {
          id: 'tag-methods',
          name: 'Methods',
          iconKey: 'flask-conical',
          colorKey: 'green',
          createdAt: 2,
          updatedAt: 2
        }
      ]
    }
    setTagsApi({
      snapshot: vi.fn(() => pendingLoad),
      create: vi.fn().mockResolvedValue(mutationResult)
    })
    useTagStore.setState({ ...favoriteSnapshot(1), status: 'ready' })

    const load = useTagStore.getState().load()
    await useTagStore
      .getState()
      .create({ name: 'Methods', iconKey: 'flask-conical', colorKey: 'green' })
    resolveLoad?.(favoriteSnapshot(1))
    await load

    expect(useTagStore.getState()).toMatchObject({
      status: 'ready',
      revision: 2,
      tags: mutationResult.tags
    })
  })

  it('does not let an older mutation response overwrite a newer revision', async () => {
    let resolveOlder: ((snapshot: TagSnapshot) => void) | undefined
    const olderResponse = new Promise<TagSnapshot>((resolve) => {
      resolveOlder = resolve
    })
    const initialTags: TagSnapshot['tags'] = [
      ...favoriteSnapshot().tags,
      {
        id: 'tag-a',
        name: 'A',
        iconKey: 'tag',
        colorKey: 'blue',
        createdAt: 2,
        updatedAt: 2
      },
      {
        id: 'tag-b',
        name: 'B',
        iconKey: 'tag',
        colorKey: 'blue',
        createdAt: 3,
        updatedAt: 3
      }
    ]
    const olderSnapshot: TagSnapshot = {
      revision: 2,
      tags: initialTags.map((tag) =>
        tag.id === 'tag-a' ? { ...tag, name: 'Updated A', updatedAt: 4 } : tag
      ),
      assignments: []
    }
    const newerSnapshot: TagSnapshot = {
      revision: 3,
      tags: olderSnapshot.tags.map((tag) =>
        tag.id === 'tag-b' ? { ...tag, name: 'Updated B', updatedAt: 5 } : tag
      ),
      assignments: []
    }
    setTagsApi({
      update: vi.fn().mockReturnValueOnce(olderResponse).mockResolvedValueOnce(newerSnapshot)
    })
    useTagStore.setState({ ...favoriteSnapshot(1), tags: initialTags, status: 'ready' })

    const older = useTagStore.getState().update({
      id: 'tag-a',
      name: 'Updated A',
      iconKey: 'tag',
      colorKey: 'blue',
      expectedUpdatedAt: 2
    })
    await useTagStore.getState().update({
      id: 'tag-b',
      name: 'Updated B',
      iconKey: 'tag',
      colorKey: 'blue',
      expectedUpdatedAt: 3
    })
    resolveOlder?.(olderSnapshot)
    await older

    const state = useTagStore.getState()
    const tagB = state.tags.find((tag) => tag.id === 'tag-b')
    expect({
      revision: state.revision,
      tagBName: tagB && 'name' in tagB ? tagB.name : undefined
    }).toEqual({ revision: 3, tagBName: 'Updated B' })
  })

  it('ignores a load snapshot older than the current store revision', async () => {
    setTagsApi({ snapshot: vi.fn().mockResolvedValue(favoriteSnapshot(1)) })
    useTagStore.setState({ ...favoriteSnapshot(2), status: 'ready' })

    await useTagStore.getState().load()

    expect(useTagStore.getState()).toMatchObject({ status: 'ready', revision: 2 })
  })

  it('reloads only for a newer cross-renderer revision', async () => {
    let listener: ((event: { revision: number }) => void) | undefined
    const snapshot = vi.fn().mockResolvedValue(favoriteSnapshot(3))
    setTagsApi({
      snapshot,
      onChanged: vi.fn((next) => {
        listener = next
        return () => undefined
      })
    })
    useTagStore.setState({ ...favoriteSnapshot(2), status: 'ready' })
    useTagStore.getState().listen()

    listener?.({ revision: 2 })
    expect(snapshot).not.toHaveBeenCalled()
    listener?.({ revision: 3 })
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1))
    expect(useTagStore.getState().revision).toBe(3)
  })

  it('rolls back a failed optimistic assignment to the authoritative snapshot', async () => {
    const snapshot = vi.fn().mockResolvedValue(favoriteSnapshot(2))
    setTagsApi({
      snapshot,
      setAssignment: vi.fn().mockRejectedValue(new Error('failed'))
    })
    useTagStore.setState({ ...favoriteSnapshot(1), status: 'ready' })

    const mutation = useTagStore.getState().setAssignment({
      tagId: 'tag-favorite',
      resourceType: 'catalog.skill',
      resourceId: 'analysis',
      assigned: true
    })
    expect(useTagStore.getState().assignments).toHaveLength(1)
    await expect(mutation).rejects.toThrow('failed')

    expect(snapshot).toHaveBeenCalledOnce()
    expect(useTagStore.getState()).toMatchObject({ revision: 2, assignments: [] })
  })

  it('keeps a newer committed assignment when an older mutation and recovery load fail', async () => {
    const older = Promise.withResolvers<TagSnapshot>()
    const committed: TagSnapshot = {
      ...favoriteSnapshot(2),
      assignments: [
        {
          tagId: 'tag-favorite',
          resourceType: 'catalog.skill',
          resourceId: 'newer-skill',
          createdAt: 2
        }
      ]
    }
    const snapshot = vi.fn().mockRejectedValue(new Error('offline'))
    setTagsApi({
      snapshot,
      setAssignment: vi.fn().mockReturnValueOnce(older.promise).mockResolvedValueOnce(committed)
    })
    useTagStore.setState({ ...favoriteSnapshot(1), status: 'ready' })

    const first = useTagStore.getState().setAssignment({
      tagId: 'tag-favorite',
      resourceType: 'catalog.skill',
      resourceId: 'older-skill',
      assigned: true
    })
    const rejected = expect(first).rejects.toThrow('older mutation failed')
    await useTagStore.getState().setAssignment({
      tagId: 'tag-favorite',
      resourceType: 'catalog.skill',
      resourceId: 'newer-skill',
      assigned: true
    })
    const pendingResourceIds = useTagStore.getState().assignments.map((item) => item.resourceId)
    older.reject(new Error('older mutation failed'))
    await rejected

    // An unrelated success must keep the older request visible until it settles.
    expect(pendingResourceIds).toEqual(['newer-skill', 'older-skill'])
    expect(snapshot).toHaveBeenCalledOnce()
    expect(useTagStore.getState()).toMatchObject({
      revision: 2,
      assignments: committed.assignments
    })
  })

  it('optimistically reorders custom Tags while keeping the system Tag first', async () => {
    const tags: TagSnapshot['tags'] = [
      ...favoriteSnapshot().tags,
      {
        id: 'tag-a',
        name: 'A',
        iconKey: 'tag',
        colorKey: 'blue',
        createdAt: 2,
        updatedAt: 2
      },
      {
        id: 'tag-b',
        name: 'B',
        iconKey: 'tag',
        colorKey: 'green',
        createdAt: 3,
        updatedAt: 3
      }
    ]
    let resolveReorder: ((snapshot: TagSnapshot) => void) | undefined
    const pending = new Promise<TagSnapshot>((resolve) => {
      resolveReorder = resolve
    })
    const reorder = vi.fn(() => pending)
    setTagsApi({ reorder })
    useTagStore.setState({ ...favoriteSnapshot(1), tags, status: 'ready' })

    const mutation = useTagStore.getState().reorder({ tagIds: ['tag-b', 'tag-a'] })
    expect(useTagStore.getState().tags.map((tag) => tag.id)).toEqual([
      'tag-favorite',
      'tag-b',
      'tag-a'
    ])
    resolveReorder?.({ ...favoriteSnapshot(2), tags: [tags[0]!, tags[2]!, tags[1]!] })
    await mutation
    expect(reorder).toHaveBeenCalledWith({ tagIds: ['tag-b', 'tag-a'] })
    expect(useTagStore.getState().revision).toBe(2)
  })

  it('does not restore a deleted Tag when an older reorder and recovery load fail', async () => {
    const older = Promise.withResolvers<TagSnapshot>()
    const initial: TagSnapshot = {
      ...favoriteSnapshot(1),
      tags: [
        ...favoriteSnapshot().tags,
        {
          id: 'tag-methods',
          name: 'Methods',
          iconKey: 'flask-conical',
          colorKey: 'green',
          createdAt: 1,
          updatedAt: 1
        }
      ]
    }
    const committed = favoriteSnapshot(2)
    setTagsApi({
      snapshot: vi.fn().mockRejectedValue(new Error('offline')),
      reorder: vi.fn().mockReturnValue(older.promise),
      delete: vi.fn().mockResolvedValue(committed)
    })
    useTagStore.setState({ ...initial, status: 'ready' })

    const first = useTagStore.getState().reorder({ tagIds: ['tag-methods'] })
    const rejected = expect(first).rejects.toThrow('older reorder failed')
    await useTagStore.getState().delete('tag-methods')
    expect(useTagStore.getState().tags).toEqual(committed.tags)
    older.reject(new Error('older reorder failed'))
    await rejected

    expect(useTagStore.getState()).toMatchObject({ revision: 2, tags: committed.tags })
  })

  it('reloads the authoritative Tag order after a failed optimistic reorder', async () => {
    const authoritative = favoriteSnapshot(2)
    const snapshot = vi.fn().mockResolvedValue(authoritative)
    setTagsApi({
      reorder: vi.fn().mockRejectedValue(new Error('failed')),
      snapshot
    })
    useTagStore.setState({
      ...favoriteSnapshot(1),
      status: 'ready',
      tags: [
        ...favoriteSnapshot().tags,
        {
          id: 'tag-a',
          name: 'A',
          iconKey: 'tag',
          colorKey: 'blue',
          createdAt: 2,
          updatedAt: 2
        }
      ]
    })

    await expect(useTagStore.getState().reorder({ tagIds: ['tag-a'] })).rejects.toThrow('failed')
    expect(snapshot).toHaveBeenCalledOnce()
    expect(useTagStore.getState()).toMatchObject(authoritative)
  })
  it.each(['older-first', 'newer-first'])(
    'removes failed optimistic assignments when both writes and recovery fail (%s)',
    async (order) => {
      const older = Promise.withResolvers<TagSnapshot>()
      const newer = Promise.withResolvers<TagSnapshot>()
      setTagsApi({
        snapshot: vi.fn().mockRejectedValue(new Error('offline')),
        setAssignment: vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
      })
      useTagStore.setState({ ...favoriteSnapshot(1), status: 'ready' })
      const first = useTagStore.getState().setAssignment({
        tagId: 'tag-favorite',
        resourceType: 'catalog.skill',
        resourceId: 'older',
        assigned: true
      })
      const firstRejected = expect(first).rejects.toThrow('failed')
      const second = useTagStore.getState().setAssignment({
        tagId: 'tag-favorite',
        resourceType: 'catalog.skill',
        resourceId: 'newer',
        assigned: true
      })
      const secondRejected = expect(second).rejects.toThrow('failed')
      if (order === 'older-first') {
        older.reject(new Error('failed'))
        await firstRejected
        const pendingIds = useTagStore.getState().assignments.map((a) => a.resourceId)
        newer.reject(new Error('failed'))
        await secondRejected
        expect(pendingIds).toContain('newer')
      } else {
        newer.reject(new Error('failed'))
        await secondRejected
        expect(useTagStore.getState().assignments.map((a) => a.resourceId)).toEqual(['older'])
        older.reject(new Error('failed'))
        await firstRejected
      }
      expect(useTagStore.getState()).toMatchObject({
        revision: 1,
        assignments: [],
        status: 'error'
      })
    }
  )

  it('keeps a snapshot delivered by a changed event when an older assignment fails', async () => {
    const older = Promise.withResolvers<TagSnapshot>()
    let listener: ((event: { revision: number }) => void) | undefined
    const committed = {
      ...favoriteSnapshot(2),
      assignments: [
        {
          tagId: 'tag-favorite',
          resourceType: 'catalog.skill' as const,
          resourceId: 'remote',
          createdAt: 2
        }
      ]
    }
    setTagsApi({
      snapshot: vi
        .fn()
        .mockResolvedValueOnce(committed)
        .mockRejectedValueOnce(new Error('offline')),
      setAssignment: vi.fn().mockReturnValue(older.promise),
      onChanged: vi.fn((next) => {
        listener = next
        return () => undefined
      })
    })
    useTagStore.setState({ ...favoriteSnapshot(1), status: 'ready' })
    const stop = useTagStore.getState().listen()
    const pending = useTagStore.getState().setAssignment({
      tagId: 'tag-favorite',
      resourceType: 'catalog.skill',
      resourceId: 'older',
      assigned: true
    })
    const rejected = expect(pending).rejects.toThrow('failed')
    listener?.({ revision: 2 })
    await vi.waitFor(() => expect(useTagStore.getState().revision).toBe(2))
    older.reject(new Error('failed'))
    await rejected
    expect(useTagStore.getState().assignments).toEqual(committed.assignments)
    stop()
  })
  it.each(['older-first', 'newer-first'])(
    'restores the accepted order after overlapping reorders both fail (%s)',
    async (order) => {
      const older = Promise.withResolvers<TagSnapshot>()
      const newer = Promise.withResolvers<TagSnapshot>()
      const tags: TagSnapshot['tags'] = [
        ...favoriteSnapshot().tags,
        ...['a', 'b', 'c'].map((id) => ({
          id,
          name: id,
          iconKey: 'tag' as const,
          colorKey: 'blue' as const,
          createdAt: 1,
          updatedAt: 1
        }))
      ]
      setTagsApi({
        snapshot: vi.fn().mockRejectedValue(new Error('offline')),
        reorder: vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
      })
      useTagStore.setState({ ...favoriteSnapshot(1), tags, status: 'ready' })
      const first = useTagStore.getState().reorder({ tagIds: ['b', 'a', 'c'] })
      const firstRejected = expect(first).rejects.toThrow('failed')
      const second = useTagStore.getState().reorder({ tagIds: ['c', 'b', 'a'] })
      const secondRejected = expect(second).rejects.toThrow('failed')
      if (order === 'older-first') {
        older.reject(new Error('failed'))
        await firstRejected
        const pendingIds = useTagStore.getState().tags.map((tag) => tag.id)
        newer.reject(new Error('failed'))
        await secondRejected
        expect(pendingIds).toEqual(['tag-favorite', 'c', 'b', 'a'])
      } else {
        newer.reject(new Error('failed'))
        await secondRejected
        older.reject(new Error('failed'))
        await firstRejected
      }
      expect(useTagStore.getState().tags).toEqual(tags)
    }
  )
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
  const tag = (revision: number, name: string): TagSnapshot => ({
    revision,
    tags: [
      { id: 'tag-1', name, iconKey: 'tag', colorKey: 'gray', createdAt: 1, updatedAt: revision }
    ],
    assignments: []
  })

  it.each(['create', 'update', 'delete', 'reorder', 'setAssignment'] as const)(
    'keeps the newer event read after a stale %s reply',
    async (operation) => {
      useTagStore.setState({
        ...createInitialTagState(),
        ...tag(1, 'initial'),
        status: 'ready'
      } as never)
      const write = deferred<ReturnType<typeof tag>>()
      const read = deferred<ReturnType<typeof tag>>()
      const intermediate = deferred<ReturnType<typeof tag>>()
      let changed!: (event: { revision: number }) => void
      vi.stubGlobal('window', {
        api: {
          tags: {
            [operation]: () => write.promise,
            snapshot: vi
              .fn()
              .mockReturnValueOnce(intermediate.promise)
              .mockReturnValueOnce(read.promise),
            onChanged: (fn: (event: { revision: number }) => void) => {
              changed = fn
              return () => {}
            }
          }
        }
      })
      const store = useTagStore.getState()
      const saving =
        operation === 'create'
          ? store.create({ name: 'local', iconKey: 'tag', colorKey: 'gray' })
          : operation === 'update'
            ? store.update({
                id: 'tag-1',
                name: 'local',
                iconKey: 'tag',
                colorKey: 'gray',
                expectedUpdatedAt: 1
              })
            : operation === 'delete'
              ? store.delete('tag-1')
              : operation === 'reorder'
                ? store.reorder({ tagIds: ['tag-1'] })
                : store.setAssignment({
                    tagId: 'tag-1',
                    resourceType: 'catalog.skill',
                    resourceId: 'skill-1',
                    assigned: true
                  })
      const remove = useTagStore.getState().listen()
      changed({ revision: 3 })
      intermediate.resolve(tag(3, 'remote-3'))
      await intermediate.promise
      await Promise.resolve()
      expect(useTagStore.getState().revision).toBe(3)
      changed({ revision: 4 })
      write.resolve(tag(2, 'local'))
      await saving
      read.resolve(tag(4, 'remote-4'))
      await read.promise
      await Promise.resolve()
      expect(useTagStore.getState()).toMatchObject({
        revision: 4,
        tags: [{ name: 'remote-4' }],
        status: 'ready'
      })
      remove()
    }
  )
})

it('retains a newer event read even when the command reply is still acceptable', async () => {
  let changed!: (event: { revision: number }) => void
  let resolveRead!: (snapshot: TagSnapshot) => void
  let resolveWrite!: (snapshot: TagSnapshot) => void
  setTagsApi({
    onChanged: vi.fn((listener) => {
      changed = listener
      return () => undefined
    }),
    update: vi.fn(
      () =>
        new Promise<TagSnapshot>((resolve) => {
          resolveWrite = resolve
        })
    ),
    snapshot: vi.fn(
      () =>
        new Promise<TagSnapshot>((resolve) => {
          resolveRead = resolve
        })
    )
  })
  useTagStore.setState({ ...favoriteSnapshot(1), status: 'ready' })
  const remove = useTagStore.getState().listen()
  const saving = useTagStore
    .getState()
    .update({ id: 'custom', name: 'local', iconKey: 'tag', colorKey: 'gray', expectedUpdatedAt: 1 })
  changed({ revision: 3 })
  resolveWrite(favoriteSnapshot(2))
  await saving
  resolveRead(favoriteSnapshot(3))
  await Promise.resolve()
  await Promise.resolve()
  remove()
  expect(useTagStore.getState().revision).toBe(3)
})

it('keeps a committed mutation ready when an earlier load rejects', async () => {
  let rejectRead!: (error: Error) => void
  const tag = {
    id: 'custom-tag',
    name: 'Original',
    iconKey: 'tag' as const,
    colorKey: 'gray' as const,
    createdAt: 1,
    updatedAt: 1
  }
  setTagsApi({
    snapshot: vi.fn(
      () =>
        new Promise<TagSnapshot>((_, reject) => {
          rejectRead = reject
        })
    ),
    delete: vi.fn().mockResolvedValue(favoriteSnapshot(2))
  })
  useTagStore.setState({ ...favoriteSnapshot(1), tags: [tag], status: 'ready' })
  const reading = useTagStore.getState().load()
  await useTagStore.getState().delete(tag.id)
  rejectRead(new Error('earlier read failed'))
  await reading
  expect(useTagStore.getState()).toMatchObject({ revision: 2, status: 'ready', error: undefined })
})
