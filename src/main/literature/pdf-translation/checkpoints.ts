import { findVerifiedPdfDocument, registerVerifiedPdfContent } from '../../pdf-documents/identity'
import {
  pdfTranslationLayoutSnapshotSchema,
  pdfTranslationSnapshotMatchesSources
} from '../../../shared/pdf-translation-snapshot'
import { createHash, randomUUID } from 'node:crypto'
import { createLogger } from '../../logger'

const log = createLogger('pdf-translation-checkpoint')
import {
  reconcilePdfTranslationCheckpoint,
  pdfTranslationSourceIndices,
  nextPdfTranslationSourceIndex
} from '../../../shared/pdf-translation-recovery'
import { Prisma, type PrismaClient } from '@prisma/client'
import type { PdfDocumentSource } from '../../../shared/pdf-bookmarks'
import {
  pdfTranslationCheckpointSchema,
  pdfTranslationGlossarySchema,
  pdfTranslationSaveSnapshotSchema,
  type PdfTranslationSaveSnapshotRequest,
  pdfTranslationRecordLayoutSchema,
  pdfTranslationLayoutReportSchema,
  type PdfTranslationRecordLayoutRequest,
  pdfTranslationBlockFailureSchema,
  type PdfTranslationBlockFailure,
  pdfTranslationDocumentSourceSchema,
  pdfTranslationSourceKey,
  type PdfTranslationCheckpointRequest,
  type PdfTranslationCheckpoint,
  type PdfTranslationBeginRequest,
  type PdfTranslationModel,
  type PdfTranslationEdition,
  type PdfTranslationSelectEditionRequest
} from '../../../shared/pdf-translation'
import { withDataRootWrite } from '../../storage/migration-state'

type CheckpointIdentity = Pick<
  PdfTranslationCheckpoint,
  'attachmentVersionId' | 'documentSource' | 'checksum'
>
const storageIdentity = (
  key: string
): { parent: Prisma.Sql; blocks: Prisma.Sql; column: Prisma.Sql; key: string } => ({
  parent: Prisma.raw('"PdfTranslation"'),
  blocks: Prisma.raw('"PdfTranslationBlock"'),
  column: Prisma.raw('"translationId"'),
  key
})
type StorageReference = { id: string }

const textHash = (text: string): string => createHash('sha256').update(text).digest('hex')
const matchingLayoutReports = (
  checkpoint: PdfTranslationCheckpoint,
  reports = checkpoint.layoutReports
): NonNullable<PdfTranslationCheckpoint['layoutReports']> => {
  const translated = new Map(
    pdfTranslationSourceIndices(checkpoint).map((index, position) => [
      index,
      checkpoint.translations[position]
    ])
  )
  return (reports ?? []).filter((report) => {
    const source = checkpoint.sources[report.sourceIndex],
      translation = translated.get(report.sourceIndex)
    return (
      source !== undefined &&
      translation !== undefined &&
      report.sourceHash === textHash(source) &&
      report.translationHash === textHash(translation)
    )
  })
}

type CheckpointRow = {
  payloadJson: string
  layoutSnapshotJson?: string | null
  revision: number
  blocks: { sourceIndex: number; translation: string | null; revision: number }[]
}

const checkpointPayload = (checkpoint: PdfTranslationCheckpoint): string =>
  JSON.stringify({ ...checkpoint, layoutSnapshot: undefined })
const freezeSnapshot = (value: unknown): void => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSnapshot(child)
    Object.freeze(value)
  }
}

// A run uses CAS after each accepted paragraph; a stale window cannot replace newer work.
export class PdfTranslationCheckpoints {
  // Only immutable snapshots read or committed by this owner can use block-sized writes.
  private readonly persistedLengths = new WeakMap<PdfTranslationCheckpoint, number>()
  private readonly storageReferences = new WeakMap<PdfTranslationCheckpoint, StorageReference>()

  private remember(checkpoint: PdfTranslationCheckpoint, length: number): PdfTranslationCheckpoint {
    freezeSnapshot(checkpoint.layoutSnapshot)
    for (const entry of checkpoint.glossary) Object.freeze(entry)
    Object.freeze(checkpoint.glossary)
    Object.freeze(checkpoint.sources)
    Object.freeze(checkpoint.translations)
    Object.freeze(checkpoint.translatedSourceIndices)
    Object.freeze(checkpoint.failedSourceIndices)
    for (const failure of checkpoint.failures ?? []) {
      Object.freeze(failure.pageNumbers)
      Object.freeze(failure)
    }
    Object.freeze(checkpoint.failures)
    for (const report of checkpoint.layoutReports ?? []) {
      if (report.failure) {
        Object.freeze(report.failure.pageNumbers)
        Object.freeze(report.failure)
      }
      Object.freeze(report)
    }
    Object.freeze(checkpoint.layoutReports)
    Object.freeze(checkpoint.model)
    if (checkpoint.documentSource) Object.freeze(checkpoint.documentSource)
    Object.freeze(checkpoint)
    this.persistedLengths.set(checkpoint, length)
    return checkpoint
  }

  constructor(
    private readonly options: {
      getClient: () => Promise<PrismaClient>
      authority: {
        resolveVersion(
          versionId: string
        ): Promise<{ attachmentId: string; checksum: string } | undefined>
      }
      resolveDocumentSource?: (source: PdfDocumentSource) => Promise<PdfDocumentSource | undefined>
    }
  ) {}

  private async resolveIdentity(
    request: PdfTranslationCheckpointRequest
  ): Promise<CheckpointIdentity> {
    if (typeof request !== 'string') {
      const supplied = pdfTranslationDocumentSourceSchema.parse(request)
      if (supplied.kind === 'literature-attachment-version') {
        const version = await this.options.authority.resolveVersion(supplied.versionId)
        if (
          !version ||
          version.attachmentId !== supplied.sourceFileId ||
          version.checksum !== supplied.checksum
        )
          throw new Error('Translation source is unavailable.')
        return { attachmentVersionId: supplied.versionId, checksum: version.checksum }
      }
      const resolved = await this.options.resolveDocumentSource?.(supplied)
      if (!resolved || pdfTranslationSourceKey(supplied) !== pdfTranslationSourceKey(resolved))
        throw new Error('Translation source is unavailable.')
      return { documentSource: resolved, checksum: resolved.checksum }
    }
    if (!request || request.length > 256) throw new Error('Invalid attachment version.')
    const version = await this.options.authority.resolveVersion(request)
    if (!version) throw new Error('Translation source is unavailable.')
    return { attachmentVersionId: request, checksum: version.checksum }
  }

  // Resolve the current access path on every read/write; sharing a result never grants access
  // to another source. Verified documents own editions; readers hold their own selection.
  private async requireSource(
    tx: Prisma.TransactionClient,
    identity: CheckpointIdentity
  ): Promise<{ sizeBytes: bigint }> {
    const source = identity.documentSource
    if (!source) {
      const version = await tx.literatureAttachmentVersion.findFirst({
        where: {
          id: identity.attachmentVersionId,
          checksum: identity.checksum,
          attachment: { item: { deletedAt: null, mergedIntoItemId: null } }
        }
      })
      if (!version) throw new Error('Translation source is unavailable.')
      return { sizeBytes: version.sizeBytes }
    }
    const project = await tx.project.findFirst({ where: { id: source.projectId, deletedAt: null } })
    const version =
      source.kind === 'upload-version'
        ? await tx.uploadVersion.findFirst({
            where: {
              id: source.versionId,
              uploadFileId: source.sourceFileId,
              checksum: identity.checksum,
              state: 'ready',
              uploadFile: { projectId: source.projectId }
            }
          })
        : await tx.artifactVersion.findFirst({
            where: {
              id: source.versionId,
              artifactId: source.sourceFileId,
              checksum: identity.checksum,
              state: 'finalized',
              artifact: { projectId: source.projectId }
            }
          })
    if (!project || !version) throw new Error('Translation source is unavailable.')
    return { sizeBytes: version.sizeBytes }
  }

  async contentKey(request: PdfTranslationCheckpointRequest): Promise<string> {
    const identity = await this.resolveIdentity(request)
    const client = await this.options.getClient()
    // Read-only package attachments have no database owner.
    if (
      identity.attachmentVersionId &&
      !(await client.literatureAttachmentVersion.findUnique({
        where: { id: identity.attachmentVersionId }
      }))
    )
      return identity.checksum
    const source = await client.$transaction((tx) => this.requireSource(tx, identity))
    return `${identity.checksum}:${source.sizeBytes}`
  }

  private async requireDocument(
    tx: Prisma.TransactionClient,
    identity: CheckpointIdentity,
    source: { sizeBytes: bigint }
  ): Promise<string> {
    const content = { checksum: identity.checksum, sizeBytes: source.sizeBytes }
    const document = await findVerifiedPdfDocument(tx, {
      kind: identity.documentSource?.kind ?? 'literature-attachment-version',
      versionId: identity.documentSource?.versionId ?? identity.attachmentVersionId!,
      checksum: identity.checksum
    })
    // resolveIdentity has already verified the managed bytes, including older unregistered PDFs.
    return (document ?? (await registerVerifiedPdfContent(tx, content))).id
  }

  private async readStored(
    tx: Prisma.TransactionClient,
    identity: CheckpointIdentity,
    source: { sizeBytes: bigint },
    checkpointKey?: string
  ): Promise<Prisma.PdfTranslationGetPayload<{ include: { blocks: true } }> | null> {
    const pdfDocumentId = await this.requireDocument(tx, identity, source)
    // Explicit reads never fall back to a different edition when the requested one is gone.
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "PdfTranslation" WHERE "pdfDocumentId" = ${pdfDocumentId}
        ${checkpointKey === undefined ? Prisma.empty : Prisma.sql`AND json_extract("payloadJson", '$.key') = ${checkpointKey}`}
      ORDER BY "createdAt" DESC, "id" DESC LIMIT 1
    `)
    const row = rows[0]
      ? await tx.pdfTranslation.findUnique({ where: { id: rows[0].id }, include: { blocks: true } })
      : null
    if (row && (row.checksum !== identity.checksum || row.sizeBytes !== source.sizeBytes))
      throw new Error('Translation source changed.')
    return row
  }

  async read(
    request: PdfTranslationCheckpointRequest,
    checkpointKey?: string
  ): Promise<PdfTranslationCheckpoint | null> {
    return this.readResolved(await this.resolveIdentity(request), checkpointKey)
  }

  async list(request: PdfTranslationCheckpointRequest): Promise<PdfTranslationEdition[]> {
    const identity = await this.resolveIdentity(request)
    return withDataRootWrite(async () => {
      const client = await this.options.getClient()
      if (
        identity.attachmentVersionId &&
        !(await client.literatureAttachmentVersion.findUnique({
          where: { id: identity.attachmentVersionId }
        }))
      )
        return []
      return client.$transaction(async (tx) => {
        const source = await this.requireSource(tx, identity)
        const pdfDocumentId = await this.requireDocument(tx, identity, source)
        const rows = await tx.$queryRaw<
          Array<{
            id: string
            key: string
            language: string
            glossary: string
            concurrency: number
            model: string
            updatedAt: Date
          }>
        >(Prisma.sql`
          SELECT "id", json_extract("payloadJson", '$.key') AS "key",
            json_extract("payloadJson", '$.language') AS "language",
            json_extract("payloadJson", '$.glossary') AS "glossary",
            coalesce(json_extract("payloadJson", '$.concurrency'), 1) AS "concurrency",
            json_extract("payloadJson", '$.model') AS "model", "updatedAt"
          FROM "PdfTranslation" WHERE "pdfDocumentId" = ${pdfDocumentId}
          ORDER BY "createdAt" DESC, "id" DESC
        `)
        return rows.map((row) => ({
          id: row.id,
          key: pdfTranslationCheckpointSchema.shape.key.parse(row.key),
          language: pdfTranslationCheckpointSchema.shape.language.parse(row.language),
          glossary: pdfTranslationCheckpointSchema.shape.glossary.parse(JSON.parse(row.glossary)),
          concurrency:
            pdfTranslationCheckpointSchema.shape.concurrency.parse(Number(row.concurrency)) ?? 1,
          model: pdfTranslationCheckpointSchema.shape.model.parse(JSON.parse(row.model)),
          updatedAt: new Date(row.updatedAt).getTime()
        }))
      })
    })
  }

  async select(
    request: PdfTranslationSelectEditionRequest,
    signal?: AbortSignal
  ): Promise<PdfTranslationCheckpoint> {
    signal?.throwIfAborted()
    const identity = await this.resolveIdentity(request.source)
    return withDataRootWrite(async () => {
      const client = await this.options.getClient()
      return client.$transaction(async (tx) => {
        const source = await this.requireSource(tx, identity)
        const pdfDocumentId = await this.requireDocument(tx, identity, source)
        const row = await tx.pdfTranslation.findFirst({
          where: { id: request.translationId, pdfDocumentId },
          include: { blocks: true }
        })
        if (row && (row.checksum !== identity.checksum || row.sizeBytes !== source.sizeBytes))
          throw new Error('Translation source changed.')
        const checkpoint = this.decode(row, identity)
        if (!checkpoint || !row) throw new Error('Translation edition is unavailable.')
        signal?.throwIfAborted()
        this.storageReferences.set(checkpoint, { id: row.id })
        return checkpoint
      })
    })
  }

  async delete(request: PdfTranslationSelectEditionRequest, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const identity = await this.resolveIdentity(request.source)
    return withDataRootWrite(async () => {
      const client = await this.options.getClient()
      await client.$transaction(async (tx) => {
        const source = await this.requireSource(tx, identity)
        const pdfDocumentId = await this.requireDocument(tx, identity, source)
        signal?.throwIfAborted()
        // Cascade only this edition's blocks, never the PDF or other editions.
        const result = await tx.pdfTranslation.deleteMany({
          where: { id: request.translationId, pdfDocumentId }
        })
        if (!result.count) throw new Error('Translation edition is unavailable.')
        signal?.throwIfAborted()
      })
    })
  }

  private async readResolved(
    identity: CheckpointIdentity,
    checkpointKey?: string
  ): Promise<PdfTranslationCheckpoint | null> {
    const startedAt = performance.now()
    return withDataRootWrite(async () => {
      const client = await this.options.getClient()
      if (
        identity.attachmentVersionId &&
        !(await client.literatureAttachmentVersion.findUnique({
          where: { id: identity.attachmentVersionId }
        }))
      )
        return null
      return client.$transaction(async (tx) => {
        const source = await this.requireSource(tx, identity)
        const row = await this.readStored(tx, identity, source, checkpointKey)
        const decodedAt = performance.now()
        const checkpoint = this.decode(row, identity)
        if (checkpoint && row) this.storageReferences.set(checkpoint, { id: row.id })
        log.debug('checkpoint restored', {
          stage: 'checkpoint-read',
          storageMs: decodedAt - startedAt,
          decodeMs: performance.now() - decodedAt,
          sourceCount: checkpoint?.sources.length ?? 0,
          blockCount: row?.blocks.length ?? 0,
          payloadChars: row?.payloadJson.length ?? 0,
          layoutSnapshotChars: row?.layoutSnapshotJson?.length ?? 0
        })
        return checkpoint
      })
    })
  }

  private decode(
    row: CheckpointRow | null,
    identity: CheckpointIdentity
  ): PdfTranslationCheckpoint | null {
    if (!row) return null
    if (row.payloadJson.length > 8 * 1024 * 1024) throw new Error('Invalid translation checkpoint.')
    let value = pdfTranslationCheckpointSchema.parse(JSON.parse(row.payloadJson))
    if (value.checksum !== identity.checksum || value.revision !== row.revision)
      throw new Error('Translation source changed.')
    // The payload's original entry point may have been removed. Only the verified current
    // source is exposed to the renderer; the immutable content and saved layout stay shared.
    value = { ...value, attachmentVersionId: undefined, documentSource: undefined, ...identity }
    const state = row.blocks.find((block) => block.sourceIndex === -1)
    const blocks = row.blocks.filter((block) => block.sourceIndex !== -1)
    if (state) {
      if (
        state.translation !== null ||
        state.revision < value.revision ||
        (blocks.length ? Math.max(...blocks.map((block) => block.revision)) : value.revision) !==
          state.revision ||
        blocks.some(
          (block) =>
            block.revision <= value.revision ||
            block.sourceIndex < 0 ||
            block.sourceIndex >= value.sources.length
        )
      )
        throw new Error('Invalid translation checkpoint.')
      const accepted = new Map(
        pdfTranslationSourceIndices(value).map((index, position) => [
          index,
          value.translations[position]
        ])
      )
      const failed = new Set(value.failedSourceIndices ?? [])
      for (const block of blocks) {
        if (block.translation === null) {
          accepted.delete(block.sourceIndex)
          failed.add(block.sourceIndex)
        } else {
          accepted.set(block.sourceIndex, block.translation)
          failed.delete(block.sourceIndex)
        }
      }
      const entries = [...accepted].sort(([a], [b]) => a - b)
      value = pdfTranslationCheckpointSchema.parse({
        ...value,
        version: 1,
        revision: state.revision,
        translations: entries.map(([, text]) => text),
        translatedSourceIndices: entries.map(([index]) => index),
        failedSourceIndices: [...failed].sort((a, b) => a - b),
        ...(value.failures
          ? { failures: value.failures.filter(({ sourceIndex }) => failed.has(sourceIndex)) }
          : {})
      })
    } else if (blocks.length) throw new Error('Invalid translation checkpoint.')
    if (row.layoutSnapshotJson) {
      if (row.layoutSnapshotJson.length > 32 * 1024 * 1024)
        throw new Error('Invalid PDF layout snapshot.')
      const snapshot = pdfTranslationLayoutSnapshotSchema.parse(JSON.parse(row.layoutSnapshotJson))
      if (!pdfTranslationSnapshotMatchesSources(snapshot, value.fingerprint, value.sources))
        throw new Error('PDF layout snapshot does not match translation.')
      value = { ...value, layoutSnapshot: snapshot }
    }
    if (value.layoutReports) value = { ...value, layoutReports: matchingLayoutReports(value) }
    return state ? this.remember(value, checkpointPayload(value).length) : value
  }

  // One-time adoption for legacy checkpoints. Never replace a run's existing layout or
  // touch its revision: a concurrent paragraph save must remain valid.
  async saveSnapshot(input: PdfTranslationSaveSnapshotRequest, signal: AbortSignal): Promise<void> {
    const request = pdfTranslationSaveSnapshotSchema.parse(input)
    await withDataRootWrite(async () => {
      signal.throwIfAborted()
      const identity = await this.resolveIdentity(request.source)
      const client = await this.options.getClient()
      await client.$transaction(async (tx) => {
        const source = await this.requireSource(tx, identity)
        const row = await this.readStored(tx, identity, source, request.checkpointKey)
        if (!row) throw new Error('Translation checkpoint no longer exists.')
        const storage = storageIdentity(row.id)
        const current = pdfTranslationCheckpointSchema.parse(JSON.parse(row.payloadJson))
        if (
          current.key !== request.checkpointKey ||
          current.checksum !== identity.checksum ||
          !pdfTranslationSnapshotMatchesSources(
            request.snapshot,
            current.fingerprint,
            current.sources
          )
        )
          throw new Error('PDF layout snapshot does not match translation.')
        const snapshotJson = JSON.stringify(request.snapshot)
        if (row.layoutSnapshotJson) {
          if (row.layoutSnapshotJson !== snapshotJson)
            throw new Error('PDF layout snapshot is already pinned.')
          return
        }
        signal.throwIfAborted()
        await tx.$executeRaw(Prisma.sql`
          UPDATE ${storage.parent} SET "layoutSnapshotJson" = ${snapshotJson}
          WHERE "id" = ${storage.key} AND "layoutSnapshotJson" IS NULL
        `)
      })
    })
  }

  async recordLayout(input: PdfTranslationRecordLayoutRequest, signal: AbortSignal): Promise<void> {
    const request = pdfTranslationRecordLayoutSchema.parse(input)
    if (
      request.generatedAt > Date.now() + 60000 ||
      new Set(request.units.map((unit) => unit.sourceIndex)).size !== request.units.length
    )
      throw new Error('Invalid PDF layout report.')
    await withDataRootWrite(async () => {
      signal.throwIfAborted()
      const identity = await this.resolveIdentity(request.source)
      const client = await this.options.getClient()
      const applied = await client.$transaction(async (tx) => {
        signal.throwIfAborted()
        const source = await this.requireSource(tx, identity)
        const row = await this.readStored(tx, identity, source, request.checkpointKey)
        if (!row) return []
        const storage = storageIdentity(row.id)
        const current = this.decode(row, identity)
        if (!current || !row || current.key !== request.checkpointKey) return []
        const translated = new Map(
          pdfTranslationSourceIndices(current).map((index, position) => [
            index,
            current.translations[position]
          ])
        )
        const reports = new Map(
          (current.layoutReports ?? []).map((report) => [report.sourceIndex, report])
        )
        const committed: {
          sourceIndex: number
          failure?: PdfTranslationRecordLayoutRequest['units'][number]['failure']
        }[] = []
        for (const unit of request.units) {
          if (
            current.sources[unit.sourceIndex] !== unit.source ||
            translated.get(unit.sourceIndex) !== unit.translation ||
            (reports.get(unit.sourceIndex)?.generatedAt ?? -1) >= request.generatedAt
          )
            continue
          reports.set(unit.sourceIndex, {
            sourceIndex: unit.sourceIndex,
            sourceHash: textHash(unit.source),
            translationHash: textHash(unit.translation),
            generatedAt: request.generatedAt,
            ...(unit.failure ? { failure: unit.failure } : {})
          })
          committed.push({
            sourceIndex: unit.sourceIndex,
            ...(unit.failure ? { failure: unit.failure } : {})
          })
        }
        if (!committed.length) return []
        // Keep the base revision and block overrides intact: diagnostics never invalidate an
        // in-flight translation CAS. Successful reports are tombstones for late old failures.
        const base = pdfTranslationCheckpointSchema.parse(JSON.parse(row.payloadJson))
        const payloadJson = JSON.stringify({
          ...base,
          layoutReports: [...reports.values()].sort((a, b) => a.sourceIndex - b.sourceIndex)
        })
        if (payloadJson.length > 8 * 1024 * 1024) throw new Error('Invalid translation checkpoint.')
        signal.throwIfAborted()
        await tx.$executeRaw(
          Prisma.sql`UPDATE ${storage.parent} SET "payloadJson" = ${payloadJson}, "updatedAt" = ${new Date()} WHERE "id" = ${storage.key}`
        )
        return committed
      })
      const failures = applied.filter((report) => report.failure)
      if (failures.length) {
        const fields = {
          checkpointKey: request.checkpointKey,
          generatedAt: request.generatedAt,
          stage: 'pdf-layout',
          updatedCount: applied.length,
          failureCount: failures.length,
          reports: failures
            .slice(0, 20)
            .map(({ sourceIndex, failure }) => ({ sourceIndex, ...failure }))
        }
        log.warn('PDF layout diagnoses persisted', fields)
      }
    })
  }

  async open(
    input: PdfTranslationBeginRequest,
    targetKey: string,
    model: PdfTranslationModel
  ): Promise<PdfTranslationCheckpoint | undefined> {
    input = { ...input, glossary: pdfTranslationGlossarySchema.parse(input.glossary) }
    if (input.layoutSnapshot) {
      const snapshot = pdfTranslationLayoutSnapshotSchema.parse(input.layoutSnapshot)
      if (!pdfTranslationSnapshotMatchesSources(snapshot, input.fingerprint, input.sources))
        throw new Error('PDF layout snapshot does not match translation.')
      input = { ...input, layoutSnapshot: snapshot }
    }
    const request = input.documentSource ?? input.attachmentVersionId
    if (!request) return undefined
    const identity = await this.resolveIdentity(request)
    const previous = input.checkpoint
      ? await this.readResolved(identity, input.checkpoint.key)
      : null
    // Read-only package attachments retain the existing ephemeral translation flow.
    const client = await this.options.getClient()
    if (
      identity.attachmentVersionId &&
      !(await client.literatureAttachmentVersion.findUnique({
        where: { id: identity.attachmentVersionId }
      }))
    )
      return undefined
    if (input.checkpoint && previous?.key === input.checkpoint.key) {
      if (
        previous.fingerprint !== input.fingerprint ||
        previous.targetKey !== targetKey ||
        previous.language !== input.language ||
        JSON.stringify(previous.glossary) !== JSON.stringify(input.glossary) ||
        (previous.concurrency ?? 1) !== (input.concurrency ?? 1)
      )
        throw new Error('Translation checkpoint does not match.')
      if (
        previous.layoutSnapshot &&
        input.layoutSnapshot &&
        JSON.stringify(previous.layoutSnapshot) !== JSON.stringify(input.layoutSnapshot)
      )
        throw new Error('PDF layout snapshot is already pinned.')
      const reconciled = reconcilePdfTranslationCheckpoint(
        previous,
        input.fingerprint,
        input.sources
      )
      if (!reconciled) throw new Error('Translation checkpoint does not match.')
      const reference = this.storageReferences.get(previous)
      if (reference) this.storageReferences.set(reconciled, reference)
      return reconciled
    }
    if (input.checkpoint) throw new Error('Translation changed in another window.')
    const opened = pdfTranslationCheckpointSchema.parse({
      version: 1,
      key: randomUUID(),
      revision: 1,
      ...identity,
      fingerprint: input.fingerprint,
      language: input.language,
      glossary: input.glossary,
      ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
      targetKey,
      model,
      ...(input.layoutSnapshot ? { layoutSnapshot: input.layoutSnapshot } : {}),
      sources: [...input.sources],
      translatedSourceIndices: [],
      translations: []
    })
    const id = randomUUID()
    // Persist admission before returning its key: cancellation or restart before the
    // first paragraph must leave a resumable edition, not an in-memory-only reference.
    await withDataRootWrite(() =>
      client.$transaction(async (tx) => {
        const source = await this.requireSource(tx, identity)
        await tx.pdfTranslation.create({
          data: {
            id,
            pdfDocumentId: await this.requireDocument(tx, identity, source),
            checksum: identity.checksum,
            sizeBytes: source.sizeBytes,
            revision: opened.revision,
            payloadJson: checkpointPayload(opened),
            layoutSnapshotJson: opened.layoutSnapshot ? JSON.stringify(opened.layoutSnapshot) : null
          }
        })
      })
    )
    this.storageReferences.set(opened, { id })
    return opened
  }

  // Undefined text records a rejected block; it never becomes an accepted translation.
  async append(
    checkpoint: PdfTranslationCheckpoint,
    index: number,
    text: string | undefined,
    signal: AbortSignal,
    replaceExisting = false,
    diagnostic?: PdfTranslationBlockFailure
  ): Promise<PdfTranslationCheckpoint> {
    const startedAt = performance.now()
    return withDataRootWrite(async () => {
      signal.throwIfAborted()
      const position = pdfTranslationSourceIndices(checkpoint).indexOf(index)
      const failed = checkpoint.failedSourceIndices ?? []
      if (!Number.isInteger(index) || index < 0 || index >= checkpoint.sources.length)
        throw new Error('Translation prefix is incomplete.')
      const failure =
        text === undefined && diagnostic !== undefined
          ? pdfTranslationBlockFailureSchema.parse(diagnostic)
          : undefined
      if (
        text === undefined &&
        (position >= 0 ||
          (failed.includes(index) &&
            (!failure ||
              JSON.stringify(
                checkpoint.failures?.find(({ sourceIndex }) => sourceIndex === index)
              ) === JSON.stringify({ ...failure, sourceIndex: index }))))
      )
        return checkpoint
      if (
        replaceExisting
          ? position < 0
          : position >= 0 ||
            ((checkpoint.concurrency ?? 1) === 1 &&
              index !== nextPdfTranslationSourceIndex(checkpoint) &&
              !failed.includes(index))
      )
        throw new Error('Translation prefix is incomplete.')
      const entries = pdfTranslationSourceIndices(checkpoint).map((sourceIndex, position) => ({
        index: sourceIndex,
        translation: checkpoint.translations[position]
      }))
      if (text !== undefined) {
        if (replaceExisting) entries[position] = { index, translation: text }
        else entries.push({ index, translation: text })
      }
      entries.sort((a, b) => a.index - b.index)
      const failures = (checkpoint.failures ?? []).filter(
        ({ sourceIndex }) => sourceIndex !== index
      )
      if (failure) failures.push({ ...failure, sourceIndex: index })
      failures.sort((a, b) => a.sourceIndex - b.sourceIndex)
      const diagnosticsChanged =
        JSON.stringify(failures) !== JSON.stringify(checkpoint.failures ?? [])
      const candidate: PdfTranslationCheckpoint = {
        ...checkpoint,
        version: 1,
        revision: checkpoint.revision + 1,
        failedSourceIndices:
          text === undefined
            ? [...new Set([...failed, index])].sort((a, b) => a - b)
            : failed.filter((failedIndex) => failedIndex !== index),
        ...(checkpoint.failures !== undefined || failure ? { failures } : {}),
        translations: entries.map(({ translation }) => translation),
        translatedSourceIndices: entries.map(({ index }) => index)
      }
      const previousLength = this.persistedLengths.get(checkpoint)
      // Diagnostic changes are rare: fold them into the existing snapshot atomically.
      // Successful paragraphs without changed diagnostics retain block-sized upserts.
      const incremental = previousLength !== undefined && !diagnosticsChanged
      let next: PdfTranslationCheckpoint
      let payloadJson: string | undefined
      let length: number
      if (incremental) {
        pdfTranslationCheckpointSchema.shape.revision.parse(candidate.revision)
        if (text !== undefined) {
          pdfTranslationCheckpointSchema.shape.translations.element.parse(text)
          if (!text.trim()) throw new Error('Invalid translation checkpoint.')
        }
        const arrayLength = (values: readonly number[] | undefined): number =>
          JSON.stringify(values ?? []).length
        length =
          previousLength +
          String(candidate.revision).length -
          String(checkpoint.revision).length +
          arrayLength(candidate.failedSourceIndices) -
          arrayLength(checkpoint.failedSourceIndices) +
          arrayLength(candidate.translatedSourceIndices) -
          arrayLength(checkpoint.translatedSourceIndices) +
          (text === undefined
            ? 0
            : JSON.stringify(text).length -
              (replaceExisting
                ? JSON.stringify(checkpoint.translations[position]).length
                : -(checkpoint.translations.length ? 1 : 0)))
        if (length > 8 * 1024 * 1024) throw new Error('Invalid translation checkpoint.')
        next = candidate
      } else {
        // New runs, legacy prefixes and reconciled extraction changes replace the base once.
        next = pdfTranslationCheckpointSchema.parse(candidate)
        payloadJson = checkpointPayload(next)
        length = payloadJson.length
      }
      const snapshotBuildMs = performance.now() - startedAt
      const request = checkpoint.documentSource ?? checkpoint.attachmentVersionId!
      const identity = await this.resolveIdentity(request)
      signal.throwIfAborted()
      if (identity.checksum !== checkpoint.checksum) throw new Error('Translation source changed.')
      const client = await this.options.getClient()
      let committedId: string | undefined
      await client.$transaction(async (tx) => {
        signal.throwIfAborted()
        const source = await this.requireSource(tx, identity)
        const reference = this.storageReferences.get(checkpoint)
        if (!reference) throw new Error('Translation checkpoint must be reopened.')
        const pdfDocumentId = await this.requireDocument(tx, identity, source)
        const current = await tx.pdfTranslation.findUnique({
          where: { id: reference.id },
          select: { pdfDocumentId: true, checksum: true, sizeBytes: true }
        })
        if (!current) throw new Error('Translation changed in another window.')
        if (
          current &&
          (current.pdfDocumentId !== pdfDocumentId ||
            current.checksum !== identity.checksum ||
            current.sizeBytes !== source.sizeBytes)
        )
          throw new Error('Translation source changed.')
        const storage = storageIdentity(reference.id)
        committedId = storage.key
        if (incremental && replaceExisting) {
          const rows = await tx.$queryRaw<Array<{ reports: string | null }>>(
            Prisma.sql`SELECT json_extract("payloadJson", '$.layoutReports') AS reports FROM ${storage.parent} WHERE "id" = ${storage.key}`
          )
          if (rows[0]?.reports) {
            const storedReports = pdfTranslationLayoutReportSchema
              .array()
              .max(10000)
              .parse(JSON.parse(rows[0].reports))
            const reports = matchingLayoutReports(next, storedReports)
            length +=
              JSON.stringify(reports).length - JSON.stringify(next.layoutReports ?? []).length
            next = { ...next, layoutReports: reports }
            if (length > 8 * 1024 * 1024) throw new Error('Invalid translation checkpoint.')
            if (reports.length !== storedReports.length)
              await tx.$executeRaw(
                Prisma.sql`UPDATE ${storage.parent} SET "payloadJson" = json_set("payloadJson", '$.layoutReports', json(${JSON.stringify(reports)})), "updatedAt" = ${new Date()} WHERE "id" = ${storage.key}`
              )
          }
        }
        if (!incremental) {
          // Snapshot replacement must merge the latest independently committed layout reports.
          // Never copy reports from another run, changed extraction or replaced translations.
          const rows = await tx.$queryRaw<
            Array<{ payloadJson: string; layoutSnapshotJson: string | null }>
          >(
            Prisma.sql`SELECT "payloadJson", "layoutSnapshotJson" FROM ${storage.parent} WHERE "id" = ${storage.key}`
          )
          const current = rows[0]
            ? pdfTranslationCheckpointSchema.parse(JSON.parse(rows[0].payloadJson))
            : undefined
          if (current?.key !== next.key) {
            await tx.$executeRaw(
              Prisma.sql`UPDATE ${storage.parent} SET "layoutSnapshotJson" = NULL WHERE "id" = ${storage.key}`
            )
          } else if (rows[0]?.layoutSnapshotJson) {
            const snapshot = pdfTranslationLayoutSnapshotSchema.parse(
              JSON.parse(rows[0].layoutSnapshotJson)
            )
            if (
              !pdfTranslationSnapshotMatchesSources(snapshot, next.fingerprint, next.sources) ||
              (next.layoutSnapshot &&
                JSON.stringify(next.layoutSnapshot) !== rows[0].layoutSnapshotJson)
            )
              throw new Error('PDF layout snapshot is already pinned.')
            next = { ...next, layoutSnapshot: snapshot }
          }
          const reports =
            current?.key === next.key &&
            current.sources.length === next.sources.length &&
            current.sources.every((source, index) => source === next.sources[index])
              ? matchingLayoutReports(next, current.layoutReports)
              : []
          next = {
            ...next,
            ...(current?.layoutReports || next.layoutReports ? { layoutReports: reports } : {})
          }
          payloadJson = checkpointPayload(next)
          length = payloadJson.length
          if (length > 8 * 1024 * 1024) throw new Error('Invalid translation checkpoint.')
        }
        // The -1 row owns the live revision: the unchanged parent TEXT is not rewritten.
        const state =
          incremental ||
          (
            await tx.$queryRaw<Array<{ revision: number }>>(Prisma.sql`
            SELECT revision FROM ${storage.blocks}
            WHERE ${storage.column} = ${storage.key} AND "sourceIndex" = -1
          `)
          ).length > 0
        const updated = state
          ? await tx.$executeRaw(Prisma.sql`
                UPDATE ${storage.blocks} SET revision = ${next.revision}
                WHERE ${storage.column} = ${storage.key} AND "sourceIndex" = -1
                  AND revision = ${checkpoint.revision}
              `)
          : await tx.$executeRaw(Prisma.sql`
                UPDATE ${storage.parent} SET revision = ${next.revision}, "payloadJson" = ${payloadJson!}, "updatedAt" = ${new Date()}
                WHERE "id" = ${storage.key} AND revision = ${checkpoint.revision}
              `)
        if (updated !== 1) throw new Error('Translation changed in another window.')
        if (state && !incremental)
          await tx.$executeRaw(Prisma.sql`
            UPDATE ${storage.parent} SET revision = ${next.revision}, "payloadJson" = ${payloadJson!}, "updatedAt" = ${new Date()}
            WHERE "id" = ${storage.key}
          `)
        if (!incremental) {
          await tx.$executeRaw(Prisma.sql`
            UPDATE ${storage.parent} SET "layoutSnapshotJson" = ${next.layoutSnapshot ? JSON.stringify(next.layoutSnapshot) : null}
            WHERE "id" = ${storage.key}
              AND "layoutSnapshotJson" IS NULL
          `)
        }
        if (incremental)
          await tx.$executeRaw(Prisma.sql`
          INSERT INTO ${storage.blocks} (${storage.column}, "sourceIndex", "revision", "translation")
          VALUES (${storage.key}, ${index}, ${next.revision}, ${text ?? null})
          ON CONFLICT (${storage.column}, "sourceIndex") DO UPDATE
          SET revision = excluded.revision, translation = excluded.translation
        `)
        else {
          await tx.$executeRaw(
            Prisma.sql`DELETE FROM ${storage.blocks} WHERE ${storage.column} = ${storage.key}`
          )
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO ${storage.blocks} (${storage.column}, "sourceIndex", "revision")
            VALUES (${storage.key}, -1, ${next.revision})
          `)
        }
        if (incremental)
          await tx.$executeRaw(Prisma.sql`
            UPDATE ${storage.parent} SET "updatedAt" = ${new Date()} WHERE "id" = ${storage.key}
          `)
        signal.throwIfAborted()
      })
      log.debug('checkpoint committed', {
        stage: 'checkpoint',
        blockIndex: index,
        revision: next.revision,
        sourceCount: checkpoint.sources.length,
        incremental,
        durationMs: performance.now() - startedAt,
        writtenTextBytes: text === undefined ? 0 : Buffer.byteLength(text, 'utf8'),
        baseSnapshotBytes: payloadJson === undefined ? 0 : Buffer.byteLength(payloadJson, 'utf8'),
        snapshotBuildMs,
        snapshotCharacters: length
      })
      this.storageReferences.set(next, { id: committedId! })
      return this.remember(next, length)
    })
  }
}
