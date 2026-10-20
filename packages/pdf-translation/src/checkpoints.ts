import {
  pdfTranslationLayoutSnapshotSchema,
  pdfTranslationSnapshotMatchesSources
} from './snapshot.js'
import { createHash, randomUUID } from 'node:crypto'
import {
  silentDiagnostics,
  standaloneWriteAdmission,
  type TranslationDiagnostics,
  type TranslationWriteAdmission
} from './ports.js'

import {
  reconcilePdfTranslationCheckpoint,
  pdfTranslationSourceIndices,
  nextPdfTranslationSourceIndex
} from './recovery.js'
import type {
  TranslationDatabase,
  TranslationTransaction,
  TranslationStoredCheckpoint,
  TranslationCheckpointIdentity
} from './storage.js'
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
  pdfTranslationSourceSchema,
  type PdfTranslationCheckpointRequest,
  type PdfTranslationCheckpoint,
  type PdfTranslationBeginRequest,
  type PdfTranslationModel,
  type PdfTranslationEdition,
  type PdfTranslationSelectEditionRequest
} from './contracts.js'

type CheckpointIdentity = TranslationCheckpointIdentity
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
  // Only immutable snapshots committed by this owner can use block-sized writes.
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
    Object.freeze(checkpoint)
    this.persistedLengths.set(checkpoint, length)
    return checkpoint
  }

  constructor(
    private readonly options: {
      getClient: () => Promise<TranslationDatabase>
      diagnostics?: TranslationDiagnostics
      writes?: TranslationWriteAdmission
      resolveSource: (sourceId: string) => Promise<CheckpointIdentity | undefined>
    }
  ) {}

  private get diagnostics(): TranslationDiagnostics {
    return this.options.diagnostics ?? silentDiagnostics
  }
  private get writes(): TranslationWriteAdmission {
    return this.options.writes ?? standaloneWriteAdmission
  }
  private async resolveIdentity(
    request: PdfTranslationCheckpointRequest
  ): Promise<CheckpointIdentity> {
    const sourceId = pdfTranslationSourceSchema.parse(request)
    const identity = await this.options.resolveSource(sourceId)
    if (!identity) throw new Error('Translation source is unavailable.')
    return identity
  }

  async contentKey(request: PdfTranslationCheckpointRequest): Promise<string> {
    const identity = await this.resolveIdentity(request)
    const client = await this.options.getClient()
    // Read-only sources have no database owner.
    if (!(await client.canPersist(identity))) return identity.checksum
    const source = await client.transaction((tx) => tx.requireSource(identity))
    return `${identity.checksum}:${source.sizeBytes}`
  }

  private async readStored(
    tx: TranslationTransaction,
    identity: CheckpointIdentity,
    source: { sizeBytes: bigint },
    checkpointKey?: string
  ): Promise<TranslationStoredCheckpoint | null> {
    const contentId = await tx.requireDocument(identity, source)
    // Explicit reads never fall back to a different edition when the requested one is gone.
    const row = await tx.findLatest(contentId, checkpointKey)
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
    return this.writes.write(async () => {
      const client = await this.options.getClient()
      if (!(await client.canPersist(identity))) return []
      return client.transaction(async (tx) => {
        const source = await tx.requireSource(identity)
        const contentId = await tx.requireDocument(identity, source)
        const rows = await tx.list(contentId)
        return rows.map((row) => ({
          id: row.id,
          key: pdfTranslationCheckpointSchema.shape.key.parse(row.key),
          language: pdfTranslationCheckpointSchema.shape.language.parse(row.language),
          glossary: pdfTranslationCheckpointSchema.shape.glossary.parse(row.glossary),
          concurrency:
            pdfTranslationCheckpointSchema.shape.concurrency.parse(Number(row.concurrency)) ?? 1,
          model: pdfTranslationCheckpointSchema.shape.model.parse(row.model),
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
    return this.writes.write(async () => {
      const client = await this.options.getClient()
      return client.transaction(async (tx) => {
        const source = await tx.requireSource(identity)
        const contentId = await tx.requireDocument(identity, source)
        const row = await tx.read(request.translationId, contentId)
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
    return this.writes.write(async () => {
      const client = await this.options.getClient()
      await client.transaction(async (tx) => {
        const source = await tx.requireSource(identity)
        const contentId = await tx.requireDocument(identity, source)
        signal?.throwIfAborted()
        // Delete only this edition; other source editions remain available.
        const result = await tx.delete(request.translationId, contentId)
        if (!result) throw new Error('Translation edition is unavailable.')
        signal?.throwIfAborted()
      })
    })
  }

  private async readResolved(
    identity: CheckpointIdentity,
    checkpointKey?: string
  ): Promise<PdfTranslationCheckpoint | null> {
    const startedAt = performance.now()
    return this.writes.write(async () => {
      const client = await this.options.getClient()
      if (!(await client.canPersist(identity))) return null
      return client.transaction(async (tx) => {
        const source = await tx.requireSource(identity)
        const row = await this.readStored(tx, identity, source, checkpointKey)
        const decodedAt = performance.now()
        const checkpoint = this.decode(row, identity)
        if (checkpoint && row) this.storageReferences.set(checkpoint, { id: row.id })
        this.diagnostics.debug('checkpoint restored', {
          stage: 'checkpoint-read',
          storageMs: decodedAt - startedAt,
          decodeMs: performance.now() - decodedAt,
          sourceCount: checkpoint?.sources.length ?? 0,
          translatedCount: checkpoint?.translations.length ?? 0
        })
        return checkpoint
      })
    })
  }

  private decode(
    record: TranslationStoredCheckpoint | null,
    identity: CheckpointIdentity
  ): PdfTranslationCheckpoint | null {
    if (!record) return null
    let value = pdfTranslationCheckpointSchema.parse(record.checkpoint)
    if (checkpointPayload(value).length > 8 * 1024 * 1024)
      throw new Error('Invalid translation checkpoint.')
    if (value.checksum !== identity.checksum) throw new Error('Translation source changed.')
    // The consumer may retain an old entry point; only the authorized current source is exposed.
    value = { ...value, ...identity }
    if (
      value.layoutSnapshot &&
      !pdfTranslationSnapshotMatchesSources(value.layoutSnapshot, value.fingerprint, value.sources)
    )
      throw new Error('PDF layout snapshot does not match translation.')
    if (value.layoutReports) value = { ...value, layoutReports: matchingLayoutReports(value) }
    return value
  }

  // One-time adoption for legacy checkpoints. Never replace a run's existing layout or
  // touch its revision: a concurrent paragraph save must remain valid.
  async saveSnapshot(input: PdfTranslationSaveSnapshotRequest, signal: AbortSignal): Promise<void> {
    const request = pdfTranslationSaveSnapshotSchema.parse(input)
    await this.writes.write(async () => {
      signal.throwIfAborted()
      const identity = await this.resolveIdentity(request.source)
      const client = await this.options.getClient()
      await client.transaction(async (tx) => {
        const source = await tx.requireSource(identity)
        const row = await this.readStored(tx, identity, source, request.checkpointKey)
        if (!row) throw new Error('Translation checkpoint no longer exists.')
        const current = pdfTranslationCheckpointSchema.parse(row.checkpoint)
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
        if (row.checkpoint.layoutSnapshot) {
          if (JSON.stringify(row.checkpoint.layoutSnapshot) !== snapshotJson)
            throw new Error('PDF layout snapshot is already pinned.')
          return
        }
        signal.throwIfAborted()
        await tx.pinLayout(row.id, request.snapshot)
        signal.throwIfAborted()
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
    await this.writes.write(async () => {
      signal.throwIfAborted()
      const identity = await this.resolveIdentity(request.source)
      const client = await this.options.getClient()
      const applied = await client.transaction(async (tx) => {
        signal.throwIfAborted()
        const source = await tx.requireSource(identity)
        const row = await this.readStored(tx, identity, source, request.checkpointKey)
        if (!row) return []
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
        // Layout diagnostics never invalidate an in-flight translation revision.
        const layoutReports = [...reports.values()].sort((a, b) => a.sourceIndex - b.sourceIndex)
        if (checkpointPayload({ ...current, layoutReports }).length > 8 * 1024 * 1024)
          throw new Error('Invalid translation checkpoint.')
        signal.throwIfAborted()
        await tx.updateLayoutReports(row.id, layoutReports)
        signal.throwIfAborted()
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
        this.diagnostics.warn('PDF layout diagnoses persisted', fields)
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
    const request = input.sourceId
    if (!request) return undefined
    const identity = await this.resolveIdentity(request)
    const previous = input.checkpoint
      ? await this.readResolved(identity, input.checkpoint.key)
      : null
    // Read-only sources retain the existing ephemeral translation flow.
    const client = await this.options.getClient()
    if (!(await client.canPersist(identity))) return undefined
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
    await this.writes.write(() =>
      client.transaction(async (tx) => {
        const source = await tx.requireSource(identity)
        await tx.insert({
          id,
          contentId: await tx.requireDocument(identity, source),
          checksum: identity.checksum,
          sizeBytes: source.sizeBytes,
          checkpoint: opened
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
    return this.writes.write(async () => {
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
      let serializedCheckpoint: string | undefined
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
        serializedCheckpoint = checkpointPayload(next)
        length = serializedCheckpoint.length
      }
      const snapshotBuildMs = performance.now() - startedAt
      const request = checkpoint.sourceId
      const identity = await this.resolveIdentity(request)
      signal.throwIfAborted()
      if (identity.checksum !== checkpoint.checksum) throw new Error('Translation source changed.')
      const client = await this.options.getClient()
      let committedId: string | undefined
      await client.transaction(async (tx) => {
        signal.throwIfAborted()
        const source = await tx.requireSource(identity)
        const reference = this.storageReferences.get(checkpoint)
        if (!reference) throw new Error('Translation checkpoint must be reopened.')
        const contentId = await tx.requireDocument(identity, source)
        const current = await tx.readHeader(reference.id)
        if (!current) throw new Error('Translation changed in another window.')
        if (
          current &&
          (current.contentId !== contentId ||
            current.checksum !== identity.checksum ||
            current.sizeBytes !== source.sizeBytes)
        )
          throw new Error('Translation source changed.')
        committedId = reference.id
        let layoutReports: PdfTranslationCheckpoint['layoutReports']
        if (incremental && replaceExisting) {
          const reports = await tx.readLayoutReports(reference.id)
          if (reports) {
            const storedReports = pdfTranslationLayoutReportSchema.array().max(10000).parse(reports)
            const matching = matchingLayoutReports(next, storedReports)
            length +=
              JSON.stringify(matching).length - JSON.stringify(next.layoutReports ?? []).length
            next = { ...next, layoutReports: matching }
            if (length > 8 * 1024 * 1024) throw new Error('Invalid translation checkpoint.')
            if (matching.length !== storedReports.length) layoutReports = matching
          }
        }
        if (!incremental) {
          // Snapshot replacement must merge the latest independently committed layout reports.
          // Never copy reports from another run, changed extraction or replaced translations.
          const current = await tx.readMetadata(reference.id)
          if (current?.key === next.key && current.layoutSnapshot) {
            const snapshot = pdfTranslationLayoutSnapshotSchema.parse(current.layoutSnapshot)
            if (
              !pdfTranslationSnapshotMatchesSources(snapshot, next.fingerprint, next.sources) ||
              (next.layoutSnapshot &&
                JSON.stringify(next.layoutSnapshot) !== JSON.stringify(snapshot))
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
          serializedCheckpoint = checkpointPayload(next)
          length = serializedCheckpoint.length
          if (length > 8 * 1024 * 1024) throw new Error('Invalid translation checkpoint.')
        }
        const updated = await tx.commit(reference.id, checkpoint.revision, {
          checkpoint: next,
          ...(incremental
            ? { changedBlock: { sourceIndex: index, translation: text ?? null } }
            : {}),
          ...(layoutReports !== undefined ? { layoutReports } : {})
        })
        if (!updated) throw new Error('Translation changed in another window.')
        signal.throwIfAborted()
      })
      this.diagnostics.debug('checkpoint committed', {
        stage: 'checkpoint',
        blockIndex: index,
        revision: next.revision,
        sourceCount: checkpoint.sources.length,
        incremental,
        durationMs: performance.now() - startedAt,
        writtenTextBytes: text === undefined ? 0 : Buffer.byteLength(text, 'utf8'),
        baseSnapshotBytes:
          serializedCheckpoint === undefined ? 0 : Buffer.byteLength(serializedCheckpoint, 'utf8'),
        snapshotBuildMs,
        snapshotCharacters: length
      })
      this.storageReferences.set(next, { id: committedId! })
      return this.remember(next, length)
    })
  }
}
