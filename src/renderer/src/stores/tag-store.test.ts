import { beforeEach, describe, expect, it, vi } from 'vitest'

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
})
