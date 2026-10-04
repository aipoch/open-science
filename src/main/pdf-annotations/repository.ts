import { previewSharing, commitSharing } from './sharing'
import { registerVerifiedPdfContent } from '../pdf-documents/identity'
import type { PdfNativeAnnotationDraft } from './native-import-core'
import type { PdfSharingPreview, PdfSharingDecision } from '../../shared/pdf-annotations'
import {
  bindingId,
  bindingSource,
  bindingWhere,
  ensureBinding,
  projectAnnotation,
  resolveAnnotationId,
  touchDocument,
  removeDocumentSources,
  type DocumentTransaction
} from './document-store'
import { Prisma, type PdfAnnotation as PdfAnnotationRow, type PrismaClient } from '@prisma/client'
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { createLogger, diagnosticErrorFields } from '../logger'
import {
  pdfAnnotationScope,
  pdfNativeImportReceiptSchema,
  type PdfNativeImportReceipt,
  type PdfAnnotationScope,
  type PdfAnnotationsChangedEvent,
  type PdfAnnotationSource
} from '../../shared/pdf-annotations'
const log = createLogger('pdf-annotations')
type NativeImportReceiptInput = {
  scope: PdfAnnotationScope
  source: PdfAnnotationSource
  result: PdfNativeImportReceipt
}
const importReceiptId = (scope: PdfAnnotationScope, source: PdfAnnotationSource): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        scope.projectId ?? null,
        source.kind,
        source.sourceFileId,
        source.versionId,
        source.checksum
      ])
    )
    .digest('hex')
import { z } from 'zod'
import {
  createPdfAnnotationRequestSchema,
  pdfAnnotationSchema,
  type CreatePdfAnnotationRequest,
  type DeletePdfAnnotationRequest,
  type ListPdfAnnotationsRequest,
  type PdfAnnotation,
  type PdfAnnotationListResult,
  type UpdatePdfAnnotationRequest
} from '../../shared/pdf-annotations'

type Client = Pick<
  PrismaClient,
  | '$transaction'
  | 'pdfDocument'
  | 'contentBlob'
  | 'uploadVersion'
  | 'artifactVersion'
  | 'pdfAnnotationDocument'
  | 'pdfAnnotationSourceBinding'
  | 'pdfAnnotationAlias'
  | 'pdfAnnotation'
  | 'pdfAnnotationImport'
  | 'tagAssignment'
  | 'tag'
  | 'project'
  | 'projectDeletionIntent'
  | 'literatureAttachmentVersion'
>
type Transaction = Pick<
  Prisma.TransactionClient,
  | 'pdfDocument'
  | 'contentBlob'
  | 'uploadVersion'
  | 'artifactVersion'
  | 'pdfAnnotationDocument'
  | 'pdfAnnotationSourceBinding'
  | 'pdfAnnotationAlias'
  | 'pdfAnnotation'
  | 'pdfAnnotationImport'
  | 'tagAssignment'
  | 'tag'
  | 'project'
  | 'projectDeletionIntent'
  | 'literatureAttachmentVersion'
>
const selectorEnvelope = z.object({ version: z.literal(1), selector: z.unknown() }).strict()

const annotationFromRow = (row: PdfAnnotationRow, tagIds: string[]): PdfAnnotation =>
  pdfAnnotationSchema.parse({
    id: row.id,
    projectId: row.projectId ?? undefined,
    sessionId: row.sessionId ?? undefined,
    ...(row.projectId === null ? { literatureVersionId: row.versionId } : {}),
    version: 1,
    kind: row.kind,
    color: row.color ?? undefined,
    origin: row.origin === 'imported' ? 'imported' : 'user',
    externalSubtype: row.externalSubtype ?? undefined,
    tagIds,
    note: row.note,
    target: {
      source: {
        kind: row.sourceKind,
        projectId: row.projectId ?? undefined,
        sourceFileId: row.sourceFileId,
        versionId: row.versionId,
        sessionId: row.sourceSessionId ?? undefined,
        checksum: row.checksum,
        name: row.name,
        path: row.path
      },
      selector: selectorEnvelope.parse(JSON.parse(row.selectorJson)).selector
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  })

const recover = (existing: PdfAnnotation, request: CreatePdfAnnotationRequest): PdfAnnotation => {
  const content = {
    ...request,
    createdInSessionId: undefined,
    sessionId:
      request.createdInSessionId === undefined
        ? request.sessionId
        : (request.createdInSessionId ?? undefined),
    origin: request.origin ?? 'user',
    tagIds: [...request.tagIds].sort(),
    version: 1,
    createdAt: existing.createdAt,
    updatedAt: existing.updatedAt
  }
  if (
    !isDeepStrictEqual(JSON.parse(JSON.stringify(existing)), JSON.parse(JSON.stringify(content)))
  ) {
    throw new Error('PDF annotation identity already exists with different content.')
  }
  return existing
}

const readAnnotations = async (
  client: Pick<
    Transaction,
    | 'tagAssignment'
    | 'pdfAnnotationSourceBinding'
    | 'project'
    | 'projectDeletionIntent'
    | 'literatureAttachmentVersion'
  >,
  rows: PdfAnnotationRow[],
  preferredProjectId?: string
): Promise<PdfAnnotation[]> => {
  if (!rows.length) return []
  const assignments = await client.tagAssignment.findMany({
    where: { resourceType: 'pdf.annotation', resourceId: { in: rows.map(({ id }) => id) } },
    orderBy: { tagId: 'asc' }
  })
  const byId = new Map<string, string[]>()
  for (const { resourceId, tagId } of assignments) {
    const ids = byId.get(resourceId) ?? []
    ids.push(tagId)
    byId.set(resourceId, ids)
  }
  const sources = await client.pdfAnnotationSourceBinding.findMany({
    where: { documentId: { in: rows.map((row) => row.documentId) } },
    orderBy: { id: 'asc' }
  })
  const [projects, deletions, versions] = await Promise.all([
    client.project.findMany({
      where: {
        id: { in: sources.flatMap((source) => (source.projectId ? [source.projectId] : [])) },
        deletedAt: null
      },
      select: { id: true }
    }),
    client.projectDeletionIntent.findMany({ select: { projectId: true } }),
    client.literatureAttachmentVersion.findMany({
      where: {
        id: { in: sources.filter((source) => !source.projectId).map((source) => source.versionId) },
        attachment: { item: { deletedAt: null, mergedIntoItemId: null } }
      },
      select: { id: true }
    })
  ])
  const activeProjects = new Set(projects.map((project) => project.id))
  for (const deletion of deletions) activeProjects.delete(deletion.projectId)
  const activeVersions = new Set(versions.map((version) => version.id))
  const activeSources = sources.filter((source) =>
    source.projectId ? activeProjects.has(source.projectId) : activeVersions.has(source.versionId)
  )
  return rows.flatMap((row) => {
    const live = activeSources.filter((source) => source.documentId === row.documentId)
    // Internal resource snapshots retain Trash records; prefer a live navigation route when one exists.
    const candidates = live.length
      ? live
      : sources.filter((source) => source.documentId === row.documentId)
    const source =
      (preferredProjectId
        ? (candidates.find((source) => source.projectId === preferredProjectId) ??
          candidates.find((source) => source.projectId === null))
        : undefined) ??
      candidates.find(
        (source) => source.projectId === row.projectId && source.versionId === row.versionId
      ) ??
      candidates[0]
    return source ? [annotationFromRow(projectAnnotation(row, source), byId.get(row.id) ?? [])] : []
  })
}
const replaceTags = async (
  transaction: Transaction,
  id: string,
  tagIds: readonly string[]
): Promise<void> => {
  const tags = await transaction.tag.findMany({
    where: { id: { in: [...tagIds] } },
    select: { id: true }
  })
  if (tags.length !== tagIds.length)
    throw new Error('Tag no longer exists. Reload Tags and try again.')
  await transaction.tagAssignment.deleteMany({
    where: { resourceType: 'pdf.annotation', resourceId: id, tagId: { notIn: [...tagIds] } }
  })
  for (const tagId of tagIds) {
    const reference = { resourceType: 'pdf.annotation', resourceId: id, tagId }
    await transaction.tagAssignment.upsert({
      where: { tagId_resourceType_resourceId: reference },
      create: reference,
      update: {}
    })
  }
}

// Call from the resource owner's transaction; polymorphic assignments have no resource FK.
const deletePdfAnnotations = async (
  transaction: DocumentTransaction,
  where: {
    id?: string | { in: string[] }
    projectId?: string | null
    sessionId?: string | null | { in: string[] }
    sourceKind?: string
    sourceFileId?: string | { in: string[] }
    versionId?: string
    updatedAt?: Date
    document?: Prisma.PdfAnnotationWhereInput['document']
  }
): Promise<number> => {
  if (!where.id) {
    const { projectId, sourceKind, sourceFileId, versionId } = where
    return removeDocumentSources(transaction, { projectId, sourceKind, sourceFileId, versionId })
  }
  const rows = await transaction.pdfAnnotation.findMany({ where, select: { id: true } })
  if (!rows.length) return 0
  const ids = rows.map(({ id }) => id)
  await transaction.tagAssignment.deleteMany({
    where: { resourceType: 'pdf.annotation', resourceId: { in: ids } }
  })
  await transaction.pdfAnnotationAlias.updateMany({
    where: { annotationId: { in: ids } },
    data: { annotationId: null }
  })
  return (await transaction.pdfAnnotation.deleteMany({ where: { id: { in: ids } } })).count
}

const scopeWhere = (request: ListPdfAnnotationsRequest): Prisma.PdfAnnotationWhereInput => ({
  document: { sources: { some: bindingWhere(request) } }
})
const scopedRow = async (
  tx: Transaction,
  row: PdfAnnotationRow,
  scope: ListPdfAnnotationsRequest
): Promise<PdfAnnotationRow> => {
  const source = await tx.pdfAnnotationSourceBinding.findFirst({
    where: { ...bindingWhere(scope), documentId: row.documentId },
    orderBy: { id: 'asc' }
  })
  if (!source) throw new Error('PDF annotation source is not available.')
  await requireDocumentOwner(tx, source)
  return projectAnnotation(row, source)
}

const requireProject = async (
  client: Pick<Transaction, 'project' | 'projectDeletionIntent'>,
  projectId: string
): Promise<void> => {
  const [project, deletion] = await Promise.all([
    client.project.findFirst({ where: { id: projectId, deletedAt: null }, select: { id: true } }),
    client.projectDeletionIntent.findUnique({ where: { projectId }, select: { projectId: true } })
  ])
  if (!project || deletion) throw new Error('Project not available.')
}

// Check the owning Project or catalog row inside the transaction so deletion cannot race a write.
const requireDocumentOwner = async (
  transaction: Transaction,
  row: {
    sourceKind: string
    versionId: string
    sourceFileId: string
    checksum: string
    projectId: string | null
  }
): Promise<void> => {
  if (row.projectId !== null) {
    await requireProject(transaction, row.projectId)
    return
  }
  const version = await transaction.literatureAttachmentVersion.findFirst({
    where: {
      id: row.versionId,
      attachmentId: row.sourceFileId,
      checksum: row.checksum,
      attachment: { item: { deletedAt: null, mergedIntoItemId: null } }
    }
  })
  if (row.sourceKind !== 'literature-attachment-version' || !version)
    throw new Error('PDF annotation source is not available.')
}

class PdfAnnotationRepository {
  constructor(
    private readonly getClient: () => Promise<Client>,
    private readonly onChanged?: (
      event?: PdfAnnotationsChangedEvent,
      tagsChanged?: boolean
    ) => Promise<void>
  ) {}

  private async notifyChanged(
    event?: PdfAnnotationsChangedEvent,
    tagsChanged = true
  ): Promise<void> {
    try {
      if (!event) {
        await this.onChanged?.(undefined, tagsChanged)
        return
      }
      const client = await this.getClient()
      const documents = await client.pdfAnnotationSourceBinding.findMany({
        where: bindingWhere(event.scope),
        select: { documentId: true }
      })
      const bindings = await client.pdfAnnotationSourceBinding.findMany({
        where: { documentId: { in: documents.map((row) => row.documentId) } }
      })
      const scopes = new Map<string, PdfAnnotationScope>()
      scopes.set(JSON.stringify(pdfAnnotationScope(event.scope)), pdfAnnotationScope(event.scope))
      for (const source of bindings) {
        const scope = source.projectId
          ? { projectId: source.projectId }
          : { literatureVersionId: source.versionId }
        scopes.set(JSON.stringify(scope), scope)
      }
      for (const scope of scopes.values()) await this.onChanged?.({ ...event, scope }, tagsChanged)
    } catch (error) {
      log.warn('Could not publish committed PDF annotation changes', diagnosticErrorFields(error))
    }
  }

  async registerVerifiedSource(source: PdfAnnotationSource, sizeBytes: number): Promise<boolean> {
    const client = await this.getClient()
    const result = await client.$transaction(async (tx) => {
      await requireDocumentOwner(tx, {
        ...source,
        sourceKind: source.kind,
        projectId: source.projectId ?? null
      })
      const document = await registerVerifiedPdfContent(tx, {
        checksum: source.checksum,
        sizeBytes: BigInt(sizeBytes)
      })
      const previous = await tx.pdfAnnotationSourceBinding.findUnique({
        where: { id: bindingId(source) }
      })
      const binding = await ensureBinding(tx, source, document)
      return {
        changed: previous?.documentId !== binding.documentId,
        pending:
          (await tx.pdfAnnotationDocument.count({ where: { pdfDocumentId: document.id } })) > 1
      }
    })
    if (result.changed) await this.notifySharing(source)
    return result.pending
  }

  async reconcileSource(
    source: PdfAnnotationSource,
    sizeBytes: number,
    drafts: readonly PdfNativeAnnotationDraft[],
    token?: string,
    decisions: readonly PdfSharingDecision[] = []
  ): Promise<PdfSharingPreview | null> {
    const client = await this.getClient()
    let merged = false
    const result = await client.$transaction(async (tx) => {
      await requireDocumentOwner(tx, {
        ...source,
        sourceKind: source.kind,
        projectId: source.projectId ?? null
      })
      const binding = await ensureBinding(tx, source)
      const document = await tx.pdfAnnotationDocument.findUniqueOrThrow({
        where: { id: binding.documentId }
      })
      if (!document.pdfDocumentId || document.sizeBytes !== BigInt(sizeBytes))
        throw new Error('PDF content identity is not verified.')
      const groups = await tx.pdfAnnotationDocument.findMany({
        where: { pdfDocumentId: document.pdfDocumentId, id: { not: document.pdfDocumentId } },
        orderBy: { id: 'asc' }
      })
      for (const group of groups) {
        const documents = { left: document.pdfDocumentId, right: group.id }
        const context = `reconcile:${document.pdfDocumentId}`
        const preview = await previewSharing(tx, source, source, drafts, context, documents)
        if (preview.conflicts.length && !token) return preview
        await commitSharing(
          tx,
          source,
          source,
          sizeBytes,
          drafts,
          context,
          token ?? preview.token,
          decisions,
          documents
        )
        merged = true
        // A decision token covers exactly one conflicting group. The next group is reviewed anew.
        if (token) return { ...preview, committed: true, shared: true }
      }
      return null
    })
    if (merged) await this.notifySharing(source)
    return result
  }

  async previewSharing(
    source: PdfAnnotationSource,
    target: PdfAnnotationSource,
    drafts: readonly PdfNativeAnnotationDraft[],
    context: string
  ): Promise<PdfSharingPreview> {
    const client = await this.getClient()
    return client.$transaction((tx) => previewSharing(tx, source, target, drafts, context))
  }
  async commitSharing(
    tx: Prisma.TransactionClient,
    source: PdfAnnotationSource,
    target: PdfAnnotationSource,
    sizeBytes: number,
    drafts: readonly PdfNativeAnnotationDraft[],
    context: string,
    token: string,
    decisions: readonly PdfSharingDecision[]
  ): Promise<void> {
    for (const value of [source, target])
      await requireDocumentOwner(tx, {
        ...value,
        sourceKind: value.kind,
        projectId: value.projectId ?? null
      })
    await commitSharing(tx, source, target, sizeBytes, drafts, context, token, decisions)
  }
  async notifySharing(source: PdfAnnotationSource): Promise<void> {
    await this.notifyChanged({
      scope: source.projectId
        ? { projectId: source.projectId }
        : { literatureVersionId: source.versionId }
    })
  }

  async get(id: string): Promise<PdfAnnotation | undefined> {
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      const resolvedId = await resolveAnnotationId(transaction, id)
      const row = resolvedId
        ? await transaction.pdfAnnotation.findUnique({ where: { id: resolvedId } })
        : null
      return row ? (await readAnnotations(transaction, [row]))[0] : undefined
    })
  }

  async list(request: ListPdfAnnotationsRequest): Promise<PdfAnnotationListResult> {
    const client = await this.getClient()
    const limit = request.limit ?? 50
    const scope = {
      ...scopeWhere(request),
      ...(request.id ? { id: request.id } : {})
    }
    const after = request.cursor
      ? {
          OR: [
            { createdAt: { gt: new Date(request.cursor.createdAt) } },
            { createdAt: new Date(request.cursor.createdAt), id: { gt: request.cursor.id } }
          ]
        }
      : {}
    return client.$transaction(async (transaction) => {
      if (request.id) {
        const id = await resolveAnnotationId(transaction, request.id)
        if (!id) return { items: [], total: 0 }
        scope.id = id
      }
      if (request.projectId) await requireProject(transaction, request.projectId)
      const rows = await transaction.pdfAnnotation.findMany({
        where: { ...scope, ...after },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit + 1
      })
      const total = await transaction.pdfAnnotation.count({ where: scope })
      const documents = await transaction.pdfAnnotationDocument.findMany({
        where: { sources: { some: bindingWhere(request) } },
        include: { sources: { orderBy: { id: 'asc' } } }
      })
      const sourceGroups = documents
        .filter((document) => document.sources.length > 1)
        .map((document) => document.sources.map(bindingSource))
      const pending = await transaction.pdfAnnotationDocument.findMany({
        where: {
          pdfDocumentId: {
            in: documents.flatMap((document) =>
              document.pdfDocumentId ? [document.pdfDocumentId] : []
            )
          }
        },
        select: { id: true, pdfDocumentId: true }
      })
      const reconciliationSources = documents
        .filter(
          (document) =>
            document.pdfDocumentId &&
            pending.some(
              (group) => group.pdfDocumentId === document.pdfDocumentId && group.id !== document.id
            )
        )
        .flatMap((document) => document.sources.map(bindingSource))
      const projected = await Promise.all(
        rows.slice(0, limit).map((row) => scopedRow(transaction, row, request))
      )
      const page = await readAnnotations(transaction, projected)
      const last = rows.length > limit ? page.at(-1) : undefined
      const receipt =
        !request.cursor &&
        (request.literatureVersionId || (request.sourceFileId && request.versionId))
          ? await transaction.pdfAnnotationImport.findFirst({
              where: {
                document: { sources: { some: bindingWhere(request) } }
              }
            })
          : null
      return {
        items: page,
        total,
        ...(sourceGroups.length ? { sourceGroups } : {}),
        ...(reconciliationSources.length ? { reconciliationSources } : {}),
        ...(receipt
          ? { nativeImport: pdfNativeImportReceiptSchema.parse(JSON.parse(receipt.resultJson)) }
          : {}),
        ...(last ? { nextCursor: { createdAt: last.createdAt, id: last.id } } : {})
      }
    })
  }

  async recoverCreate(request: CreatePdfAnnotationRequest): Promise<PdfAnnotation | undefined> {
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      if (await transaction.pdfAnnotationAlias.findUnique({ where: { id: request.id } }))
        throw new Error('PDF annotation was reconciled. Reload annotations and try again.')
      const existing = await transaction.pdfAnnotation.findUnique({ where: { id: request.id } })
      if (existing) await scopedRow(transaction, existing, request)
      return existing
        ? recover(
            (
              await readAnnotations(transaction, [await scopedRow(transaction, existing, request)])
            )[0],
            request
          )
        : undefined
    })
  }

  async create(input: CreatePdfAnnotationRequest): Promise<PdfAnnotation> {
    const request = createPdfAnnotationRequestSchema.parse(input)
    if (request.projectId !== request.target.source.projectId)
      throw new Error('PDF annotation source project does not match.')
    const client = await this.getClient()
    const { source, selector } = request.target
    const existing = await this.recoverCreate(request)
    if (existing) return existing
    try {
      const created = await client.$transaction(async (transaction) => {
        // Reconciliation may commit after the optimistic idempotency lookup.
        if (await transaction.pdfAnnotationAlias.findUnique({ where: { id: request.id } }))
          throw new Error('PDF annotation was reconciled. Reload annotations and try again.')
        await requireDocumentOwner(transaction, {
          projectId: request.projectId ?? null,
          sourceKind: source.kind,
          versionId: source.versionId,
          sourceFileId: source.sourceFileId,
          checksum: source.checksum
        })
        const binding = await ensureBinding(transaction, source)
        const row = await transaction.pdfAnnotation.create({
          data: {
            id: request.id,
            documentId: binding.documentId,
            projectId: request.projectId,
            sessionId:
              request.createdInSessionId === undefined
                ? request.sessionId
                : (request.createdInSessionId ?? undefined),
            sourceSessionId: source.sessionId,
            sourceKind: source.kind,
            sourceFileId: source.sourceFileId,
            versionId: source.versionId,
            checksum: source.checksum,
            name: source.name,
            path: source.path,
            kind: request.kind,
            selectorJson: JSON.stringify({ version: 1, selector }),
            color: request.color,
            origin: request.origin ?? 'user',
            externalSubtype: request.externalSubtype,
            note: request.note,
            createdAt: request.createdAt ? new Date(request.createdAt) : undefined
          }
        })
        await touchDocument(transaction, binding.documentId)
        await replaceTags(transaction, row.id, request.tagIds)
        return (await readAnnotations(transaction, [row]))[0]
      })
      await this.notifyChanged(
        { scope: request, id: created.id, updatedAt: created.updatedAt },
        created.tagIds.length > 0
      )
      return created
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
        throw error
      const raced = await this.recoverCreate(request)
      if (!raced) throw error
      return raced
    }
  }

  // Native PDF import has no user-created tag assignments. Keeping the batch in one transaction
  // avoids opening a SQLite transaction for every imported mark while retaining the same source
  // validation and idempotent IDs as create().
  async nativeImportReceipt(
    _scope: PdfAnnotationScope,
    source: PdfAnnotationSource
  ): Promise<PdfNativeImportReceipt | undefined> {
    const client = await this.getClient()
    const row = await client.pdfAnnotationImport.findFirst({
      where: { document: { sources: { some: { id: bindingId(source) } } } }
    })
    return row ? pdfNativeImportReceiptSchema.parse(JSON.parse(row.resultJson)) : undefined
  }

  async createMany(
    inputs: readonly CreatePdfAnnotationRequest[],
    receipt?: NativeImportReceiptInput
  ): Promise<number> {
    if (inputs.length === 0 && !receipt) return 0
    const requests = inputs.map((input) => createPdfAnnotationRequestSchema.parse(input))
    if (requests.some((request) => request.tagIds.length > 0)) {
      throw new Error('Batched PDF annotation creation does not support tag assignments.')
    }
    const first = requests[0]
    const uniqueById = new Map<string, CreatePdfAnnotationRequest>()
    for (const request of requests) {
      if (
        request.projectId !== first.projectId ||
        request.sessionId !== first.sessionId ||
        request.literatureVersionId !== first.literatureVersionId ||
        !isDeepStrictEqual(request.target.source, first.target.source)
      ) {
        throw new Error('Batched PDF annotations must share one source and scope.')
      }
      const previous = uniqueById.get(request.id)
      if (previous && !isDeepStrictEqual(previous, request)) {
        throw new Error('PDF annotation identity already exists with different content.')
      }
      uniqueById.set(request.id, request)
    }
    const uniqueRequests = [...uniqueById.values()]
    const source = first?.target.source ?? receipt!.source
    const importScope = first ?? receipt!.scope
    if (
      receipt &&
      importReceiptId(importScope, source) !== importReceiptId(receipt.scope, receipt.source)
    )
      throw new Error('Native import receipt must match annotations.')
    if (receipt) pdfNativeImportReceiptSchema.parse(receipt.result)
    const client = await this.getClient()
    const created = await client.$transaction(async (transaction) => {
      await requireDocumentOwner(transaction, {
        projectId: importScope.projectId ?? null,
        sourceKind: source.kind,
        versionId: source.versionId,
        sourceFileId: source.sourceFileId,
        checksum: source.checksum
      })
      const binding = await ensureBinding(transaction, source)
      if (receipt) {
        const id = importReceiptId(receipt.scope, source)
        if (
          await transaction.pdfAnnotationImport.findUnique({
            where: { documentId: binding.documentId }
          })
        )
          return 0
        await transaction.pdfAnnotationImport.create({
          data: {
            id,
            documentId: binding.documentId,
            projectId: importScope.projectId,
            sessionId: importScope.sessionId,
            sourceKind: source.kind,
            sourceFileId: source.sourceFileId,
            versionId: source.versionId,
            checksum: source.checksum,
            resultJson: JSON.stringify(receipt.result)
          }
        })
      }
      const existing = await transaction.pdfAnnotation.findMany({
        where: { id: { in: uniqueRequests.map((request) => request.id) } },
        select: { id: true }
      })
      const existingIds = new Set(existing.map(({ id }) => id))
      const pending = uniqueRequests.filter((request) => !existingIds.has(request.id))
      await touchDocument(transaction, binding.documentId)
      if (pending.length === 0) return 0
      return (
        await transaction.pdfAnnotation.createMany({
          data: pending.map((request) => ({
            id: request.id,
            documentId: binding.documentId,
            nativeKey:
              request.origin === 'imported' && /^native:[a-f0-9]{32}:[a-f0-9]{64}$/.test(request.id)
                ? request.id.slice(-64)
                : null,
            nativeBaselineJson:
              request.origin === 'imported'
                ? JSON.stringify({ note: request.note, color: request.color ?? null, tagIds: [] })
                : null,
            projectId: request.projectId,
            sessionId:
              request.createdInSessionId === undefined
                ? request.sessionId
                : (request.createdInSessionId ?? undefined),
            sourceSessionId: request.target.source.sessionId,
            sourceKind: request.target.source.kind,
            sourceFileId: request.target.source.sourceFileId,
            versionId: request.target.source.versionId,
            checksum: request.target.source.checksum,
            name: request.target.source.name,
            path: request.target.source.path,
            kind: request.kind,
            selectorJson: JSON.stringify({ version: 1, selector: request.target.selector }),
            color: request.color,
            origin: request.origin ?? 'user',
            externalSubtype: request.externalSubtype,
            note: request.note,
            createdAt: request.createdAt ? new Date(request.createdAt) : undefined
          }))
        })
      ).count
    })
    if (created) await this.notifyChanged({ scope: importScope }, false)
    return created
  }

  async update(request: UpdatePdfAnnotationRequest): Promise<PdfAnnotation> {
    const client = await this.getClient()
    if (await client.pdfAnnotationAlias.findUnique({ where: { id: request.id } }))
      throw new Error('PDF annotation was reconciled. Reload annotations and try again.')
    const scope = {
      id: request.id,
      ...scopeWhere(request),
      ...(request.expectedUpdatedAt ? { updatedAt: new Date(request.expectedUpdatedAt) } : {})
    }
    const result = await client.$transaction(async (transaction) => {
      const current = await transaction.pdfAnnotation.findFirst({ where: scope })
      if (!current)
        throw new Error('PDF annotation not found or changed. Reload annotations and try again.')
      await scopedRow(transaction, current, request)
      const updated = await transaction.pdfAnnotation.updateMany({
        where: scope,
        data: {
          updatedAt: new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1)),
          ...(request.note === undefined ? {} : { note: request.note }),
          ...(request.color === undefined ? {} : { color: request.color })
        }
      })
      if (!updated.count) throw new Error('PDF annotation not found.')
      await touchDocument(transaction, current.documentId)
      if (request.tagIds) await replaceTags(transaction, request.id, request.tagIds)
      const row = await transaction.pdfAnnotation.findFirst({
        where: { id: request.id, ...scopeWhere(request) }
      })
      if (!row) throw new Error('PDF annotation not found.')
      return (await readAnnotations(transaction, [await scopedRow(transaction, row, request)]))[0]
    })
    await this.notifyChanged(
      { scope: request, id: result.id, updatedAt: result.updatedAt },
      result.tagIds.length > 0 || request.tagIds !== undefined
    )
    return result
  }

  async delete(request: DeletePdfAnnotationRequest): Promise<boolean> {
    const client = await this.getClient()
    const { expectedUpdatedAt } = request
    const scope = { id: request.id, ...scopeWhere(request) }
    const count = await client.$transaction(async (transaction) => {
      const existing = await transaction.pdfAnnotation.findFirst({ where: scope })
      if (existing) {
        await scopedRow(transaction, existing, request)
        await touchDocument(transaction, existing.documentId)
      }
      const count = await deletePdfAnnotations(transaction, {
        id: request.id,
        document: scope.document,
        ...(expectedUpdatedAt ? { updatedAt: new Date(expectedUpdatedAt) } : {})
      })
      if (!count && expectedUpdatedAt)
        throw new Error('PDF annotation not found or changed. Reload annotations and try again.')
      return count
    })
    if (count) await this.notifyChanged({ scope: request, id: request.id })
    return count > 0
  }
}
export { PdfAnnotationRepository, deletePdfAnnotations, readAnnotations }
