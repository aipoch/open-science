import {
  formatSmartRule,
  parseSmartRule,
  serializedSmartRuleSchema
} from '@aipoch/literature-screening/rules'
import type { LiteratureItemView } from './contracts.js'
import {
  LITERATURE_COLLECTION_DESCRIPTION_MAX_LENGTH,
  LITERATURE_COLLECTION_REVISION_CONFLICT,
  literatureCandidateInputSchema,
  literatureItemInputSchema,
  literaturePdfProvenanceSchema,
  type LiteratureCandidateInput,
  type LiteratureCatalogCommand,
  type LiteratureCatalogReceipt,
  type LiteratureSourceInput
} from './contracts.js'
import { LibraryImporter } from './importer.js'
import {
  candidateDedupeKey,
  canonicalJson,
  findIdentityItem,
  normalizeSpace,
  normalizedIdentifiers,
  sha256
} from './identity.js'
import type { LibraryPdf, LibraryStore } from './ports.js'
/** Transaction-scoped library workflow. The caller owns commit/rollback and post-commit publication. */
export class LibraryTransaction extends LibraryImporter {
  constructor(protected readonly store: LibraryStore) {
    super(store)
  }
  async updateItem(
    command: Extract<LiteratureCatalogCommand, { kind: 'update-item' }>,
    sources: readonly LiteratureSourceInput[] = [],
    operationId?: string
  ): Promise<LiteratureCatalogReceipt> {
    const itemId = normalizeSpace(command.itemId),
      item = literatureItemInputSchema.parse(command.item)
    if (operationId) {
      const receipt = await this.store.metadataReceipt(operationId)
      if (receipt) {
        if (
          receipt.itemId !== itemId ||
          receipt.expectedMetadataRevision !== command.expectedMetadataRevision
        )
          throw new Error('Metadata operation identity does not match the reviewed reference.')
        return { kind: 'item', id: itemId, state: 'present' }
      }
    }
    const existing = await this.store.item(itemId)
    if (!existing || existing.deletedAt !== undefined)
      throw new Error('Literature Item is unavailable.')
    if (existing.metadataRevision !== command.expectedMetadataRevision)
      throw new Error(
        `Literature Item revision conflict: expected ${command.expectedMetadataRevision}, actual ${existing.metadataRevision}.`
      )
    await this.store.replaceMetadata(itemId, command.expectedMetadataRevision, item)
    for (const source of sources) await this.store.attachSource({ source, itemId })
    if (operationId) {
      const committed = await this.store.item(itemId)
      if (!committed) throw new Error('Literature Item is unavailable.')
      await this.store.saveMetadataReceipt(operationId, {
        itemId,
        expectedMetadataRevision: command.expectedMetadataRevision,
        committedMetadataRevision: committed.metadataRevision
      })
    }
    return { kind: 'item', id: itemId, state: 'present' }
  }
  async stageCandidate(
    input: LiteratureCandidateInput,
    pdf?: LibraryPdf,
    signal?: AbortSignal
  ): Promise<LiteratureCatalogReceipt> {
    const candidate = literatureCandidateInputSchema.parse(input)
    const provenanceJson = pdf?.provenance
      ? canonicalJson(literaturePdfProvenanceSchema.parse(pdf.provenance))
      : null
    signal?.throwIfAborted()
    const existingId = await findIdentityItem(
      this.store,
      normalizedIdentifiers(candidate.item.identifiers)
    )
    const existing = existingId ? await this.store.item(existingId) : undefined
    signal?.throwIfAborted()
    // Cancellation may prevent admission, but never abandon a partially written transaction.
    if (existingId && existing && existing.deletedAt === undefined && !pdf) {
      await this.store.attachProjectIfPresent(
        candidate.origin.projectId,
        existingId,
        candidate.origin.kind
      )
      await this.store.attachSource({ source: candidate.source, itemId: existingId })
      return { kind: 'item', id: existingId, state: 'present' }
    }
    const key = pdf
      ? sha256(`pdf:${candidateDedupeKey(candidate)}:${pdf.checksum}`)
      : candidateDedupeKey(candidate)
    const previous = await this.store.candidateByKey(key)
    if (previous?.state === 'accepted' && previous.acceptedDeleted)
      await this.store.retireCandidateKey(previous.id)
    const json = canonicalJson(candidate)
    const persisted = await this.store.createCandidate(key, candidate, json, sha256(json))
    await this.store.recordDiscovery(
      persisted.id,
      candidate,
      canonicalJson([
        candidate.origin.kind,
        candidate.origin.projectId ?? null,
        candidate.origin.sessionId ?? null
      ])
    )
    if (persisted.state === 'pending') {
      if (pdf) await this.store.stagePdf(persisted.id, pdf, provenanceJson)
      if (previous?.id !== persisted.id)
        await this.store.attachSource({ source: candidate.source, candidateId: persisted.id })
    }
    return {
      kind: 'candidate',
      id: persisted.id,
      state: persisted.state as 'pending' | 'accepted' | 'dismissed'
    }
  }
  async acceptCandidate(candidateId: string): Promise<LiteratureCatalogReceipt> {
    const row = await this.store.candidate(candidateId)
    if (!row) throw new Error('Literature Inbox candidate not found.')
    if (row.state === 'accepted' && row.acceptedItemId)
      return { kind: 'item', id: row.acceptedItemId, state: 'present' }
    if (row.state !== 'pending') throw new Error('Literature Inbox candidate is already settled.')
    const candidate = literatureCandidateInputSchema.parse(JSON.parse(row.candidateJson))
    const id =
      (await findIdentityItem(this.store, normalizedIdentifiers(candidate.item.identifiers))) ??
      (await this.store.createItem(candidate.item))
    await this.store.restoreItem(id)
    await this.store.transferCandidateSources(row.id, id)
    for (const discovery of row.discoveries)
      await this.store.attachProjectIfPresent(
        discovery.projectId ?? undefined,
        id,
        discovery.origin
      )
    await this.store.acceptCandidate(row.id, id)
    await this.store.transferCandidatePdfs(candidateId, id)
    return { kind: 'item', id, state: 'linked' }
  }
  async settleCandidates(
    ids: readonly string[],
    state: 'accepted' | 'dismissed'
  ): Promise<LiteratureCatalogReceipt> {
    if (state === 'accepted') {
      for (const id of ids) await this.acceptCandidate(id)
    } else if ((await this.store.changeCandidates(ids, 'pending', 'dismissed')) !== ids.length)
      throw new Error('One or more Literature Inbox candidates are not pending.')
    return { kind: 'candidate', id: ids[0]!, state, count: ids.length }
  }
  async restoreCandidates(ids: readonly string[]): Promise<LiteratureCatalogReceipt> {
    if ((await this.store.changeCandidates(ids, 'dismissed', 'pending')) !== ids.length)
      throw new Error('One or more Literature Inbox candidates are not dismissed.')
    return { kind: 'candidate', id: ids[0]!, state: 'pending', count: ids.length }
  }
  mergeViews(ids: readonly string[]): Promise<LiteratureItemView[]> {
    return this.store.mergeViews(ids)
  }
  async setCollectionItem(
    command: Extract<LiteratureCatalogCommand, { kind: 'set-collection-item' }>
  ): Promise<LiteratureCatalogReceipt> {
    const collection = await this.store.collection(command.collectionId)
    if (!collection) throw new Error('Literature Collection is unavailable.')
    if (collection.smart) throw new Error('Use an explicit smart collection override.')
    if (command.included) {
      if (!(await this.store.activeItemCount([command.itemId])))
        throw new Error('One or more Literature Items are unavailable.')
      await this.store.linkCollection(
        command.collectionId,
        command.itemId,
        (await this.store.lastCollectionOrder(command.collectionId)) + 1
      )
    } else await this.store.unlinkCollection(command.collectionId, command.itemId)
    return { kind: 'item', id: command.itemId, state: command.included ? 'linked' : 'unlinked' }
  }
  async setProjectItems(
    command: Extract<LiteratureCatalogCommand, { kind: 'set-project-items' }>
  ): Promise<LiteratureCatalogReceipt> {
    const ids = [...new Set(command.itemIds)]
    if (!command.included) await this.store.unlinkProject(command.projectId, ids)
    else {
      const source = normalizeSpace(command.source)
      if (!source) throw new Error('Project Literature source is required.')
      if (!(await this.store.projectAvailable(command.projectId)))
        throw new Error('Project is unavailable.')
      if ((await this.store.activeItemCount(ids)) !== ids.length)
        throw new Error('One or more Literature Items are unavailable.')
      await Promise.all(ids.map((id) => this.store.linkProject(command.projectId, id, source)))
    }
    return { kind: 'item', id: ids[0]!, state: command.included ? 'linked' : 'unlinked' }
  }
  async setItemLifecycle(
    command: Extract<LiteratureCatalogCommand, { kind: 'set-item-lifecycle' }>
  ): Promise<LiteratureCatalogReceipt> {
    const ids = [...new Set(command.itemIds)]
    const count = await this.store.setLifecycle(ids, command.state)
    await this.store.invalidateAssessments(ids)
    if (count !== ids.length) throw new Error('One or more Literature Items are unavailable.')
    return { kind: 'item', id: ids[0]!, state: command.state }
  }
  async mergeItems(
    command: Extract<LiteratureCatalogCommand, { kind: 'merge-items' }>
  ): Promise<{ receipt: LiteratureCatalogReceipt; tagsChanged: boolean }> {
    const ids = [...new Set(command.duplicateIds)].filter((id) => id !== command.survivorId)
    if (ids.length !== command.duplicateIds.length)
      throw new Error('Duplicate Literature Item ids must be unique and exclude the survivor.')
    const rows = await this.store.mergeViews([command.survivorId, ...ids])
    if (rows.length !== ids.length + 1)
      throw new Error('One or more Literature Items are unavailable for merging.')
    if (
      command.expectedItems.length !== rows.length ||
      rows.some(
        (row) =>
          !command.expectedItems.some(
            (expected) =>
              expected.id === row.id &&
              expected.metadataRevision === row.metadataRevision &&
              expected.updatedAt === row.updatedAt
          )
      )
    )
      throw new Error('Literature references changed after review.')
    const decisions = new Map<string, string>()
    for (const override of await this.store.mergeOverrides([command.survivorId, ...ids])) {
      const previous = decisions.get(override.collectionId)
      if (previous && previous !== override.decision)
        throw new Error(
          'Resolve conflicting smart collection decisions before merging these references.'
        )
      decisions.set(override.collectionId, override.decision)
    }
    await this.store.prepareMerge(command.survivorId, ids, decisions)
    // Metadata replacement must share the transaction with all cross-domain relationship moves.
    await this.store.replaceMetadata(
      command.survivorId,
      command.expectedMetadataRevision,
      literatureItemInputSchema.parse(command.item)
    )
    const tagsChanged = await this.store.moveMergedRelations(command.survivorId, ids)
    return { receipt: { kind: 'item', id: command.survivorId, state: 'merged' }, tagsChanged }
  }
  async createCollection(
    nameInput: string,
    descriptionInput?: string,
    parentId?: string
  ): Promise<LiteratureCatalogReceipt> {
    const name = normalizeSpace(nameInput)
    if (!name) throw new Error('Literature Collection name is required.')
    if (parentId && (await this.store.collection(parentId))?.smart)
      throw new Error('Smart collections cannot contain child collections.')
    const id = await this.store.createCollection({
      name,
      description: descriptionInput?.trim() ?? '',
      parentId,
      sortOrder: (await this.store.lastSiblingOrder(parentId)) + 1
    })
    return { kind: 'collection', id }
  }
  async updateCollection(
    command: Extract<LiteratureCatalogCommand, { kind: 'update-collection' }>
  ): Promise<LiteratureCatalogReceipt> {
    const name = normalizeSpace(command.name)
    if (!name) throw new Error('Literature Collection name is required.')
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1)
      throw new Error(LITERATURE_COLLECTION_REVISION_CONFLICT)
    const previous = await this.store.collectionState(command.collectionId)
    if (previous?.smart) serializedSmartRuleSchema.parse(command.description)
    else if (command.description.trim().length > LITERATURE_COLLECTION_DESCRIPTION_MAX_LENGTH)
      throw new Error('Collection description is too long.')
    const previousRule = previous?.smart ? parseSmartRule(previous.description) : undefined
    const description = previous?.smart
      ? formatSmartRule(parseSmartRule(command.description)!)
      : command.description.trim()
    if (
      command.smartScope &&
      (!previous?.smart || !(await this.store.scopeAvailable(command.smartScope)))
    )
      throw new Error('Smart collection source is unavailable.')
    const scopeChanged =
      command.smartScope &&
      previous?.smart &&
      (command.smartScope.kind !== previous.smart.scopeKind ||
        (command.smartScope.kind === 'library' ? null : command.smartScope.id) !==
          previous.smart.scopeId)
    const ruleChanged = Boolean(
      (previousRule ? formatSmartRule(previousRule) : previous?.description) !== description ||
      scopeChanged ||
      (command.smartEvidenceMode !== undefined &&
        command.smartEvidenceMode !== previous?.smart?.evidenceMode)
    )
    const count = await this.store.updateCollection(
      command.collectionId,
      command.expectedRevision,
      { name, description }
    )
    if (count && previous?.smart && (ruleChanged || command.smartAutoUpdate !== undefined))
      await this.store.updateSmartCollection(command.collectionId, {
        ruleChanged,
        scope: command.smartScope,
        evidenceMode: command.smartEvidenceMode,
        autoUpdate: command.smartAutoUpdate
      })
    if (count && previous?.smart && ruleChanged)
      await this.store.saveSmartRuleVersion(command.collectionId)
    if (count !== 1) throw new Error(LITERATURE_COLLECTION_REVISION_CONFLICT)
    return { kind: 'collection', id: command.collectionId }
  }
  async removeCollection(id: string): Promise<LiteratureCatalogReceipt> {
    await this.store.removeCollection(id)
    return { kind: 'collection', id }
  }
  async moveCollectionItems(
    command: Extract<LiteratureCatalogCommand, { kind: 'move-collection-items' }>
  ): Promise<LiteratureCatalogReceipt> {
    const ids = [...new Set(command.itemIds)]
    const target = await this.store.collection(command.targetCollectionId)
    if (!target) throw new Error('Literature Collection is unavailable.')
    if (
      target.smart ||
      (command.sourceCollectionId &&
        (await this.store.collection(command.sourceCollectionId))?.smart)
    )
      throw new Error('Smart collection membership cannot be moved manually.')
    if ((await this.store.activeItemCount(ids)) !== ids.length)
      throw new Error('One or more Literature Items are unavailable.')
    let order = (await this.store.lastCollectionOrder(target.id)) + 1
    for (const id of ids) await this.store.linkCollection(target.id, id, order++)
    if (command.sourceCollectionId && command.sourceCollectionId !== target.id)
      for (const id of ids) await this.store.unlinkCollection(command.sourceCollectionId, id)
    return { kind: 'item', id: ids[0]!, state: 'linked' }
  }
  async deleteItemsPermanently(
    requestedIds: readonly string[]
  ): Promise<{ receipt: LiteratureCatalogReceipt; tagsChanged: boolean }> {
    const ids = [...new Set(requestedIds)]
    const items = await this.store.deletionItems(ids)
    if (items.length !== ids.length || items.some((item) => !item.deleted))
      throw new Error('Only Literature Items in Trash can be permanently deleted.')
    const deletionIds = [...new Set([...ids, ...(await this.store.mergedItemIds(ids))])]
    this.store.assertAttachmentsUnreferenced(await this.store.attachmentIds(deletionIds))
    const tagsChanged = await this.store.deleteItemsAndRelations(deletionIds)
    return { receipt: { kind: 'item', id: ids[0]!, state: 'deleted-permanently' }, tagsChanged }
  }
}
