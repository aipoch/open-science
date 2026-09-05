import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { PrismaClient } from '@prisma/client'

import type {
  AppGeneratedArtifactProducer,
  ArtifactVersionFile,
  CreateArtifactVersionRequest
} from '../../shared/artifact-provenance'
import type { ArtifactDurability } from './durability'
import type {
  ArtifactVersionProducerCapture,
  PreparedArtifactVersionPersistence
} from './provenance-producer-capture'
import type { ArtifactRepository } from './repository'
import { requireAgentArtifactVersion } from './provenance-version-kind'
import type { ArtifactWriteBudgetOwner } from './write-budget-owner'
import { assertDiskReserve, copyFileWithinBudget, digestFileWithinBudget } from '../bounded-file-io'
import {
  LOCAL_RESOURCE_BUDGETS,
  assertWithinResourceBudget,
  type LocalResourceBudgetOverrides
} from '../resource-budget'
import { availableBytes } from '../storage/usage'

const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const VERSION_ALLOCATION_MAX_ATTEMPTS = 3

const assertSafeSegment = (value: string, label: string): string => {
  if (!SAFE_SEGMENT_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
  return value
}

const assertChecksum = (value: string, label: string): string => {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}: expected lowercase SHA-256`)
  }
  return value
}

// JavaScript has no native toCaseFold. Locale-independent lowercase plus the multi-character and
// positional folds that differ on supported filenames covers the portability cases that ordinary
// lowercasing misses (notably German sharp-s and Greek final sigma).
const normalizeArtifactFilename = (filename: string): string =>
  filename
    .normalize('NFC')
    .toLocaleLowerCase('und')
    .replace(/\u00df/gu, 'ss')
    .replace(/\u03c2/gu, '\u03c3')

const storageKey = (...segments: string[]): string => segments.join('/')
const isRetryableLineageVersionConflict = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'P2002') {
    return false
  }
  const meta =
    'meta' in error && typeof error.meta === 'object' && error.meta ? error.meta : undefined
  const target = meta && 'target' in meta ? meta.target : undefined
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')]
  const joined = fields.join(' ')
  return (
    (joined.includes('artifactId') && joined.includes('versionNumber')) ||
    (joined.includes('projectId') &&
      joined.includes('sessionId') &&
      joined.includes('normalizedFilename'))
  )
}

const withVersionAllocationRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (attempt >= VERSION_ALLOCATION_MAX_ATTEMPTS || !isRetryableLineageVersionConflict(error)) {
        throw error
      }
    }
  }
}

type CompatibilityRoutingPublicationOptions = {
  allowRoutingReplacement?: boolean
  replaceUnroutedBytes?: boolean
  signal?: AbortSignal
}
type PersistedVersionFileRecord = {
  state: string
  originKind: string
  managedVisibleAt: Date | null
  id: string
  artifactId: string
  versionNumber: number
  filename: string
  artifactRunId: string
  contentStorageKey: string
  contentType: string | null
  sizeBytes: bigint
  checksum: string
  createdAt: Date
  producerRunId: string | null
  executionSnapshotJson: string | null
}
type StagingArtifactVersionRecord = PersistedVersionFileRecord & {
  state: string
  evidenceStorageKey: string
  evidenceJson: string
  evidenceChecksum: string
  executionSnapshotChecksum: string | null
  executionSnapshotStorageKey: string | null
  artifact: { id: string; filename: string }
}
type PublishCompatibilityRouting = (
  version: PersistedVersionFileRecord,
  options?: CompatibilityRoutingPublicationOptions
) => Promise<void>
type WriteVersionWithinSession = (
  request: CreateArtifactVersionRequest,
  publishCompatibilityRouting: PublishCompatibilityRouting,
  signal?: AbortSignal,
  appGeneratedProducer?: AppGeneratedArtifactProducer
) => Promise<ArtifactVersionFile>

type ArtifactProvenanceVersionWriterOptions = {
  storageRoot: string
  getClient: () => Promise<PrismaClient>
  compatibilityRepository: Pick<ArtifactRepository, 'listPendingRunFiles'>
  createId: () => string
  now: () => Date
  durability: ArtifactDurability
  resourceBudgets?: LocalResourceBudgetOverrides
  writeBudgetOwner: Pick<ArtifactWriteBudgetOwner, 'assertReserved' | 'release'>
  captureProducer: (
    request: CreateArtifactVersionRequest,
    createdAt: Date,
    artifactChecksum: string,
    appGeneratedProducer?: AppGeneratedArtifactProducer
  ) => Promise<ArtifactVersionProducerCapture>
  prepareVersionPersistence: (input: {
    request: CreateArtifactVersionRequest
    producer: ArtifactVersionProducerCapture
    artifactId: string
    versionId: string
    versionNumber: number
    checksum: string
    sizeBytes: number
    createdAt: Date
  }) => PreparedArtifactVersionPersistence
  recoverStagingVersion: (
    version: StagingArtifactVersionRecord,
    projectId: string,
    appSessionId: string,
    requestedFilename: string,
    publishCompatibilityRouting: PublishCompatibilityRouting
  ) => Promise<ArtifactVersionFile>
  projectVersionFile: (
    version: PersistedVersionFileRecord,
    projectId: string,
    appSessionId: string
  ) => Promise<ArtifactVersionFile>
}

class ArtifactProvenanceVersionWriter {
  // Repository instances can coexist over separate Prisma clients for the same database. Serialize
  // writes per app Session process-wide so lineage allocation and aggregate byte budgets cannot race.
  private static readonly sessionWrites = new Map<string, Promise<void>>()

  constructor(private readonly options: ArtifactProvenanceVersionWriterOptions) {}

  async writeVersion(
    request: CreateArtifactVersionRequest,
    publishCompatibilityRouting: PublishCompatibilityRouting,
    signal?: AbortSignal,
    appGeneratedProducer?: AppGeneratedArtifactProducer
  ): Promise<ArtifactVersionFile> {
    return this.withSessionWrite(request, (writeVersion) =>
      writeVersion(request, publishCompatibilityRouting, signal, appGeneratedProducer)
    )
  }

  async withSessionWrite<Result>(
    request: Pick<CreateArtifactVersionRequest, 'projectId' | 'appSessionId'>,
    operation: (writeVersion: WriteVersionWithinSession) => Promise<Result>
  ): Promise<Result> {
    const sessionKey = `${this.options.storageRoot}\0${request.projectId}\0${request.appSessionId}`
    const previous =
      ArtifactProvenanceVersionWriter.sessionWrites.get(sessionKey) ?? Promise.resolve()
    let release = (): void => undefined
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent
    })
    const tail = previous.then(() => current)
    ArtifactProvenanceVersionWriter.sessionWrites.set(sessionKey, tail)
    await previous

    try {
      return await operation((...args) => this.writeVersionWithinSession(...args))
    } finally {
      release()
      if (ArtifactProvenanceVersionWriter.sessionWrites.get(sessionKey) === tail) {
        ArtifactProvenanceVersionWriter.sessionWrites.delete(sessionKey)
      }
    }
  }

  private async writeVersionWithinSession(
    request: CreateArtifactVersionRequest,
    publishCompatibilityRouting: PublishCompatibilityRouting,
    signal?: AbortSignal,
    appGeneratedProducer?: AppGeneratedArtifactProducer
  ): Promise<ArtifactVersionFile> {
    if (request.resourceReservationId) {
      if (
        request.resourceSizeBytes === undefined ||
        !Number.isSafeInteger(request.resourceSizeBytes) ||
        request.resourceSizeBytes < 0
      ) {
        throw new Error('Artifact write reservation requires a valid streamed byte count.')
      }
      if (!request.resourceChecksum || !SHA256_PATTERN.test(request.resourceChecksum)) {
        throw new Error('Artifact write reservation requires a valid streamed checksum.')
      }
      await this.options.writeBudgetOwner.assertReserved({
        reservationId: request.resourceReservationId,
        projectId: request.projectId,
        appSessionId: request.appSessionId,
        artifactStorageSessionId: request.artifactStorageSessionId,
        artifactRunId: request.artifactRunId,
        writeOperationId: request.writeOperationId,
        filename: request.filename,
        actualBytes: request.resourceSizeBytes
      })
    }

    let version: ArtifactVersionFile
    try {
      version = await this.writeVersionSerialized(
        request,
        publishCompatibilityRouting,
        signal,
        appGeneratedProducer
      )
    } catch (error) {
      if (request.resourceReservationId) {
        try {
          await this.options.writeBudgetOwner.release({
            projectId: request.projectId,
            appSessionId: request.appSessionId,
            artifactStorageSessionId: request.artifactStorageSessionId,
            artifactRunId: request.artifactRunId,
            reservationId: request.resourceReservationId
          })
        } catch {
          // Preserve the write failure; run/session cleanup can retry reservation release.
        }
      }
      throw error
    }

    if (request.resourceReservationId) {
      await this.options.writeBudgetOwner.release({
        projectId: request.projectId,
        appSessionId: request.appSessionId,
        artifactStorageSessionId: request.artifactStorageSessionId,
        artifactRunId: request.artifactRunId,
        reservationId: request.resourceReservationId
      })
    }
    return version
  }

  private async writeVersionSerialized(
    request: CreateArtifactVersionRequest,
    publishCompatibilityRouting: PublishCompatibilityRouting,
    signal?: AbortSignal,
    appGeneratedProducer?: AppGeneratedArtifactProducer
  ): Promise<ArtifactVersionFile> {
    const projectId = assertSafeSegment(request.projectId, 'project id')
    const appSessionId = assertSafeSegment(request.appSessionId, 'session id')
    const artifactStorageSessionId = assertSafeSegment(
      request.artifactStorageSessionId,
      'artifact storage session id'
    )
    const artifactRunId = assertSafeSegment(request.artifactRunId, 'artifact run id')
    const writeOperationId = assertSafeSegment(request.writeOperationId, 'write operation id')
    const writeRequestChecksum = assertChecksum(
      request.writeRequestChecksum,
      'write request checksum'
    )
    const normalizedFilename = normalizeArtifactFilename(request.filename)
    const client = await this.options.getClient()
    const existing = await client.artifactVersion.findUnique({
      where: { writeOperationId },
      include: {
        artifact: true,
        messageSnapshot: true,
        inputs: { orderBy: { ordinal: 'asc' } }
      }
    })

    if (existing) {
      const agentVersion = requireAgentArtifactVersion(existing)
      if (
        agentVersion.writeRequestChecksum !== writeRequestChecksum ||
        agentVersion.artifact.projectId !== projectId ||
        agentVersion.artifact.sessionId !== appSessionId
      ) {
        throw new Error(
          `Artifact write operation was reused for a different request: ${writeOperationId}`
        )
      }
      if (agentVersion.state === 'staging') {
        return this.options.recoverStagingVersion(
          agentVersion,
          projectId,
          appSessionId,
          request.filename,
          publishCompatibilityRouting
        )
      }
      if (agentVersion.state !== 'pending' && agentVersion.state !== 'finalized') {
        throw new Error(`Artifact write has an invalid lifecycle state: ${writeOperationId}`)
      }

      if (agentVersion.state === 'pending') {
        await publishCompatibilityRouting(agentVersion, { replaceUnroutedBytes: true, signal })
      }
      return this.options.projectVersionFile(agentVersion, projectId, appSessionId)
    }

    const pendingFiles = await this.options.compatibilityRepository.listPendingRunFiles({
      projectId: projectId,
      sessionId: artifactStorageSessionId,
      runId: artifactRunId
    })
    const matchingPendingFiles = pendingFiles.filter(
      (file) => normalizeArtifactFilename(file.name) === normalizedFilename
    )
    const pendingFile =
      matchingPendingFiles.find((file) => file.name === request.filename) ??
      (matchingPendingFiles.length === 1 ? matchingPendingFiles[0] : undefined)

    if (!pendingFile) {
      if (matchingPendingFiles.length > 1) {
        throw new Error(`Pending artifact filename is ambiguous: ${request.filename}`)
      }
      throw new Error(`Pending artifact file not found: ${request.filename}`)
    }

    const versionId = this.options.createId()
    const stagingStorageKey = storageKey(
      'artifacts',
      projectId,
      appSessionId,
      '.provenance',
      '.staging',
      'versions',
      versionId
    )
    const stagingDirectory = join(this.options.storageRoot, ...stagingStorageKey.split('/'))
    const stagingContentPath = join(stagingDirectory, 'content')

    let stagingRowPersisted = false
    try {
      await mkdir(stagingDirectory, { recursive: true })
      const pendingStat = await stat(pendingFile.path)
      assertDiskReserve(
        await availableBytes(stagingDirectory),
        pendingStat.size,
        this.options.resourceBudgets?.diskReserveBytes ?? LOCAL_RESOURCE_BUDGETS.diskReserveBytes
      )
      const contentDigest = await copyFileWithinBudget(
        pendingFile.path,
        stagingContentPath,
        this.options.resourceBudgets?.artifactFileBytes ?? LOCAL_RESOURCE_BUDGETS.artifactFileBytes,
        signal
      )
      await this.options.durability.syncFile(stagingContentPath)
      const { checksum, sizeBytes } = contentDigest
      if (request.resourceChecksum && request.resourceChecksum !== checksum) {
        throw new Error('Artifact write reservation checksum does not match staged content.')
      }
      const createdAt = this.options.now()
      const producer = await this.options.captureProducer(
        request,
        createdAt,
        checksum,
        appGeneratedProducer
      )
      const persisted = await withVersionAllocationRetry(() =>
        client.$transaction(async (transaction) => {
          const origin = await transaction.fileOriginSession.upsert({
            where: { projectId_sessionId: { projectId, sessionId: appSessionId } },
            create: {
              projectId,
              sessionId: appSessionId,
              titleSnapshot: request.titleSnapshot
            },
            update: request.titleSnapshot ? { titleSnapshot: request.titleSnapshot } : {}
          })
          if (origin.state !== 'active') {
            throw new Error('Artifact origin Session is being deleted and cannot accept a Version.')
          }

          let lineage = await transaction.artifactLineage.findUnique({
            where: {
              projectId_sessionId_normalizedFilename: {
                projectId,
                sessionId: appSessionId,
                normalizedFilename
              }
            }
          })
          if (!lineage) {
            lineage = await transaction.artifactLineage.create({
              data: {
                id: this.options.createId(),
                projectId,
                sessionId: appSessionId,
                normalizedFilename,
                filename: request.filename
              }
            })
          }

          const [latest, basedOnVersion] = await Promise.all([
            transaction.artifactVersion.aggregate({
              where: { artifactId: lineage.id },
              _max: { versionNumber: true }
            }),
            transaction.artifactVersion.findFirst({
              where: {
                artifactId: lineage.id,
                OR: [
                  { artifactRunId, state: { in: ['pending', 'finalized'] } },
                  ...(lineage.currentVersionId ? [{ id: lineage.currentVersionId }] : [])
                ]
              },
              orderBy: { versionNumber: 'desc' },
              select: { id: true }
            })
          ])
          const versionNumber = (latest._max.versionNumber ?? 0) + 1
          const contentStorageKey = storageKey(
            'artifacts',
            projectId,
            appSessionId,
            '.provenance',
            lineage.id,
            'versions',
            versionId,
            'content'
          )
          const evidenceStorageKey = storageKey(
            'artifacts',
            projectId,
            appSessionId,
            '.provenance',
            lineage.id,
            'versions',
            versionId,
            'evidence.json'
          )
          const prepared = this.options.prepareVersionPersistence({
            request,
            producer,
            artifactId: lineage.id,
            versionId,
            versionNumber,
            checksum,
            sizeBytes,
            createdAt
          })
          const executionSnapshotStorageKey = prepared.executionSnapshotJson
            ? storageKey(
                'artifacts',
                projectId,
                appSessionId,
                '.provenance',
                lineage.id,
                'versions',
                versionId,
                'execution.json'
              )
            : undefined

          const countedStates = ['staging', 'pending', 'finalized']
          const [turnUsage, sessionUsage] = await Promise.all([
            transaction.artifactVersion.aggregate({
              where: { artifactRunId, state: { in: countedStates } },
              _sum: { sizeBytes: true }
            }),
            transaction.artifactVersion.aggregate({
              where: {
                artifact: { projectId, sessionId: appSessionId },
                state: { in: countedStates }
              },
              _sum: { sizeBytes: true }
            })
          ])
          assertWithinResourceBudget(
            'turn',
            Number(turnUsage._sum.sizeBytes ?? 0n) + sizeBytes,
            this.options.resourceBudgets?.artifactTurnBytes ??
              LOCAL_RESOURCE_BUDGETS.artifactTurnBytes
          )
          assertWithinResourceBudget(
            'session',
            Number(sessionUsage._sum.sizeBytes ?? 0n) + sizeBytes,
            this.options.resourceBudgets?.artifactSessionBytes ??
              LOCAL_RESOURCE_BUDGETS.artifactSessionBytes
          )

          return requireAgentArtifactVersion(
            await transaction.artifactVersion.create({
              data: {
                id: versionId,
                artifactId: lineage.id,
                versionNumber,
                filename: request.filename,
                basedOnVersionId: basedOnVersion?.id,
                artifactRunId,
                writeOperationId,
                writeRequestChecksum,
                rootFrameId: assertSafeSegment(request.rootFrameId, 'root frame id'),
                agentFrameId: assertSafeSegment(request.agentFrameId, 'agent frame id'),
                messageBranchId: assertSafeSegment(request.messageBranchId, 'message branch id'),
                runtimeSegmentId: assertSafeSegment(request.runtimeSegmentId, 'runtime segment id'),
                promptMessageId: assertSafeSegment(request.promptMessageId, 'prompt message id'),
                notebookSessionId: prepared.notebookSessionId,
                producerRunId: prepared.producerRunId,
                producerRunIndex: prepared.producerRunIndex,
                state: 'staging',
                contentStorageKey,
                evidenceStorageKey,
                contentType: request.contentType,
                sizeBytes: BigInt(sizeBytes),
                checksum,
                evidenceJson: prepared.evidenceJson,
                evidenceChecksum: prepared.evidenceChecksum,
                evidenceSchemaVersion: 1,
                executionSnapshotJson: prepared.executionSnapshotJson,
                executionSnapshotChecksum: prepared.executionSnapshotChecksum,
                executionSnapshotStorageKey,
                executionSnapshotSchemaVersion: prepared.executionSnapshotJson ? 2 : undefined,
                ...(prepared.inputs ? { inputs: prepared.inputs } : {}),
                createdAt
              }
            })
          )
        })
      )
      stagingRowPersisted = true

      const evidencePath = join(stagingDirectory, 'evidence.json')
      await writeFile(evidencePath, persisted.evidenceJson, 'utf8')
      await this.syncAndVerifyFile(
        evidencePath,
        persisted.evidenceChecksum,
        `Artifact Version evidence mirror is corrupt: ${persisted.id}`,
        signal
      )
      if (persisted.executionSnapshotJson) {
        const executionPath = join(stagingDirectory, 'execution.json')
        await writeFile(executionPath, persisted.executionSnapshotJson, 'utf8')
        await this.syncAndVerifyFile(
          executionPath,
          persisted.executionSnapshotChecksum!,
          `Artifact Version execution mirror is corrupt: ${persisted.id}`,
          signal
        )
      }
      const finalContentPath = join(
        this.options.storageRoot,
        ...persisted.contentStorageKey.split('/')
      )
      await mkdir(dirname(dirname(finalContentPath)), { recursive: true })
      await this.options.durability.syncDirectory(stagingDirectory)
      const finalDirectory = dirname(finalContentPath)
      await rename(stagingDirectory, finalDirectory)
      await this.options.durability.syncDirectory(dirname(finalDirectory))

      await publishCompatibilityRouting(persisted, { allowRoutingReplacement: true, signal })
      const finalized = await client.$transaction(async (transaction) => {
        await transaction.artifactLineage.update({
          where: { id: persisted.artifactId },
          data: { filename: request.filename }
        })
        return requireAgentArtifactVersion(
          await transaction.artifactVersion.update({
            where: { id: persisted.id },
            data: { state: 'pending' }
          })
        )
      })
      return this.options.projectVersionFile(finalized, projectId, appSessionId)
    } catch (error) {
      // Once SQLite owns the staging row, its copied bytes are recovery state for an idempotent
      // transport retry. Removing them here would force a retry to reread a mutable pending source.
      if (!stagingRowPersisted) {
        await rm(stagingDirectory, { recursive: true, force: true })
      }
      throw error
    }
  }

  private async syncAndVerifyFile(
    path: string,
    expectedChecksum: string,
    corruptMessage: string,
    signal?: AbortSignal
  ): Promise<void> {
    await this.options.durability.syncFile(path)
    const { checksum } = await digestFileWithinBudget(
      path,
      this.options.resourceBudgets?.artifactFileBytes ?? LOCAL_RESOURCE_BUDGETS.artifactFileBytes,
      signal
    )
    if (checksum !== expectedChecksum) throw new Error(corruptMessage)
  }
}

export { ArtifactProvenanceVersionWriter, normalizeArtifactFilename }
export type {
  CompatibilityRoutingPublicationOptions,
  PersistedVersionFileRecord,
  PublishCompatibilityRouting,
  StagingArtifactVersionRecord
}
