import { createHash } from 'node:crypto'
import { lstat, opendir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  managedObservationResultSchema,
  type ManagedObservationResult
} from '../../shared/managed-execution'
import { runObservationTargetSchema, type RunObservationTarget } from '../../shared/run-observation'
import {
  MAX_RUN_OBSERVATION_ARCHIVE_BYTES,
  parseRunObservationArchive,
  type RunObservationArchiveMedia
} from '../../shared/run-observation-archive'
import { recordedObservationTargetSchema } from '../../shared/run-observation-recorded'
import type { ArtifactVersionFile } from '../../shared/artifact-provenance'
import type { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import type { SessionOperationContext } from '../notebook/session-operation-owner'
import {
  managedOutputWriteAttemptSchema,
  type ManagedOutputWriteAttempt
} from '../notebook/managed-output-publication'
import {
  DurableJsonRecoveryBarrierError,
  readDurableJsonFile,
  writeDurableJsonFile
} from '../storage/durable-json-file'
import type { RunObservationRecorder, RunObservationRecordingHandle } from './recorder'

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
const checksum = z.string().regex(/^[a-f0-9]{64}$/)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const provenanceSchema = z
  .object({
    rootFrameId: id,
    agentFrameId: id,
    messageBranchId: id,
    runtimeSegmentId: id,
    promptMessageId: id
  })
  .strict()
const targetSchema = runObservationTargetSchema.refine((value) => !!value.executionInvocationId)
const referenceSchema = z
  .object({
    filename: z.string().min(1).max(200),
    artifactId: id.optional(),
    versionId: id,
    checksum,
    sizeBytes: count
  })
  .strict()
const recordSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordingId: checksum,
    target: targetSchema,
    provenance: provenanceSchema,
    result: managedObservationResultSchema,
    attempts: z.array(managedOutputWriteAttemptSchema).max(64),
    reference: referenceSchema.optional()
  })
  .strict()
type RecordState = z.infer<typeof recordSchema>
type Reference = z.infer<typeof referenceSchema>
type Context = Pick<
  SessionOperationContext,
  'projectId' | 'sessionId' | 'provenanceContext' | 'saveAuxiliaryOutput'
>
type Artifacts = Pick<ArtifactProvenanceRepository, 'resolveVersionDescriptors'> &
  Partial<Pick<ArtifactProvenanceRepository, 'replayVersion' | 'readPublishedVersionForWrite'>>
export type ManagedObservationBegin = {
  result: ManagedObservationResult
  handle?: RunObservationRecordingHandle
}
export type ManagedObservationPublication = {
  result: ManagedObservationResult
  output?: { filename: string; versionId: string }
  /** The current turn must end before its ordinary Artifact publisher can confirm this Version. */
  savedInCurrentTurn: boolean
}
export type ManagedRunObservationCoordinatorDependencies = {
  dataRoot: string
  recorder(): Pick<RunObservationRecorder, 'start' | 'load' | 'markPublished'> | undefined
  artifacts: Artifacts
}
const MAX_RECORD_BYTES = 512 * 1024
const MAX_RECORDS = 256
const MAX_TOTAL_BYTES = 64 * 1024 * 1024
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const recordingId = (target: RunObservationTarget): string =>
  hash(JSON.stringify([target.projectId, target.sessionId, target.executionInvocationId]))
const sameTarget = (a: RunObservationTarget, b: RunObservationTarget): boolean =>
  (['projectId', 'sessionId', 'operationId', 'executionInvocationId', 'runId'] as const).every(
    (key) => a[key] === b[key]
  )

/** Owns optional capture/publication. It neither launches Runs nor acknowledges their output
 * collections. Both durable capture and exact write intents survive release of the environment. */
export class ManagedRunObservationCoordinator {
  private readonly directory: string
  private readonly operations = new Map<string, Promise<unknown>>()
  private writeTail: Promise<void> = Promise.resolve()
  private pendingOperations = 0
  constructor(private readonly dependencies: ManagedRunObservationCoordinatorDependencies) {
    this.directory = join(dependencies.dataRoot, 'managed-observation-publications')
  }

  async begin(
    targetInput: RunObservationTarget,
    context: Context
  ): Promise<ManagedObservationBegin> {
    const target = targetSchema.parse(targetInput)
    const recorder = this.dependencies.recorder()
    if (!recorder) return { result: { status: 'unavailable', warning: 'capture-unavailable' } }
    let handle: RunObservationRecordingHandle | undefined
    try {
      return await this.exclusive(target, async () => {
        const provenance = provenanceSchema.parse(context.provenanceContext)
        this.assertContext(target, provenance, context)
        const previous = await this.read(target)
        if (previous) return { result: previous.result }
        const record: RecordState = {
          schemaVersion: 1,
          recordingId: recordingId(target),
          target,
          provenance,
          result: { status: 'recording', recordingId: recordingId(target) },
          attempts: []
        }
        await this.write(record)
        try {
          handle = await recorder.start(target)
        } catch {
          record.result = {
            status: 'failed',
            recordingId: record.recordingId,
            warning: 'capture-start-failed'
          }
          await this.write(record)
          throw new Error('Capture could not be started.')
        }
        if (handle.recordingId !== record.recordingId || !sameTarget(handle.target, target))
          throw new Error('Recording identity does not match the admitted execution.')
        return { result: record.result, handle }
      })
    } catch {
      if (handle) await this.drain(handle)
      return { result: { status: 'failed', warning: 'capture-start-failed' } }
    }
  }

  /** This optional path catches failures so observation cannot replace an execution outcome. */
  async publish(input: {
    target: RunObservationTarget
    context: Context
    handle?: RunObservationRecordingHandle
    media?: readonly RunObservationArchiveMedia[]
    recovery: boolean
    reservedFilenames?: readonly string[]
  }): Promise<ManagedObservationPublication> {
    const target = targetSchema.parse(input.target)
    try {
      return await this.exclusive(target, async () => {
        const recorder = this.dependencies.recorder()
        const record = await this.read(target)
        if (!recorder || !record)
          return {
            result: { status: 'unavailable', warning: 'capture-unavailable' },
            savedInCurrentTurn: false
          }
        this.assertContext(target, record.provenance, input.context)
        let handle = input.handle
        let partial = false
        let archive
        try {
          if (handle) {
            if (!sameTarget(handle.target, target) || handle.recordingId !== record.recordingId)
              throw new Error('Recording handle does not match its admitted execution.')
            try {
              await handle.sample()
            } catch {
              partial = true
            }
            for (const media of input.media ?? []) {
              try {
                await handle.appendMedia(media)
              } catch {
                partial = true
              }
            }
            archive = await handle.finish()
          } else {
            const saved = await recorder.load(target)
            if (saved?.recovered || saved?.status === 'recording') {
              handle = await recorder.start(target)
              archive = await handle.finish()
            } else archive = saved?.archive
          }
        } catch {
          if (handle) await this.drain(handle)
          record.result = {
            status: 'failed',
            recordingId: record.recordingId,
            warning: 'capture-failed'
          }
          await this.write(record)
          return { result: record.result, savedInCurrentTurn: false }
        }
        if (!archive) {
          record.result = {
            status: 'unavailable',
            recordingId: record.recordingId,
            warning:
              record.result.warning === 'capture-start-failed'
                ? 'capture-start-failed'
                : 'capture-empty'
          }
          await this.write(record)
          return { result: record.result, savedInCurrentTurn: false }
        }
        if (archive.recordingId !== record.recordingId)
          throw new Error('Archive identity does not match its original recording.')
        const content = JSON.stringify(archive)
        const expected = {
          filename: `replay-${record.recordingId}.json`,
          checksum: hash(content),
          sizeBytes: Buffer.byteLength(content)
        }
        partial ||=
          archive.coverage.stopReason !== 'run-ended' ||
          !!archive.coverage.samplingFailures ||
          !!archive.coverage.missingMediaKeys.length
        record.result = {
          status: 'ready',
          recordingId: record.recordingId,
          ...(record.reference ? { versionId: record.reference.versionId } : {}),
          ...(partial ? { warning: 'capture-partial' as const } : {})
        }
        await this.write(record)
        try {
          const saved = await recorder.load(target)
          const reference =
            record.reference ??
            (saved?.publication.state !== 'unpublished' && saved?.publication
              ? {
                  ...expected,
                  artifactId: saved.publication.artifactId,
                  versionId: saved.publication.versionId
                }
              : undefined)
          if (reference) {
            if (
              reference.filename !== expected.filename ||
              reference.checksum !== expected.checksum ||
              reference.sizeBytes !== expected.sizeBytes
            )
              throw new Error('Observation save receipt content changed.')
            await this.verify(target, reference, input.recovery)
            await this.remember(record, reference)
            return this.publication(record, false)
          }
          // Replaying a persisted Main-issued write intent is read-only. An unresolved or
          // unpublished prior attempt is never permission to issue a different write blindly.
          for (const attempt of record.attempts) {
            if (!this.dependencies.artifacts.replayVersion)
              throw new Error('Write replay is unavailable.')
            this.assertAttempt(attempt, record, expected)
            const artifact = await this.dependencies.artifacts.replayVersion(attempt.request)
            if (!artifact) continue
            const candidate = {
              ...expected,
              artifactId: artifact.artifactId,
              versionId: artifact.versionId
            }
            if (
              artifact.checksum !== expected.checksum ||
              artifact.size !== expected.sizeBytes ||
              artifact.producerRunId
            )
              throw new Error('Recovered capture content differs from its exact write intent.')
            await this.verify(target, candidate, true)
            await this.remember(record, candidate)
            return this.publication(record, false)
          }
          if (input.reservedFilenames?.includes(expected.filename))
            throw new Error('Capture filename conflicts with a Run output.')
          if (!input.context.saveAuxiliaryOutput)
            throw new Error('Optional capture publisher is unavailable.')
          const savedOutput = await input.context.saveAuxiliaryOutput({
            filename: expected.filename,
            contentType: 'application/json',
            source: { kind: 'inline', content },
            publication: {
              beforeWrite: async (value) => {
                const attempt = managedOutputWriteAttemptSchema.parse(value)
                this.assertAttempt(attempt, record, expected)
                const current = provenanceSchema.parse(input.context.provenanceContext)
                if (
                  Object.entries(current).some(
                    ([key, value]) =>
                      attempt.destination.provenanceContext[key as keyof typeof current] !== value
                  )
                )
                  throw new Error('Capture write does not belong to the current Main turn.')
                if (record.attempts.length >= 64)
                  throw new Error('Capture write attempt capacity reached.')
                record.attempts.push(attempt)
                await this.write(record)
              }
            }
          })
          if (savedOutput.status !== 'saved') throw new Error('Optional capture save failed.')
          const artifact = savedOutput.artifact
          const writtenReference = {
            ...expected,
            artifactId: artifact.artifactId,
            versionId: artifact.versionId
          }
          // The ordinary turn publisher has not finalized this Version yet. Its finalized-only
          // descriptor reader cannot prove a pending write; retain the exact Main write receipt
          // now and independently verify publication after the original turn ends.
          this.assertWrittenReference(target, writtenReference, artifact)
          await this.remember(record, writtenReference)
          return this.publication(record, true)
        } catch {
          record.result = {
            ...record.result,
            status: 'pending',
            warning: input.recovery ? 'archive-recovery-pending' : 'archive-save-failed'
          }
          await this.write(record)
          return { result: record.result, savedInCurrentTurn: false }
        }
      })
    } catch {
      return {
        result: {
          status: 'pending',
          recordingId: recordingId(target),
          warning: input.recovery ? 'archive-recovery-pending' : 'archive-save-failed'
        },
        savedInCurrentTurn: false
      }
    }
  }

  async status(targetInput: RunObservationTarget): Promise<ManagedObservationResult | undefined> {
    const target = targetSchema.parse(targetInput)
    return this.exclusive(target, async () => (await this.read(target))?.result).catch(
      () => undefined
    )
  }

  /** An author's native archive has no import receipt. Its private Main publication receipt,
   * not a filename or self-declared source ID, can attest identity for duplicate-content media.
   * This is read-only and deliberately cannot confirm, save, or recover an Artifact write. */
  async readNativeSourceVersionMapping(
    targetInput: z.infer<typeof recordedObservationTargetSchema>,
    archiveInput: {
      recordingId: string
      checksum: string
      sizeBytes: number
      content: Uint8Array
    }
  ): Promise<Readonly<Record<string, string>> | undefined> {
    try {
      const target = recordedObservationTargetSchema.parse(targetInput)
      const identity = z
        .object({
          recordingId: checksum,
          checksum,
          sizeBytes: count.max(MAX_RUN_OBSERVATION_ARCHIVE_BYTES),
          content: z.instanceof(Uint8Array)
        })
        .strict()
        .parse(archiveInput)
      const result = await readDurableJsonFile(
        join(this.directory, `${identity.recordingId}.json`),
        this.decode,
        {},
        { maxBytes: MAX_RECORD_BYTES }
      )
      if (result.status !== 'found') return undefined
      const record = result.value
      const reference = record.reference
      if (
        record.recordingId !== identity.recordingId ||
        record.target.projectId !== target.projectId ||
        record.target.sessionId !== target.sessionId ||
        record.result.status !== 'published' ||
        !reference ||
        reference.artifactId !== target.artifactId ||
        reference.versionId !== target.versionId ||
        reference.checksum !== identity.checksum ||
        reference.sizeBytes !== identity.sizeBytes
      )
        return undefined
      await this.verify(record.target, reference, true)
      // These are the reader's already verified immutable Version bytes. Re-check their exact
      // digest against the private publication receipt; recording caches may have been deleted.
      if (
        identity.content.byteLength !== identity.sizeBytes ||
        createHash('sha256').update(identity.content).digest('hex') !== identity.checksum
      )
        return undefined
      const archive = parseRunObservationArchive(
        new TextDecoder('utf-8', { fatal: true }).decode(identity.content)
      )
      if (archive.recordingId !== record.recordingId) return undefined
      const versionIds = [...new Set(archive.media.flatMap((media) => media.sourceVersionId ?? []))]
      const mapping: Record<string, string> = Object.create(null)
      for (let start = 0; start < versionIds.length; start += 100) {
        const batch = versionIds.slice(start, start + 100)
        const versions = await this.dependencies.artifacts.resolveVersionDescriptors({
          projectId: target.projectId,
          appSessionId: target.sessionId,
          versionIds: batch
        })
        for (const versionId of batch) {
          const exact = versions.filter((version) => version.versionId === versionId)
          const version = exact.length === 1 ? exact[0] : undefined
          if (
            version?.projectId === target.projectId &&
            version.sessionId === target.sessionId &&
            version.state === 'finalized' &&
            version.isPublished === true &&
            id.safeParse(version.artifactId).success &&
            archive.media
              .filter((media) => media.sourceVersionId === versionId)
              .every(
                (media) => media.checksum === version.checksum && media.sizeBytes === version.size
              )
          )
            mapping[versionId] = versionId
        }
      }
      // Publication may have changed while reading the exact media Versions.
      await this.verify(record.target, reference, true)
      return mapping
    } catch {
      return undefined
    }
  }

  /** Confirmation is independent of the execution environment and may be retried after release. */
  async confirm(targetInput: RunObservationTarget): Promise<ManagedObservationResult | undefined> {
    const target = targetSchema.parse(targetInput)
    return this.exclusive(target, async () => {
      const record = await this.read(target)
      const recorder = this.dependencies.recorder()
      if (!record || !recorder) return record?.result
      try {
        if (!record.reference) {
          const saved = await recorder.load(target)
          if (!saved?.archive || !this.dependencies.artifacts.readPublishedVersionForWrite)
            return record.result
          const content = JSON.stringify(saved.archive)
          const expected = {
            filename: `replay-${record.recordingId}.json`,
            checksum: hash(content),
            sizeBytes: Buffer.byteLength(content)
          }
          for (const attempt of record.attempts) {
            this.assertAttempt(attempt, record, expected)
            // Unlike replayVersion, this reader never recovers staged writes or repairs routes.
            const artifact = await this.dependencies.artifacts.readPublishedVersionForWrite(
              attempt.request
            )
            if (!artifact) continue
            const reference = {
              ...expected,
              artifactId: artifact.artifactId,
              versionId: artifact.versionId
            }
            this.assertWrittenReference(target, reference, artifact)
            await this.verify(target, reference, true)
            await this.remember(record, reference)
            break
          }
        }
        if (!record.reference) return record.result
        await this.verify(target, record.reference, true)
        const { artifactId, versionId, checksum, sizeBytes } = record.reference
        const publication = await recorder.markPublished(target, {
          artifactId,
          versionId,
          checksum,
          sizeBytes
        })
        if (publication.state !== 'published') return record.result
        record.result = {
          status: 'published',
          recordingId: record.recordingId,
          versionId,
          ...(record.result.warning === 'capture-partial'
            ? { warning: 'capture-partial' as const }
            : {})
        }
        await this.write(record)
      } catch {
        /* Preserve the real saved receipt; the next publication hint can retry. */
      }
      return record.result
    }).catch(() => undefined)
  }

  async reconcilePublished(scope?: { projectId: string; sessionId: string }): Promise<void> {
    const paths = await this.inventory().catch(() => [])
    for (const item of paths) {
      if (!item.name.endsWith('.json')) continue
      try {
        const decoded = await readDurableJsonFile(
          join(this.directory, item.name),
          this.decode,
          {},
          { maxBytes: MAX_RECORD_BYTES }
        )
        if (decoded.status !== 'found') continue
        const record = decoded.value
        if (
          scope &&
          (record.target.projectId !== scope.projectId ||
            record.target.sessionId !== scope.sessionId)
        )
          continue
        // A publication hook may run inside saveOutput. Do not wait on the operation whose
        // writer is awaiting that hook; the durable receipt will be checked on the next hint.
        if (
          (record.reference || record.attempts.length > 0) &&
          record.result.status !== 'published' &&
          !this.operations.has(record.recordingId)
        )
          await this.confirm(record.target)
      } catch {
        /* One inaccessible/corrupt capture must not block other executions' cleanup. */
      }
    }
  }

  async drain(handle: RunObservationRecordingHandle): Promise<void> {
    try {
      await handle.finish()
    } catch {
      await handle.abort().catch(() => undefined)
    }
  }

  private publication(
    record: RecordState,
    savedInCurrentTurn: boolean
  ): ManagedObservationPublication {
    return {
      result: structuredClone(record.result),
      ...(record.reference
        ? { output: { filename: record.reference.filename, versionId: record.reference.versionId } }
        : {}),
      savedInCurrentTurn
    }
  }
  private async remember(record: RecordState, reference: Reference): Promise<void> {
    record.reference = reference
    record.result = { ...record.result, status: 'saved', versionId: reference.versionId }
    await this.write(record)
    try {
      const { artifactId, versionId, checksum, sizeBytes } = reference
      const publication = await this.dependencies
        .recorder()!
        .markPublished(record.target, { artifactId, versionId, checksum, sizeBytes })
      if (publication.state === 'published') record.result.status = 'published'
    } catch {
      record.result.warning = 'archive-receipt-failed'
    }
    await this.write(record)
  }
  private async verify(
    target: RunObservationTarget,
    reference: Reference,
    requirePublished: boolean
  ): Promise<void> {
    const versions = await this.dependencies.artifacts.resolveVersionDescriptors({
      projectId: target.projectId,
      appSessionId: target.sessionId,
      versionIds: [reference.versionId]
    })
    const exact = versions.filter((version) => version.versionId === reference.versionId)
    const version = exact.length === 1 ? exact[0] : undefined
    if (
      !version ||
      version.projectId !== target.projectId ||
      version.sessionId !== target.sessionId ||
      version.name !== reference.filename ||
      version.checksum !== reference.checksum ||
      version.size !== reference.sizeBytes ||
      version.producerRunId ||
      (reference.artifactId && version.artifactId !== reference.artifactId) ||
      (requirePublished && (version.state !== 'finalized' || !version.isPublished))
    )
      throw new Error('Original capture Version is unavailable or awaiting publication.')
  }
  private assertWrittenReference(
    target: RunObservationTarget,
    reference: Reference,
    artifact: ArtifactVersionFile
  ): void {
    referenceSchema.parse(reference)
    if (
      artifact.projectId !== target.projectId ||
      artifact.sessionId !== target.sessionId ||
      !artifact.artifactId ||
      artifact.artifactId !== reference.artifactId ||
      artifact.versionId !== reference.versionId ||
      artifact.name !== reference.filename ||
      artifact.mimeType !== 'application/json' ||
      artifact.checksum !== reference.checksum ||
      artifact.size !== reference.sizeBytes ||
      artifact.producerRunId
    )
      throw new Error('Capture save receipt differs from its exact Main write.')
  }
  private assertContext(
    target: RunObservationTarget,
    provenance: z.infer<typeof provenanceSchema>,
    context: Context
  ): void {
    const current = provenanceSchema.parse(context.provenanceContext)
    if (
      context.projectId !== target.projectId ||
      context.sessionId !== target.sessionId ||
      current.rootFrameId !== current.agentFrameId ||
      (['rootFrameId', 'agentFrameId', 'messageBranchId'] as const).some(
        (field) => current[field] !== provenance[field]
      )
    )
      throw new Error('Capture belongs to a different Main branch or Session.')
  }
  private assertAttempt(
    attempt: ManagedOutputWriteAttempt,
    record: RecordState,
    expected: { filename: string; checksum: string; sizeBytes: number }
  ): void {
    const destination = attempt.destination.provenanceContext
    if (
      attempt.request.projectId !== record.target.projectId ||
      attempt.request.appSessionId !== record.target.sessionId ||
      attempt.request.filename !== expected.filename ||
      attempt.request.contentType !== 'application/json' ||
      attempt.request.producerRunId ||
      attempt.source.producerRunId ||
      attempt.source.producerProvenance ||
      attempt.source.kind !== 'inline' ||
      attempt.source.sha256 !== expected.checksum ||
      attempt.source.sizeBytes !== expected.sizeBytes ||
      (['rootFrameId', 'agentFrameId', 'messageBranchId'] as const).some(
        (key) => destination[key] !== record.provenance[key]
      )
    )
      throw new Error('Capture write intent differs from the original Main recording.')
  }
  private decode = (text: string): RecordState => {
    try {
      const record = recordSchema.parse(JSON.parse(text))
      if (
        record.recordingId !== recordingId(record.target) ||
        record.result.recordingId !== record.recordingId ||
        record.provenance.rootFrameId !== record.provenance.agentFrameId ||
        (record.reference &&
          (record.reference.filename !== `replay-${record.recordingId}.json` ||
            record.reference.versionId !== record.result.versionId))
      )
        throw new Error('Invalid capture identity.')
      if (record.reference)
        for (const attempt of record.attempts) this.assertAttempt(attempt, record, record.reference)
      return record
    } catch {
      throw new DurableJsonRecoveryBarrierError(
        'Capture publication record is malformed or from an unsupported version; preserving it.'
      )
    }
  }
  private async read(target: RunObservationTarget): Promise<RecordState | undefined> {
    const path = join(this.directory, `${recordingId(target)}.json`)
    try {
      if (!(await lstat(path)).isFile()) throw new Error('Invalid capture record file.')
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure
    }
    const result = await readDurableJsonFile(path, this.decode, {}, { maxBytes: MAX_RECORD_BYTES })
    if (result.status === 'missing') return undefined
    if (!sameTarget(result.value.target, target))
      throw new Error('Capture target differs from its original identity.')
    return result.value
  }
  private async inventory(): Promise<Array<{ name: string; size: number }>> {
    let directory: Awaited<ReturnType<typeof opendir>>
    try {
      directory = await opendir(this.directory)
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw failure
    }
    const files: Array<{ name: string; size: number }> = []
    let seen = 0
    for await (const entry of directory) {
      if (++seen > MAX_RECORDS * 8 + 64)
        throw new Error('Capture publication directory capacity reached.')
      if (!/^[a-f0-9]{64}\.json(?:\..+\.tmp)?$/.test(entry.name)) continue
      if (!entry.isFile()) throw new Error('Invalid capture publication file.')
      const metadata = await lstat(join(this.directory, entry.name))
      if (!metadata.isFile()) throw new Error('Capture publication file changed during inspection.')
      files.push({ name: entry.name, size: metadata.size })
    }
    return files
  }
  private write(record: RecordState): Promise<void> {
    const text = JSON.stringify(record)
    const operation = this.writeTail.then(async () => {
      if (Buffer.byteLength(text) > MAX_RECORD_BYTES)
        throw new Error('Capture publication record capacity reached.')
      this.decode(text)
      const inventory = await this.inventory()
      const existing = inventory.find((item) => item.name === `${record.recordingId}.json`)
      if (
        (!existing &&
          inventory.filter((item) => item.name.endsWith('.json')).length >= MAX_RECORDS) ||
        inventory.reduce((bytes, item) => bytes + item.size, 0) -
          (existing?.size ?? 0) +
          Buffer.byteLength(text) >
          MAX_TOTAL_BYTES
      )
        throw new Error('Capture publication storage capacity reached.')
      await writeDurableJsonFile(join(this.directory, `${record.recordingId}.json`), text)
    })
    this.writeTail = operation.catch(() => undefined)
    return operation
  }
  private exclusive<T>(target: RunObservationTarget, operation: () => Promise<T>): Promise<T> {
    const key = recordingId(target)
    if (this.pendingOperations >= 128 || (!this.operations.has(key) && this.operations.size >= 64))
      return Promise.reject(new Error('Capture operation capacity reached.'))
    this.pendingOperations++
    const previous = this.operations.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.operations.set(key, current)
    void current
      .finally(() => {
        this.pendingOperations--
        if (this.operations.get(key) === current) this.operations.delete(key)
      })
      .catch(() => undefined)
    return current
  }
}
