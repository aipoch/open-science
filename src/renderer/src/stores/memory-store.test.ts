import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MemorySnapshot } from '../../../shared/memory'
import { createInitialMemoryState, useMemoryStore } from './memory-store'

const snapshot = (revision = 1): MemorySnapshot => ({
  revision,
  enabled: false,
  categories: [
    {
      id: 'memory-category-about-you',
      systemKey: 'about-you',
      autoRecall: true,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      entries: []
    }
  ],
  projects: []
})

const setMemoryApi = (api: Partial<Window['api']['memory']>): void => {
  ;(globalThis as unknown as { window: { api: { memory: unknown } } }).window = {
    api: { memory: api }
  } as never
}

beforeEach(() => useMemoryStore.setState(createInitialMemoryState()))

describe('memory store', () => {
  it('hydrates and selects About you', async () => {
    setMemoryApi({ snapshot: vi.fn().mockResolvedValue(snapshot()) })

    await useMemoryStore.getState().load()

    expect(useMemoryStore.getState()).toMatchObject({
      status: 'ready',
      selectedCategoryId: 'memory-category-about-you',
      revision: 1
    })
  })

  it('keeps a mutation snapshot ahead of an older in-flight load', async () => {
    let resolveLoad: ((value: MemorySnapshot) => void) | undefined
    const pendingLoad = new Promise<MemorySnapshot>((resolve) => {
      resolveLoad = resolve
    })
    const updated = { ...snapshot(2), enabled: true }
    setMemoryApi({
      snapshot: vi.fn(() => pendingLoad),
      setEnabled: vi.fn().mockResolvedValue(updated)
    })

    const load = useMemoryStore.getState().load()
    await useMemoryStore.getState().setEnabled(true)
    resolveLoad?.(snapshot(1))
    await load

    expect(useMemoryStore.getState()).toMatchObject({ revision: 2, enabled: true })
  })

  it('finishes loading without replacing a newer snapshot with an older revision', async () => {
    setMemoryApi({
      snapshot: vi.fn().mockResolvedValueOnce(snapshot(3)).mockResolvedValueOnce(snapshot(2))
    })

    await useMemoryStore.getState().load()
    await useMemoryStore.getState().load()

    expect(useMemoryStore.getState()).toMatchObject({ ...snapshot(3), status: 'ready' })
  })

  it('keeps a newer load snapshot when an older mutation response arrives last', async () => {
    let resolveMutation!: (value: MemorySnapshot) => void
    const pendingMutation = new Promise<MemorySnapshot>((resolve) => {
      resolveMutation = resolve
    })
    setMemoryApi({
      snapshot: vi.fn().mockResolvedValueOnce(snapshot(1)).mockResolvedValueOnce(snapshot(3)),
      setEnabled: vi.fn(() => pendingMutation)
    })
    await useMemoryStore.getState().load()

    const mutation = useMemoryStore.getState().setEnabled(true)
    await useMemoryStore.getState().load()
    expect(useMemoryStore.getState()).toMatchObject({ revision: 3, enabled: false })
    resolveMutation({ ...snapshot(2), enabled: true })
    await mutation

    expect(useMemoryStore.getState()).toMatchObject({
      revision: 3,
      enabled: false,
      status: 'ready'
    })
  })

  it('allows a pending newer load to finish after a stale mutation response', async () => {
    let resolveMutation!: (value: MemorySnapshot) => void
    let resolveLoad!: (value: MemorySnapshot) => void
    const pendingMutation = new Promise<MemorySnapshot>((resolve) => {
      resolveMutation = resolve
    })
    const pendingLoad = new Promise<MemorySnapshot>((resolve) => {
      resolveLoad = resolve
    })
    setMemoryApi({
      snapshot: vi.fn().mockResolvedValueOnce(snapshot(3)).mockReturnValueOnce(pendingLoad),
      setEnabled: vi.fn(() => pendingMutation)
    })
    const mutation = useMemoryStore.getState().setEnabled(true)
    await useMemoryStore.getState().load()
    const load = useMemoryStore.getState().load()

    resolveMutation({ ...snapshot(2), enabled: true })
    await mutation
    resolveLoad(snapshot(4))
    await load

    expect(useMemoryStore.getState()).toMatchObject({
      revision: 4,
      enabled: false,
      status: 'ready'
    })
  })

  it.each([
    ['Mine', 'Mine'],
    ['　Ｍｉｎｅ \t Notes　', 'Mine Notes']
  ])(
    'returns and selects %s when another window also created a category',
    async (name, storedName) => {
      let resolveCreate!: (value: MemorySnapshot) => void
      const pendingCreate = new Promise<MemorySnapshot>((resolve) => {
        resolveCreate = resolve
      })
      setMemoryApi({
        snapshot: vi.fn().mockResolvedValue(snapshot(1)),
        createCategory: vi.fn(() => pendingCreate)
      })
      await useMemoryStore.getState().load()

      const creation = useMemoryStore.getState().createCategory({
        name,
        guidance: '',
        autoRecall: false
      })
      resolveCreate({
        ...snapshot(3),
        categories: [
          ...snapshot().categories,
          ...[
            { id: 'other', name: 'Other' },
            { id: 'mine', name: storedName }
          ].map((category, index) => ({
            ...category,
            guidance: '',
            autoRecall: false,
            revision: 1,
            createdAt: index + 2,
            updatedAt: index + 2,
            entries: []
          }))
        ]
      })

      expect.soft(await creation).toBe('mine')
      expect(useMemoryStore.getState().selectedCategoryId).toBe('mine')
    }
  )

  it('does not select a created category already removed by a newer snapshot', async () => {
    let resolveCreate!: (value: MemorySnapshot) => void
    const pendingCreate = new Promise<MemorySnapshot>((resolve) => {
      resolveCreate = resolve
    })
    setMemoryApi({
      snapshot: vi.fn().mockResolvedValueOnce(snapshot(1)).mockResolvedValueOnce(snapshot(3)),
      createCategory: vi.fn(() => pendingCreate)
    })
    await useMemoryStore.getState().load()
    const creation = useMemoryStore.getState().createCategory({
      name: 'Mine',
      guidance: '',
      autoRecall: false
    })
    await useMemoryStore.getState().load()
    resolveCreate({
      ...snapshot(2),
      categories: [
        ...snapshot().categories,
        {
          id: 'mine',
          name: 'Mine',
          guidance: '',
          autoRecall: false,
          revision: 1,
          createdAt: 2,
          updatedAt: 2,
          entries: []
        }
      ]
    })

    expect(await creation).toBe('mine')
    expect(useMemoryStore.getState()).toMatchObject({
      ...snapshot(3),
      selectedCategoryId: 'memory-category-about-you'
    })
  })

  it('reloads only when another renderer announces a newer revision', async () => {
    let listener: ((event: { revision: number }) => void) | undefined
    const read = vi.fn().mockResolvedValue(snapshot(3))
    setMemoryApi({
      snapshot: read,
      onChanged: vi.fn((next) => {
        listener = next
        return () => undefined
      })
    })
    useMemoryStore.setState({
      ...snapshot(2),
      status: 'ready',
      selectedCategoryId: undefined,
      selectedProjectId: 'project-deleted',
      projects: [
        {
          projectId: 'project-deleted',
          name: 'Deleted project',
          archived: false,
          entries: []
        }
      ]
    })
    useMemoryStore.getState().listen()

    listener?.({ revision: 2 })
    expect(read).not.toHaveBeenCalled()
    listener?.({ revision: 3 })
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    await vi.waitFor(() =>
      expect(useMemoryStore.getState()).toMatchObject({
        revision: 3,
        projects: [],
        selectedCategoryId: 'memory-category-about-you',
        selectedProjectId: undefined
      })
    )
  })

  it('preserves a selected project container across snapshots and falls back when it disappears', async () => {
    const withProject: MemorySnapshot = {
      ...snapshot(2),
      projects: [
        {
          projectId: 'project-a',
          name: 'Project A',
          archived: false,
          entries: []
        }
      ]
    }
    setMemoryApi({ snapshot: vi.fn().mockResolvedValue(withProject) })

    await useMemoryStore.getState().load()
    useMemoryStore.getState().selectProject('project-a')
    expect(useMemoryStore.getState()).toMatchObject({
      selectedCategoryId: undefined,
      selectedProjectId: 'project-a'
    })

    setMemoryApi({ snapshot: vi.fn().mockResolvedValue({ ...snapshot(3), projects: [] }) })
    await useMemoryStore.getState().load()

    expect(useMemoryStore.getState()).toMatchObject({
      selectedCategoryId: 'memory-category-about-you',
      selectedProjectId: undefined
    })
  })
})
