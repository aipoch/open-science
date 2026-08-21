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
  ]
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
    useMemoryStore.setState({ ...snapshot(2), status: 'ready' })
    useMemoryStore.getState().listen()

    listener?.({ revision: 2 })
    expect(read).not.toHaveBeenCalled()
    listener?.({ revision: 3 })
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
  })
})
