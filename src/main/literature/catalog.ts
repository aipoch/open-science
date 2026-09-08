import { createHash, randomUUID } from 'node:crypto'

import { Prisma, type PrismaClient } from '@prisma/client'
import { findLiteratureDuplicateGroups } from './duplicates'
import { planLiteratureMerge, supplementLiteratureMetadata } from './duplicate-metadata'

import {
  LITERATURE_IDENTITY_SCHEMES,
  LITERATURE_IMPORT_IDENTITY_CONFLICT,
  LITERATURE_COLLECTION_NAME_CONFLICT,
  literatureCandidateInputSchema,
  literatureItemInputSchema,
  normalizeLiteratureIdentifierValue,
  normalizeLiteratureIdentifierPreferences,
  type LiteratureCatalogCommand,
  type LiteratureDuplicatePolicy,
  type LiteratureCollectionView,
  type LiteratureCatalogReceipt,
  type LiteratureCatalogSearchPage,
  type LiteratureCatalogSearchRequest,
  type LiteratureCandidateInput,
  type LiteratureCreatorInput,
  type LiteratureIdentifierInput,
  type LiteratureIdentifierScheme,
  type LiteratureInboxCandidateView,
  type LiteratureInboxState,
  type LiteratureItemInput,
  type LiteratureItemView,
  type LiteratureRecordImportReceipt,
  type LiteratureRecordImportEntry,
  type LiteratureRecordImportError,
  type LiteratureSourceInput
} from '../../shared/literature'

type LiteratureCatalogClient = Pick<
  PrismaClient,
  | '$transaction'
  | 'contentBlob'
  | 'literatureAttachment'
  | 'literatureCollection'
  | 'literatureInboxCandidate'
  | 'literatureItem'
  | 'projectLiterature'
  | 'tagAssignment'
>

type LiteratureCatalogClientProvider = () => Promise<LiteratureCatalogClient>
const duplicateGroups = new WeakMap<
  LiteratureCatalogClient,
  Promise<ReturnType<typeof findLiteratureDuplicateGroups>>
>()

type AttachLiteratureContentInput = Readonly<{
  itemId: string
  expectedMetadataRevision?: number
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

type AttachedLiteratureContent = Readonly<{ attachmentId: string; versionId: string }>

type ApplyLiteratureMetadataInput = Readonly<{
  itemId: string
  expectedMetadataRevision: number
  item: LiteratureItemInput
  source: LiteratureSourceInput
}>

const identitySchemes = new Set<string>(LITERATURE_IDENTITY_SCHEMES)

const normalizeSpace = (value: string): string =>
  value.normalize('NFKC').trim().replace(/\s+/gu, ' ')

const normalizeIdentifier = (scheme: LiteratureIdentifierScheme, rawValue: string): string => {
  const value = normalizeSpace(rawValue)
  switch (scheme) {
    case 'doi':
      return normalizeLiteratureIdentifierValue(scheme, value).toLowerCase()
    case 'pmid':
      return normalizeLiteratureIdentifierValue(scheme, value)
    case 'pmcid':
      return normalizeLiteratureIdentifierValue(scheme, value)
    case 'arxiv':
      return normalizeLiteratureIdentifierValue(scheme, value).toLowerCase()
    case 'isbn':
    case 'issn':
      return value.replace(/[^0-9X]/giu, '').toUpperCase()
    case 'other':
      return value.toLowerCase()
  }
}

const normalizeCreatorName = (creator: LiteratureCreatorInput): string =>
  creator.nameMode === 'organization'
    ? normalizeSpace(creator.literalName).toLowerCase()
    : normalizeSpace(`${creator.familyName} ${creator.givenName}`).toLowerCase()

const canonicalJsonValue = (value: unknown): unknown => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)])
    )
  }
  throw new Error('Literature metadata must contain JSON-compatible values.')
}

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalJsonValue(value))

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

const normalizedIdentifiers = (
  identifiers: readonly LiteratureIdentifierInput[]
): Array<LiteratureIdentifierInput & { normalizedValue: string }> => {
  const unique = new Map<string, LiteratureIdentifierInput & { normalizedValue: string }>()
  for (const identifier of identifiers) {
    const normalizedValue = normalizeIdentifier(identifier.scheme, identifier.value)
    if (!normalizedValue) throw new Error(`Literature ${identifier.scheme} identifier is empty.`)
    const key = `${identifier.scheme}:${normalizedValue}`
    if (!unique.has(key) || identifier.isPrimary)
      unique.set(key, { ...identifier, normalizedValue })
  }
  return normalizeLiteratureIdentifierPreferences([...unique.values()])
}

const candidateDedupeKey = (candidate: LiteratureCandidateInput): string => {
  const identity = normalizedIdentifiers(candidate.item.identifiers).find(({ scheme }) =>
    identitySchemes.has(scheme)
  )
  if (identity) return `${identity.scheme}:${identity.normalizedValue}`
  if (candidate.source.externalId) {
    return `source:${normalizeSpace(candidate.source.provider).toLowerCase()}:${normalizeSpace(candidate.source.externalId).toLowerCase()}`
  }
  const firstCreator = candidate.item.creators[0]
  return `metadata:${sha256(
    canonicalJson({
      creator: firstCreator ? normalizeCreatorName(firstCreator) : '',
      issuedYear: candidate.item.issuedYear ?? null,
      title: normalizeSpace(candidate.item.title).toLowerCase()
    })
  )}`
}

const itemInclude = {
  creators: { include: { creator: true }, orderBy: { ordinal: 'asc' as const } },
  identifiers: { orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }] },
  projects: { select: { projectId: true }, orderBy: { addedAt: 'asc' as const } },
  collections: { select: { collectionId: true }, orderBy: { addedAt: 'asc' as const } },
  attachments: {
    include: { versions: { orderBy: { versionNumber: 'desc' as const } } },
    orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'asc' as const }]
  }
} satisfies Prisma.LiteratureItemInclude

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
      filename: version.filename,
      contentType: version.contentType,
      sizeBytes: Number(version.sizeBytes),
      checksum: version.checksum,
      pageCount: version.pageCount ?? undefined,
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
  pdfs?: { id: string; filename: string; sizeBytes: bigint; pageCount: number; sourceUrl: string }[]
}): LiteratureInboxCandidateView => ({
  id: row.id,
  state: row.state as LiteratureInboxState,
  candidate: literatureCandidateInputSchema.parse(JSON.parse(row.candidateJson)),
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
  const project = await transaction.project.findUnique({
    where: { id: projectId },
    select: { id: true }
  })
  if (!project) return
  await transaction.projectLiterature.upsert({
    where: { projectId_itemId: { projectId, itemId } },
    create: { projectId, itemId, source },
    update: { source }
  })
}

const findIdentityItem = async (
  transaction: Prisma.TransactionClient,
  identifiers: readonly (LiteratureIdentifierInput & { normalizedValue: string })[]
): Promise<string | undefined> => {
  const identity = identifiers.filter(({ scheme }) => identitySchemes.has(scheme))
  if (identity.length === 0) return undefined
  const match = await transaction.literatureIdentifier.findFirst({
    where: {
      item: { mergedIntoItemId: null },
      OR: identity.map(({ normalizedValue, scheme }) => ({ scheme, normalizedValue }))
    },
    orderBy: [{ item: { deletedAt: 'asc' } }, { item: { createdAt: 'asc' } }, { itemId: 'asc' }],
    select: { itemId: true }
  })
  return match?.itemId
}

const restoreExistingItem = (
  transaction: Prisma.TransactionClient,
  itemId: string
): Promise<{ count: number }> =>
  transaction.literatureItem.updateMany({
    where: { id: itemId },
    data: { deletedAt: null }
  })

const identityKey = (scheme: string, value: string): string => `${scheme}:${value}`

type ImportIdentityIndex = {
  byIdentifier: Map<string, Set<string | number>>
  records: Map<string | number, Pick<LiteratureItemInput, 'title' | 'identifiers'>>
}

const rememberImportIdentity = (
  index: ImportIdentityIndex,
  target: string | number,
  item: Pick<LiteratureItemInput, 'title' | 'identifiers'>
): void => {
  index.records.set(target, item)
  for (const { scheme, normalizedValue } of normalizedIdentifiers(item.identifiers)) {
    if (!identitySchemes.has(scheme)) continue
    const key = identityKey(scheme, normalizedValue)
    const targets = index.byIdentifier.get(key) ?? new Set<string | number>()
    targets.add(target)
    index.byIdentifier.set(key, targets)
  }
}

// Include all owners, including Trash and explicitly independent duplicates.
const importIdentityMap = async (
  transaction: Prisma.TransactionClient,
  items: readonly LiteratureItemInput[]
): Promise<ImportIdentityIndex> => {
  const identifiers = items.flatMap((item) =>
    normalizedIdentifiers(item.identifiers).filter(({ scheme }) => identitySchemes.has(scheme))
  )
  const result: ImportIdentityIndex = { byIdentifier: new Map(), records: new Map() }
  for (let offset = 0; offset < identifiers.length; offset += 200) {
    const matches = await transaction.literatureItem.findMany({
      where: {
        mergedIntoItemId: null,
        identifiers: {
          some: {
            OR: identifiers
              .slice(offset, offset + 200)
              .map(({ scheme, normalizedValue }) => ({ scheme, normalizedValue }))
          }
        }
      },
      select: { id: true, title: true, identifiers: true }
    })
    for (const match of matches) {
      rememberImportIdentity(result, match.id, {
        title: match.title,
        identifiers: match.identifiers.map((identifier) => ({
          scheme: identifier.scheme as LiteratureIdentifierScheme,
          value: identifier.rawValue,
          isPrimary: identifier.isPrimary
        }))
      })
    }
  }
  return result
}

const importIdentity = (
  index: ImportIdentityIndex,
  item: LiteratureItemInput
): { target?: string | number; conflict?: LiteratureRecordImportEntry['conflict'] } => {
  const identifiers = normalizedIdentifiers(item.identifiers).filter(({ scheme }) =>
    identitySchemes.has(scheme)
  )
  const targets = [
    ...new Set(
      identifiers.flatMap(({ scheme, normalizedValue }) => [
        ...(index.byIdentifier.get(identityKey(scheme, normalizedValue)) ?? [])
      ])
    )
  ]
  const contradictory = identifiers.some((identifier) =>
    identifiers.some(
      (other) =>
        other.scheme === identifier.scheme && other.normalizedValue !== identifier.normalizedValue
    )
  )
  const target = targets[0]
  const existing =
    target === undefined ? [] : normalizedIdentifiers(index.records.get(target)!.identifiers)
  const disagrees = identifiers.some((identifier) => {
    const sameScheme = existing.filter(({ scheme }) => scheme === identifier.scheme)
    return (
      sameScheme.length > 0 &&
      !sameScheme.some(({ normalizedValue }) => normalizedValue === identifier.normalizedValue)
    )
  })
  if (targets.length > 1 || contradictory || disagrees)
    return {
      conflict: {
        identifiers: identifiers.map(({ scheme, value, isPrimary }) => ({
          scheme,
          value,
          isPrimary
        })),
        matches: targets.map((target) => ({
          ...(typeof target === 'string' ? { itemId: target } : { inputIndex: target }),
          title: index.records.get(target)!.title
        }))
      }
    }
  return { target }
}

// Plan the entire batch before any write. Virtual targets retain input indexes,
// so bridges between earlier rows are checked identically in preview and commit.
const resolveImportItems = (
  identities: ImportIdentityIndex,
  items: readonly LiteratureItemInput[]
): ReturnType<typeof importIdentity>[] =>
  items.map((item, inputIndex) => {
    const resolution = importIdentity(identities, item)
    if (resolution.conflict) return resolution
    const target = resolution.target ?? inputIndex
    const previous = identities.records.get(target)
    rememberImportIdentity(identities, target, {
      title: previous?.title ?? item.title,
      identifiers: [...(previous?.identifiers ?? []), ...item.identifiers]
    })
    return resolution
  })

const createItem = async (
  transaction: Prisma.TransactionClient,
  item: LiteratureItemInput
): Promise<string> => {
  const identifiers = normalizedIdentifiers(item.identifiers)
  const created = await transaction.literatureItem.create({
    data: {
      itemType: item.itemType,
      title: normalizeSpace(item.title),
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

const supplementExistingItem = async (
  transaction: Prisma.TransactionClient,
  itemId: string,
  incoming: LiteratureItemInput
): Promise<LiteratureItemInput> => {
  const row = await transaction.literatureItem.findUniqueOrThrow({
    where: { id: itemId },
    include: itemInclude
  })
  const existing = toItemView(row).item
  const { item } = supplementLiteratureMetadata(existing, incoming)
  if (canonicalJson(existing) !== canonicalJson(item)) {
    await replaceItemMetadata(transaction, itemId, row.metadataRevision, item)
  }
  return item
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
    select: { metadataRevision: true, creators: { select: { creatorId: true } } }
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
          ? { nameMode: 'organization', literalName: creator.literalName, normalizedName }
          : {
              nameMode: 'person',
              givenName: creator.givenName,
              familyName: creator.familyName,
              normalizedName
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

const acceptInboxCandidate = async (
  transaction: Prisma.TransactionClient,
  candidateId: string
): Promise<LiteratureCatalogReceipt> => {
  const row = await transaction.literatureInboxCandidate.findUnique({
    where: { id: candidateId }
  })
  if (!row) throw new Error('Literature Inbox candidate not found.')
  if (row.state === 'accepted' && row.acceptedItemId) {
    return { kind: 'item', id: row.acceptedItemId, state: 'present' }
  }
  if (row.state !== 'pending') throw new Error('Literature Inbox candidate is already settled.')
  const candidate = literatureCandidateInputSchema.parse(JSON.parse(row.candidateJson))
  const identifiers = normalizedIdentifiers(candidate.item.identifiers)
  const itemId =
    (await findIdentityItem(transaction, identifiers)) ??
    (await createItem(transaction, candidate.item))
  await restoreExistingItem(transaction, itemId)
  await transaction.literatureSourceRecord.updateMany({
    where: { inboxCandidateId: row.id },
    data: { inboxCandidateId: null, itemId }
  })
  await attachProjectIfPresent(
    transaction,
    candidate.origin.projectId,
    itemId,
    candidate.origin.kind
  )
  await transaction.literatureInboxCandidate.update({
    where: { id: row.id },
    data: { state: 'accepted', acceptedItemId: itemId, settledAt: new Date() }
  })
  const pdfs = await transaction.literatureInboxPdf.findMany({ where: { candidateId } })
  for (const pdf of pdfs) {
    const existing = await transaction.literatureAttachmentVersion.findFirst({
      where: { checksum: pdf.checksum, attachment: { itemId } }
    })
    if (!existing)
      await transaction.literatureAttachment.create({
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
              versionNumber: 1
            }
          }
        }
      })
  }
  await transaction.literatureInboxPdf.deleteMany({ where: { candidateId } })
  return { kind: 'item', id: itemId, state: 'linked' }
}

class LiteratureCatalog {
  constructor(private readonly getClient: LiteratureCatalogClientProvider) {}

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
        where: { item: { deletedAt: null, mergedIntoItemId: null } },
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
        ...(query ? { name: { contains: query } } : {})
      }
      const [totalCount, rows] = await Promise.all([
        client.literatureCollection.count({ where }),
        client.literatureCollection.findMany({
          where,
          include: {
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
        entries: rows.slice(0, limit).map((row): LiteratureCollectionView => ({
          id: row.id,
          name: row.name,
          description: row.description,
          parentId: row.parentId ?? undefined,
          itemCount: row._count.items,
          createdAt: row.createdAt.getTime(),
          updatedAt: row.updatedAt.getTime()
        })),
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
    const filter = request.filter
    const tagIds = [
      ...new Set([...(filter?.tagIds ?? []), ...(request.tagId ? [request.tagId] : [])])
    ]
    let taggedItemIds: string[] | undefined
    if (tagIds.length > 0) {
      const assignments = await client.tagAssignment.findMany({
        where: { resourceType: 'literature.item', tagId: { in: tagIds } },
        select: { resourceId: true, tagId: true }
      })
      const assigned = new Map<string, Set<string>>()
      for (const assignment of assignments) {
        const ids = assigned.get(assignment.resourceId) ?? new Set<string>()
        ids.add(assignment.tagId)
        assigned.set(assignment.resourceId, ids)
      }
      taggedItemIds = [...assigned]
        .filter(([, ids]) => tagIds.every((tagId) => ids.has(tagId)))
        .map(([itemId]) => itemId)
    }
    const lifecycle = request.lifecycle ?? 'active'
    const textQueries = [query, normalizeSpace(filter?.query ?? '')].filter(Boolean)
    const where: Prisma.LiteratureItemWhereInput = {
      ...(lifecycle === 'deleted' ? { deletedAt: { not: null } } : { deletedAt: null }),
      ...(taggedItemIds ? { id: { in: taggedItemIds } } : {}),
      ...(request.projectId || filter?.projectId
        ? { projects: { some: { projectId: request.projectId ?? filter?.projectId } } }
        : {}),
      ...(request.collectionId || filter?.collectionId
        ? {
            collections: {
              some: { collectionId: request.collectionId ?? filter?.collectionId }
            }
          }
        : {}),
      ...(filter?.creator
        ? {
            creators: {
              some: {
                creator: {
                  normalizedName: { contains: normalizeSpace(filter.creator).toLowerCase() }
                }
              }
            }
          }
        : {}),
      ...(filter?.containerTitle
        ? { containerTitle: { contains: normalizeSpace(filter.containerTitle) } }
        : {}),
      ...(filter?.itemTypes?.length ? { itemType: { in: filter.itemTypes } } : {}),
      ...(filter?.yearFrom !== undefined || filter?.yearTo !== undefined
        ? {
            issuedYear: {
              ...(filter.yearFrom !== undefined ? { gte: filter.yearFrom } : {}),
              ...(filter.yearTo !== undefined ? { lte: filter.yearTo } : {})
            }
          }
        : {}),
      ...(filter?.hasFullText === undefined
        ? {}
        : filter.hasFullText
          ? { attachments: { some: { versions: { some: {} } } } }
          : { attachments: { none: { versions: { some: {} } } } }),
      ...(textQueries.length
        ? {
            AND: textQueries.map((text) => ({
              OR: [
                { title: { contains: text } },
                { abstract: { contains: text } },
                { containerTitle: { contains: text } },
                {
                  creators: {
                    some: { creator: { normalizedName: { contains: text.toLowerCase() } } }
                  }
                }
              ]
            }))
          }
        : {})
    }
    const sortDirection = request.sortDirection ?? (request.sortBy === 'title' ? 'asc' : 'desc')
    const orderBy: Prisma.LiteratureItemOrderByWithRelationInput[] =
      request.sortBy === 'title'
        ? [{ title: sortDirection }, { id: 'asc' }]
        : request.sortBy === 'year'
          ? [
              { issuedYear: { sort: sortDirection, nulls: 'last' } },
              { title: 'asc' },
              { id: 'asc' }
            ]
          : request.sortBy === 'rating'
            ? [{ rating: sortDirection }, { title: 'asc' }, { id: 'asc' }]
            : request.sortBy === 'created'
              ? [{ createdAt: sortDirection }, { id: 'asc' }]
              : [{ updatedAt: sortDirection }, { id: 'asc' }]
    const [totalCount, rows] = await Promise.all([
      client.literatureItem.count({ where }),
      client.literatureItem.findMany({
        where: {
          ...where
        },
        include: itemInclude,
        orderBy,
        skip: offset,
        take: limit + 1
      })
    ])
    return {
      entries: rows.slice(0, limit).map(toItemView),
      totalCount,
      nextOffset: rows.length > limit ? offset + limit : undefined
    }
  }

  async get(itemId: string): Promise<LiteratureItemView | undefined> {
    const client = await this.getClient()
    const requested = await client.literatureItem.findUnique({
      where: { id: itemId },
      include: itemInclude
    })
    const row = requested?.mergedIntoItemId
      ? await client.literatureItem.findFirst({
          where: { id: requested.mergedIntoItemId, deletedAt: null },
          include: itemInclude
        })
      : requested?.deletedAt
        ? undefined
        : requested
    return row ? toItemView(row) : undefined
  }

  async getMany(itemIds: readonly string[]): Promise<LiteratureItemView[]> {
    const ids = [...new Set(itemIds.map(normalizeSpace).filter(Boolean))]
    if (ids.length === 0) return []
    const client = await this.getClient()
    const requestedRows = await client.literatureItem.findMany({
      where: { id: { in: ids } },
      include: itemInclude
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
            include: itemInclude
          })
    const survivorsById = new Map(survivors.map((row) => [row.id, row]))
    return ids.flatMap((id) => {
      const requested = requestedById.get(id)
      const resolved = requested?.mergedIntoItemId
        ? survivorsById.get(requested.mergedIntoItemId)
        : requested?.deletedAt
          ? undefined
          : requested
      return resolved ? [{ ...toItemView(resolved), id }] : []
    })
  }

  async applyMetadata(input: ApplyLiteratureMetadataInput): Promise<LiteratureItemView> {
    await this.updateItem(
      {
        kind: 'update-item',
        itemId: input.itemId,
        expectedMetadataRevision: input.expectedMetadataRevision,
        item: input.item
      },
      input.source
    )
    const updated = await this.get(input.itemId)
    if (!updated) throw new Error('Literature Item is unavailable.')
    return updated
  }

  async attachContent(input: AttachLiteratureContentInput): Promise<AttachedLiteratureContent> {
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
    return client.$transaction(async (transaction) => {
      const [item, blob] = await Promise.all([
        transaction.literatureItem.findFirst({
          where: { id: itemId, deletedAt: null },
          select: { id: true, metadataRevision: true }
        }),
        transaction.contentBlob.findUnique({ where: { id: input.contentBlobId } })
      ])
      if (!item) throw new Error('Literature Item is unavailable.')
      if (
        input.expectedMetadataRevision !== undefined &&
        item.metadataRevision !== input.expectedMetadataRevision
      ) {
        throw new Error('Literature Item changed before the PDF could be attached.')
      }
      if (
        !blob ||
        blob.state !== 'available' ||
        blob.checksum !== input.checksum ||
        blob.sizeBytes !== BigInt(input.sizeBytes) ||
        (blob.contentType !== null && blob.contentType !== contentType)
      ) {
        throw new Error('Literature attachment bytes do not match the content authority.')
      }

      if (!input.attachmentId) {
        const existingItemVersion = await transaction.literatureAttachmentVersion.findFirst({
          where: { checksum: input.checksum, attachment: { itemId } },
          select: { id: true, attachmentId: true }
        })
        if (existingItemVersion) {
          return {
            attachmentId: existingItemVersion.attachmentId,
            versionId: existingItemVersion.id
          }
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
      if (existing) return { attachmentId: attachment.id, versionId: existing.id }
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
          pageCount: input.pageCount
        },
        select: { id: true }
      })
      return { attachmentId: attachment.id, versionId: version.id }
    })
  }

  async transact(command: LiteratureCatalogCommand): Promise<LiteratureCatalogReceipt> {
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
  private execute(command: LiteratureCatalogCommand): Promise<LiteratureCatalogReceipt> {
    switch (command.kind) {
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
    const items = inputs.map((item) => literatureItemInputSchema.parse(item))
    const client = await this.getClient()
    return client
      .$transaction(
        async (transaction) => {
          let nextSortOrder = 0
          if (collectionId) {
            const collection = await transaction.literatureCollection.findUnique({
              where: { id: collectionId },
              select: { id: true }
            })
            if (!collection) throw new Error('Literature Collection is unavailable.')
            const last = await transaction.literatureCollectionItem.findFirst({
              where: { collectionId },
              orderBy: { sortOrder: 'desc' },
              select: { sortOrder: true }
            })
            nextSortOrder = (last?.sortOrder ?? -1) + 1
          }

          const identities = await importIdentityMap(transaction, items)
          const resolutions =
            duplicatePolicy === 'separate' ? [] : resolveImportItems(identities, items)
          if (resolutions.some(({ conflict }) => conflict))
            throw new Error(LITERATURE_IMPORT_IDENTITY_CONFLICT)
          const importedTargets = new Map<number, string>()
          const itemIds: string[] = []
          let createdCount = 0
          let reusedCount = 0
          for (const [inputIndex, item] of items.entries()) {
            const target = resolutions[inputIndex]?.target
            const existingId =
              typeof target === 'string'
                ? target
                : target === undefined
                  ? undefined
                  : importedTargets.get(target)
            const itemId = existingId ?? (await createItem(transaction, item))
            if (existingId) {
              await restoreExistingItem(transaction, existingId)
              if (duplicatePolicy === 'fill-missing') {
                await supplementExistingItem(transaction, existingId, item)
              }
              reusedCount += 1
            } else {
              createdCount += 1
            }
            importedTargets.set(inputIndex, itemId)
            if (!itemIds.includes(itemId)) itemIds.push(itemId)
            if (collectionId) {
              await transaction.literatureCollectionItem.upsert({
                where: { collectionId_itemId: { collectionId, itemId } },
                create: { collectionId, itemId, sortOrder: nextSortOrder },
                update: {}
              })
              nextSortOrder += 1
            }
          }
          return { itemIds, createdCount, reusedCount }
        },
        // The parser admits up to 1,000 references, including large author lists. Keep this
        // operation atomic without applying Prisma's five-second single-command deadline.
        { timeout: 60_000 }
      )
      .finally(() => duplicateGroups.delete(client))
  }

  async inspectImportItems(
    inputs: readonly LiteratureItemInput[],
    errors: readonly LiteratureRecordImportError[],
    parserWarnings: readonly LiteratureRecordImportEntry['warnings'][] = []
  ): Promise<LiteratureRecordImportEntry[]> {
    const items = inputs.map((item) => literatureItemInputSchema.parse(item))
    const client = await this.getClient()
    const entries: LiteratureRecordImportEntry[] = []
    await client.$transaction(async (transaction) => {
      const identities = await importIdentityMap(transaction, items)
      const resolutions = resolveImportItems(identities, items)
      for (const [index, item] of items.entries()) {
        const { target, conflict } = resolutions[index]!
        const existingItemId = !conflict && typeof target === 'string' ? target : undefined
        const warnings: LiteratureRecordImportEntry['warnings'] = [
          ...(parserWarnings[index] ?? []),
          ...(item.creators.length === 0 ? (['missing-authors'] as const) : []),
          ...(item.issuedYear === undefined && !item.issuedText ? (['missing-year'] as const) : []),
          ...(!item.containerTitle &&
          ['journalArticle', 'conferencePaper', 'preprint'].includes(item.itemType)
            ? (['missing-container-title'] as const)
            : [])
        ]
        entries.push({
          index,
          title: item.title,
          status: conflict
            ? 'conflict'
            : target !== undefined
              ? 'existing'
              : warnings.length > 0
                ? 'warning'
                : 'ready',
          ...(conflict ? { conflict } : {}),
          warnings,
          item,
          ...(existingItemId ? { existingItemId } : {})
        })
      }
    })
    for (const [errorIndex, error] of errors.entries()) {
      entries.push({
        index: items.length + errorIndex,
        title: error.preview,
        status: 'invalid',
        warnings: [],
        error: error.error
      })
    }
    return entries
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
    source?: LiteratureSourceInput
  ): Promise<LiteratureCatalogReceipt> {
    const itemId = normalizeSpace(command.itemId)
    const item = literatureItemInputSchema.parse(command.item)
    const client = await this.getClient()

    return client
      .$transaction(async (transaction): Promise<LiteratureCatalogReceipt> => {
        await replaceItemMetadata(transaction, itemId, command.expectedMetadataRevision, item)
        if (source) await this.attachSource(transaction, { source, itemId })
        return { kind: 'item', id: itemId, state: 'present' }
      })
      .finally(() => duplicateGroups.delete(client))
  }

  private async stageCandidate(
    input: LiteratureCandidateInput,
    pdf?: Omit<AttachLiteratureContentInput, 'itemId'> & { pageCount: number; sourceUrl: string }
  ): Promise<LiteratureCatalogReceipt> {
    const candidate = literatureCandidateInputSchema.parse(input)
    const identifiers = normalizedIdentifiers(candidate.item.identifiers)
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      const existingItemId = await findIdentityItem(transaction, identifiers)
      if (existingItemId && !pdf) {
        await restoreExistingItem(transaction, existingItemId)
        await attachProjectIfPresent(
          transaction,
          candidate.origin.projectId,
          existingItemId,
          candidate.origin.kind
        )
        await this.attachSource(transaction, { source: candidate.source, itemId: existingItemId })
        return { kind: 'item', id: existingItemId, state: 'present' }
      }
      const dedupeKey = pdf
        ? sha256(`pdf:${candidateDedupeKey(candidate)}:${pdf.checksum}`)
        : candidateDedupeKey(candidate)
      const candidateJson = canonicalJson(candidate)
      const metadataChecksum = sha256(candidateJson)
      const persisted = await transaction.literatureInboxCandidate.upsert({
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
      })
      if (persisted.state === 'pending') {
        if (pdf) {
          const blob = await transaction.contentBlob.findUnique({
            where: { id: pdf.contentBlobId }
          })
          if (
            !blob ||
            blob.state !== 'available' ||
            blob.checksum !== pdf.checksum ||
            blob.sizeBytes !== BigInt(pdf.sizeBytes) ||
            (blob.contentType && blob.contentType !== 'application/pdf')
          )
            throw new Error('Inbox PDF content or ownership changed.')
          await transaction.literatureInboxPdf.upsert({
            where: { candidateId_checksum: { candidateId: persisted.id, checksum: pdf.checksum } },
            create: {
              candidateId: persisted.id,
              contentBlobId: blob.id,
              filename: pdf.filename,
              sizeBytes: blob.sizeBytes,
              checksum: blob.checksum,
              pageCount: pdf.pageCount,
              sourceUrl: pdf.sourceUrl
            },
            update: {}
          })
        }
        await this.attachSource(transaction, {
          source: candidate.source,
          candidateId: persisted.id
        })
      }
      return {
        kind: 'candidate',
        id: persisted.id,
        state: persisted.state as LiteratureInboxState
      }
    })
  }

  private async acceptCandidate(candidateId: string): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    return client.$transaction((transaction) => acceptInboxCandidate(transaction, candidateId))
  }

  async stageAcquiredPdf(
    candidate: LiteratureCandidateInput,
    pdf: Omit<AttachLiteratureContentInput, 'itemId'> & { pageCount: number; sourceUrl: string }
  ): Promise<LiteratureCatalogReceipt> {
    return this.stageCandidate(candidate, pdf)
  }

  private async dismissCandidate(candidateId: string): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    const updated = await client.literatureInboxCandidate.updateMany({
      where: { id: candidateId, state: 'pending' },
      data: { state: 'dismissed', settledAt: new Date() }
    })
    if (updated.count === 0) throw new Error('Literature Inbox candidate is not pending.')
    return { kind: 'candidate', id: candidateId, state: 'dismissed' }
  }

  private async settleCandidates(
    command: Extract<LiteratureCatalogCommand, { kind: 'settle-candidates' }>
  ): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      if (command.state === 'accepted') {
        for (const candidateId of command.candidateIds) {
          await acceptInboxCandidate(transaction, candidateId)
        }
      } else {
        const updated = await transaction.literatureInboxCandidate.updateMany({
          where: { id: { in: command.candidateIds }, state: 'pending' },
          data: { state: 'dismissed', settledAt: new Date() }
        })
        if (updated.count !== command.candidateIds.length) {
          throw new Error('One or more Literature Inbox candidates are not pending.')
        }
      }
      return {
        kind: 'candidate',
        id: command.candidateIds[0]!,
        state: command.state,
        count: command.candidateIds.length
      }
    })
  }

  private async restoreCandidates(
    candidateIds: readonly string[]
  ): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      const updated = await transaction.literatureInboxCandidate.updateMany({
        where: { id: { in: [...candidateIds] }, state: 'dismissed' },
        data: { state: 'pending', settledAt: null }
      })
      if (updated.count !== candidateIds.length) {
        throw new Error('One or more Literature Inbox candidates are not dismissed.')
      }
      return {
        kind: 'candidate',
        id: candidateIds[0]!,
        state: 'pending',
        count: candidateIds.length
      }
    })
  }

  private async createCollection(
    nameInput: string,
    descriptionInput?: string,
    parentId?: string
  ): Promise<LiteratureCatalogReceipt> {
    const name = normalizeSpace(nameInput)
    if (!name) throw new Error('Literature Collection name is required.')
    const client = await this.getClient()
    const last = await client.literatureCollection.findFirst({
      where: { parentId: parentId ?? null },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true }
    })
    const collection = await client.literatureCollection
      .create({
        data: {
          name,
          nameKey: name.toLowerCase(),
          description: descriptionInput?.trim() ?? '',
          parentId,
          sortOrder: (last?.sortOrder ?? -1) + 1
        },
        select: { id: true }
      })
      .catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new Error(LITERATURE_COLLECTION_NAME_CONFLICT)
        }
        throw error
      })
    return { kind: 'collection', id: collection.id }
  }

  private async updateCollection(
    command: Extract<LiteratureCatalogCommand, { kind: 'update-collection' }>
  ): Promise<LiteratureCatalogReceipt> {
    const name = normalizeSpace(command.name)
    if (!name) throw new Error('Literature Collection name is required.')
    const client = await this.getClient()
    const collection = await client.literatureCollection
      .update({
        where: { id: command.collectionId },
        data: {
          name,
          nameKey: name.toLowerCase(),
          description: command.description.trim()
        },
        select: { id: true }
      })
      .catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new Error(LITERATURE_COLLECTION_NAME_CONFLICT)
        }
        throw error
      })
    return { kind: 'collection', id: collection.id }
  }

  private async deleteCollection(collectionId: string): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    const collection = await client.literatureCollection
      .delete({
        where: { id: collectionId },
        select: { id: true }
      })
      .catch((error: unknown) => {
        // SQLite rolls back the entire delete if promoting a child would duplicate a root name.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new Error(LITERATURE_COLLECTION_NAME_CONFLICT)
        }
        throw error
      })
    return { kind: 'collection', id: collection.id }
  }

  private async setCollectionItem(
    command: Extract<LiteratureCatalogCommand, { kind: 'set-collection-item' }>
  ): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    if (!command.included) {
      await client.$transaction((transaction) =>
        transaction.literatureCollectionItem.deleteMany({
          where: { collectionId: command.collectionId, itemId: command.itemId }
        })
      )
      return { kind: 'item', id: command.itemId, state: 'unlinked' }
    }
    await client.$transaction(async (transaction) => {
      const last = await transaction.literatureCollectionItem.findFirst({
        where: { collectionId: command.collectionId },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true }
      })
      await transaction.literatureCollectionItem.upsert({
        where: {
          collectionId_itemId: { collectionId: command.collectionId, itemId: command.itemId }
        },
        create: {
          collectionId: command.collectionId,
          itemId: command.itemId,
          sortOrder: (last?.sortOrder ?? -1) + 1
        },
        update: {}
      })
    })
    return { kind: 'item', id: command.itemId, state: 'linked' }
  }

  private async setProjectItem(
    command: Extract<LiteratureCatalogCommand, { kind: 'set-project-item' }>
  ): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    if (!command.included) {
      await client.$transaction((transaction) =>
        transaction.projectLiterature.deleteMany({
          where: { projectId: command.projectId, itemId: command.itemId }
        })
      )
      return { kind: 'item', id: command.itemId, state: 'unlinked' }
    }
    const source = normalizeSpace(command.source)
    if (!source) throw new Error('Project Literature source is required.')
    await client.$transaction((transaction) =>
      transaction.projectLiterature.upsert({
        where: { projectId_itemId: { projectId: command.projectId, itemId: command.itemId } },
        create: { projectId: command.projectId, itemId: command.itemId, source },
        update: { source }
      })
    )
    return { kind: 'item', id: command.itemId, state: 'linked' }
  }

  private async setProjectItems(
    command: Extract<LiteratureCatalogCommand, { kind: 'set-project-items' }>
  ): Promise<LiteratureCatalogReceipt> {
    const itemIds = [...new Set(command.itemIds)]
    const client = await this.getClient()
    if (!command.included) {
      await client.$transaction((transaction) =>
        transaction.projectLiterature.deleteMany({
          where: { projectId: command.projectId, itemId: { in: itemIds } }
        })
      )
      return { kind: 'item', id: itemIds[0]!, state: 'unlinked' }
    }
    const source = normalizeSpace(command.source)
    if (!source) throw new Error('Project Literature source is required.')
    await client.$transaction((transaction) =>
      Promise.all(
        itemIds.map((itemId) =>
          transaction.projectLiterature.upsert({
            where: { projectId_itemId: { projectId: command.projectId, itemId } },
            create: { projectId: command.projectId, itemId, source },
            update: { source }
          })
        )
      )
    )
    return { kind: 'item', id: itemIds[0]!, state: 'linked' }
  }

  private async setItemLifecycle(
    command: Extract<LiteratureCatalogCommand, { kind: 'set-item-lifecycle' }>
  ): Promise<LiteratureCatalogReceipt> {
    const itemIds = [...new Set(command.itemIds)]
    const client = await this.getClient()
    const now = new Date()
    await client.$transaction(async (transaction) => {
      const updated = await transaction.literatureItem.updateMany({
        where: { id: { in: itemIds }, mergedIntoItemId: null },
        data: command.state === 'deleted' ? { deletedAt: now } : { deletedAt: null }
      })
      if (updated.count !== itemIds.length) {
        throw new Error('One or more Literature Items are unavailable.')
      }
    })
    return { kind: 'item', id: itemIds[0]!, state: command.state }
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
    const itemIds = [...new Set(command.itemIds)]
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      const requestedItems = await transaction.literatureItem.findMany({
        where: { id: { in: itemIds } },
        select: { id: true, deletedAt: true }
      })
      if (
        requestedItems.length !== itemIds.length ||
        requestedItems.some(({ deletedAt }) => deletedAt === null)
      ) {
        throw new Error('Only Literature Items in Trash can be permanently deleted.')
      }

      const mergedItems = await transaction.literatureItem.findMany({
        where: { mergedIntoItemId: { in: itemIds } },
        select: { id: true }
      })
      const deletionIds = [...new Set([...itemIds, ...mergedItems.map(({ id }) => id)])]
      const creatorLinks = await transaction.literatureItemCreator.findMany({
        where: { itemId: { in: deletionIds } },
        select: { creatorId: true }
      })

      await transaction.literatureInboxCandidate.deleteMany({
        where: { acceptedItemId: { in: deletionIds } }
      })
      await transaction.tagAssignment.deleteMany({
        where: { resourceType: 'literature.item', resourceId: { in: deletionIds } }
      })
      await transaction.literatureItem.updateMany({
        where: { id: { in: deletionIds } },
        data: { mergedIntoItemId: null }
      })
      await transaction.literatureItem.deleteMany({ where: { id: { in: deletionIds } } })

      const creatorIds = [...new Set(creatorLinks.map(({ creatorId }) => creatorId))]
      if (creatorIds.length > 0) {
        await transaction.literatureCreator.deleteMany({
          where: { id: { in: creatorIds }, items: { none: {} } }
        })
      }
      return { kind: 'item', id: itemIds[0]!, state: 'deleted-permanently' }
    })
  }

  private async moveCollectionItems(
    command: Extract<LiteratureCatalogCommand, { kind: 'move-collection-items' }>
  ): Promise<LiteratureCatalogReceipt> {
    const itemIds = [...new Set(command.itemIds)]
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      const target = await transaction.literatureCollection.findUnique({
        where: { id: command.targetCollectionId },
        select: { id: true }
      })
      if (!target) throw new Error('Literature Collection is unavailable.')
      const available = await transaction.literatureItem.count({
        where: { id: { in: itemIds }, deletedAt: null, mergedIntoItemId: null }
      })
      if (available !== itemIds.length)
        throw new Error('One or more Literature Items are unavailable.')
      const last = await transaction.literatureCollectionItem.findFirst({
        where: { collectionId: target.id },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true }
      })
      let sortOrder = (last?.sortOrder ?? -1) + 1
      for (const itemId of itemIds) {
        await transaction.literatureCollectionItem.upsert({
          where: { collectionId_itemId: { collectionId: target.id, itemId } },
          create: { collectionId: target.id, itemId, sortOrder },
          update: {}
        })
        sortOrder += 1
      }
      if (command.sourceCollectionId && command.sourceCollectionId !== command.targetCollectionId) {
        await transaction.literatureCollectionItem.deleteMany({
          where: { collectionId: command.sourceCollectionId, itemId: { in: itemIds } }
        })
      }
      return { kind: 'item', id: itemIds[0]!, state: 'linked' }
    })
  }

  private async mergeItems(
    command: Extract<LiteratureCatalogCommand, { kind: 'merge-items' }>
  ): Promise<LiteratureCatalogReceipt> {
    const client = await this.getClient()
    return client.$transaction((transaction) => this.mergeItemsInTransaction(transaction, command))
  }

  private async mergeDuplicates(
    command: Extract<LiteratureCatalogCommand, { kind: 'merge-duplicates' }>
  ): Promise<LiteratureCatalogReceipt> {
    const strategy = command.strategy ?? 'conflict-free'
    if (strategy !== 'conflict-free' && command.mode === 'commit' && !command.expectedItems) {
      throw new Error('Preview the selected merge strategy before committing.')
    }
    const batch: NonNullable<LiteratureCatalogReceipt['batch']> = {
      eligible: 0,
      reduced: 0,
      review: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
      groups: [],
      details: []
    }
    const seen = new Set<string>()
    const client = await this.getClient()
    for (const [groupIndex, ids] of command.groups.entries()) {
      const detail: NonNullable<typeof batch.details>[number] = { groupIndex, status: 'skipped' }
      batch.details!.push(detail)
      if (ids.length > 20 || ids.some((id) => seen.has(id)) || new Set(ids).size !== ids.length) {
        detail.reason = ids.length > 20 ? 'too-large' : 'overlapping'
        batch.skipped += 1
        batch.review += 1
        continue
      }
      ids.forEach((id) => seen.add(id))
      try {
        const merged = await client.$transaction(async (transaction) => {
          const rows = await transaction.literatureItem.findMany({
            where: { id: { in: ids }, deletedAt: null, mergedIntoItemId: null },
            include: itemInclude,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
          })
          if (rows.length !== ids.length) {
            detail.reason = 'unavailable'
            return undefined
          }
          const views = rows.map(toItemView)
          detail.title = views[0]?.item.title
          if (
            command.mode === 'commit' &&
            command.expectedItems &&
            views.some(
              (view) =>
                !command.expectedItems!.some(
                  (expected) =>
                    expected.id === view.id &&
                    expected.metadataRevision === view.metadataRevision &&
                    expected.updatedAt === view.updatedAt
                )
            )
          ) {
            detail.reason = 'changed'
            return undefined
          }
          const plan = planLiteratureMerge(views, strategy)
          if (!plan) {
            detail.reason =
              strategy === 'conflict-free' && planLiteratureMerge(views, 'oldest')
                ? 'conflicts'
                : 'identity'
            return undefined
          }
          const items = views.map(({ id, metadataRevision, updatedAt }) => ({
            id,
            metadataRevision,
            updatedAt
          }))
          if (command.mode === 'commit') {
            await this.mergeItemsInTransaction(transaction, {
              kind: 'merge-items',
              survivorId: plan.survivor.id,
              duplicateIds: rows.filter((row) => row.id !== plan.survivor.id).map((row) => row.id),
              expectedMetadataRevision: plan.survivor.metadataRevision,
              expectedItems: items,
              item: plan.item
            })
          }
          return {
            survivorId: plan.survivor.id,
            survivorTitle: plan.survivor.item.title,
            conflicts: plan.conflicts,
            items
          }
        })
        if (merged) {
          // Publish the result only after the transaction commits successfully.
          batch.groups!.push(merged)
          detail.status = command.mode === 'commit' ? 'merged' : 'ready'
          batch.eligible += 1
          batch.reduced += ids.length - 1
          if (command.mode === 'commit') batch.succeeded += 1
        } else {
          batch.review += 1
          batch.skipped += 1
        }
      } catch {
        detail.status = 'failed'
        detail.reason = 'failed'
        batch.failed += 1
      }
    }
    return { kind: 'item', id: command.groups[0][0], batch }
  }

  private async mergeItemsInTransaction(
    transaction: Prisma.TransactionClient,
    command: Extract<LiteratureCatalogCommand, { kind: 'merge-items' }>
  ): Promise<LiteratureCatalogReceipt> {
    const duplicateIds = [...new Set(command.duplicateIds)].filter(
      (itemId) => itemId !== command.survivorId
    )
    if (duplicateIds.length !== command.duplicateIds.length) {
      throw new Error('Duplicate Literature Item ids must be unique and exclude the survivor.')
    }
    const rows = await transaction.literatureItem.findMany({
      where: {
        id: { in: [command.survivorId, ...duplicateIds] },
        deletedAt: null,
        mergedIntoItemId: null
      },
      select: { id: true, metadataRevision: true, updatedAt: true }
    })
    if (rows.length !== duplicateIds.length + 1) {
      throw new Error('One or more Literature Items are unavailable for merging.')
    }
    if (
      command.expectedItems.length !== rows.length ||
      rows.some(
        (row) =>
          !command.expectedItems.some(
            (expected) =>
              expected.id === row.id &&
              expected.metadataRevision === row.metadataRevision &&
              expected.updatedAt === row.updatedAt.getTime()
          )
      )
    ) {
      throw new Error('Literature references changed after review.')
    }
    await transaction.literatureIdentifier.deleteMany({
      where: { itemId: { in: duplicateIds } }
    })
    await replaceItemMetadata(
      transaction,
      command.survivorId,
      command.expectedMetadataRevision,
      command.item
    )

    const [memberships, projects, assignments] = await Promise.all([
      transaction.literatureCollectionItem.findMany({
        where: { itemId: { in: duplicateIds } },
        select: { collectionId: true, itemId: true, sortOrder: true }
      }),
      transaction.projectLiterature.findMany({
        where: { itemId: { in: duplicateIds } },
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
            itemId: command.survivorId
          }
        },
        create: {
          collectionId: membership.collectionId,
          itemId: command.survivorId,
          sortOrder: membership.sortOrder
        },
        update: {}
      })
    }
    for (const project of projects) {
      await transaction.projectLiterature.upsert({
        where: {
          projectId_itemId: { projectId: project.projectId, itemId: command.survivorId }
        },
        create: {
          projectId: project.projectId,
          itemId: command.survivorId,
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
            resourceId: command.survivorId
          }
        },
        create: {
          tagId: assignment.tagId,
          resourceType: 'literature.item',
          resourceId: command.survivorId
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
        data: { itemId: command.survivorId }
      }),
      transaction.literatureSourceRecord.updateMany({
        where: { itemId: { in: duplicateIds } },
        data: { itemId: command.survivorId }
      }),
      transaction.literatureInboxCandidate.updateMany({
        where: { acceptedItemId: { in: duplicateIds } },
        data: { acceptedItemId: command.survivorId }
      })
    ])
    await transaction.literatureItem.updateMany({
      where: {
        OR: [{ id: { in: duplicateIds } }, { mergedIntoItemId: { in: duplicateIds } }]
      },
      data: { deletedAt: new Date(), mergedIntoItemId: command.survivorId }
    })
    return { kind: 'item', id: command.survivorId, state: 'merged' }
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
          provider_externalId: { provider: data.provider, externalId: data.externalId }
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

export { LiteratureCatalog, candidateDedupeKey, normalizeIdentifier }
export type {
  ApplyLiteratureMetadataInput,
  AttachedLiteratureContent,
  AttachLiteratureContentInput
}
