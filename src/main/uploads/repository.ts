import { constants, createReadStream } from 'node:fs'
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

import type { ArtifactPreviewResult, ReadArtifactPreviewRequest } from '../../shared/artifacts'
import {
  DEFAULT_UPLOAD_PROJECT_NAME,
  PENDING_UPLOAD_SESSION_ID,
  toPersistedUploadedAttachment,
  toRuntimeUploadedAttachment,
  type AppendUploadTransferRequest,
  type BeginUploadTransferRequest,
  type DeleteUploadRequest,
  type StageLocalUploadRequest,
  type UploadTransferProgress,
  type UploadTransferRequest,
  type UploadTransferStatus,
  type UploadedAttachment,
  type PersistedUploadedAttachment
} from '../../shared/uploads'
import type { PersistedChatMessage, PersistedChatSession } from '../../shared/session-persistence'
import { ActiveTransferOwner } from './active-transfer-owner'
import { ManagedUploadResolver, type ResolvedManagedUpload } from './managed-upload-resolver'
import {
  OrphanLegacyUploadAuthorityMissingError,
  StagedPublicationOwner,
  type UploadVersionRecord
} from './staged-publication-owner'
import {
  UPLOADS_DIR,
  assertPathInsideRoot,
  assertSafePathSegment,
  getSessionUploadDir,
  isFileExistsError,
  isMissingFileError
} from './storage-helpers'

const LIVE_COPY_TEMP_SUFFIX = '.live-copy.tmp'
const LEGACY_CLEANUP_PRIVATE_SUFFIX = '.legacy-cleanup.private'
const LEGACY_CLEANUP_CANDIDATE = 'candidate'

type UploadRepositoryOptions = {
  maxFileBytes?: number
  getClient?: () => Promise<PrismaClient>
  getLegacyFileChecksum?: (path: string) => Promise<string>
  renameLegacyForCleanup?: (source: string, destination: string) => Promise<void>
  createLocalReadStream?: (
    sourcePath: string,
    options: { highWaterMark: number; signal: AbortSignal }
  ) => ReturnType<typeof createReadStream>
}

type LegacyUploadUpgradeOptions = {
  // Live callers cannot prove that every renderer has applied the returned path-free projection.
  // Preserve the legacy source until a later startup/deletion reconciliation runs without live state.
  // Orphan recovery also preserves it, but may only reuse authority left by the old deletion tail:
  // recreating identity after provenance succeeded could claim unrelated residual bytes.
  mode?: 'reconcile' | 'live-save' | 'orphan-recovery' | 'terminal-delete'
}

const sha256File = async (filePath: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

type FileIdentity = Awaited<ReturnType<typeof lstat>>

const hasSameFileIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size

const hasSameFileSnapshot = (left: FileIdentity, right: FileIdentity): boolean =>
  hasSameFileIdentity(left, right) &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs

class LegacyCleanupIncompleteError extends Error {}

// Terminal Project deletion may leave bytes only when reconciliation has positively proved that the
// deterministic legacy path no longer contains the Version-owned source. Callers must not use this
// type for missing/corrupt Version authority or transient filesystem/private-claim failures.
class UnsafeLegacyUploadResidualError extends Error {}

// Orphan adoption may suppress only this positively proven cross-version state: the Upload row is
// absent while candidate bytes exist or cannot safely be ruled out from the surviving locator.
// Database/filesystem failures and malformed surviving authority keep their original retry behavior.
// Promise.all rejects before sibling publication settles. Orphan recovery must not let a late
// sibling reactivate ManagedFile rows after its caller has already soft-deleted the Project index.
// Prefer an ordinary failure over the suppressible missing-authority state so DB/FS errors retain
// their durable intent instead of being accidentally collapsed into orphan-retained.
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

type LegacyCleanupResult =
  { status: 'absent' | 'removed' } | { status: 'unsafe-residual'; reason: string }

// Owns app-managed uploads so renderer paths are always validated in the main process.
class UploadRepository {
  private readonly transferOwner: ActiveTransferOwner
  private readonly managedUploadResolver: ManagedUploadResolver
  private readonly stagedPublicationOwner: StagedPublicationOwner

  // The storage root is the app persistence root; this class appends uploads/project/session.
  constructor(
    private readonly storageRoot: string,
    private readonly options: UploadRepositoryOptions = {}
  ) {
    this.transferOwner = new ActiveTransferOwner(storageRoot, options)
    this.managedUploadResolver = new ManagedUploadResolver(storageRoot, options)
    this.stagedPublicationOwner = new StagedPublicationOwner(storageRoot, options, {
      resolver: this.managedUploadResolver,
      completeStagingUpload: (...args) => this.completeStagingUpload(...args),
      hasOrphanLegacyCandidate: (...args) => this.hasOrphanLegacyCandidate(...args),
      removeVerifiedLegacyCopy: (input) => this.removeVerifiedLegacyCopy(input)
    })
  }

  // Allocates an empty temporary file for sources that can only provide bytes (Web, clipboard,
  // synthetic File objects). Chunks are appended through appendTransfer and committed by finish.
  async beginTransfer(request: BeginUploadTransferRequest): Promise<UploadTransferStatus> {
    return this.transferOwner.beginTransfer(request)
  }

  // Accepts exactly one bounded chunk at the caller's expected offset. This makes retries safe:
  // callers query status and resume from receivedBytes instead of duplicating data.
  async appendTransfer(request: AppendUploadTransferRequest): Promise<UploadTransferStatus> {
    return this.transferOwner.appendTransfer(request)
  }

  async getTransferStatus(request: UploadTransferRequest): Promise<UploadTransferStatus | null> {
    return this.transferOwner.getTransferStatus(request)
  }

  // Publishes a fully received temporary file into the same pending attachment namespace used by
  // desktop-path uploads. Incomplete transfers remain resumable until explicitly aborted.
  async finishTransfer(request: UploadTransferRequest): Promise<UploadedAttachment> {
    return this.transferOwner.finishTransfer(request)
  }

  // Cancellation is idempotent so renderer cleanup can safely race a failed transfer.
  async abortTransfer(request: UploadTransferRequest): Promise<void> {
    return this.transferOwner.abortTransfer(request)
  }

  // Streams an existing desktop file into managed staging without routing its bytes through the
  // renderer or a single IPC message. The temporary file is committed only after all bytes arrive.
  async stageLocalFile(
    request: StageLocalUploadRequest,
    onProgress?: (progress: UploadTransferProgress) => void
  ): Promise<UploadedAttachment> {
    return this.transferOwner.stageLocalFile(request, onProgress)
  }

  // Moves pending attachments into their durable session directory once the runtime id is known.
  async finalizePendingSessionUploads(
    sessionId: string,
    attachments: UploadedAttachment[],
    projectId = DEFAULT_UPLOAD_PROJECT_NAME
  ): Promise<UploadedAttachment[]> {
    return this.stagedPublicationOwner.finalizePendingSessionUploads(
      sessionId,
      attachments,
      projectId
    )
  }

  private async finalizeSessionUploads(
    sessionId: string,
    attachments: UploadedAttachment[],
    projectId: string,
    options: { preserveLegacySource?: boolean; requireExistingAuthority?: boolean } = {}
  ): Promise<UploadedAttachment[]> {
    return this.stagedPublicationOwner.finalizeSessionUploads(
      sessionId,
      attachments,
      projectId,
      options
    )
  }

  // Converts path-only Session records from pre-Version releases before the Session repository is
  // allowed to write its path-free JSON projection, and reconciles historical copies left behind by
  // older Version-aware releases. Repeated references share one publication or reconciliation.
  async upgradeLegacySessionUploads(
    session: PersistedChatSession,
    options: LegacyUploadUpgradeOptions = {}
  ): Promise<PersistedChatSession> {
    this.assertConsistentSessionUploadReferences(session)
    const isLiveSave = options.mode === 'live-save' || options.mode === 'orphan-recovery'
    const requireExistingAuthority = options.mode === 'orphan-recovery'
    const isTerminalDelete = options.mode === 'terminal-delete'
    const upgrades = new Map<string, Promise<PersistedUploadedAttachment | undefined>>()
    const reconciliations = new Map<string, Promise<LegacyCleanupResult>>()
    const upgrade = async (
      upload: PersistedUploadedAttachment
    ): Promise<PersistedUploadedAttachment | undefined> => {
      if (upload.versionId) {
        const persisted = toPersistedUploadedAttachment(
          toRuntimeUploadedAttachment(upload, session.projectId)
        )
        if (isLiveSave) return Promise.resolve(persisted)
        const reconciliationKey = `${upload.id}:${upload.versionId}`
        let reconciliation = reconciliations.get(reconciliationKey)
        if (!reconciliation) {
          reconciliation = this.removeVerifiedLegacyCopy({
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
            await this.assertLegacySourceAbsent(upload.sessionId, upload.name, cleanup)
          }
          return persisted
        })
      }

      const existing = upgrades.get(upload.id)
      if (existing) return existing
      const operation = (async () => {
        if (!upload.path) {
          throw new Error(`Legacy upload has no recoverable path: ${upload.id}`)
        }
        const [finalized] = await this.finalizeSessionUploads(
          session.id,
          [toRuntimeUploadedAttachment(upload, session.projectId)],
          session.projectId,
          { preserveLegacySource: isLiveSave, requireExistingAuthority }
        )
        if (!finalized) return undefined
        if (isTerminalDelete) {
          await this.assertLegacySourceAbsent(upload.sessionId, upload.name, { status: 'absent' })
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
        ? {
            conversationGraph: {
              ...session.conversationGraph,
              messages: graphMessages!
            }
          }
        : {})
    }
  }

  // Operation sharing is safe only after every occurrence across the flat transcript and graph has
  // proven the same immutable identity. This synchronous, lexical preflight runs before any DB or
  // filesystem work starts, so a conflicting historical locator cannot be overwritten or orphaned.
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

  // Completes crash-interrupted staging rows at startup. Both native pending uploads and legacy
  // session-owned files have deterministic source candidates; a post-rename crash is recovered from
  // the already-valid final content. Every row is attempted so one corrupt upload cannot hide others.
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
          join(this.getSessionUploadDir(PENDING_UPLOAD_SESSION_ID), version.filename),
          join(this.getSessionUploadDir(version.uploadFile.sessionId), version.filename)
        ]
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

  // Deletes an app-managed upload after resolving the caller path through the trust boundary.
  async deleteUpload(request: DeleteUploadRequest): Promise<void> {
    return this.managedUploadResolver.deleteUpload(request)
  }

  // Resolves a renderer-provided upload path only after root and symlink checks pass.
  async resolveManagedUploadPath(
    request: DeleteUploadRequest,
    scope: { projectId?: string; sessionId?: string } = {}
  ): Promise<string> {
    return this.managedUploadResolver.resolveManagedUploadPath(request, scope)
  }

  // Resolves an upload only when it belongs to the named durable session. Agent-facing tools use
  // this stricter seam so a model cannot point a capability at another conversation's attachment.
  async resolveSessionUploadPath(
    sessionId: string,
    request: DeleteUploadRequest,
    projectId?: string
  ): Promise<string> {
    return this.managedUploadResolver.resolveSessionUploadPath(sessionId, request, projectId)
  }

  // Resolves both immutable bytes and their frozen user-facing name. Native Upload Versions store
  // bytes in a file named `content`, so consumers must not infer the original extension from the
  // physical path.
  async resolveSessionUpload(
    sessionId: string,
    request: DeleteUploadRequest,
    projectId?: string
  ): Promise<ResolvedManagedUpload> {
    return this.managedUploadResolver.resolveSessionUpload(sessionId, request, projectId)
  }

  async resolveManagedUpload(
    request: DeleteUploadRequest,
    scope: { projectId?: string; sessionId?: string } = {}
  ): Promise<ResolvedManagedUpload> {
    return this.managedUploadResolver.resolveManagedUpload(request, scope)
  }

  // Reads upload previews through the shared bounded reader after upload-specific path validation.
  async readManagedUploadPreview(
    request: ReadArtifactPreviewRequest
  ): Promise<ArtifactPreviewResult> {
    return this.managedUploadResolver.readManagedUploadPreview(request)
  }

  // Missing legacy and private candidates are positive evidence that the old deletion tail already
  // consumed the bytes. A mismatched recorded locator remains unknown and is retained fail-closed.
  private async hasOrphanLegacyCandidate(
    projectId: string,
    sessionId: string,
    uploadFileId: string,
    attachment: UploadedAttachment
  ): Promise<boolean> {
    assertSafePathSegment(projectId)
    assertSafePathSegment(sessionId)
    assertSafePathSegment(uploadFileId)
    const legacyRoot = this.getSessionUploadDir(sessionId)
    const expectedLegacyPath = resolve(legacyRoot, attachment.name)
    const privateClaimDir = `${expectedLegacyPath}${LEGACY_CLEANUP_PRIVATE_SUFFIX}`
    assertPathInsideRoot(legacyRoot, expectedLegacyPath)
    assertPathInsideRoot(legacyRoot, privateClaimDir)
    if (resolve(attachment.path) !== expectedLegacyPath) return true

    for (const candidate of [expectedLegacyPath, privateClaimDir]) {
      try {
        await lstat(candidate)
        return true
      } catch (error) {
        if (!isMissingFileError(error)) throw error
      }
    }

    // A live-save can crash after copying bytes into an authority-derived Version directory. The
    // Version id is unavailable once SQLite authority is gone, so scan only this Upload's bounded
    // versions root. Empty directories left by provenance cleanup are harmless; any surviving entry
    // (including content.live-copy.tmp) is retained for manual/retry recovery.
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
      const entries = await readdir(join(versionsRoot, versionEntry.name), {
        withFileTypes: true
      })
      if (entries.length > 0) return true
    }
    return false
  }

  private async completeStagingUpload(
    projectId: string,
    sessionId: string,
    attachment: UploadedAttachment,
    version: UploadVersionRecord,
    options: { preserveSource?: boolean } = {}
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
        // A prior live save completed its copy but exited before the atomic final rename. The
        // deterministic path is derived from staging authority, so recovery can safely finish it.
        await rename(temporaryPath, finalPath)
        finalValid = await validateContent(finalPath)
        if (!finalValid) {
          throw new Error(`Recovered Upload Version content is corrupt: ${version.id}`)
        }
      } else {
        // Remove a partial/corrupt crash residue before retrying from the still-authoritative source.
        await rm(temporaryPath, { force: true })
      }
    }

    if (!finalValid) {
      let sourcePath: string | undefined
      try {
        sourcePath = await this.resolveManagedUploadPath({ path: attachment.path })
      } catch (error) {
        if (!isMissingFileError(error)) throw error
      }
      if (!sourcePath || !(await validateContent(sourcePath))) {
        const client = await this.options.getClient!()
        await client.$transaction(async (tx) => {
          await tx.uploadVersion.deleteMany({ where: { id: version.id, state: 'staging' } })
          await tx.uploadFile.deleteMany({
            where: { id: version.uploadFileId, versions: { none: {} } }
          })
        })
        throw new Error(`Upload Version staging content is unavailable: ${version.id}`)
      }
      if (options.preserveSource) {
        // A live Session may still be rendering the path-only projection. Publish through an atomic
        // temporary copy, but retain that sole readable path until a later startup/deletion pass can
        // prove the path-free projection is authoritative without relying on renderer delivery.
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
        // The staging row is durable before this atomic move. If the process exits before the row is
        // marked ready, startup recovery validates the final path and completes publication. If the
        // Session JSON still contains the legacy path, a retry resolves the same row by uploadFileId.
        await rename(sourcePath, finalPath)
      }
      finalValid = await validateContent(finalPath)
      if (!finalValid) {
        throw new Error(`Published Upload Version content is corrupt: ${version.id}`)
      }
    }

    // A valid final path supersedes any deterministic crash residue from an earlier staging retry.
    await rm(`${finalPath}${LIVE_COPY_TEMP_SUFFIX}`, { force: true })

    const client = await this.options.getClient!()
    const ready = await client.$transaction(async (tx) => {
      const updated =
        version.state === 'ready'
          ? version
          : await tx.uploadVersion.update({
              where: { id: version.id },
              data: { state: 'ready' }
            })
      const timestamp = updated.createdAt ?? new Date()
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
          sourceVersionId: version.id,
          checksum: version.checksum,
          projectId,
          sessionId,
          displayName: version.originalFilename || version.filename,
          storageKey: version.contentStorageKey,
          mimeType: version.contentType,
          sizeBytes: version.sizeBytes,
          mtimeMs: BigInt(timestamp.getTime()),
          sortAtMs: BigInt(timestamp.getTime())
        },
        update: {
          sourceVersionId: version.id,
          checksum: version.checksum,
          sessionId,
          displayName: version.originalFilename || version.filename,
          storageKey: version.contentStorageKey,
          mimeType: version.contentType,
          sizeBytes: version.sizeBytes,
          mtimeMs: BigInt(timestamp.getTime()),
          sortAtMs: BigInt(timestamp.getTime()),
          deletedAt: null,
          deleteOperationId: null
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

  // Reconciles copies left by releases that published a ready Version without consuming the legacy
  // source. Cleanup is fail-closed: SQLite authority, both byte copies, the deterministic legacy path,
  // and the source file identity must all remain valid through the final pre-delete check.
  private async removeVerifiedLegacyCopy(input: {
    projectId: string
    sessionId: string
    uploadFileId: string
    versionId: string
    filename: string
    legacyPath?: string
  }): Promise<LegacyCleanupResult> {
    const projectId = assertSafePathSegment(input.projectId)
    const sessionId = assertSafePathSegment(input.sessionId)
    const uploadFileId = assertSafePathSegment(input.uploadFileId)
    const versionId = assertSafePathSegment(input.versionId)
    const legacyRoot = this.getSessionUploadDir(sessionId)
    const expectedLegacyPath = resolve(legacyRoot, input.filename)
    const cleanupPrivateDir = `${expectedLegacyPath}${LEGACY_CLEANUP_PRIVATE_SUFFIX}`
    const cleanupPrivatePath = join(cleanupPrivateDir, LEGACY_CLEANUP_CANDIDATE)
    assertPathInsideRoot(legacyRoot, expectedLegacyPath)
    assertPathInsideRoot(legacyRoot, cleanupPrivateDir)
    assertPathInsideRoot(legacyRoot, cleanupPrivatePath)

    let initialLegacyInfo: FileIdentity | undefined
    let privateDirInfo: FileIdentity | undefined
    let privateInfo: FileIdentity | undefined
    try {
      initialLegacyInfo = await lstat(expectedLegacyPath)
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
    try {
      privateDirInfo = await lstat(cleanupPrivateDir)
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
    if (privateDirInfo) {
      if (!privateDirInfo.isDirectory() || privateDirInfo.isSymbolicLink()) {
        throw new LegacyCleanupIncompleteError(
          `Legacy upload cleanup found an unsafe private claim: ${input.filename}`
        )
      }
      try {
        privateInfo = await lstat(cleanupPrivatePath)
      } catch (error) {
        if (!isMissingFileError(error)) throw error
        try {
          await rmdir(cleanupPrivateDir)
          privateDirInfo = undefined
        } catch {
          throw new LegacyCleanupIncompleteError(
            `Legacy upload cleanup found an incomplete private claim: ${input.filename}`
          )
        }
      }
    }
    if (!initialLegacyInfo && !privateInfo) return { status: 'absent' }

    if (input.legacyPath && resolve(input.legacyPath) !== expectedLegacyPath) {
      return {
        status: 'unsafe-residual',
        reason: 'the recorded legacy path does not match its deterministic Session path'
      }
    }

    if (!this.options.getClient) {
      throw new Error(`Upload Version authority is unavailable for legacy cleanup: ${versionId}`)
    }

    // The common path-free case has neither candidate, so the lstat checks above avoid a database read
    // and full immutable-file hash on every subsequent Session save. Database failures after a
    // candidate is found propagate so reconciliation remains incomplete and retries later.
    const client = await this.options.getClient()
    const version = await client.uploadVersion.findFirst({
      where: {
        id: versionId,
        uploadFileId,
        state: 'ready',
        uploadFile: { is: { projectId, sessionId } }
      },
      select: {
        contentStorageKey: true,
        filename: true,
        sizeBytes: true,
        checksum: true
      }
    })
    if (!version) {
      throw new Error(`Ready Upload Version authority is unavailable: ${versionId}`)
    }
    if (version.filename !== input.filename) {
      throw new Error(`Ready Upload Version filename does not match: ${versionId}`)
    }

    const finalPath = resolve(this.storageRoot, ...version.contentStorageKey.split('/'))
    assertPathInsideRoot(this.storageRoot, finalPath, 'Upload storage key escapes storage.')
    const finalInfo = await stat(finalPath)
    if (
      !finalInfo.isFile() ||
      finalInfo.size !== Number(version.sizeBytes) ||
      (await sha256File(finalPath)) !== version.checksum
    ) {
      throw new Error(`Ready Upload Version content is unavailable or corrupt: ${versionId}`)
    }

    // A pre-existing claim has lost the pre-rename inode witness held by its original process. Never
    // delete that candidate from checksum alone: restore it without overwrite, release the claim, and
    // make this invocation prove the legacy path again before acquiring a fresh claim.
    if (privateInfo) {
      await this.restoreLegacyCleanupPrivate(
        cleanupPrivateDir,
        cleanupPrivatePath,
        expectedLegacyPath,
        privateInfo
      )
    }

    let verifiedLegacyInfo: FileIdentity
    try {
      initialLegacyInfo = await lstat(expectedLegacyPath)
      if (!initialLegacyInfo.isFile() || initialLegacyInfo.isSymbolicLink()) {
        return {
          status: 'unsafe-residual',
          reason: 'the deterministic legacy path is not a regular owned file'
        }
      }
      const sourcePath = await this.resolveManagedUploadPath(
        { path: expectedLegacyPath },
        { projectId, sessionId }
      )
      const resolvedLegacyPath = await realpath(expectedLegacyPath)
      const resolvedFinalPath = await realpath(finalPath)
      if (
        sourcePath !== resolvedLegacyPath ||
        sourcePath === resolvedFinalPath ||
        initialLegacyInfo.size !== Number(version.sizeBytes)
      ) {
        return {
          status: 'unsafe-residual',
          reason: 'the deterministic legacy path does not match the Version-owned source'
        }
      }

      const legacyChecksum = await (this.options.getLegacyFileChecksum ?? sha256File)(
        expectedLegacyPath
      )
      if (legacyChecksum !== version.checksum) {
        return {
          status: 'unsafe-residual',
          reason: 'the deterministic legacy path contains different content'
        }
      }

      verifiedLegacyInfo = await lstat(expectedLegacyPath)
      const verifiedLegacyPath = await realpath(expectedLegacyPath)
      if (
        !verifiedLegacyInfo.isFile() ||
        verifiedLegacyInfo.isSymbolicLink() ||
        verifiedLegacyPath !== sourcePath ||
        !hasSameFileSnapshot(verifiedLegacyInfo, initialLegacyInfo)
      ) {
        return {
          status: 'unsafe-residual',
          reason: 'the deterministic legacy path changed during ownership verification'
        }
      }
    } catch (error) {
      if (isMissingFileError(error)) return { status: 'absent' }
      throw error
    }

    try {
      // mkdir is the no-replace claim Node exposes portably. Once this empty directory is ours, the
      // rename target inside it cannot collide with another cooperating cleanup process.
      await mkdir(cleanupPrivateDir)
    } catch (error) {
      if (isFileExistsError(error)) {
        throw new LegacyCleanupIncompleteError(
          `Legacy upload cleanup private claim is already occupied: ${input.filename}`
        )
      }
      throw error
    }

    try {
      await (this.options.renameLegacyForCleanup ?? rename)(expectedLegacyPath, cleanupPrivatePath)
    } catch (error) {
      if (isMissingFileError(error)) {
        try {
          await rmdir(cleanupPrivateDir)
        } catch {
          throw new LegacyCleanupIncompleteError(
            `Legacy upload cleanup could not release its private claim: ${input.filename}`
          )
        }
        return { status: 'absent' }
      }
      throw error
    }

    const movedInfo = await lstat(cleanupPrivatePath)
    const movedChecksum = await sha256File(cleanupPrivatePath)
    const reverifiedMovedInfo = await lstat(cleanupPrivatePath)
    if (
      !hasSameFileIdentity(movedInfo, verifiedLegacyInfo) ||
      movedChecksum !== version.checksum ||
      !hasSameFileSnapshot(reverifiedMovedInfo, movedInfo)
    ) {
      await this.restoreLegacyCleanupPrivate(
        cleanupPrivateDir,
        cleanupPrivatePath,
        expectedLegacyPath,
        reverifiedMovedInfo
      )
      return {
        status: 'unsafe-residual',
        reason: 'the claimed legacy source changed before removal'
      }
    }

    await rm(cleanupPrivatePath, { force: true })
    await rmdir(cleanupPrivateDir)
    return { status: 'removed' }
  }

  private async restoreLegacyCleanupPrivate(
    cleanupPrivateDir: string,
    cleanupPrivatePath: string,
    expectedLegacyPath: string,
    privateInfo: FileIdentity
  ): Promise<void> {
    if (!privateInfo.isFile() || privateInfo.isSymbolicLink()) {
      throw new LegacyCleanupIncompleteError(
        `Legacy upload cleanup left an unverifiable private candidate: ${basename(expectedLegacyPath)}`
      )
    }

    try {
      await link(cleanupPrivatePath, expectedLegacyPath)
    } catch (error) {
      if (isFileExistsError(error)) {
        // If a previous restore linked the same inode before crashing, finish removal of the extra
        // private name. Any different replacement wins EEXIST and remains untouched alongside it.
        const currentLegacyInfo = await lstat(expectedLegacyPath).catch(() => undefined)
        if (currentLegacyInfo && hasSameFileIdentity(currentLegacyInfo, privateInfo)) {
          await rm(cleanupPrivatePath, { force: true })
          await rmdir(cleanupPrivateDir)
          return
        }
      }
      throw new LegacyCleanupIncompleteError(
        `Legacy upload cleanup could not safely restore a private candidate: ${basename(expectedLegacyPath)}`
      )
    }

    await rm(cleanupPrivatePath, { force: true })
    await rmdir(cleanupPrivateDir)
  }

  // Session/project deletion removes the final JSON authority needed to discover a legacy duplicate.
  // Refuse that terminal commit while any deterministic candidate remains, including a replacement
  // file that fail-closed checksum or inode validation deliberately would not delete.
  private async assertLegacySourceAbsent(
    sessionId: string,
    filename: string,
    cleanup: LegacyCleanupResult
  ): Promise<void> {
    const legacyRoot = this.getSessionUploadDir(assertSafePathSegment(sessionId))
    const legacyPath = resolve(legacyRoot, filename)
    const cleanupPrivateDir = `${legacyPath}${LEGACY_CLEANUP_PRIVATE_SUFFIX}`
    assertPathInsideRoot(legacyRoot, legacyPath)
    assertPathInsideRoot(legacyRoot, cleanupPrivateDir)
    try {
      await lstat(cleanupPrivateDir)
      throw new LegacyCleanupIncompleteError(
        `Legacy upload cleanup found an incomplete private claim: ${filename}`
      )
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
    try {
      await lstat(legacyPath)
    } catch (error) {
      if (isMissingFileError(error)) return
      throw error
    }
    if (cleanup.status === 'unsafe-residual') {
      throw new UnsafeLegacyUploadResidualError(
        `Legacy upload source is not owned by its ready Version: ${filename}; ${cleanup.reason}.`
      )
    }
    throw new Error(`Legacy upload cleanup is incomplete: ${filename}`)
  }

  // Returns the staging or durable directory for one upload session.
  private getSessionUploadDir(sessionId: string): string {
    return getSessionUploadDir(this.storageRoot, sessionId)
  }
}

export {
  OrphanLegacyUploadAuthorityMissingError,
  UnsafeLegacyUploadResidualError,
  UploadRepository
}
