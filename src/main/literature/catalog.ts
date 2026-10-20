import { journalBindingIdentity } from '@aipoch/journal-catalog/contracts'
import {
  LibraryTransaction,
  canonicalJson,
  mergeLiteratureDuplicates,
  normalizeIdentifier,
  normalizeSpace,
  normalizedIdentifiers,
  type LibraryStore
} from '@aipoch/literature-library'
import { LITERATURE_OVERSIZED_REFERENCE } from '@aipoch/literature-library'

import { smartEvidenceModeSchema, smartScopeSchema } from '@aipoch/literature-screening/contracts'
import { createHash, randomUUID } from 'node:crypto'
import { ApplicationCommandError } from '../../shared/application-command-contract'
import {
  type LiteratureExportRecordRequest,
  type LiteratureExportRecordResult
} from '../../shared/literature-export'
import { bindLiteraturePdfVersion } from '../pdf-annotations/source-bindings'
import { deletePdfAnnotations, readAnnotations } from '../pdf-annotations/repository'
import type { ContentRepository } from '../storage/content-repository'
import type { JournalAttributes } from './journal-attributes'
import { boundedLiteraturePage } from './response-page'
import type { LiteratureScreening } from './screening-adapter'
import { saveSmartRuleVersion } from './smart-rule-history'

import { createLogger } from '@aipoch/diagnostics/node'
import { findLiteratureDuplicateGroups } from '@aipoch/literature-library'
import { Prisma, type PrismaClient } from '@prisma/client'
import { normalizeLiteratureSearchTextV1 as normalizeSearchText } from '../../shared/literature-search-text'
import { searchTitleRank } from '../../shared/search-text'

import {
  normalizeLiteratureIdentifierValue,
  type LiteratureCreatorInput,
  type LiteratureIdentifierScheme
} from '@aipoch/literature-citations/contracts'
import {
  LITERATURE_COLLECTION_NAME_CONFLICT,
  literatureCandidateInputSchema,
  literatureCandidateOriginSchema,
  literaturePdfProvenanceSchema,
  type LiteratureCandidateInput,
  type LiteratureCatalogCommand,
  type LiteratureCatalogReceipt,
  type LiteratureCatalogSearchRequest,
  type LiteratureChangedEvent,
  type LiteratureCollectionView,
  type LiteratureDuplicatePolicy,
  type LiteratureInboxCandidateView,
  type LiteratureInboxState,
  type LiteratureItemView,
  type LiteraturePdfProvenance,
  type LiteratureRecordImportEntry,
  type LiteratureRecordImportError,
  type LiteratureRecordImportReceipt,
  type LiteratureSourceInput,
  type LiteratureSourceRecordView
} from '@aipoch/literature-library/contracts'
import {
  literatureItemInputSchema,
  type LiteratureItemInput
} from '@aipoch/literature-library/item'
import {
  literatureCandidateStatesRequestSchema,
  literatureCandidateStatesResultSchema,
  type LiteratureCandidateStatesRequest,
  type LiteratureCandidateStatesResult,
  type LiteratureAnnotationSearchView,
  type LiteratureCatalogSearchPage
} from '../../shared/literature'

type LiteratureCatalogClient = Pick<
  PrismaClient,
  | '$transaction'
  | '$queryRaw'
  | 'contentBlob'
  | 'literatureAttachment'
  | 'literatureAttachmentVersion'
  | 'literatureCollection'
  | 'literatureInboxCandidate'
  | 'literatureItem'
  | 'project'
  | 'projectLiterature'
  | 'projectDeletionIntent'
  | 'tagAssignment'
  | 'pdfAnnotationSourceBinding'
  | 'pdfAnnotation'
>

const log = createLogger('literature-catalog')

type LiteratureCatalogClientProvider = () => Promise<LiteratureCatalogClient>
const duplicateGroups = new WeakMap<
  LiteratureCatalogClient,
  Promise<ReturnType<typeof findLiteratureDuplicateGroups>>
>()

type AttachLiteratureContentInput = Readonly<{
  itemId: string
  expectedMetadataRevision?: number
  provenance?: LiteraturePdfProvenance
  attachmentId?: string
  kind?: string
  title?: string
  contentBlobId: string
  filename: string
  contentType: string
  sizeBytes: number
  checksum: string
  pageCount?: number
}>

type AttachedLiteratureContent = Readonly<{
  attachmentId: string
  versionId: string
  itemId?: string
}>

type ApplyLiteratureMetadataInput = Readonly<{
  operationId?: string
  itemId: string
  expectedMetadataRevision: number
  item: LiteratureItemInput
  source: LiteratureSourceInput
  sources?: readonly LiteratureSourceInput[]
}>

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const normalizeCreatorName = (creator: LiteratureCreatorInput): string =>
  creator.nameMode === 'organization'
    ? normalizeSearchText(creator.literalName)
    : normalizeSearchText(`${creator.familyName} ${creator.givenName}`)

const searchIdentifiers = (
  text: string
): { scheme: LiteratureIdentifierScheme; normalizedValue: string }[] => {
  const forms: [LiteratureIdentifierScheme, RegExp][] = [
    ['doi', /^10\.\d{4,9}\/\S+$/u],
    ['pmid', /^\d+$/u],
    ['pmcid', /^PMC\d+$/u],
    ['arxiv', /^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})$/iu],
    ['isbn', /^(?:\d{9}[\dX]|\d{13})$/u],
    ['issn', /^\d{7}[\dX]$/u]
  ]
  return forms.flatMap(([scheme, pattern]) => {
    // A bare number denotes a PMID, not an implicitly prefixed PMCID.
    if (scheme === 'pmcid' && /^\d+$/u.test(text)) return []
    // ISBN/ISSN normalization strips arbitrary characters; admit only explicit numeric forms.
    if ((scheme === 'isbn' || scheme === 'issn') && !/^[\dX\s-]+$/iu.test(text)) return []
    const normalizedValue = normalizeIdentifier(scheme, text)
    return pattern.test(normalizedValue) ? [{ scheme, normalizedValue }] : []
  })
}

// Deletion intents are independent recovery records, not a Project foreign-key relation.
const availableProjectWhere = async (
  client: Pick<Prisma.TransactionClient, 'projectDeletionIntent'>
): Promise<Prisma.ProjectWhereInput> => ({
  deletedAt: null,
  id: {
    notIn: (await client.projectDeletionIntent.findMany({ select: { projectId: true } })).map(
      ({ projectId }) => projectId
    )
  }
})

const itemInclude = {
  creators: { include: { creator: true }, orderBy: { ordinal: 'asc' as const } },
  identifiers: { orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }] },
  projects: { select: { projectId: true }, orderBy: { addedAt: 'asc' as const } },
  collections: { select: { collectionId: true }, orderBy: { addedAt: 'asc' as const } },
  attachments: {
    include: {
      versions: {
        include: {
          contentBlob: {
            select: { state: true, lastVerificationFailure: true, lastVerificationAttemptAt: true }
          }
        },
        orderBy: { versionNumber: 'desc' as const }
      }
    },
    orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }]
  }
} satisfies Prisma.LiteratureItemInclude

const activeItemInclude = async (
  client: Pick<Prisma.TransactionClient, 'projectDeletionIntent'>
): Promise<
  typeof itemInclude & {
    projects: typeof itemInclude.projects & { where: Prisma.ProjectLiteratureWhereInput }
  }
> => ({
  ...itemInclude,
  projects: { ...itemInclude.projects, where: { project: await availableProjectWhere(client) } }
})

type LiteratureItemRow = Prisma.LiteratureItemGetPayload<{ include: typeof itemInclude }>

const toItemView = (row: LiteratureItemRow): LiteratureItemView => ({
  id: row.id,
  item: {
    itemType: row.itemType as LiteratureItemInput['itemType'],
    title: row.title,
    abstract: row.abstract,
    issuedText: row.issuedText,
    issuedYear: row.issuedYear ?? undefined,
    containerTitle: row.containerTitle,
    shortTitle: row.shortTitle,
    language: row.language,
    rights: row.rights,
    url: row.url,
    accessedAt: row.accessedAt?.getTime(),
    citationKey: row.citationKey ?? undefined,
    extra: row.extra,
    rating: row.rating,
    personalNote: row.personalNote,
    typeFields: JSON.parse(row.typeFieldsJson) as Record<string, unknown>,
    creators: row.creators.map(({ creator, creatorType }) =>
      creator.nameMode === 'organization'
        ? { nameMode: 'organization', literalName: creator.literalName, creatorType }
        : {
            nameMode: 'person',
            givenName: creator.givenName,
            familyName: creator.familyName,
            creatorType
          }
    ),
    identifiers: row.identifiers.map((identifier) => ({
      scheme: identifier.scheme as LiteratureIdentifierScheme,
      value: normalizeLiteratureIdentifierValue(
        identifier.scheme as LiteratureIdentifierScheme,
        identifier.rawValue
      ),
      isPrimary: identifier.isPrimary
    }))
  },
  attachments: row.attachments.map((attachment) => ({
    id: attachment.id,
    kind: attachment.kind,
    title: attachment.title,
    sortOrder: attachment.sortOrder,
    versions: attachment.versions.map((version) => ({
      id: version.id,
      versionNumber: version.versionNumber,
      provenance: version.provenanceJson
        ? literaturePdfProvenanceSchema.parse(JSON.parse(version.provenanceJson))
        : undefined,
      filename: version.filename,
      contentType: version.contentType,
      sizeBytes: Number(version.sizeBytes),
      checksum: version.checksum,
      pageCount: version.pageCount ?? undefined,
      availability:
        version.contentBlob.state !== 'available' || version.contentBlob.lastVerificationFailure
          ? 'unavailable'
          : version.contentBlob.lastVerificationAttemptAt
            ? 'available'
            : 'unknown',
      verificationFailure: version.contentBlob.lastVerificationFailure ?? undefined,
      verificationAttemptAt: version.contentBlob.lastVerificationAttemptAt?.getTime(),
      createdAt: version.createdAt.getTime()
    })),
    createdAt: attachment.createdAt.getTime(),
    updatedAt: attachment.updatedAt.getTime()
  })),
  projectIds: row.projects.map(({ projectId }) => projectId),
  collectionIds: row.collections.map(({ collectionId }) => collectionId),
  metadataRevision: row.metadataRevision,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
  deletedAt: row.deletedAt?.getTime(),
  mergedIntoItemId: row.mergedIntoItemId ?? undefined
})

const toCandidateView = (row: {
  id: string
  state: string
  candidateJson: string
  acceptedItemId: string | null
  createdAt: Date
  updatedAt: Date
  discoveries: {
    origin: string
    projectId: string | null
    sessionId: string | null
    createdAt: Date
  }[]
  pdfs?: { id: string; filename: string; sizeBytes: bigint; pageCount: number; sourceUrl: string }[]
}): LiteratureInboxCandidateView => ({
  id: row.id,
  state: row.state as LiteratureInboxState,
  candidate: literatureCandidateInputSchema.parse(JSON.parse(row.candidateJson)),
  discoveries: row.discoveries.map((discovery) => ({
    origin: literatureCandidateOriginSchema.parse({
      kind: discovery.origin,
      projectId: discovery.projectId ?? undefined,
      sessionId: discovery.sessionId ?? undefined
    }),
    createdAt: discovery.createdAt.getTime()
  })),
  pdfs: row.pdfs?.map((pdf) => ({ ...pdf, sizeBytes: Number(pdf.sizeBytes) })),
  acceptedItemId: row.acceptedItemId ?? undefined,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime()
})

const attachProjectIfPresent = async (
  transaction: Prisma.TransactionClient,
  projectId: string | undefined,
  itemId: string,
  source: string
): Promise<void> => {
  if (!projectId) return
  const project = await transaction.project.findFirst({
    where: { AND: [{ id: projectId }, await availableProjectWhere(transaction)] },
    select: { id: true }
  })
  if (!project) return
  await transaction.projectLiterature.upsert({
    where: { projectId_itemId: { projectId, itemId } },
    create: { projectId, itemId, source },
    update: { source }
  })
}

// Include all owners, including Trash and explicitly independent duplicates.

// Plan the entire batch before any write. Virtual targets retain input indexes,
// so bridges between earlier rows are checked identically in preview and commit.

const createItem = async (
  transaction: Prisma.TransactionClient,
  item: LiteratureItemInput,
  id?: string
): Promise<string> => {
  const identifiers = normalizedIdentifiers(item.identifiers)
  const created = await transaction.literatureItem.create({
    data: {
      id,
      itemType: item.itemType,
      title: normalizeSpace(item.title),
      normalizedTitle: normalizeSearchText(item.title),
      normalizedAbstract: normalizeSearchText(item.abstract),
      normalizedContainerTitle: normalizeSearchText(item.containerTitle),
      abstract: item.abstract,
      issuedText: item.issuedText,
      issuedYear: item.issuedYear,
      containerTitle: item.containerTitle,
      shortTitle: item.shortTitle,
      language: item.language,
      rights: item.rights,
      url: item.url,
      accessedAt: item.accessedAt === undefined ? undefined : new Date(item.accessedAt),
      citationKey: item.citationKey,
      extra: item.extra,
      rating: item.rating ?? 0,
      personalNote: item.personalNote ?? '',
      typeFieldsJson: canonicalJson(item.typeFields),
      identifiers: {
        create: identifiers.map(({ isPrimary, normalizedValue, scheme, value }) => ({
          scheme,
          rawValue: value,
          normalizedValue,
          isPrimary
        }))
      }
    },
    select: { id: true }
  })
  if (item.creators.length > 0) {
    const creators = item.creators.map((creator) => ({
      id: randomUUID(),
      normalizedName: normalizeCreatorName(creator),
      normalizedDisplayName: normalizeSearchText(
        creator.nameMode === 'organization'
          ? creator.literalName
          : `${creator.givenName} ${creator.familyName}`
      ),
      ...(creator.nameMode === 'organization'
        ? { nameMode: 'organization', literalName: creator.literalName }
        : { nameMode: 'person', givenName: creator.givenName, familyName: creator.familyName })
    }))
    await transaction.literatureCreator.createMany({ data: creators })
    await transaction.literatureItemCreator.createMany({
      data: creators.map((creator, ordinal) => ({
        itemId: created.id,
        creatorId: creator.id,
        creatorType: item.creators[ordinal].creatorType,
        ordinal
      }))
    })
  }
  return created.id
}

const replaceItemMetadata = async (
  transaction: Prisma.TransactionClient,
  itemId: string,
  expectedMetadataRevision: number,
  input: LiteratureItemInput
): Promise<void> => {
  const item = literatureItemInputSchema.parse(input)
  const identifiers = normalizedIdentifiers(item.identifiers)
  const existing = await transaction.literatureItem.findFirst({
    where: { id: itemId, deletedAt: null },
    select: {
      metadataRevision: true,
      creators: { select: { creatorId: true } },
      itemType: true,
      containerTitle: true,
      typeFieldsJson: true,
      identifiers: { select: { scheme: true, rawValue: true } }
    }
  })
  if (!existing) throw new Error('Literature Item is unavailable.')
  if (existing.metadataRevision !== expectedMetadataRevision) {
    throw new Error(
      `Literature Item revision conflict: expected ${expectedMetadataRevision}, actual ${existing.metadataRevision}.`
    )
  }
  // Identifiers belong to individual records; intentionally separate references remain editable.
  const updated = await transaction.literatureItem.updateMany({
    where: { id: itemId, deletedAt: null, metadataRevision: expectedMetadataRevision },
    data: {
      itemType: item.itemType,
      title: normalizeSpace(item.title),
      normalizedTitle: normalizeSearchText(item.title),
      normalizedAbstract: normalizeSearchText(item.abstract),
      normalizedContainerTitle: normalizeSearchText(item.containerTitle),
      abstract: item.abstract,
      issuedText: item.issuedText,
      issuedYear: item.issuedYear ?? null,
      containerTitle: item.containerTitle,
      shortTitle: item.shortTitle,
      language: item.language,
      rights: item.rights,
      url: item.url,
      accessedAt: item.accessedAt === undefined ? null : new Date(item.accessedAt),
      citationKey: item.citationKey ?? null,
      extra: item.extra,
      rating: item.rating ?? 0,
      personalNote: item.personalNote ?? '',
      typeFieldsJson: canonicalJson(item.typeFields),
      metadataRevision: { increment: 1 }
    }
  })
  if (updated.count !== 1) throw new Error('Literature Item revision conflict.')
  if (
    journalBindingIdentity({
      ...existing,
      typeFields: JSON.parse(existing.typeFieldsJson),
      identifiers: existing.identifiers.map(({ scheme, rawValue }) => ({ scheme, value: rawValue }))
    }) !== journalBindingIdentity({ ...item, identifiers })
  ) {
    await transaction.$executeRaw`DELETE FROM "JournalItemBinding" WHERE "itemId" = ${itemId}`
  }
  await transaction.literatureItemCreator.deleteMany({ where: { itemId } })
  await transaction.literatureIdentifier.deleteMany({ where: { itemId } })
  if (identifiers.length > 0) {
    await transaction.literatureIdentifier.createMany({
      data: identifiers.map(({ isPrimary, normalizedValue, scheme, value }) => ({
        itemId,
        scheme,
        rawValue: value,
        normalizedValue,
        isPrimary
      }))
    })
  }
  for (const [ordinal, creator] of item.creators.entries()) {
    const normalizedName = normalizeCreatorName(creator)
    const persisted = await transaction.literatureCreator.create({
      data:
        creator.nameMode === 'organization'
          ? {
              nameMode: 'organization',
              literalName: creator.literalName,
              normalizedName,
              normalizedDisplayName: normalizedName
            }
          : {
              nameMode: 'person',
              givenName: creator.givenName,
              familyName: creator.familyName,
              normalizedName,
              normalizedDisplayName: normalizeSearchText(
                `${creator.givenName} ${creator.familyName}`
              )
            },
      select: { id: true }
    })
    await transaction.literatureItemCreator.create({
      data: { itemId, creatorId: persisted.id, creatorType: creator.creatorType, ordinal }
    })
  }
  const replacedCreatorIds = existing.creators.map(({ creatorId }) => creatorId)
  if (replacedCreatorIds.length > 0) {
    await transaction.literatureCreator.deleteMany({
      where: { id: { in: replacedCreatorIds }, items: { none: {} } }
    })
  }
}

const transferSourceRecords = async (
  transaction: Prisma.TransactionClient,
  where: Prisma.LiteratureSourceRecordWhereInput,
  itemId: string
): Promise<void> => {
  const sources = await transaction.literatureSourceRecord.findMany({
    where,
    orderBy: [{ fetchedAt: 'asc' }, { id: 'asc' }]
  })
  for (const source of sources) {
    const existing = await transaction.literatureSourceRecord.findFirst({
      where: {
        itemId,
        provider: source.provider,
        externalId: source.externalId,
        ...(source.externalId ? {} : { sourceUrl: source.sourceUrl })
      }
    })
    if (existing) {
      if (source.fetchedAt > existing.fetchedAt) {
        await transaction.literatureSourceRecord.update({
          where: { id: existing.id },
          data: {
            rawMetadataJson: source.rawMetadataJson,
            metadataChecksum: source.metadataChecksum,
            sourceUrl: source.sourceUrl,
            fetchedAt: source.fetchedAt
          }
        })
      }
      await transaction.literatureSourceRecord.delete({ where: { id: source.id } })
    } else {
      await transaction.literatureSourceRecord.update({
        where: { id: source.id },
        data: { inboxCandidateId: null, itemId }
      })
    }
  }
}

class LiteratureCatalog {
  constructor(
    private readonly getClient: LiteratureCatalogClientProvider,
    private readonly onTagAssignmentsChanged?: () => Promise<void>,
    private readonly content?: Pick<ContentRepository, 'verify' | 'sweep'>,
    private readonly withAttachmentRemoval: <Result>(
      remove: (assertUnreferenced: (attachmentIds: readonly string[]) => void) => Promise<Result>
    ) => Promise<Result> = async (remove) =>
      remove((attachmentIds) => {
        // Metadata-only clients may delete metadata, but cannot bypass attachment authority.
        if (attachmentIds.length) throw new Error('Literature attachment removal is unavailable.')
      }),
    private readonly onChanged?: (event: LiteratureChangedEvent) => void,
    private readonly smart?: LiteratureScreening,
    private readonly journalAttributes?: JournalAttributes
  ) {}

  private revision = 0

  private publishChanged(change: Omit<LiteratureChangedEvent, 'revision'>): void {
    try {
      this.onChanged?.({ ...change, revision: ++this.revision })
    } catch (error) {
      log.warn('Could not publish committed literature changes', { error })
    }
    this.smart?.schedule()
  }

  // Observe writes on the transaction's own SQLite connection. Read-only previews and empty
  // upserts do not emit; rollback cannot reach publication. Delivery cannot undo the commit.
  private async commit<T>(
    client: LiteratureCatalogClient,
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
    changes:
      | Omit<LiteratureChangedEvent, 'revision'>
      | ((result: T) => Omit<LiteratureChangedEvent, 'revision'>),
    options?: { timeout: number }
  ): Promise<T> {
    // A library search may hold the single SQLite connection for up to 30 seconds.
    // Acquisition must not fail at Prisma's 2s default while that valid read is still running.
    const transactionOptions = { maxWait: 30_000, ...options }
    if (!this.onChanged && !this.smart) return client.$transaction(operation, transactionOptions)
    const committed = await client.$transaction(async (transaction) => {
      const count = async (): Promise<bigint> =>
        (
          await transaction.$queryRawUnsafe<{ count: bigint }[]>('SELECT total_changes() AS count')
        )[0]!.count
      const before = await count()
      const result = await operation(transaction)
      return { result, changed: (await count()) !== before }
    }, transactionOptions)
    if (committed.changed) {
      duplicateGroups.delete(client)
      this.publishChanged(typeof changes === 'function' ? changes(committed.result) : changes)
    }
    return committed.result
  }

  private async publishTagAssignmentsChanged(): Promise<void> {
    try {
      await this.onTagAssignmentsChanged?.()
    } catch (error) {
      // Delivery cannot roll back an already committed catalog transaction.
      log.warn('Could not publish committed tag assignment changes', { error })
    }
  }

  async search(request: LiteratureCatalogSearchRequest): Promise<LiteratureCatalogSearchPage> {
    const client = await this.getClient()
    const offset = Math.max(0, request.offset ?? 0)
    const limit = Math.min(100, Math.max(1, request.limit ?? 50))
    const query = normalizeSpace(request.query ?? '')
    if (request.scope === 'duplicates') {
      if (request.refreshDuplicates) duplicateGroups.delete(client)
      let pending = duplicateGroups.get(client)
      if (!pending) {
        pending = client.literatureItem
          .findMany({
            where: { deletedAt: null, mergedIntoItemId: null },
            select: {
              id: true,
              itemType: true,
              title: true,
              issuedYear: true,
              creators: {
                where: { creatorType: 'author' },
                select: {
                  creator: { select: { familyName: true, givenName: true, literalName: true } }
                },
                orderBy: { ordinal: 'asc' },
                take: 1
              },
              identifiers: { select: { scheme: true, normalizedValue: true } }
            },
            orderBy: { id: 'asc' }
          })
          .then(findLiteratureDuplicateGroups)
        duplicateGroups.set(client, pending)
        void pending.catch(() => {
          if (duplicateGroups.get(client) === pending) duplicateGroups.delete(client)
        })
      }
      const groups = await pending
      return {
        entries: groups.slice(offset, offset + limit),
        totalCount: groups.length,
        nextOffset: offset + limit < groups.length ? offset + limit : undefined
      }
    }
    if (request.scope === 'project-counts') {
      const rows = await client.projectLiterature.groupBy({
        by: ['projectId'],
        where: {
          project: await availableProjectWhere(client),
          item: { deletedAt: null, mergedIntoItemId: null }
        },
        _count: { itemId: true },
        orderBy: { projectId: 'asc' }
      })
      return {
        entries: rows.map((row) => ({
          projectId: row.projectId,
          itemCount: row._count.itemId
        })),
        totalCount: rows.length
      }
    }
    if (request.scope === 'collections') {
      const where = {
        ...(request.parentId ? { parentId: request.parentId } : {}),
        ...(request.itemId || request.projectId
          ? {
              OR: [
                {
                  id: {
                    in:
                      (await this.smart?.matchingCollections(request.itemId, request.projectId)) ??
                      []
                  }
                },
                {
                  items: {
                    some: {
                      ...(request.itemId ? { itemId: request.itemId } : {}),
                      ...(request.projectId
                        ? { item: { projects: { some: { projectId: request.projectId } } } }
                        : {})
                    }
                  }
                }
              ]
            }
          : {}),
        ...(query ? { name: { contains: query } } : {})
      }
      const [totalCount, rows] = await Promise.all([
        client.literatureCollection.count({ where }),
        client.literatureCollection.findMany({
          where,
          include: {
            smart: true,
            _count: {
              select: { items: { where: { item: { deletedAt: null, mergedIntoItemId: null } } } }
            }
          },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          skip: offset,
          take: limit + 1
        })
      ])
      return {
        entries: await Promise.all(
          rows.slice(0, limit).map(async (row): Promise<LiteratureCollectionView> => {
            const members = row.smart ? await this.smart?.members(row.id) : undefined
            return {
              id: row.id,
              revision: row.revision,
              name: row.name,
              description: row.description,
              parentId: row.parentId ?? undefined,
              smart: members !== undefined,
              smartEvidenceMode: row.smart
                ? smartEvidenceModeSchema.parse(row.smart.evidenceMode)
                : undefined,
              smartAutoUpdate: row.smart?.autoUpdate,
              smartScope: row.smart
                ? smartScopeSchema.parse({
                    kind: row.smart.scopeKind,
                    ...(row.smart.scopeId ? { id: row.smart.scopeId } : {})
                  })
                : undefined,
              itemCount: members?.length ?? row._count.items,
              createdAt: row.createdAt.getTime(),
              updatedAt: row.updatedAt.getTime()
            }
          })
        ),
        totalCount,
        nextOffset: rows.length > limit ? offset + limit : undefined
      }
    }
    if (request.scope === 'inbox') {
      const where = {
        state: request.inboxState ?? 'pending',
        ...(query
          ? {
              OR: [{ title: { contains: query } }, { abstract: { contains: query } }]
            }
          : {})
      }
      const [totalCount, rows] = await Promise.all([
        client.literatureInboxCandidate.count({ where }),
        client.literatureInboxCandidate.findMany({
          where,
          include: {
            discoveries: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
            pdfs: {
              select: {
                id: true,
                filename: true,
                sizeBytes: true,
                pageCount: true,
                sourceUrl: true
              }
            }
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip: offset,
          take: limit + 1
        })
      ])
      return {
        entries: rows.slice(0, limit).map(toCandidateView),
        totalCount,
        nextOffset: rows.length > limit ? offset + limit : undefined
      }
    }
    const journalFilterIds = request.filter?.journalAttributes?.length
      ? await this.journalAttributes?.filterItemIds(
          client as PrismaClient,
          request.filter.journalAttributes,
          request.lifecycle
        )
      : undefined
    return client.$transaction(
      (transaction) => this.searchLibrary(request, transaction, true, journalFilterIds),
      {
        timeout: 30_000
      }
    )
  }

  // The main-process agent adapter applies the existing MCP projection and output budget.
  // This entry point is not exposed by the renderer/Web search command.
  async searchForAgent(
    request: LiteratureCatalogSearchRequest & { scope: 'library' }
  ): Promise<LiteratureCatalogSearchPage> {
    const client = await this.getClient()
    const journalFilterIds = request.filter?.journalAttributes?.length
      ? await this.journalAttributes?.filterItemIds(
          client as PrismaClient,
          request.filter.journalAttributes,
          request.lifecycle
        )
      : undefined
    return client.$transaction(
      (transaction) => this.searchLibrary(request, transaction, false, journalFilterIds),
      { timeout: 30_000 }
    )
  }

  private async searchLibrary(
    request: LiteratureCatalogSearchRequest,
    client: Prisma.TransactionClient,
    boundResponse = true,
    journalFilterIds?: string[]
  ): Promise<LiteratureCatalogSearchPage> {
    const offset = Math.max(0, request.offset ?? 0)
    const limit = Math.min(100, Math.max(1, request.limit ?? 50))
    const filter = request.filter
    const query = normalizeSpace(request.query ?? '')
    const predicates: Prisma.Sql[] = [
      request.lifecycle === 'deleted'
        ? Prisma.sql`i."deletedAt" IS NOT NULL`
        : Prisma.sql`i."deletedAt" IS NULL`
    ]
    if (request.itemIds !== undefined) {
      predicates.push(
        request.itemIds.length
          ? Prisma.sql`selected.id IN (${Prisma.join(request.itemIds)})`
          : Prisma.sql`0 = 1`
      )
    }
    if (filter?.journalAttributes?.length)
      predicates.push(
        journalFilterIds?.length
          ? Prisma.sql`i.id IN (SELECT value FROM json_each(${JSON.stringify(journalFilterIds)}))`
          : Prisma.sql`0 = 1`
      )
    const contains = (column: Prisma.Sql, text: string): Prisma.Sql =>
      Prisma.sql`instr(${column}, ${normalizeSearchText(text)}) > 0`
    const creatorMatches = (text: string): Prisma.Sql => Prisma.sql`EXISTS (
      SELECT 1 FROM "LiteratureItemCreator" ic JOIN "LiteratureCreator" c ON c.id = ic."creatorId"
      WHERE ic."itemId" = i.id AND (${contains(Prisma.sql`c."normalizedName"`, text)}
        OR ${contains(Prisma.sql`c."normalizedDisplayName"`, text)}))`
    for (const text of [request.query, filter?.query].filter(
      (value): value is string => !!value?.trim()
    )) {
      const alternatives = [
        contains(Prisma.sql`i."normalizedTitle"`, text),
        contains(Prisma.sql`i."normalizedAbstract"`, text),
        contains(Prisma.sql`i."normalizedContainerTitle"`, text),
        creatorMatches(text)
      ]
      const identifiers = searchIdentifiers(normalizeSpace(text))
      if (identifiers.length)
        alternatives.push(Prisma.sql`EXISTS (
        SELECT 1 FROM "LiteratureIdentifier" identifier WHERE identifier."itemId" = i.id AND (
          ${Prisma.join(
            identifiers.map(
              ({ scheme, normalizedValue }) =>
                Prisma.sql`(identifier.scheme = ${scheme} AND identifier."normalizedValue" = ${normalizedValue})`
            ),
            ' OR '
          )}))`)
      predicates.push(Prisma.sql`(${Prisma.join(alternatives, ' OR ')})`)
    }
    if (filter?.creator?.trim()) predicates.push(creatorMatches(filter.creator))
    if (filter?.containerTitle?.trim())
      predicates.push(contains(Prisma.sql`i."normalizedContainerTitle"`, filter.containerTitle))
    const projectId = request.projectId ?? filter?.projectId
    if (projectId)
      predicates.push(
        Prisma.sql`EXISTS (SELECT 1 FROM "ProjectLiterature" p JOIN "Project" project ON project.id = p."projectId" WHERE p."itemId" = i.id AND p."projectId" = ${projectId} AND project."deletedAt" IS NULL AND NOT EXISTS (SELECT 1 FROM "ProjectDeletionIntent" d WHERE d."projectId" = project.id))`
      )
    const collectionId = request.collectionId ?? filter?.collectionId
    if (collectionId) {
      const members = await this.smart?.members(
        collectionId,
        client,
        request.smartFilter,
        request.smartDecisionSource
      )
      predicates.push(
        members === undefined
          ? Prisma.sql`EXISTS (SELECT 1 FROM "LiteratureCollectionItem" c WHERE c."itemId" = i.id AND c."collectionId" = ${collectionId})`
          : members.length
            ? Prisma.sql`i.id IN (SELECT value FROM json_each(${JSON.stringify(members)}))`
            : Prisma.sql`0 = 1`
      )
    }
    for (const tagId of new Set([
      ...(filter?.tagIds ?? []),
      ...(request.tagId ? [request.tagId] : [])
    ]))
      predicates.push(
        Prisma.sql`EXISTS (SELECT 1 FROM "TagAssignment" t WHERE t."resourceType" = 'literature.item' AND t."resourceId" = i.id AND t."tagId" = ${tagId})`
      )
    if (filter?.itemTypes?.length)
      predicates.push(Prisma.sql`i."itemType" IN (${Prisma.join(filter.itemTypes)})`)
    if (filter?.yearFrom !== undefined)
      predicates.push(Prisma.sql`i."issuedYear" >= ${filter.yearFrom}`)
    if (filter?.yearTo !== undefined)
      predicates.push(Prisma.sql`i."issuedYear" <= ${filter.yearTo}`)
    if (request.updatedAfter !== undefined)
      predicates.push(Prisma.sql`i."updatedAt" >= ${new Date(request.updatedAfter)}`)
    const hasFullText = request.entryKind === 'pdf' ? true : filter?.hasFullText
    if (hasFullText !== undefined)
      predicates.push(Prisma.sql`${hasFullText ? Prisma.empty : Prisma.sql`NOT`} EXISTS (
      SELECT 1 FROM "LiteratureAttachment" a JOIN "LiteratureAttachmentVersion" v ON v."attachmentId" = a.id WHERE a."itemId" = i.id)`)
    const where = Prisma.join(predicates, ' AND ')
    if (request.scope === 'global-search') {
      // Rank lightweight identities across both kinds, then hydrate only the requested page.
      const [papers, collections] = await Promise.all([
        request.entryKind === 'collection' || request.entryKind === 'note'
          ? []
          : client.$queryRaw<{ id: string; title: string; updatedAt: Date }[]>(
              Prisma.sql`SELECT i.id, i.title, i."updatedAt" FROM "LiteratureItem" i WHERE ${where}`
            ),
        request.entryKind && request.entryKind !== 'collection'
          ? []
          : client.literatureCollection.findMany({
              where: {
                ...(request.updatedAfter === undefined
                  ? {}
                  : { updatedAt: { gte: new Date(request.updatedAfter) } }),
                ...(request.projectId
                  ? {
                      AND: [
                        {
                          OR: [
                            {
                              id: {
                                in:
                                  (await this.smart?.matchingCollections(
                                    undefined,
                                    request.projectId,
                                    client
                                  )) ?? []
                              }
                            },
                            {
                              items: {
                                some: {
                                  item: {
                                    deletedAt: null,
                                    projects: {
                                      some: {
                                        projectId: request.projectId,
                                        project: await availableProjectWhere(client)
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          ]
                        }
                      ]
                    }
                  : {}),
                ...(query
                  ? { OR: [{ name: { contains: query } }, { description: { contains: query } }] }
                  : {})
              },
              select: { id: true, name: true, updatedAt: true }
            })
      ])
      // Search stored annotation text only; PDF bytes/rendering are never needed here.
      const includeNotes = !request.entryKind || request.entryKind === 'note'
      const quote = Prisma.sql`COALESCE(json_extract(a."selectorJson", '$.selector.exact'), json_extract(a."selectorJson", '$.selector.text'), '')`
      const needle = query.toLowerCase()
      const notePredicates = [
        Prisma.sql`(a.note <> '' OR ${quote} <> '')`,
        Prisma.sql`EXISTS (SELECT 1 FROM "PdfAnnotationSourceBinding" annotationSource WHERE annotationSource."documentId" = a."documentId" AND (
        (annotationSource."sourceKind" = 'literature-attachment-version' AND EXISTS (
          SELECT 1 FROM "LiteratureAttachmentVersion" v
          JOIN "LiteratureAttachment" attachment ON attachment.id = v."attachmentId"
          JOIN "LiteratureItem" item ON item.id = attachment."itemId"
          WHERE v.id = annotationSource."versionId" AND attachment.id = annotationSource."sourceFileId"
            AND item."deletedAt" IS NULL AND item."mergedIntoItemId" IS NULL
            ${
              projectId
                ? Prisma.sql`AND EXISTS (SELECT 1 FROM "ProjectLiterature" link
              JOIN "Project" project ON project.id = link."projectId"
              WHERE link."itemId" = item.id AND project.id = ${projectId}
                AND project."deletedAt" IS NULL AND NOT EXISTS (SELECT 1 FROM "ProjectDeletionIntent" d WHERE d."projectId" = project.id))`
                : Prisma.empty
            }
        )) OR (annotationSource."sourceKind" <> 'literature-attachment-version' AND EXISTS (
          SELECT 1 FROM "Project" project
          WHERE project.id = annotationSource."projectId"
            AND project."deletedAt" IS NULL
            AND NOT EXISTS (SELECT 1 FROM "ProjectDeletionIntent" d WHERE d."projectId" = project.id)
            ${projectId ? Prisma.sql`AND project.id = ${projectId}` : Prisma.empty}
        ))))`
      ]
      if (needle)
        notePredicates.push(
          Prisma.sql`(instr(lower(a.note), ${needle}) > 0 OR instr(lower(${quote}), ${needle}) > 0)`
        )
      if (request.updatedAfter !== undefined)
        notePredicates.push(Prisma.sql`a."updatedAt" >= ${new Date(request.updatedAfter)}`)
      const noteWhere = Prisma.join(notePredicates, ' AND ')
      const score =
        !needle || request.searchSort === 'recent'
          ? Prisma.sql`0`
          : Prisma.sql`CASE
        WHEN lower(a.note) = ${needle} OR lower(${quote}) = ${needle} THEN 3
        WHEN instr(lower(a.note), ${needle}) = 1 OR instr(lower(${quote}), ${needle}) = 1 THEN 2 ELSE 1 END`
      const [noteCount, notes] = includeNotes
        ? await Promise.all([
            client.$queryRaw<{ total: bigint }[]>(
              Prisma.sql`SELECT COUNT(*) AS total FROM "PdfAnnotation" a WHERE ${noteWhere}`
            ),
            request.countOnly
              ? []
              : client.$queryRaw<{ id: string; updatedAt: Date; score: number }[]>(Prisma.sql`
          SELECT a.id, a."updatedAt", ${score} AS score FROM "PdfAnnotation" a WHERE ${noteWhere}
          ORDER BY score DESC, a."updatedAt" DESC, a.id ASC LIMIT ${offset + limit}`)
          ])
        : [[], []]
      const totalCount = papers.length + collections.length + Number(noteCount[0]?.total ?? 0)
      const ranked = [
        ...papers.map((item) => ({
          id: item.id,
          title: item.title,
          updatedAt: item.updatedAt.getTime(),
          kind: 'paper' as const,
          score: request.searchSort === 'recent' ? 0 : searchTitleRank(item.title, query)
        })),
        ...collections.map((item) => ({
          id: item.id,
          title: item.name,
          updatedAt: item.updatedAt.getTime(),
          kind: 'collection' as const,
          score: request.searchSort === 'recent' ? 0 : searchTitleRank(item.name, query)
        })),
        ...notes.map((note) => ({
          ...note,
          updatedAt: note.updatedAt.getTime(),
          score: Number(note.score),
          kind: 'note' as const
        }))
      ].sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      if (request.countOnly) return { entries: [], totalCount }
      const page = ranked.slice(offset, offset + limit)
      const paperIds = page.filter((item) => item.kind === 'paper').map((item) => item.id)
      const selectedPapers = paperIds.length
        ? await client.literatureItem.findMany({
            where: { id: { in: paperIds } },
            include: await activeItemInclude(client)
          })
        : []
      const paperViews = new Map(
        (await this.itemViews(selectedPapers, client)).map((item) => [item.id, item])
      )
      const collectionIds = page.filter((item) => item.kind === 'collection').map((item) => item.id)
      const selectedCollections = collectionIds.length
        ? await client.literatureCollection.findMany({
            where: { id: { in: collectionIds } },
            include: {
              smart: true,
              _count: {
                select: { items: { where: { item: { deletedAt: null, mergedIntoItemId: null } } } }
              }
            }
          })
        : []
      const collectionViews = new Map(
        await Promise.all(
          selectedCollections.map(async (row) => {
            const members = row.smart ? await this.smart?.members(row.id, client) : undefined
            return [
              row.id,
              {
                revision: row.revision,
                id: row.id,
                name: row.name,
                description: row.description,
                parentId: row.parentId ?? undefined,
                smart: members !== undefined,
                smartScope: row.smart
                  ? smartScopeSchema.parse({
                      kind: row.smart.scopeKind,
                      ...(row.smart.scopeId ? { id: row.smart.scopeId } : {})
                    })
                  : undefined,
                smartEvidenceMode: row.smart
                  ? smartEvidenceModeSchema.parse(row.smart.evidenceMode)
                  : undefined,
                smartAutoUpdate: row.smart?.autoUpdate,
                itemCount: members?.length ?? row._count.items,
                createdAt: row.createdAt.getTime(),
                updatedAt: row.updatedAt.getTime()
              }
            ] as const
          })
        )
      )
      const noteIds = page.filter((item) => item.kind === 'note').map((item) => item.id)
      const noteViews = new Map(
        (noteIds.length
          ? await readAnnotations(
              client,
              await client.pdfAnnotation.findMany({ where: { id: { in: noteIds } } }),
              projectId
            )
          : []
        ).map((annotation) => [annotation.id, { id: annotation.id, annotation }])
      )
      const entries = page.flatMap(
        (
          item
        ): (LiteratureItemView | LiteratureCollectionView | LiteratureAnnotationSearchView)[] => {
          const view =
            item.kind === 'paper'
              ? paperViews.get(item.id)
              : item.kind === 'note'
                ? noteViews.get(item.id)
                : collectionViews.get(item.id)
          return view ? [view] : []
        }
      )
      const bounded = boundedLiteraturePage(
        entries,
        0,
        limit,
        (row) =>
          new ApplicationCommandError('command-failed', LITERATURE_OVERSIZED_REFERENCE + row.id)
      )
      const nextOffset = offset + bounded.entries.length
      return {
        entries: bounded.entries,
        totalCount,
        nextOffset: nextOffset < totalCount ? nextOffset : undefined
      }
    }

    const direction =
      (request.sortDirection ?? (request.sortBy === 'title' ? 'asc' : 'desc')) === 'asc'
        ? Prisma.sql`ASC`
        : Prisma.sql`DESC`
    const orderBy =
      request.sortBy === 'title'
        ? Prisma.sql`i.title ${direction}, i.id ASC`
        : request.sortBy === 'year'
          ? Prisma.sql`i."issuedYear" IS NULL ASC, i."issuedYear" ${direction}, i.title ASC, i.id ASC`
          : request.sortBy === 'rating'
            ? Prisma.sql`i.rating ${direction}, i.title ASC, i.id ASC`
            : request.sortBy === 'created'
              ? Prisma.sql`i."createdAt" ${direction}, i.id ASC`
              : Prisma.sql`i."updatedAt" ${direction}, i.id ASC`
    // Selected IDs follow getMany's alias contract: filter survivor metadata, return requested IDs.
    const from =
      request.itemIds === undefined
        ? Prisma.sql`"LiteratureItem" i`
        : Prisma.sql`"LiteratureItem" selected JOIN "LiteratureItem" i
          ON i.id = COALESCE(selected."mergedIntoItemId", selected.id)`
    const requestedId = request.itemIds === undefined ? Prisma.sql`i.id` : Prisma.sql`selected.id`
    if (request.countOnly) {
      const [count] = await client.$queryRaw<{ total: bigint }[]>(
        Prisma.sql`SELECT COUNT(*) AS total FROM ${from} WHERE ${where}`
      )
      return { entries: [], totalCount: Number(count!.total) }
    }
    const ids = await client.$queryRaw<
      { id: string; requestedId: string }[]
    >(Prisma.sql`SELECT i.id, ${requestedId} AS "requestedId" FROM ${from} WHERE ${where} ORDER BY ${orderBy}, ${requestedId} ASC
      ${request.allItemIds ? Prisma.empty : Prisma.sql`LIMIT ${limit} OFFSET ${offset}`}`)
    const itemIds = ids.map(({ id }) => id)
    if (request.allItemIds)
      return {
        entries: [],
        itemIds: ids.map(({ requestedId }) => requestedId),
        totalCount: ids.length
      }
    const [count] = await client.$queryRaw<{ total: bigint }[]>(
      Prisma.sql`SELECT COUNT(*) AS total FROM ${from} WHERE ${where}`
    )
    const totalCount = Number(count!.total)
    const rows = itemIds.length
      ? await client.literatureItem.findMany({
          where: { id: { in: itemIds } },
          include: await activeItemInclude(client)
        })
      : []
    const byId = new Map((await this.itemViews(rows, client)).map((row) => [row.id, row]))
    const decisions = new Map(
      (collectionId
        ? ((await this.smart?.decisions(collectionId, itemIds, client)) ?? [])
        : []
      ).map((row) => [row.id, row])
    )
    const entries = ids.map(({ id, requestedId }) => ({
      ...byId.get(id)!,
      ...(decisions.has(id) ? { smartDecision: decisions.get(id) } : {}),
      id: requestedId
    }))
    const page = boundResponse
      ? boundedLiteraturePage(
          entries,
          0,
          limit,
          (row) =>
            new ApplicationCommandError('command-failed', LITERATURE_OVERSIZED_REFERENCE + row.id)
        )
      : { entries }
    return {
      entries: page.entries,
      totalCount,
      nextOffset:
        offset + page.entries.length < totalCount ? offset + page.entries.length : undefined
    }
  }

  private async itemViews(
    rows: LiteratureItemRow[],
    client?: Prisma.TransactionClient
  ): Promise<LiteratureItemView[]> {
    const memberships = await this.smart?.memberships(
      rows.map((row) => row.id),
      client
    )
    return rows.map((row) => {
      const view = toItemView(row)
      return {
        ...view,
        collectionIds: [...view.collectionIds, ...(memberships?.get(row.id) ?? [])]
      }
    })
  }

  async exportRecord(
    request: LiteratureExportRecordRequest
  ): Promise<LiteratureExportRecordResult> {
    const client = await this.getClient()
    // Export the retained record itself, including Trash metadata and merge provenance.
    // Normal get() deliberately hides deleted records and follows active aliases.
    const row = await client.literatureItem.findUnique({
      where: { id: request.itemId },
      include: await activeItemInclude(client)
    })
    if (!row) throw new Error('Reference unavailable')
    const content = JSON.stringify((await this.itemViews([row]))[0])
    const digest = createHash('sha256').update(content).digest('hex')
    const offset = request.offset ?? 0
    if ((offset > 0 && !request.digest) || (request.digest && request.digest !== digest))
      throw new Error('Reference changed during export. Try again.')
    if (offset >= content.length) throw new Error('Invalid reference export offset.')
    // Offsets are UTF-16 code units. Concatenate chunks before encoding the complete JSON so
    // supplementary Unicode characters split at a chunk boundary remain lossless.
    const end = Math.min(content.length, offset + 262144)
    return {
      chunk: content.slice(offset, end),
      digest,
      nextOffset: end < content.length ? end : undefined
    }
  }

  async getCandidateStates(
    request: LiteratureCandidateStatesRequest
  ): Promise<LiteratureCandidateStatesResult> {
    const { candidateIds } = literatureCandidateStatesRequestSchema.parse(request)
    const client = await this.getClient()
    const rows = await client.literatureInboxCandidate.findMany({
      where: { id: { in: [...new Set(candidateIds)] } },
      select: {
        id: true,
        state: true,
        acceptedItem: {
          select: {
            id: true,
            deletedAt: true,
            mergedInto: { select: { id: true, deletedAt: true } }
          }
        }
      }
    })
    return literatureCandidateStatesResultSchema.parse({
      candidates: rows.map((row) => {
        const item = row.acceptedItem?.mergedInto ?? row.acceptedItem
        return {
          candidateId: row.id,
          state: row.state,
          ...(row.state === 'accepted' && item && !item.deletedAt
            ? { acceptedItemId: item.id }
            : {})
        }
      })
    })
  }

  async get(itemId: string): Promise<LiteratureItemView | undefined> {
    const client = await this.getClient()
    const requested = await client.literatureItem.findUnique({
      where: { id: itemId },
      include: await activeItemInclude(client)
    })
    const row = requested?.mergedIntoItemId
      ? await client.literatureItem.findFirst({
          where: { id: requested.mergedIntoItemId, deletedAt: null },
          include: await activeItemInclude(client)
        })
      : requested?.deletedAt
        ? undefined
        : requested
    return row ? (await this.itemViews([row]))[0] : undefined
  }

  async sources(itemId: string): Promise<LiteratureSourceRecordView[]> {
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      const requested = await transaction.literatureItem.findUnique({ where: { id: itemId } })
      const item = requested?.mergedIntoItemId
        ? await transaction.literatureItem.findUnique({ where: { id: requested.mergedIntoItemId } })
        : requested
      if (!item || item.deletedAt) throw new Error('Literature Item is unavailable.')
      const rows = await transaction.literatureSourceRecord.findMany({
        where: { itemId: item.id },
        orderBy: [{ fetchedAt: 'desc' }, { id: 'asc' }]
      })
      return rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        externalId: row.externalId ?? undefined,
        sourceUrl: row.sourceUrl ?? undefined,
        rawMetadata: JSON.parse(row.rawMetadataJson) as Record<string, unknown>,
        savedAt: row.fetchedAt.getTime()
      }))
    })
  }

  async getMany(itemIds: readonly string[]): Promise<LiteratureItemView[]> {
    const ids = [...new Set(itemIds.map(normalizeSpace).filter(Boolean))]
    if (ids.length === 0) return []
    const client = await this.getClient()
    const requestedRows = await client.literatureItem.findMany({
      where: { id: { in: ids } },
      include: await activeItemInclude(client)
    })
    const requestedById = new Map(requestedRows.map((row) => [row.id, row]))
    const survivorIds = requestedRows.flatMap((row) =>
      row.mergedIntoItemId ? [row.mergedIntoItemId] : []
    )
    const survivors =
      survivorIds.length === 0
        ? []
        : await client.literatureItem.findMany({
            where: { id: { in: survivorIds }, deletedAt: null },
            include: await activeItemInclude(client)
          })
    const survivorsById = new Map(survivors.map((row) => [row.id, row]))
    const views = new Map(
      (await this.itemViews([...requestedRows, ...survivors])).map((row) => [row.id, row])
    )
    return ids.flatMap((id) => {
      const requested = requestedById.get(id)
      const resolved = requested?.mergedIntoItemId
        ? survivorsById.get(requested.mergedIntoItemId)
        : requested?.deletedAt
          ? undefined
          : requested
      return resolved ? [{ ...views.get(resolved.id)!, id }] : []
    })
  }

  async getMetadataCommitReceipt(operationId: string): Promise<{
    operationId: string
    itemId: string
    expectedMetadataRevision: number
    committedMetadataRevision: number
  } | null> {
    const client = await this.getClient()
    return client.$transaction((transaction) =>
      transaction.literatureMetadataCommitReceipt.findUnique({ where: { operationId } })
    )
  }

  async applyMetadata(input: ApplyLiteratureMetadataInput): Promise<LiteratureItemView> {
    await this.updateItem(
      {
        kind: 'update-item',
        itemId: input.itemId,
        expectedMetadataRevision: input.expectedMetadataRevision,
        item: input.item
      },
      input.sources ?? [input.source],
      input.operationId
    )
    const updated = await this.get(input.itemId)
    if (!updated) throw new Error('Literature Item is unavailable.')
    return updated
  }

  async findItemByPdf(
    checksum: string,
    sizeBytes: number
  ): Promise<LiteratureItemView | undefined> {
    const client = await this.getClient()
    const version = await client.literatureAttachmentVersion.findFirst({
      where: {
        checksum,
        sizeBytes: BigInt(sizeBytes),
        attachment: { item: { deletedAt: null, mergedIntoItemId: null } }
      },
      select: { attachment: { select: { itemId: true } } },
      orderBy: { id: 'asc' }
    })
    return version ? ((await this.get(version.attachment.itemId)) ?? undefined) : undefined
  }

  async attachContent(
    input: AttachLiteratureContentInput,
    onAttached?: (
      transaction: Prisma.TransactionClient,
      result: AttachedLiteratureContent
    ) => Promise<void>,
    newItem?: LiteratureItemInput
  ): Promise<AttachedLiteratureContent> {
    const provenanceJson = input.provenance
      ? canonicalJson(literaturePdfProvenanceSchema.parse(input.provenance))
      : null
    const itemId = normalizeSpace(input.itemId)
    const kind = normalizeSpace(input.kind ?? 'fullText')
    const filename = normalizeSpace(input.filename)
    const contentType = normalizeSpace(input.contentType).toLowerCase()
    if (!itemId || !kind || !filename || !contentType) {
      throw new Error('Literature attachment metadata is incomplete.')
    }
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
      throw new Error('Literature attachment size is invalid.')
    }
    if (!/^[a-f0-9]{64}$/u.test(input.checksum)) {
      throw new Error('Literature attachment checksum is invalid.')
    }
    if (
      input.pageCount !== undefined &&
      (!Number.isSafeInteger(input.pageCount) || input.pageCount < 1)
    ) {
      throw new Error('Literature attachment page count is invalid.')
    }

    const client = await this.getClient()
    return this.commit(
      client,
      async (transaction) => {
        const finish = async (
          result: AttachedLiteratureContent
        ): Promise<AttachedLiteratureContent> => {
          await bindLiteraturePdfVersion(transaction, result.versionId)
          await onAttached?.(transaction, result)
          return result
        }
        const blob = await transaction.contentBlob.findUnique({
          where: { id: input.contentBlobId }
        })
        if (
          !blob ||
          blob.state !== 'available' ||
          blob.checksum !== input.checksum ||
          blob.sizeBytes !== BigInt(input.sizeBytes) ||
          (blob.contentType !== null && blob.contentType !== contentType)
        ) {
          throw new Error('Literature attachment bytes do not match the content authority.')
        }
        if (newItem) {
          // Recheck inside the writing transaction: independent windows may both have observed
          // an empty catalog before asking to add the same PDF.
          const duplicate = await transaction.literatureAttachmentVersion.findFirst({
            where: {
              checksum: input.checksum,
              sizeBytes: BigInt(input.sizeBytes),
              attachment: { item: { deletedAt: null, mergedIntoItemId: null } }
            },
            include: { attachment: { select: { itemId: true } } },
            orderBy: { id: 'asc' }
          })
          if (duplicate)
            return finish({
              attachmentId: duplicate.attachmentId,
              versionId: duplicate.id,
              itemId: duplicate.attachment.itemId
            })
          if (!(await transaction.literatureItem.findUnique({ where: { id: itemId } })))
            await createItem(transaction, literatureItemInputSchema.parse(newItem), itemId)
        }
        const item = await transaction.literatureItem.findFirst({
          where: { id: itemId, deletedAt: null },
          select: { id: true, metadataRevision: true }
        })
        if (!item) throw new Error('Literature Item is unavailable.')
        if (
          input.expectedMetadataRevision !== undefined &&
          item.metadataRevision !== input.expectedMetadataRevision
        ) {
          throw new Error('Literature Item changed before the PDF could be attached.')
        }

        if (!input.attachmentId) {
          const existingItemVersion = await transaction.literatureAttachmentVersion.findFirst({
            where: { checksum: input.checksum, attachment: { itemId } },
            select: { id: true, attachmentId: true }
          })
          if (existingItemVersion) {
            return finish({
              attachmentId: existingItemVersion.attachmentId,
              versionId: existingItemVersion.id
            })
          }
        }

        const attachment = input.attachmentId
          ? await transaction.literatureAttachment.findFirst({
              where: { id: input.attachmentId, itemId },
              select: { id: true }
            })
          : await transaction.literatureAttachment.create({
              data: {
                itemId,
                kind,
                title: input.title?.trim() ?? '',
                sortOrder: await transaction.literatureAttachment.count({ where: { itemId } })
              },
              select: { id: true }
            })
        if (!attachment) throw new Error('Literature Attachment is unavailable.')

        const existing = await transaction.literatureAttachmentVersion.findUnique({
          where: {
            attachmentId_checksum: { attachmentId: attachment.id, checksum: input.checksum }
          },
          select: { id: true }
        })
        if (existing) {
          return finish({ attachmentId: attachment.id, versionId: existing.id })
        }
        const latest = await transaction.literatureAttachmentVersion.findFirst({
          where: { attachmentId: attachment.id },
          orderBy: { versionNumber: 'desc' },
          select: { versionNumber: true }
        })
        const version = await transaction.literatureAttachmentVersion.create({
          data: {
            attachmentId: attachment.id,
            contentBlobId: blob.id,
            versionNumber: (latest?.versionNumber ?? 0) + 1,
            filename,
            contentType,
            sizeBytes: BigInt(input.sizeBytes),
            checksum: input.checksum,
            pageCount: input.pageCount,
            provenanceJson
          },
          select: { id: true }
        })
        return finish({ attachmentId: attachment.id, versionId: version.id })
      },
      (result) => ({ itemIds: [result.itemId ?? itemId] })
    )
  }

  async transact(command: LiteratureCatalogCommand): Promise<LiteratureCatalogReceipt> {
    if (
      command.kind === 'read-smart-run-progress' ||
      command.kind === 'read-smart-history' ||
      command.kind === 'read-smart-decisions' ||
      command.kind === 'create-smart-collection' ||
      command.kind === 'smart-collection' ||
      command.kind === 'preview-smart-collection' ||
      command.kind === 'cancel-smart-preview'
    ) {
      if (!this.smart) throw new Error('Smart collections are unavailable.')
      return this.smart.execute(command)
    }
    try {
      return await this.execute(command)
    } finally {
      if (
        [
          'create-item',
          'update-item',
          'accept-candidate',
          'settle-candidates',
          'set-item-lifecycle',
          'delete-items-permanently',
          'merge-items',
          'merge-duplicates'
        ].includes(command.kind) &&
        (command.kind !== 'merge-duplicates' || command.mode !== 'preview')
      )
        duplicateGroups.delete(await this.getClient())
    }
  }
  private async deleteAttachment(
    command: Extract<LiteratureCatalogCommand, { kind: 'delete-attachment' }>
  ): Promise<LiteratureCatalogReceipt> {
    if (!this.content) throw new Error('Literature content operations are unavailable.')
    // The session barrier protects reference confirmation and the deletion transaction only.
    const { contentIds, annotationsDeleted, sourceBindingsDeleted } =
      await this.withAttachmentRemoval((assertUnreferenced) =>
        this.deleteUnreferencedAttachment(command, assertUnreferenced)
      )
    // Source removal also changes the tagged note's navigation route while its bytes are retained.
    let tagsChanged = annotationsDeleted > 0 || sourceBindingsDeleted > 0
    let cleanupPending = false
    try {
      const sweep = await this.content.sweep({
        contentIds,
        createdBefore: new Date(Date.now() + 1)
      })
      cleanupPending = sweep.failedIds.length > 0
      // Verified PDF notes survive source removal while their blob still exists. The sweep can
      // remove their tag assignments when it deletes the last blob, after the catalog commit.
      tagsChanged ||= sweep.removedIds.length > 0
    } catch {
      cleanupPending = true
    }
    if (tagsChanged) await this.publishTagAssignmentsChanged()
    return { kind: 'item', id: command.itemId, state: 'unlinked', cleanupPending }
  }

  private async deleteUnreferencedAttachment(
    command: Extract<LiteratureCatalogCommand, { kind: 'delete-attachment' }>,
    assertUnreferenced: (attachmentIds: readonly string[]) => void
  ): Promise<{ contentIds: string[]; annotationsDeleted: number; sourceBindingsDeleted: number }> {
    const client = await this.getClient()
    return this.commit(
      client,
      async (transaction) => {
        const attachment = await transaction.literatureAttachment.findFirst({
          where: {
            id: command.attachmentId,
            itemId: command.itemId,
            item: { deletedAt: null, mergedIntoItemId: null }
          },
          select: { versions: { select: { contentBlobId: true } } }
        })
        if (!attachment) throw new Error('Literature Attachment is unavailable.')
        assertUnreferenced([command.attachmentId])
        const sourceScope = {
          sourceKind: 'literature-attachment-version',
          sourceFileId: command.attachmentId
        }
        const sourceBindingsDeleted = await transaction.pdfAnnotationSourceBinding.count({
          where: sourceScope
        })
        const annotationsDeleted = await deletePdfAnnotations(transaction, sourceScope)
        await transaction.literatureAttachment.delete({ where: { id: command.attachmentId } })
        return {
          contentIds: attachment.versions.map(({ contentBlobId }) => contentBlobId),
          annotationsDeleted,
          sourceBindingsDeleted
        }
      },
      { itemIds: [command.itemId] }
    )
  }

  private async verifyAttachment(
    command: Extract<LiteratureCatalogCommand, { kind: 'verify-attachment' }>
  ): Promise<LiteratureCatalogReceipt> {
    if (!this.content) throw new Error('Literature content operations are unavailable.')
    const client = await this.getClient()
    const version = await client.literatureAttachmentVersion.findFirst({
      where: {
        id: command.versionId,
        attachment: { itemId: command.itemId, item: { deletedAt: null, mergedIntoItemId: null } }
      },
      select: { contentBlobId: true }
    })
    if (!version) throw new Error('Literature Attachment is unavailable.')
    const verification = await this.content
      .verify(version.contentBlobId, { retry: true })
      .catch((error: unknown) => {
        // Content verification persists permission-denied observations before rethrowing the OS error.
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error.code === 'EACCES' || error.code === 'EPERM')
        ) {
          this.publishChanged({ itemIds: [command.itemId] })
        }
        throw error
      })
    // Verification persists its observation before returning, including an unavailable result.
    // This invalidates that committed observation; it is not a successful verification notice.
    this.publishChanged({ itemIds: [command.itemId] })
    if (verification.state === 'unavailable') {
      throw new Error(`Literature attachment verification failed: ${verification.reason}`)
    }
    return { kind: 'item', id: command.itemId, state: 'present' }
  }

  private execute(command: LiteratureCatalogCommand): Promise<LiteratureCatalogReceipt> {
    switch (command.kind) {
      case 'delete-attachment':
        return this.deleteAttachment(command)
      case 'verify-attachment':
        return this.verifyAttachment(command)
      case 'stage-candidate':
        return this.stageCandidate(command.candidate)
      case 'create-item':
        return this.createManualItem(command.item, command.duplicatePolicy)
      case 'merge-duplicates':
        return this.mergeDuplicates(command)
      case 'update-item':
        return this.updateItem(command)
      case 'accept-candidate':
        return this.acceptCandidate(command.candidateId)
      case 'dismiss-candidate':
        return this.dismissCandidate(command.candidateId)
      case 'settle-candidates':
        return this.settleCandidates(command)
      case 'restore-candidates':
        return this.restoreCandidates(command.candidateIds)
      case 'read-smart-run-progress':
      case 'read-smart-history':
      case 'read-smart-decisions':
      case 'preview-smart-collection':
      case 'cancel-smart-preview':
      case 'create-smart-collection':
      case 'smart-collection':
        throw new Error('Smart collection commands require their owner.')
      case 'create-collection':
        return this.createCollection(command.name, command.description, command.parentId)
      case 'update-collection':
        return this.updateCollection(command)
      case 'delete-collection':
        return this.deleteCollection(command.collectionId)
      case 'set-collection-item':
        return this.setCollectionItem(command)
      case 'set-project-item':
        return this.setProjectItem(command)
      case 'set-project-items':
        return this.setProjectItems(command)
      case 'set-item-lifecycle':
        return this.setItemLifecycle(command)
      case 'delete-items-permanently':
        return this.deleteItemsPermanently(command)
      case 'move-collection-items':
        return this.moveCollectionItems(command)
      case 'merge-items':
        return this.mergeItems(command)
    }
  }

  async importItems(
    inputs: readonly LiteratureItemInput[],
    collectionId?: string,
    duplicatePolicy: LiteratureDuplicatePolicy = 'reuse'
  ): Promise<LiteratureRecordImportReceipt> {
    const client = await this.getClient()
    return this.commit(
      client,
      (tx) => this.domain(tx).importItems(inputs, collectionId, duplicatePolicy),
      (result) => ({
        itemIds: result.itemIds,
        collectionIds: collectionId ? [collectionId] : undefined
      }),
      { timeout: 60_000 }
    ).finally(() => duplicateGroups.delete(client))
  }

  async inspectImportItems(
    inputs: readonly LiteratureItemInput[],
    errors: readonly LiteratureRecordImportError[],
    parserWarnings: readonly LiteratureRecordImportEntry['warnings'][] = []
  ): Promise<LiteratureRecordImportEntry[]> {
    const client = await this.getClient()
    return client.$transaction((tx) =>
      this.domain(tx).inspectImportItems(inputs, errors, parserWarnings)
    )
  }

  private async createManualItem(
    input: LiteratureItemInput,
    duplicatePolicy?: LiteratureDuplicatePolicy
  ): Promise<LiteratureCatalogReceipt> {
    const receipt = await this.importItems([input], undefined, duplicatePolicy)
    return { kind: 'item', id: receipt.itemIds[0], state: 'present' }
  }

  private async updateItem(
    command: Extract<LiteratureCatalogCommand, { kind: 'update-item' }>,
    sources: readonly LiteratureSourceInput[] = [],
    operationId?: string
  ): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    return this.commit(client, (tx) => this.domain(tx).updateItem(command, sources, operationId), {
      itemIds: [normalizeSpace(command.itemId)]
    }).finally(() => duplicateGroups.delete(client))
  }

  private async stageCandidate(
    input: LiteratureCandidateInput,
    pdf?: Omit<AttachLiteratureContentInput, 'itemId'> & { pageCount: number; sourceUrl: string },
    signal?: AbortSignal
  ): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    return this.commit(
      client,
      (tx) => this.domain(tx).stageCandidate(input, pdf, signal),
      (result) =>
        result.kind === 'item' ? { itemIds: [result.id] } : { candidateIds: [result.id] }
    )
  }

  private async acceptCandidate(candidateId: string): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    return this.commit(
      client,
      (transaction) => this.domain(transaction).acceptCandidate(candidateId),
      (result) => ({
        candidateIds: [candidateId],
        itemIds: result.kind === 'item' ? [result.id] : undefined
      })
    )
  }

  async stageAcquiredPdf(
    candidate: LiteratureCandidateInput,
    pdf: Omit<AttachLiteratureContentInput, 'itemId'> & { pageCount: number; sourceUrl: string },
    signal?: AbortSignal
  ): Promise<LiteratureCatalogReceipt> {
    return this.stageCandidate(candidate, pdf, signal)
  }

  private async dismissCandidate(candidateId: string): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    const updated = await this.commit(
      client,
      (transaction) =>
        transaction.literatureInboxCandidate.updateMany({
          where: { id: candidateId, state: 'pending' },
          data: { state: 'dismissed', settledAt: new Date() }
        }),
      { candidateIds: [candidateId] }
    )
    if (updated.count === 0) throw new Error('Literature Inbox candidate is not pending.')
    return { kind: 'candidate', id: candidateId, state: 'dismissed' }
  }

  private async settleCandidates(
    command: Extract<LiteratureCatalogCommand, { kind: 'settle-candidates' }>
  ): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    return this.commit(
      client,
      (tx) => this.domain(tx).settleCandidates(command.candidateIds, command.state),
      { candidateIds: command.candidateIds }
    )
  }

  private async restoreCandidates(
    candidateIds: readonly string[]
  ): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    return this.commit(client, (tx) => this.domain(tx).restoreCandidates(candidateIds), {
      candidateIds
    })
  }

  private async createCollection(
    nameInput: string,
    descriptionInput?: string,
    parentId?: string
  ): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    return this.commit(
      client,
      (tx) => this.domain(tx).createCollection(nameInput, descriptionInput, parentId),
      (result) => ({ collectionIds: [result.id] })
    ).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new Error(LITERATURE_COLLECTION_NAME_CONFLICT)
      throw error
    })
  }

  private async updateCollection(
    command: Extract<LiteratureCatalogCommand, { kind: 'update-collection' }>
  ): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    const result = await this.commit(client, (tx) => this.domain(tx).updateCollection(command), {
      collectionIds: [command.collectionId]
    }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new Error(LITERATURE_COLLECTION_NAME_CONFLICT)
      throw error
    })
    await this.smart
      ?.ruleUpdated(command.collectionId)
      .catch((error) =>
        log.warn('Could not notify the running smart collection after saving its rule', { error })
      )
    return result
  }

  private async deleteCollection(collectionId: string): Promise<LiteratureCatalogReceipt> {
    if (this.smart)
      return this.smart.deleteCollection(collectionId, () => this.removeCollection(collectionId))
    return this.removeCollection(collectionId)
  }

  private async removeCollection(collectionId: string): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    return this.commit(client, (tx) => this.domain(tx).removeCollection(collectionId), {
      collectionIds: [collectionId]
    }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new Error(LITERATURE_COLLECTION_NAME_CONFLICT)
      throw error
    })
  }

  private async setCollectionItem(
    command: Extract<LiteratureCatalogCommand, { kind: 'set-collection-item' }>
  ): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    return this.commit(client, (tx) => this.domain(tx).setCollectionItem(command), {
      itemIds: [command.itemId],
      collectionIds: [command.collectionId]
    })
  }

  private async setProjectItem(
    command: Extract<LiteratureCatalogCommand, { kind: 'set-project-item' }>
  ): Promise<LiteratureCatalogReceipt> {
    return this.setProjectItems({
      ...command,
      kind: 'set-project-items',
      itemIds: [command.itemId]
    })
  }

  private async setProjectItems(
    command: Extract<LiteratureCatalogCommand, { kind: 'set-project-items' }>
  ): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    return this.commit(client, (tx) => this.domain(tx).setProjectItems(command), {
      itemIds: [...new Set(command.itemIds)]
    })
  }

  private async setItemLifecycle(
    command: Extract<LiteratureCatalogCommand, { kind: 'set-item-lifecycle' }>
  ): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    return this.commit(client, (tx) => this.domain(tx).setItemLifecycle(command), {
      itemIds: [...new Set(command.itemIds)]
    })
  }

  async contentBlobIdsForItems(itemIds: readonly string[]): Promise<string[]> {
    const uniqueItemIds = [...new Set(itemIds)]
    if (uniqueItemIds.length === 0) return []
    const client = await this.getClient()
    const items = await client.literatureItem.findMany({
      where: { id: { in: uniqueItemIds } },
      select: {
        attachments: {
          select: { versions: { select: { contentBlobId: true } } }
        }
      }
    })
    return [
      ...new Set(
        items.flatMap(({ attachments }) =>
          attachments.flatMap(({ versions }) => versions.map(({ contentBlobId }) => contentBlobId))
        )
      )
    ]
  }

  private async deleteItemsPermanently(
    command: Extract<LiteratureCatalogCommand, { kind: 'delete-items-permanently' }>
  ): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    const result = await this.withAttachmentRemoval((assert) =>
      this.commit(client, (tx) => this.domain(tx, assert).deleteItemsPermanently(command.itemIds), {
        itemIds: [...new Set(command.itemIds)]
      })
    )
    if (result.tagsChanged) await this.publishTagAssignmentsChanged()
    return result.receipt
  }

  private async moveCollectionItems(
    command: Extract<LiteratureCatalogCommand, { kind: 'move-collection-items' }>
  ): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    return this.commit(client, (tx) => this.domain(tx).moveCollectionItems(command), {
      itemIds: [...new Set(command.itemIds)],
      collectionIds: [
        command.targetCollectionId,
        ...(command.sourceCollectionId ? [command.sourceCollectionId] : [])
      ]
    })
  }

  private async mergeItems(
    command: Extract<LiteratureCatalogCommand, { kind: 'merge-items' }>
  ): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    const result = await this.commit(
      client,
      (transaction) => this.mergeItemsInTransaction(transaction, command),
      { itemIds: [command.survivorId, ...command.duplicateIds] }
    )
    if (result.tagsChanged) await this.publishTagAssignmentsChanged()
    return result.receipt
  }

  private async mergeDuplicates(
    command: Extract<LiteratureCatalogCommand, { kind: 'merge-duplicates' }>
  ): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    return mergeLiteratureDuplicates(command, async (ids, work) => {
      const merged = await this.commit(client, (tx) => work(this.domain(tx)), { itemIds: ids })
      if (merged?.tagsChanged) await this.publishTagAssignmentsChanged()
      return merged
    })
  }

  private mergeItemsInTransaction(
    transaction: Prisma.TransactionClient,
    command: Extract<LiteratureCatalogCommand, { kind: 'merge-items' }>
  ): Promise<{ receipt: LiteratureCatalogReceipt; tagsChanged: boolean }> {
    return this.domain(transaction).mergeItems(command)
  }

  private domain(
    transaction: Prisma.TransactionClient,
    assertAttachmentsUnreferenced: (ids: readonly string[]) => void = (ids) => {
      if (ids.length) throw new Error('Literature attachment removal is unavailable.')
    }
  ): LibraryTransaction {
    const store: LibraryStore = {
      collectionState: (id) =>
        transaction.literatureCollection.findUnique({
          where: { id },
          select: {
            description: true,
            smart: { select: { scopeKind: true, scopeId: true, evidenceMode: true } }
          }
        }),
      lastSiblingOrder: async (parentId) =>
        (
          await transaction.literatureCollection.findFirst({
            where: { parentId: parentId ?? null },
            orderBy: { sortOrder: 'desc' },
            select: { sortOrder: true }
          })
        )?.sortOrder ?? -1,
      createCollection: async (input) =>
        (
          await transaction.literatureCollection.create({
            data: { ...input, nameKey: input.name.toLowerCase() },
            select: { id: true }
          })
        ).id,
      updateCollection: async (id, revision, input) =>
        (
          await transaction.literatureCollection.updateMany({
            where: { id, revision },
            data: { ...input, nameKey: input.name.toLowerCase(), revision: { increment: 1 } }
          })
        ).count,
      scopeAvailable: async (scope) =>
        this.smart ? Boolean(await this.smart.scope(transaction, scope)) : false,
      updateSmartCollection: async (collectionId, input) => {
        await transaction.literatureSmartCollection.update({
          where: { collectionId },
          data: {
            ...(input.ruleChanged ? { ruleRevision: { increment: 1 } } : {}),
            ...(input.evidenceMode !== undefined ? { evidenceMode: input.evidenceMode } : {}),
            ...(input.autoUpdate !== undefined ? { autoUpdate: input.autoUpdate } : {}),
            ...(input.scope
              ? {
                  scopeKind: input.scope.kind,
                  scopeId: input.scope.kind === 'library' ? null : input.scope.id
                }
              : {})
          }
        })
      },
      saveSmartRuleVersion: (id) => saveSmartRuleVersion(transaction, id),
      removeCollection: async (id) => {
        await transaction.literatureCollection.updateMany({
          where: { parentId: id },
          data: { revision: { increment: 1 } }
        })
        await transaction.literatureCollection.delete({ where: { id } })
      },
      deletionItems: async (ids) =>
        (
          await transaction.literatureItem.findMany({
            where: { id: { in: [...ids] } },
            select: { id: true, deletedAt: true }
          })
        ).map((row) => ({ id: row.id, deleted: row.deletedAt !== null })),
      mergedItemIds: async (ids) =>
        (
          await transaction.literatureItem.findMany({
            where: { mergedIntoItemId: { in: [...ids] } },
            select: { id: true }
          })
        ).map((row) => row.id),
      attachmentIds: async (ids) =>
        (
          await transaction.literatureAttachment.findMany({
            where: { itemId: { in: [...ids] } },
            select: { id: true }
          })
        ).map((row) => row.id),
      assertAttachmentsUnreferenced,
      deleteItemsAndRelations: async (ids) => {
        const deletionIds = [...ids]
        const attachments = await transaction.literatureAttachment.findMany({
          where: { itemId: { in: deletionIds } },
          select: { id: true }
        })
        const creatorLinks = await transaction.literatureItemCreator.findMany({
          where: { itemId: { in: deletionIds } },
          select: { creatorId: true }
        })
        await transaction.literatureInboxCandidate.deleteMany({
          where: { acceptedItemId: { in: deletionIds } }
        })
        const removedTags = await transaction.tagAssignment.deleteMany({
          where: { resourceType: 'literature.item', resourceId: { in: deletionIds } }
        })
        const annotationsDeleted = await deletePdfAnnotations(transaction, {
          sourceKind: 'literature-attachment-version',
          sourceFileId: { in: attachments.map((row) => row.id) }
        })
        await transaction.literatureItem.updateMany({
          where: { id: { in: deletionIds } },
          data: { mergedIntoItemId: null }
        })
        await transaction.literatureItem.deleteMany({ where: { id: { in: deletionIds } } })
        const creatorIds = [...new Set(creatorLinks.map((row) => row.creatorId))]
        if (creatorIds.length)
          await transaction.literatureCreator.deleteMany({
            where: { id: { in: creatorIds }, items: { none: {} } }
          })
        return removedTags.count > 0 || annotationsDeleted > 0
      },

      identityMatches: (identifiers) =>
        transaction.literatureItem.findMany({
          where: {
            mergedIntoItemId: null,
            identifiers: {
              some: {
                OR: identifiers.map(({ scheme, normalizedValue }) => ({ scheme, normalizedValue }))
              }
            }
          },
          orderBy: [{ deletedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true, identifiers: true }
        }),
      importIdentityRecords: async (identifiers) => {
        if (!identifiers.length) return []
        const rows = await transaction.literatureItem.findMany({
          where: {
            mergedIntoItemId: null,
            identifiers: {
              some: {
                OR: identifiers.map(({ scheme, normalizedValue }) => ({ scheme, normalizedValue }))
              }
            }
          },
          select: { id: true, title: true, identifiers: true }
        })
        return rows.map((row) => ({
          id: row.id,
          item: {
            title: row.title,
            identifiers: row.identifiers.map((id) => ({
              scheme: id.scheme as LiteratureIdentifierScheme,
              value: id.rawValue,
              isPrimary: id.isPrimary
            }))
          }
        }))
      },
      collection: async (id) => {
        const row = await transaction.literatureCollection.findUnique({
          where: { id },
          select: { id: true, smart: { select: { collectionId: true } } }
        })
        return row ? { id, smart: Boolean(row.smart) } : null
      },
      lastCollectionOrder: async (collectionId) =>
        (
          await transaction.literatureCollectionItem.findFirst({
            where: { collectionId },
            orderBy: { sortOrder: 'desc' },
            select: { sortOrder: true }
          })
        )?.sortOrder ?? -1,
      linkCollection: async (collectionId, itemId, sortOrder) => {
        await transaction.literatureCollectionItem.upsert({
          where: { collectionId_itemId: { collectionId, itemId } },
          create: { collectionId, itemId, sortOrder },
          update: {}
        })
      },
      unlinkCollection: async (collectionId, itemId) => {
        await transaction.literatureCollectionItem.deleteMany({ where: { collectionId, itemId } })
      },
      createItem: (item) => createItem(transaction, item),
      restoreItem: async (id) => {
        await transaction.literatureItem.updateMany({ where: { id }, data: { deletedAt: null } })
      },
      item: async (id) => {
        const row = await transaction.literatureItem.findUnique({
          where: { id },
          include: itemInclude
        })
        return row ? toItemView(row) : undefined
      },
      replaceMetadata: (id, revision, item) => replaceItemMetadata(transaction, id, revision, item),
      metadataReceipt: (operationId) =>
        transaction.literatureMetadataCommitReceipt.findUnique({ where: { operationId } }),
      saveMetadataReceipt: async (operationId, receipt) => {
        await transaction.literatureMetadataCommitReceipt.create({
          data: { operationId, ...receipt }
        })
      },
      attachSource: (input) =>
        this.attachSource(transaction, input as Parameters<LiteratureCatalog['attachSource']>[1]),
      candidate: (id) =>
        transaction.literatureInboxCandidate.findUnique({
          where: { id },
          include: { discoveries: true }
        }),
      candidateByKey: async (dedupeKey) => {
        const row = await transaction.literatureInboxCandidate.findUnique({
          where: { dedupeKey },
          include: { acceptedItem: { select: { deletedAt: true } } }
        })
        return row
          ? { id: row.id, state: row.state, acceptedDeleted: Boolean(row.acceptedItem?.deletedAt) }
          : null
      },
      retireCandidateKey: async (id) => {
        await transaction.literatureInboxCandidate.update({
          where: { id },
          data: { dedupeKey: `accepted:${id}` }
        })
      },
      createCandidate: (dedupeKey, candidate, candidateJson, metadataChecksum) =>
        transaction.literatureInboxCandidate.upsert({
          where: { dedupeKey },
          create: {
            dedupeKey,
            itemType: candidate.item.itemType,
            title: candidate.item.title,
            abstract: candidate.item.abstract,
            issuedYear: candidate.item.issuedYear,
            candidateJson,
            metadataChecksum,
            origin: candidate.origin.kind,
            sourceProjectId: candidate.origin.projectId,
            sourceSessionId: candidate.origin.sessionId
          },
          update: {},
          select: { id: true, state: true }
        }),
      recordDiscovery: async (candidateId, candidate, contextKey) => {
        await transaction.literatureCandidateDiscovery.upsert({
          where: { candidateId_contextKey: { candidateId, contextKey } },
          create: {
            candidateId,
            contextKey,
            origin: candidate.origin.kind,
            projectId: candidate.origin.projectId,
            sessionId: candidate.origin.sessionId
          },
          update: {}
        })
      },
      stagePdf: async (candidateId, pdf, provenanceJson) => {
        const blob = await transaction.contentBlob.findUnique({ where: { id: pdf.contentBlobId } })
        if (
          !blob ||
          blob.state !== 'available' ||
          blob.checksum !== pdf.checksum ||
          blob.sizeBytes !== BigInt(pdf.sizeBytes) ||
          (blob.contentType && blob.contentType !== 'application/pdf')
        )
          throw new Error('Inbox PDF content or ownership changed.')
        await transaction.literatureInboxPdf.upsert({
          where: { candidateId_checksum: { candidateId, checksum: pdf.checksum } },
          create: {
            candidateId,
            contentBlobId: blob.id,
            filename: pdf.filename,
            sizeBytes: blob.sizeBytes,
            checksum: blob.checksum,
            pageCount: pdf.pageCount,
            sourceUrl: pdf.sourceUrl,
            provenanceJson
          },
          update: {}
        })
      },
      attachProjectIfPresent: (projectId, itemId, source) =>
        attachProjectIfPresent(transaction, projectId, itemId, source),
      transferCandidateSources: (candidateId, itemId) =>
        transferSourceRecords(transaction, { inboxCandidateId: candidateId }, itemId),
      acceptCandidate: async (id, itemId) => {
        await transaction.literatureInboxCandidate.update({
          where: { id },
          data: { state: 'accepted', acceptedItemId: itemId, settledAt: new Date() }
        })
      },
      transferCandidatePdfs: async (candidateId, itemId) => {
        const pdfs = await transaction.literatureInboxPdf.findMany({ where: { candidateId } })
        for (const pdf of pdfs) {
          const existing = await transaction.literatureAttachmentVersion.findFirst({
            where: { checksum: pdf.checksum, attachment: { itemId } }
          })
          if (existing) await bindLiteraturePdfVersion(transaction, existing.id)
          else {
            const attachment = await transaction.literatureAttachment.create({
              data: {
                itemId,
                kind: 'fullText',
                title: pdf.filename,
                sortOrder: await transaction.literatureAttachment.count({ where: { itemId } }),
                versions: {
                  create: {
                    contentBlobId: pdf.contentBlobId,
                    filename: pdf.filename,
                    sizeBytes: pdf.sizeBytes,
                    checksum: pdf.checksum,
                    pageCount: pdf.pageCount,
                    contentType: 'application/pdf',
                    provenanceJson: pdf.provenanceJson,
                    versionNumber: 1
                  }
                }
              },
              include: { versions: true }
            })
            await bindLiteraturePdfVersion(transaction, attachment.versions[0].id)
          }
        }
        await transaction.literatureInboxPdf.deleteMany({ where: { candidateId } })
      },
      changeCandidates: async (ids, from, to) =>
        (
          await transaction.literatureInboxCandidate.updateMany({
            where: { id: { in: [...ids] }, state: from },
            data: { state: to, settledAt: to === 'pending' ? null : new Date() }
          })
        ).count,
      activeItemCount: (ids) =>
        transaction.literatureItem.count({
          where: { id: { in: [...ids] }, deletedAt: null, mergedIntoItemId: null }
        }),
      projectAvailable: async (id) =>
        Boolean(
          await transaction.project.findFirst({
            where: { AND: [{ id }, await availableProjectWhere(transaction)] },
            select: { id: true }
          })
        ),
      linkProject: async (projectId, itemId, source) => {
        await transaction.projectLiterature.upsert({
          where: { projectId_itemId: { projectId, itemId } },
          create: { projectId, itemId, source },
          update: { source }
        })
      },
      unlinkProject: async (projectId, ids) => {
        await transaction.projectLiterature.deleteMany({
          where: { projectId, itemId: { in: [...ids] } }
        })
      },
      setLifecycle: async (ids, state) =>
        (
          await transaction.literatureItem.updateMany({
            where: { id: { in: [...ids] }, mergedIntoItemId: null },
            data: { deletedAt: state === 'deleted' ? new Date() : null }
          })
        ).count,
      invalidateAssessments: async (ids) => {
        await transaction.literatureSmartAssessment.updateMany({
          where: { itemId: { in: [...ids] } },
          data: { policyKey: 'obsolete:lifecycle-change' }
        })
      },
      mergeViews: async (ids) =>
        (
          await transaction.literatureItem.findMany({
            where: { id: { in: [...ids] }, deletedAt: null, mergedIntoItemId: null },
            include: await activeItemInclude(transaction)
          })
        ).map(toItemView),
      mergeOverrides: (ids) =>
        transaction.literatureSmartOverride.findMany({ where: { itemId: { in: [...ids] } } }),
      prepareMerge: async (survivorId, duplicateIds, decisions) => {
        for (const [collectionId, decision] of decisions)
          await transaction.literatureSmartOverride.upsert({
            where: { collectionId_itemId: { collectionId, itemId: survivorId } },
            create: { collectionId, itemId: survivorId, decision },
            update: { decision }
          })
        await transaction.literatureSmartAssessment.deleteMany({
          where: { itemId: { in: [survivorId, ...duplicateIds] } }
        })
        await transaction.$executeRaw(
          Prisma.sql`DELETE FROM "JournalItemBinding" WHERE "itemId" IN (${Prisma.join([...duplicateIds])})`
        )
        await transaction.literatureIdentifier.deleteMany({
          where: { itemId: { in: [...duplicateIds] } }
        })
      },
      moveMergedRelations: async (survivorId, duplicates) => {
        const duplicateIds = [...duplicates]
        const [memberships, projects, assignments] = await Promise.all([
          transaction.literatureCollectionItem.findMany({
            where: { itemId: { in: duplicateIds } },
            select: { collectionId: true, itemId: true, sortOrder: true }
          }),
          transaction.projectLiterature.findMany({
            where: {
              itemId: { in: duplicateIds },
              project: await availableProjectWhere(transaction)
            },
            select: { projectId: true, itemId: true, source: true }
          }),
          transaction.tagAssignment.findMany({
            where: { resourceType: 'literature.item', resourceId: { in: duplicateIds } },
            select: { tagId: true, resourceId: true }
          })
        ])
        for (const membership of memberships) {
          await transaction.literatureCollectionItem.upsert({
            where: {
              collectionId_itemId: {
                collectionId: membership.collectionId,
                itemId: survivorId
              }
            },
            create: {
              collectionId: membership.collectionId,
              itemId: survivorId,
              sortOrder: membership.sortOrder
            },
            update: {}
          })
        }
        for (const project of projects) {
          await transaction.projectLiterature.upsert({
            where: {
              projectId_itemId: { projectId: project.projectId, itemId: survivorId }
            },
            create: {
              projectId: project.projectId,
              itemId: survivorId,
              source: project.source
            },
            update: {}
          })
        }
        for (const assignment of assignments) {
          await transaction.tagAssignment.upsert({
            where: {
              tagId_resourceType_resourceId: {
                tagId: assignment.tagId,
                resourceType: 'literature.item',
                resourceId: survivorId
              }
            },
            create: {
              tagId: assignment.tagId,
              resourceType: 'literature.item',
              resourceId: survivorId
            },
            update: {}
          })
        }
        await Promise.all([
          transaction.literatureCollectionItem.deleteMany({
            where: { itemId: { in: duplicateIds } }
          }),
          transaction.projectLiterature.deleteMany({ where: { itemId: { in: duplicateIds } } }),
          transaction.tagAssignment.deleteMany({
            where: { resourceType: 'literature.item', resourceId: { in: duplicateIds } }
          }),
          transaction.literatureAttachment.updateMany({
            where: { itemId: { in: duplicateIds } },
            data: { itemId: survivorId }
          }),

          transaction.literatureInboxCandidate.updateMany({
            where: { acceptedItemId: { in: duplicateIds } },
            data: { acceptedItemId: survivorId }
          })
        ])
        await transferSourceRecords(transaction, { itemId: { in: duplicateIds } }, survivorId)
        await transaction.literatureItem.updateMany({
          where: {
            OR: [{ id: { in: duplicateIds } }, { mergedIntoItemId: { in: duplicateIds } }]
          },
          data: { deletedAt: new Date(), mergedIntoItemId: survivorId }
        })

        return assignments.length > 0
      }
    }
    return new LibraryTransaction(store)
  }

  private async attachSource(
    transaction: Prisma.TransactionClient,
    input:
      | { source: LiteratureSourceInput; candidateId: string; itemId?: never }
      | { source: LiteratureSourceInput; candidateId?: never; itemId: string }
  ): Promise<void> {
    const rawMetadataJson = canonicalJson(input.source.rawMetadata)
    const data = {
      itemId: input.itemId,
      inboxCandidateId: input.candidateId,
      provider: normalizeSpace(input.source.provider),
      externalId: input.source.externalId,
      sourceUrl: input.source.sourceUrl,
      rawMetadataJson,
      metadataChecksum: sha256(rawMetadataJson)
    }
    if (data.externalId) {
      await transaction.literatureSourceRecord.upsert({
        where: {
          ...(input.itemId !== undefined
            ? {
                itemId_provider_externalId: {
                  itemId: input.itemId,
                  provider: data.provider,
                  externalId: data.externalId
                }
              }
            : {
                inboxCandidateId_provider_externalId: {
                  inboxCandidateId: input.candidateId,
                  provider: data.provider,
                  externalId: data.externalId
                }
              })
        },
        create: data,
        update: {
          rawMetadataJson: data.rawMetadataJson,
          metadataChecksum: data.metadataChecksum,
          sourceUrl: data.sourceUrl,
          fetchedAt: new Date()
        }
      })
      return
    }
    const existing = await transaction.literatureSourceRecord.findFirst({
      where: {
        provider: data.provider,
        externalId: null,
        sourceUrl: data.sourceUrl ?? null,
        itemId: data.itemId ?? null,
        inboxCandidateId: data.inboxCandidateId ?? null
      },
      select: { id: true }
    })
    if (existing) {
      await transaction.literatureSourceRecord.update({
        where: { id: existing.id },
        data: {
          rawMetadataJson: data.rawMetadataJson,
          metadataChecksum: data.metadataChecksum,
          fetchedAt: new Date()
        }
      })
      return
    }
    await transaction.literatureSourceRecord.create({ data })
  }
}

export { LiteratureCatalog }
export type {
  ApplyLiteratureMetadataInput,
  AttachLiteratureContentInput,
  AttachedLiteratureContent
}
