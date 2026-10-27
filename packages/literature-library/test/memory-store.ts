/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test fixtures retain inferred mock types. */
import type {
  LibraryTransaction,
  normalizedIdentifiers,
  CandidateRecord,
  LibraryStore,
  MetadataReceipt
} from '../src/index.js'
import type {
  literatureItemInputSchema,
  LiteratureItemInput,
  LiteratureItemView
} from '../src/contracts.js'
export function memoryLibrary(runtime: {
  LibraryTransaction: typeof LibraryTransaction
  normalizedIdentifiers: typeof normalizedIdentifiers
  literatureItemInputSchema: typeof literatureItemInputSchema
}) {
  const view = (id: string, input: LiteratureItemInput, time: number): LiteratureItemView => ({
    id,
    item: runtime.literatureItemInputSchema.parse(input),
    attachments: [],
    collectionIds: [],
    projectIds: [],
    readingStatus: 'unread',
    metadataRevision: 1,
    createdAt: time,
    updatedAt: time
  })
  let state = {
    serial: 0,
    items: new Map<string, LiteratureItemView>(),
    collections: new Map<
      string,
      {
        id: string
        name: string
        description: string
        revision: number
        parentId?: string
        sortOrder: number
        smart: boolean
        members: Map<string, number>
      }
    >(),
    candidates: new Map<string, CandidateRecord & { key: string }>(),
    receipts: new Map<string, MetadataReceipt>(),
    sources: [] as { itemId?: string; candidateId?: string; source: unknown }[],
    projects: new Set(['project']),
    overrides: [] as { itemId: string; collectionId: string; decision: string }[],
    invalidated: [] as string[],
    attachmentTransfers: [] as string[],
    protectedAttachments: new Set<string>()
  }
  const id = (): string => `id-${++state.serial}`
  const match = (identifiers: Parameters<LibraryStore['identityMatches']>[0]) =>
    [...state.items.values()].filter(
      (row) =>
        !row.mergedIntoItemId &&
        runtime
          .normalizedIdentifiers(row.item.identifiers)
          .some((other) =>
            identifiers.some(
              (value) =>
                value.scheme === other.scheme && value.normalizedValue === other.normalizedValue
            )
          )
    )
  const store: LibraryStore = {
    identityMatches: async (identifiers) =>
      match(identifiers)
        .sort(
          (a, b) =>
            Number(Boolean(a.deletedAt)) - Number(Boolean(b.deletedAt)) ||
            a.createdAt - b.createdAt ||
            a.id.localeCompare(b.id)
        )
        .map((row) => ({
          id: row.id,
          identifiers: runtime.normalizedIdentifiers(row.item.identifiers)
        })),
    importIdentityRecords: async (identifiers) =>
      match(identifiers).map((row) => ({ id: row.id, item: row.item })),
    collection: async (key) => {
      const row = state.collections.get(key)
      return row ? { id: row.id, smart: row.smart } : null
    },
    collectionState: async (key) => {
      const row = state.collections.get(key)
      return row
        ? {
            description: row.description,
            smart: row.smart
              ? { scopeKind: 'library', scopeId: null, evidenceMode: 'metadata' }
              : null
          }
        : null
    },
    lastCollectionOrder: async (key) =>
      Math.max(-1, ...state.collections.get(key)!.members.values()),
    lastSiblingOrder: async (parent) =>
      Math.max(
        -1,
        ...[...state.collections.values()]
          .filter((row) => row.parentId === parent)
          .map((row) => row.sortOrder)
      ),
    createCollection: async (input) => {
      const key = id()
      state.collections.set(key, {
        ...input,
        id: key,
        revision: 1,
        smart: false,
        members: new Map()
      })
      return key
    },
    updateCollection: async (key, revision, input) => {
      const row = state.collections.get(key)
      if (!row || row.revision !== revision) return 0
      Object.assign(row, input, { revision: revision + 1 })
      return 1
    },
    scopeAvailable: async (scope) =>
      scope.kind === 'library' ||
      (scope.kind === 'project' ? state.projects.has(scope.id) : state.collections.has(scope.id)),
    updateSmartCollection: async () => {
      throw new Error('Smart changes require an explicit fixture')
    },
    saveSmartRuleVersion: async () => {
      throw new Error('Smart history requires an explicit fixture')
    },
    removeCollection: async (key) => {
      state.collections.delete(key)
      for (const row of state.collections.values())
        if (row.parentId === key) {
          row.parentId = undefined
          row.revision++
        }
    },
    linkCollection: async (key, itemId, order) => {
      const row = state.collections.get(key)!
      if (!row.members.has(itemId)) row.members.set(itemId, order)
    },
    unlinkCollection: async (key, itemId) => {
      state.collections.get(key)?.members.delete(itemId)
    },
    createItem: async (input) => {
      const key = id()
      state.items.set(key, view(key, input, state.serial))
      return key
    },
    restoreItem: async (key) => {
      const row = state.items.get(key)
      if (row) delete row.deletedAt
    },
    item: async (key) => (state.items.get(key) ? structuredClone(state.items.get(key)) : undefined),
    replaceMetadata: async (key, revision, item) => {
      const row = state.items.get(key)
      if (!row || row.metadataRevision !== revision || row.deletedAt !== undefined)
        throw new Error('Literature Item revision conflict.')
      row.item = structuredClone(item)
      row.metadataRevision++
      row.updatedAt = ++state.serial
    },
    metadataReceipt: async (operation) => state.receipts.get(operation) ?? null,
    saveMetadataReceipt: async (operation, receipt) => {
      state.receipts.set(operation, structuredClone(receipt))
    },
    attachSource: async (source) => {
      state.sources.push(structuredClone(source))
    },
    candidate: async (key) => state.candidates.get(key) ?? null,
    candidateByKey: async (key) => {
      const row = [...state.candidates.values()].find((row) => row.key === key)
      return row
        ? {
            id: row.id,
            state: row.state,
            acceptedDeleted: Boolean(
              row.acceptedItemId && state.items.get(row.acceptedItemId)?.deletedAt
            )
          }
        : null
    },
    retireCandidateKey: async (key) => {
      state.candidates.get(key)!.key = `accepted:${key}`
    },
    createCandidate: async (key, _candidate, candidateJson) => {
      const existing = [...state.candidates.values()].find((row) => row.key === key)
      if (existing) return existing
      const row = {
        id: id(),
        key,
        candidateJson,
        state: 'pending',
        acceptedItemId: null,
        discoveries: []
      }
      state.candidates.set(row.id, row)
      return row
    },
    recordDiscovery: async (key, candidate) => {
      const row = state.candidates.get(key)!
      if (
        !row.discoveries.some(
          (d) =>
            d.projectId === (candidate.origin.projectId ?? null) &&
            d.origin === candidate.origin.kind
        )
      )
        row.discoveries.push({
          projectId: candidate.origin.projectId ?? null,
          origin: candidate.origin.kind
        })
    },
    stagePdf: async () => {
      throw new Error('PDF storage requires an explicit fixture')
    },
    attachProjectIfPresent: async (project, item) => {
      if (
        project &&
        state.projects.has(project) &&
        !state.items.get(item)!.projectIds.includes(project)
      )
        state.items.get(item)!.projectIds.push(project)
    },
    transferCandidateSources: async (candidateId, itemId) => {
      for (const source of state.sources)
        if (source.candidateId === candidateId) {
          delete source.candidateId
          source.itemId = itemId
        }
    },
    acceptCandidate: async (key, itemId) => {
      Object.assign(state.candidates.get(key)!, { state: 'accepted', acceptedItemId: itemId })
    },
    transferCandidatePdfs: async (key, item) => {
      state.attachmentTransfers.push(`${key}:${item}`)
    },
    changeCandidates: async (ids, from, to) => {
      let count = 0
      for (const key of ids) {
        const row = state.candidates.get(key)
        if (row?.state === from) {
          row.state = to
          count++
        }
      }
      return count
    },
    activeItemCount: async (ids) =>
      ids.filter((key) => {
        const row = state.items.get(key)
        return row && row.deletedAt === undefined && !row.mergedIntoItemId
      }).length,
    projectAvailable: async (key) => state.projects.has(key),
    linkProject: async (project, key) => {
      const row = state.items.get(key)!
      if (!row.projectIds.includes(project)) row.projectIds.push(project)
    },
    unlinkProject: async (project, ids) => {
      for (const key of ids) {
        const row = state.items.get(key)
        if (row) row.projectIds = row.projectIds.filter((p) => p !== project)
      }
    },
    setReadingStatus: async (ids, readingStatus) => {
      let count = 0
      for (const key of ids) {
        const row = state.items.get(key)
        if (row && row.deletedAt === undefined && !row.mergedIntoItemId) {
          row.readingStatus = readingStatus
          row.updatedAt = ++state.serial
          count++
        }
      }
      return count
    },
    setLifecycle: async (ids, lifecycle) => {
      let count = 0
      for (const key of ids) {
        const row = state.items.get(key)
        if (row && !row.mergedIntoItemId) {
          if (lifecycle === 'deleted') row.deletedAt = ++state.serial
          else delete row.deletedAt
          count++
        }
      }
      return count
    },
    invalidateAssessments: async (ids) => {
      state.invalidated.push(...ids)
    },
    mergeViews: async (ids) =>
      [...state.items.values()]
        .filter(
          (row) => ids.includes(row.id) && row.deletedAt === undefined && !row.mergedIntoItemId
        )
        .map((row) => structuredClone(row)),
    mergeOverrides: async (ids) => state.overrides.filter((row) => ids.includes(row.itemId)),
    prepareMerge: async (survivor, ids, decisions) => {
      for (const [collectionId, decision] of decisions) {
        state.overrides = state.overrides.filter(
          (row) => row.itemId !== survivor || row.collectionId !== collectionId
        )
        state.overrides.push({ itemId: survivor, collectionId, decision })
      }
      state.invalidated.push(survivor, ...ids)
      for (const key of ids) state.items.get(key)!.item.identifiers = []
    },
    moveMergedRelations: async (survivor, ids) => {
      for (const key of ids) {
        const row = state.items.get(key)!
        row.mergedIntoItemId = survivor
        row.deletedAt = ++state.serial
        for (const col of state.collections.values()) {
          const order = col.members.get(key)
          if (order !== undefined && !col.members.has(survivor)) col.members.set(survivor, order)
          col.members.delete(key)
        }
      }
      return false
    },
    deletionItems: async (ids) =>
      [...state.items.values()]
        .filter((row) => ids.includes(row.id))
        .map((row) => ({ id: row.id, deleted: row.deletedAt !== undefined })),
    mergedItemIds: async (ids) =>
      [...state.items.values()]
        .filter((row) => row.mergedIntoItemId && ids.includes(row.mergedIntoItemId))
        .map((row) => row.id),
    attachmentIds: async (ids) =>
      ids.flatMap((key) => state.items.get(key)?.attachments.map((row) => row.id) ?? []),
    assertAttachmentsUnreferenced: (ids) => {
      if (ids.some((id) => state.protectedAttachments.has(id)))
        throw new Error('Attachment is referenced')
    },
    deleteItemsAndRelations: async (ids) => {
      for (const key of ids) state.items.delete(key)
      for (const [key, row] of state.candidates)
        if (row.acceptedItemId && ids.includes(row.acceptedItemId)) state.candidates.delete(key)
      return false
    }
  }
  return {
    store,
    get state() {
      return state
    },
    async run<T>(operation: (library: LibraryTransaction) => Promise<T>): Promise<T> {
      const before = structuredClone(state)
      try {
        return await operation(new runtime.LibraryTransaction(store))
      } catch (error) {
        state = before
        throw error
      }
    }
  }
}
