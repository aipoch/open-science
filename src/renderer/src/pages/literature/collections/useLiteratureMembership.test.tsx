// @vitest-environment jsdom
import { act, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createLiteratureDetailController } from '@aipoch/literature-library/client'
import {
  literatureItemViewSchema,
  type LiteratureCatalogCommand,
  type LiteratureCatalogReceipt
} from '@aipoch/literature-library/contracts'
import { createLiteratureTestRenderer } from '../../../../../../test/renderer/literature'
import { createLiteratureSelectionStore } from '../list/literature-selection'
import { useLiteratureMembership } from './useLiteratureMembership'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const ids = Array.from({ length: 201 }, (_, i) => `item-${i}`)
const linked: LiteratureCatalogReceipt = { kind: 'item', id: ids[0], state: 'linked' }
const created: LiteratureCatalogReceipt = { kind: 'collection', id: 'target' }

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Keep the inferred hook result and typed Vitest mocks.
function mountMembership() {
  const transact = vi.fn<(command: LiteratureCatalogCommand) => Promise<LiteratureCatalogReceipt>>()
  vi.stubGlobal('api', { literature: { transact } })
  const { renderHook } = createLiteratureTestRenderer({ api: window.api })
  const selectionStore = createLiteratureSelectionStore()
  selectionStore.replace(ids)
  const detailController = createLiteratureDetailController(async (id) =>
    literatureItemViewSchema.parse({
      id,
      item: { itemType: 'journalArticle', title: id },
      attachments: [],
      projectIds: [],
      collectionIds: [],
      metadataRevision: 1,
      createdAt: 1,
      updatedAt: 1
    })
  )
  const props = {
    collectionId: 'source',
    linkScopeRef: { current: 'source' },
    selectionStore,
    detailController,
    isBatching: false,
    setIsBatching: vi.fn(),
    setError: vi.fn(),
    resolveSelectedItemIds: async () => [...selectionStore.getSnapshot().selectedIds],
    loadEntries: vi.fn().mockResolvedValue(true),
    loadCollections: vi.fn().mockResolvedValue(undefined),
    loadProjectCounts: vi.fn().mockResolvedValue(undefined)
  }
  const { result, rerender } = renderHook(() =>
    useLiteratureMembership({ ...props, entriesKey: props.linkScopeRef.current })
  )
  return { props, result, rerender, transact }
}

it.each(['project', 'new collection'] as const)(
  'retries only uncommitted %s memberships using the original destination',
  async (destination) => {
    const { result, transact, props } = mountMembership()
    // Fail the second project batch or the first membership batch after creating a collection.
    transact
      .mockResolvedValueOnce(destination === 'project' ? linked : created)
      .mockRejectedValueOnce(new Error('Batch failed'))
      .mockResolvedValue(linked)
    await act(async () => {
      if (destination === 'project') await result.current.addSelectedItemsToProject('target')
      else expect(await result.current.createCollectionForSelection('Target')).toBe(true)
    })
    const failure = result.current.linkFailure!
    const command =
      destination === 'project'
        ? { kind: 'set-project-items', projectId: 'target', included: true, source: 'library' }
        : {
            kind: 'move-collection-items',
            sourceCollectionId: 'source',
            targetCollectionId: 'target'
          }
    const completed = destination === 'project' ? 200 : 0
    expect(failure).toEqual({
      command,
      itemIds: ids.slice(completed),
      completed,
      skipped: 0,
      scopeKey: 'source'
    })
    expect([...props.selectionStore.getSnapshot().selectedIds]).toEqual(failure.itemIds)
    expect(props.loadEntries).toHaveBeenCalledWith(true)
    expect(props.loadProjectCounts).toHaveBeenCalledOnce()
    const firstBatch = { ...command, itemIds: ids.slice(0, 200) }
    const lastBatch = { ...command, itemIds: ids.slice(200) }
    await act(() =>
      result.current.runLinkBatch(
        failure.command,
        failure.itemIds,
        failure.completed,
        failure.skipped,
        true
      )
    )
    expect(transact.mock.calls.map(([call]) => call)).toEqual(
      destination === 'project'
        ? [firstBatch, lastBatch, lastBatch]
        : [{ kind: 'create-collection', name: 'Target' }, firstBatch, firstBatch, lastBatch]
    )
    expect(props.selectionStore.getSnapshot().selectedIds.size).toBe(0)
    expect(result.current.linkFailure).toBeUndefined()
    expect(props.loadProjectCounts).toHaveBeenCalledTimes(2)
  }
)

it('finishes the original move after navigation without clearing or refreshing the new selection', async () => {
  const { result, rerender, transact, props } = mountMembership()
  const pending = Promise.withResolvers<LiteratureCatalogReceipt>()
  const started = Promise.withResolvers<void>()
  transact
    .mockImplementationOnce(() => {
      started.resolve()
      return pending.promise
    })
    .mockResolvedValue(linked)
  await act(async () => {
    const moving = result.current.moveSelectedItems('target')
    await started.promise
    props.linkScopeRef.current = 'new scope'
    props.selectionStore.replace(['new item'])
    rerender()
    pending.resolve(linked)
    await moving
  })
  const move = {
    kind: 'move-collection-items',
    sourceCollectionId: 'source',
    targetCollectionId: 'target'
  }
  expect(transact.mock.calls.map(([call]) => call)).toEqual([
    { ...move, itemIds: ids.slice(0, 200) },
    { ...move, itemIds: ids.slice(200) }
  ])
  expect([...props.selectionStore.getSnapshot().selectedIds]).toEqual(['new item'])
  expect(props.loadEntries).not.toHaveBeenCalled()
  expect(props.loadCollections).toHaveBeenCalledOnce()
  expect(props.loadProjectCounts).toHaveBeenCalledOnce()
})
