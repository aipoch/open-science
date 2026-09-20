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
        scope.sessionId ?? null,
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
  | 'pdfAnnotation'
  | 'pdfAnnotationImport'
  | 'tagAssignment'
  | 'tag'
  | 'literatureAttachmentVersion'
>
type Transaction = Pick<
  Prisma.TransactionClient,
  'pdfAnnotation' | 'pdfAnnotationImport' | 'tagAssignment' | 'tag' | 'literatureAttachmentVersion'
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
  client: Transaction,
  rows: PdfAnnotationRow[]
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
  return rows.map((row) => annotationFromRow(row, byId.get(row.id) ?? []))
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
  transaction: Pick<Transaction, 'pdfAnnotation' | 'pdfAnnotationImport' | 'tagAssignment'>,
  where: {
    id?: string | { in: string[] }
    projectId?: string | null
    sessionId?: string | null | { in: string[] }
    sourceKind?: string
    sourceFileId?: string | { in: string[] }
    versionId?: string
    updatedAt?: Date
  }
): Promise<number> => {
  if (!where.id) {
    await transaction.pdfAnnotationImport.deleteMany({
      where: {
        projectId: where.projectId,
        sessionId: where.sessionId,
        sourceKind: where.sourceKind,
        sourceFileId: where.sourceFileId,
        versionId: where.versionId
      }
    })
  }
  const rows = await transaction.pdfAnnotation.findMany({ where, select: { id: true } })
  if (!rows.length) return 0
  const ids = rows.map(({ id }) => id)
  await transaction.tagAssignment.deleteMany({
    where: { resourceType: 'pdf.annotation', resourceId: { in: ids } }
  })
  return (await transaction.pdfAnnotation.deleteMany({ where: { id: { in: ids } } })).count
}

const scopeWhere = (
  request: ListPdfAnnotationsRequest
): {
  projectId: string | null
  sessionId: string | null
  sourceKind?: string
  versionId?: string
} => {
  if (request.literatureVersionId && !request.projectId && !request.sessionId)
    return {
      projectId: null,
      sessionId: null,
      sourceKind: 'literature-attachment-version',
      versionId: request.literatureVersionId
    }
  if (!request.literatureVersionId && request.projectId && request.sessionId)
    return { projectId: request.projectId, sessionId: request.sessionId }
  throw new Error('PDF annotation scope is not available.')
}

// The catalog row is checked inside the write transaction so delete/trash cannot race a write.
const requireLibraryVersion = async (
  transaction: Transaction,
  row: {
    sourceKind: string
    versionId: string
    sourceFileId: string
    checksum: string
    projectId: string | null
  }
): Promise<void> => {
  if (row.projectId !== null) return
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
      await this.onChanged?.(
        event ? { ...event, scope: pdfAnnotationScope(event.scope) } : undefined,
        tagsChanged
      )
    } catch (error) {
      log.warn('Could not publish committed PDF annotation changes', diagnosticErrorFields(error))
    }
  }

  async get(id: string): Promise<PdfAnnotation | undefined> {
    const client = await this.getClient()
    return client.$transaction(async (transaction) => {
      const row = await transaction.pdfAnnotation.findUnique({ where: { id } })
      return row ? (await readAnnotations(transaction, [row]))[0] : undefined
    })
  }

  async list(request: ListPdfAnnotationsRequest): Promise<PdfAnnotationListResult> {
    const client = await this.getClient()
    const limit = request.limit ?? 50
    const scope = {
      ...scopeWhere(request),
      ...(request.id ? { id: request.id } : {}),
      ...(request.sourceFileId ? { sourceFileId: request.sourceFileId } : {}),
      ...(!request.literatureVersionId && request.versionId ? { versionId: request.versionId } : {})
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
      const rows = await transaction.pdfAnnotation.findMany({
        where: { ...scope, ...after },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit + 1
      })
      const total = await transaction.pdfAnnotation.count({ where: scope })
      const page = await readAnnotations(transaction, rows.slice(0, limit))
      const last = rows.length > limit ? page.at(-1) : undefined
      const receipt =
        !request.cursor &&
        (request.literatureVersionId || (request.sourceFileId && request.versionId))
          ? await transaction.pdfAnnotationImport.findFirst({
              where: {
                projectId: request.projectId ?? null,
                sessionId: request.sessionId ?? null,
                versionId: request.literatureVersionId ?? request.versionId,
                sourceFileId: request.sourceFileId
              }
            })
          : null
      return {
        items: page,
        total,
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
      const existing = await transaction.pdfAnnotation.findUnique({ where: { id: request.id } })
      if (existing) await requireLibraryVersion(transaction, existing)
      return existing
        ? recover((await readAnnotations(transaction, [existing]))[0], request)
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
        await requireLibraryVersion(transaction, {
          projectId: request.projectId ?? null,
          sourceKind: source.kind,
          versionId: source.versionId,
          sourceFileId: source.sourceFileId,
          checksum: source.checksum
        })
        const row = await transaction.pdfAnnotation.create({
          data: {
            id: request.id,
            projectId: request.projectId,
            sessionId: request.sessionId,
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
    scope: PdfAnnotationScope,
    source: PdfAnnotationSource
  ): Promise<PdfNativeImportReceipt | undefined> {
    const client = await this.getClient()
    const row = await client.pdfAnnotationImport.findUnique({
      where: { id: importReceiptId(scope, source) }
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
      await requireLibraryVersion(transaction, {
        projectId: importScope.projectId ?? null,
        sourceKind: source.kind,
        versionId: source.versionId,
        sourceFileId: source.sourceFileId,
        checksum: source.checksum
      })
      if (receipt) {
        const id = importReceiptId(receipt.scope, source)
        if (await transaction.pdfAnnotationImport.findUnique({ where: { id } })) return 0
        await transaction.pdfAnnotationImport.create({
          data: {
            id,
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
      if (pending.length === 0) return 0
      return (
        await transaction.pdfAnnotation.createMany({
          data: pending.map((request) => ({
            id: request.id,
            projectId: request.projectId,
            sessionId: request.sessionId,
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
    const scope = {
      id: request.id,
      ...scopeWhere(request),
      ...(request.expectedUpdatedAt ? { updatedAt: new Date(request.expectedUpdatedAt) } : {})
    }
    const result = await client.$transaction(async (transaction) => {
      const current = await transaction.pdfAnnotation.findFirst({ where: scope })
      if (!current)
        throw new Error('PDF annotation not found or changed. Reload annotations and try again.')
      await requireLibraryVersion(transaction, current)
      const updated = await transaction.pdfAnnotation.updateMany({
        where: scope,
        data: {
          updatedAt: new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1)),
          ...(request.note === undefined ? {} : { note: request.note }),
          ...(request.color === undefined ? {} : { color: request.color })
        }
      })
      if (!updated.count) throw new Error('PDF annotation not found.')
      if (request.tagIds) await replaceTags(transaction, request.id, request.tagIds)
      const row = await transaction.pdfAnnotation.findFirst({
        where: { id: request.id, ...scopeWhere(request) }
      })
      if (!row) throw new Error('PDF annotation not found.')
      return (await readAnnotations(transaction, [row]))[0]
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
      if (existing) await requireLibraryVersion(transaction, existing)
      const count = await deletePdfAnnotations(transaction, {
        ...scope,
        ...(expectedUpdatedAt ? { updatedAt: new Date(expectedUpdatedAt) } : {})
      })
      if (!count && expectedUpdatedAt)
        throw new Error('PDF annotation not found or changed. Reload annotations and try again.')
      return count
    })
    if (count) await this.notifyChanged({ scope: request, id: request.id })
    return count > 0
  }

  async deleteSessions(sessionIds: readonly string[]): Promise<void> {
    if (!sessionIds.length) return
    const client = await this.getClient()
    const count = await client.$transaction((transaction) =>
      deletePdfAnnotations(transaction, { sessionId: { in: [...new Set(sessionIds)] } })
    )
    if (count) await this.notifyChanged()
  }
}
export { PdfAnnotationRepository, deletePdfAnnotations }
