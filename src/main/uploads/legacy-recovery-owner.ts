import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

import {
  PENDING_UPLOAD_SESSION_ID,
  toPersistedUploadedAttachment,
  toRuntimeUploadedAttachment,
  type DeleteUploadRequest,
  type PersistedUploadedAttachment,
  type UploadedAttachment
} from '../../shared/uploads'
import type { PersistedChatMessage, PersistedChatSession } from '../../shared/session-persistence'
import {
  OrphanLegacyUploadAuthorityMissingError,
  readUploadPublicationLifecycle,
  runUploadTransaction,
  type PublicationOptions,
  type UploadVersionRecord
} from './staged-publication-owner'
import {
  UPLOADS_DIR,
  assertPathInsideRoot,
  assertSafePathSegment,
  getSessionUploadDir,
  isMissingFileError
} from './storage-helpers'
import type {
  LegacyCleanupResult,
  RemoveVerifiedLegacyCopyInput,
  VerifiedLegacyCleanupOwner
} from './verified-legacy-cleanup-owner'

const LIVE_COPY_TEMP_SUFFIX = '.live-copy.tmp'

type LegacyRecoveryOptions = {
  getClient?: () => Promise<PrismaClient>
}

type LegacyUploadUpgradeOptions = {
  // Live callers cannot prove that every renderer has applied the returned path-free projection.
  // Orphan recovery also preserves the source but may only reuse pre-existing durable authority.
  mode?: 'reconcile' | 'live-save' | 'orphan-recovery' | 'terminal-delete' | 'project-files-sync'
}

type LegacyRecoveryDependencies = {
  resolveManagedUploadPath: (request: DeleteUploadRequest) => Promise<string>
  finalizeSessionUploads: (
    sessionId: string,
    attachments: UploadedAttachment[],
    projectId: string,
    options?: PublicationOptions
  ) => Promise<UploadedAttachment[]>
  cleanup: Pick<
    VerifiedLegacyCleanupOwner,
    'assertLegacySourceAbsent' | 'hasPrivateClaim' | 'removeVerifiedLegacyCopy'
  >
}

const sha256File = async (filePath: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

// Sibling publication must settle before an orphan-recovery failure escapes, otherwise a late
// sibling could reactivate ManagedFile rows after its caller has soft-deleted the Project index.
const settleSiblingOperations = async <Value>(operations: Promise<Value>[]): Promise<Value[]> => {
  const settled = await Promise.allSettled(operations)
  const failures = settled.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  )
  const failure =
    failures.find(
      (result) => !(result.reason instanceof OrphanLegacyUploadAuthorityMissingError)
    ) ?? failures[0]
  if (failure) throw failure.reason
  return settled.map((result) => (result as PromiseFulfilledResult<Value>).value)
}

// Sole owner of legacy Session validation, upgrade, orphan authority and staging crash recovery.
class LegacyRecoveryOwner {
  constructor(
    private readonly storageRoot: string,
    private readonly options: LegacyRecoveryOptions,
    private readonly dependencies: LegacyRecoveryDependencies
  ) {}

  async upgradeLegacySessionUploads(
    session: PersistedChatSession,
    options: LegacyUploadUpgradeOptions = {}
  ): Promise<PersistedChatSession> {
    this.assertConsistentSessionUploadReferences(session)
    const isProjectFilesSync = options.mode === 'project-files-sync'
    const isLiveSave =
      options.mode === 'live-save' || options.mode === 'orphan-recovery' || isProjectFilesSync
    const requireExistingAuthority = options.mode === 'orphan-recovery'
    const isTerminalDelete = options.mode === 'terminal-delete'
    const upgrades = new Map<string, Promise<PersistedUploadedAttachment | undefined>>()
    const reconciliations = new Map<string, Promise<LegacyCleanupResult>>()
    const upgrade = async (
      upload: PersistedUploadedAttachment
    ): Promise<PersistedUploadedAttachment | undefined> => {
      if (isProjectFilesSync && upload.sessionId === PENDING_UPLOAD_SESSION_ID) return upload
      if (upload.versionId) {
        const persisted = toPersistedUploadedAttachment(
          toRuntimeUploadedAttachment(upload, session.projectId)
        )
        if (isLiveSave) {
          if (this.options.getClient) {
            const client = await this.options.getClient()
            const headless = await client.uploadVersion.findFirst({
              where: {
                id: upload.versionId,
                uploadFileId: upload.id,
                versionNumber: 1,
                state: 'ready',
                uploadFile: {
                  projectId: session.projectId,
                  sessionId: upload.sessionId,
                  currentVersionId: null
                }
              }
            })
            // Archived legacy adoption preserves ready evidence without publishing a head. Retry
            // that publication after restore, using the same transactional lifecycle checks.
            if (headless)
              await this.completeStagingUpload(
                session.projectId,
                upload.sessionId,
                toRuntimeUploadedAttachment(upload, session.projectId),
                headless,
                { preserveSource: true }
              )
          }
          return persisted
        }
        const reconciliationKey = `${upload.id}:${upload.versionId}`
        let reconciliation = reconciliations.get(reconciliationKey)
        if (!reconciliation) {
          reconciliation = this.dependencies.cleanup.removeVerifiedLegacyCopy({
            projectId: session.projectId,
            sessionId: upload.sessionId,
            uploadFileId: upload.id,
            versionId: upload.versionId,
            filename: upload.name
          })
          reconciliations.set(reconciliationKey, reconciliation)
        }
        return reconciliation.then(async (cleanup) => {
          if (isTerminalDelete) {
            await this.dependencies.cleanup.assertLegacySourceAbsent(
              upload.sessionId,
              upload.name,
              cleanup
            )
          }
          return persisted
        })
      }

      const existing = upgrades.get(upload.id)
      if (existing) return existing
      const operation = (async () => {
        if (isProjectFilesSync && this.options.getClient) {
          const client = await this.options.getClient()
          const file = await client.uploadFile.findFirst({
            where: {
              id: upload.id,
              projectId: session.projectId,
              sessionId: upload.sessionId
            },
            include: { currentVersion: true }
          })
          if (file?.currentVersion?.state === 'ready') {
            const version = file.currentVersion
            return {
              id: file.id,
              versionId: version.id,
              versionNumber: version.versionNumber,
              ...(version.createdAt ? { createdAt: version.createdAt.toISOString() } : {}),
              sessionId: file.sessionId,
              name: version.filename,
              originalName: version.originalFilename,
              ...(version.contentType ? { mimeType: version.contentType } : {}),
              size: Number(version.sizeBytes),
              sha256: version.checksum
            }
          }
        }
        if (!upload.path) throw new Error(`Legacy upload has no recoverable path: ${upload.id}`)
        const [finalized] = await this.dependencies.finalizeSessionUploads(
          isProjectFilesSync ? upload.sessionId : session.id,
          [toRuntimeUploadedAttachment(upload, session.projectId)],
          session.projectId,
          { preserveLegacySource: isLiveSave, requireExistingAuthority, legacySessionUpload: true }
        )
        if (!finalized) return undefined
        if (isTerminalDelete) {
          await this.dependencies.cleanup.assertLegacySourceAbsent(upload.sessionId, upload.name, {
            status: 'absent'
          })
        }
        return toPersistedUploadedAttachment(finalized)
      })()
      upgrades.set(upload.id, operation)
      return operation
    }
    const upgradeMessage = async <Message extends PersistedChatMessage>(
      message: Message
    ): Promise<Message> => {
      if (!message.uploads?.length) return message
      const uploads = (await settleSiblingOperations(message.uploads.map(upgrade))).filter(
        (upload): upload is PersistedUploadedAttachment => upload !== undefined
      )
      return { ...message, uploads } as Message
    }
    const messagesOperation = settleSiblingOperations(session.messages.map(upgradeMessage))
    const graphMessagesOperation = session.conversationGraph
      ? settleSiblingOperations(session.conversationGraph.messages.map(upgradeMessage))
      : undefined
    await settleSiblingOperations<unknown>([
      messagesOperation,
      ...(graphMessagesOperation ? [graphMessagesOperation] : [])
    ])
    const messages = await messagesOperation
    const graphMessages = await graphMessagesOperation

    return {
      ...session,
      messages,
      ...(session.conversationGraph
        ? { conversationGraph: { ...session.conversationGraph, messages: graphMessages! } }
        : {})
    }
  }

  // Operation sharing is safe only after every occurrence across the flat transcript and graph has
  // proven the same immutable identity, before database or filesystem work begins.
  private assertConsistentSessionUploadReferences(session: PersistedChatSession): void {
    const identities = new Map<string, string>()
    const messages = [...session.messages, ...(session.conversationGraph?.messages ?? [])]
    for (const upload of messages.flatMap((message) => message.uploads ?? [])) {
      if (upload.sha256 && upload.checksum && upload.sha256 !== upload.checksum) {
        throw new Error(`Session Upload reference has conflicting checksums: ${upload.id}`)
      }
      const identity = JSON.stringify([
        upload.sessionId,
        upload.name,
        upload.originalName,
        upload.path === undefined ? null : resolve(upload.path),
        upload.versionId ?? null,
        upload.versionNumber ?? null,
        upload.sha256 ?? upload.checksum ?? null,
        upload.size,
        upload.mimeType ?? null,
        upload.createdAt ?? null
      ])
      const existing = identities.get(upload.id)
      if (existing !== undefined && existing !== identity) {
        throw new Error(
          `Session Upload references have conflicting immutable identity: ${upload.id}`
        )
      }
      identities.set(upload.id, identity)
    }
  }

  // Completes crash-interrupted staging rows at startup. Every row is attempted so one corrupt
  // upload cannot hide another recoverable row.
  async recoverStagingUploads(): Promise<void> {
    if (!this.options.getClient) return
    const client = await this.options.getClient()
    const versions = await client.uploadVersion.findMany({
      where: { state: 'staging' },
      include: { uploadFile: true }
    })
    const results = await Promise.allSettled(
      versions.map(async (version) => {
        const finalPath = resolve(this.storageRoot, ...version.contentStorageKey.split('/'))
        const sourceCandidates = [
          finalPath,
          getSessionUploadDir(this.storageRoot, PENDING_UPLOAD_SESSION_ID),
          getSessionUploadDir(this.storageRoot, version.uploadFile.sessionId)
        ].map((path, index) => (index === 0 ? path : join(path, version.filename)))
        let sourcePath = sourceCandidates[0]
        for (const candidate of sourceCandidates) {
          try {
            if ((await stat(candidate)).isFile()) {
              sourcePath = candidate
              break
            }
          } catch (error) {
            if (!isMissingFileError(error)) throw error
          }
        }
        await this.completeStagingUpload(
          version.uploadFile.projectId,
          version.uploadFile.sessionId,
          {
            id: version.uploadFileId,
            sessionId: version.uploadFile.sessionId,
            name: version.filename,
            originalName: version.originalFilename,
            path: sourcePath,
            mimeType: version.contentType ?? undefined,
            size: Number(version.sizeBytes),
            versionId: version.id,
            versionNumber: version.versionNumber,
            checksum: version.checksum,
            createdAt: version.createdAt?.toISOString()
          },
          version
        )
      })
    )
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `Could not recover ${failures.length} staging Upload Version(s).`
      )
    }
  }

  // Missing legacy/private/version candidates are positive evidence that the old deletion tail
  // consumed the bytes. A mismatched recorded locator remains unknown and is retained fail-closed.
  async hasOrphanLegacyCandidate(
    projectId: string,
    sessionId: string,
    uploadFileId: string,
    attachment: UploadedAttachment
  ): Promise<boolean> {
    assertSafePathSegment(projectId)
    assertSafePathSegment(sessionId)
    assertSafePathSegment(uploadFileId)
    const legacyRoot = getSessionUploadDir(this.storageRoot, sessionId)
    const expectedLegacyPath = resolve(legacyRoot, attachment.name)
    assertPathInsideRoot(legacyRoot, expectedLegacyPath)
    if (resolve(attachment.path) !== expectedLegacyPath) return true
    try {
      await lstat(expectedLegacyPath)
      return true
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
    if (await this.dependencies.cleanup.hasPrivateClaim(expectedLegacyPath)) return true

    // Once SQLite authority is gone, scan only this Upload's bounded versions root. Any surviving
    // entry, including a live-copy temporary, must be retained for manual or retry recovery.
    const versionsRoot = resolve(
      this.storageRoot,
      UPLOADS_DIR,
      projectId,
      sessionId,
      uploadFileId,
      'versions'
    )
    assertPathInsideRoot(this.storageRoot, versionsRoot)
    let versionsRootInfo
    try {
      versionsRootInfo = await lstat(versionsRoot)
    } catch (error) {
      if (isMissingFileError(error)) return false
      throw error
    }
    if (!versionsRootInfo.isDirectory() || versionsRootInfo.isSymbolicLink()) return true
    const versionEntries = await readdir(versionsRoot, { withFileTypes: true })
    for (const versionEntry of versionEntries) {
      if (!versionEntry.isDirectory() || versionEntry.isSymbolicLink()) return true
      const entries = await readdir(join(versionsRoot, versionEntry.name), { withFileTypes: true })
      if (entries.length > 0) return true
    }
    return false
  }

  async removeVerifiedLegacyCopy(input: RemoveVerifiedLegacyCopyInput): Promise<unknown> {
    return this.dependencies.cleanup.removeVerifiedLegacyCopy(input)
  }

  async completeStagingUpload(
    projectId: string,
    sessionId: string,
    attachment: UploadedAttachment,
    version: UploadVersionRecord,
    options: { preserveSource?: boolean; legacySessionUpload?: boolean } = {}
  ): Promise<UploadedAttachment> {
    const finalPath = resolve(this.storageRoot, ...version.contentStorageKey.split('/'))
    assertPathInsideRoot(
      resolve(this.storageRoot),
      finalPath,
      'Upload storage key escapes storage.'
    )
    const validateContent = async (path: string): Promise<boolean> => {
      try {
        const info = await stat(path)
        return (
          info.isFile() &&
          info.size === Number(version.sizeBytes) &&
          (await sha256File(path)) === version.checksum
        )
      } catch (error) {
        if (isMissingFileError(error)) return false
        throw error
      }
    }

    let finalValid = await validateContent(finalPath)
    if (version.state === 'ready' && !finalValid) {
      throw new Error(`Ready Upload Version content is unavailable or corrupt: ${version.id}`)
    }
    if (version.state !== 'staging' && version.state !== 'ready') {
      throw new Error(`Unsupported Upload Version state: ${version.state}`)
    }
    if (!finalValid) {
      try {
        await stat(finalPath)
        throw new Error(`Upload Version final content is corrupt: ${version.id}`)
      } catch (error) {
        if (!isMissingFileError(error)) throw error
      }
      await mkdir(dirname(finalPath), { recursive: true })
      const temporaryPath = `${finalPath}${LIVE_COPY_TEMP_SUFFIX}`
      if (await validateContent(temporaryPath)) {
        await rename(temporaryPath, finalPath)
        finalValid = await validateContent(finalPath)
        if (!finalValid)
          throw new Error(`Recovered Upload Version content is corrupt: ${version.id}`)
      } else {
        await rm(temporaryPath, { force: true })
      }
    }

    if (!finalValid) {
      let sourcePath: string | undefined
      try {
        sourcePath = await this.dependencies.resolveManagedUploadPath({ path: attachment.path })
      } catch (error) {
        if (!isMissingFileError(error)) throw error
      }
      if (!sourcePath || !(await validateContent(sourcePath))) {
        const client = await this.options.getClient!()
        await runUploadTransaction(client, async (tx) => {
          await tx.uploadVersion.deleteMany({ where: { id: version.id, state: 'staging' } })
          await tx.uploadFile.deleteMany({
            where: { id: version.uploadFileId, versions: { none: {} } }
          })
        })
        throw new Error(`Upload Version staging content is unavailable: ${version.id}`)
      }
      if (options.preserveSource) {
        const temporaryPath = `${finalPath}${LIVE_COPY_TEMP_SUFFIX}`
        try {
          await copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL)
          if (!(await validateContent(temporaryPath))) {
            throw new Error(`Copied Upload Version content is corrupt: ${version.id}`)
          }
          await rename(temporaryPath, finalPath)
        } finally {
          await rm(temporaryPath, { force: true }).catch(() => undefined)
        }
      } else {
        await rename(sourcePath, finalPath)
      }
      finalValid = await validateContent(finalPath)
      if (!finalValid) throw new Error(`Published Upload Version content is corrupt: ${version.id}`)
    }

    await rm(`${finalPath}${LIVE_COPY_TEMP_SUFFIX}`, { force: true })
    const client = await this.options.getClient!()
    const ready = await runUploadTransaction(client, async (tx) => {
      const current = await tx.uploadVersion.findUniqueOrThrow({ where: { id: version.id } })
      const file = await tx.uploadFile.findUniqueOrThrow({
        where: { id: version.uploadFileId },
        include: { currentVersion: true }
      })
      const lifecycle = await readUploadPublicationLifecycle(
        tx,
        projectId,
        sessionId,
        version.uploadFileId
      )
      // Reusing immutable evidence grants no permission to advance a head or revive Files. Legacy
      // path adoption is explicit; startup recovery cannot reinterpret a pending upload as history.
      if (!lifecycle.writable) {
        if (current.state === 'ready') return current
        if (!(
          options.legacySessionUpload &&
          (lifecycle.projectExists || file.currentVersionId === current.id)
        )) {
          throw new Error('Upload publication is blocked by the Project or origin lifecycle.')
        }
      }
      const updated =
        current.state === 'ready'
          ? current
          : await tx.uploadVersion.update({ where: { id: version.id }, data: { state: 'ready' } })
      if (!lifecycle.writable) return updated
      const shouldAdvanceHead =
        !file.currentVersion || file.currentVersion.versionNumber < updated.versionNumber
      if (shouldAdvanceHead) {
        await tx.uploadFile.update({
          where: { id: file.id },
          data: { currentVersionId: updated.id }
        })
      }
      const head = shouldAdvanceHead ? updated : file.currentVersion!
      const timestamp = head.createdAt ?? new Date()
      await tx.managedFile.upsert({
        where: {
          projectId_source_sourceFileId: {
            projectId,
            source: 'upload',
            sourceFileId: version.uploadFileId
          }
        },
        create: {
          source: 'upload',
          sourceFileId: version.uploadFileId,
          sourceVersionId: head.id,
          checksum: head.checksum,
          projectId,
          sessionId,
          displayName: head.originalFilename || head.filename,
          storageKey: head.contentStorageKey,
          mimeType: head.contentType,
          sizeBytes: head.sizeBytes,
          mtimeMs: BigInt(timestamp.getTime()),
          sortAtMs: BigInt(timestamp.getTime())
        },
        update: {
          sourceVersionId: head.id,
          checksum: head.checksum,
          sessionId,
          displayName: head.originalFilename || head.filename,
          storageKey: head.contentStorageKey,
          mimeType: head.contentType,
          sizeBytes: head.sizeBytes,
          mtimeMs: BigInt(timestamp.getTime()),
          sortAtMs: BigInt(timestamp.getTime())
        }
      })
      return updated
    })

    return {
      id: version.uploadFileId,
      sessionId,
      name: version.filename,
      originalName: version.originalFilename,
      path: finalPath,
      mimeType: version.contentType ?? undefined,
      size: Number(version.sizeBytes),
      versionId: ready.id,
      versionNumber: ready.versionNumber,
      checksum: ready.checksum,
      createdAt: ready.createdAt?.toISOString()
    }
  }
}

export { LegacyRecoveryOwner }
export type { LegacyRecoveryDependencies, LegacyUploadUpgradeOptions }
