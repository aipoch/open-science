import { createReadStream } from 'node:fs'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

import {
  DEFAULT_UPLOAD_PROJECT_NAME,
  PENDING_UPLOAD_SESSION_ID,
  type UploadedAttachment
} from '../../shared/uploads'
import type { ManagedUploadResolver } from './managed-upload-resolver'
import {
  UPLOADS_DIR,
  assertPathInsideRoot,
  assertSafePathSegment,
  createUploadedAttachment,
  getSessionUploadDir,
  moveToUniqueUploadFile
} from './storage-helpers'

type StagedPublicationOptions = {
  getClient?: () => Promise<PrismaClient>
}

type PublicationOptions = {
  preserveLegacySource?: boolean
  requireExistingAuthority?: boolean
}

type UploadVersionRecord = {
  id: string
  uploadFileId: string
  versionNumber: number
  state: string
  contentStorageKey: string
  filename: string
  originalFilename: string
  contentType: string | null
  sizeBytes: bigint
  checksum: string
  createdAt: Date | null
}

type RemoveVerifiedLegacyCopyInput = {
  projectId: string
  sessionId: string
  uploadFileId: string
  versionId: string
  filename: string
  legacyPath?: string
}

type StagedPublicationDependencies = {
  resolver: ManagedUploadResolver
  completeStagingUpload: (
    projectId: string,
    sessionId: string,
    attachment: UploadedAttachment,
    version: UploadVersionRecord,
    options?: { preserveSource?: boolean }
  ) => Promise<UploadedAttachment>
  hasOrphanLegacyCandidate: (
    projectId: string,
    sessionId: string,
    uploadFileId: string,
    attachment: UploadedAttachment
  ) => Promise<boolean>
  removeVerifiedLegacyCopy: (input: RemoveVerifiedLegacyCopyInput) => Promise<unknown>
}

const sha256File = async (filePath: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

class OrphanLegacyUploadAuthorityMissingError extends Error {}

class StagedPublicationOwner {
  constructor(
    private readonly storageRoot: string,
    private readonly options: StagedPublicationOptions,
    private readonly dependencies: StagedPublicationDependencies
  ) {}

  async finalizePendingSessionUploads(
    sessionId: string,
    attachments: UploadedAttachment[],
    projectId = DEFAULT_UPLOAD_PROJECT_NAME
  ): Promise<UploadedAttachment[]> {
    return this.finalizeSessionUploads(sessionId, attachments, projectId)
  }

  async finalizeSessionUploads(
    sessionId: string,
    attachments: UploadedAttachment[],
    projectId: string,
    options: PublicationOptions = {}
  ): Promise<UploadedAttachment[]> {
    const safeSessionId = assertSafePathSegment(sessionId)
    const safeProjectId = assertSafePathSegment(projectId.trim() || DEFAULT_UPLOAD_PROJECT_NAME)
    if (options.requireExistingAuthority && !this.options.getClient) {
      throw new Error('Legacy Upload authority is unavailable for orphan recovery.')
    }

    const finalized = await Promise.all(
      attachments.map(async (attachment) => {
        if (this.options.getClient) {
          return this.publishAttachment(safeProjectId, safeSessionId, attachment, options)
        }
        return this.finalizeAttachment(safeSessionId, attachment)
      })
    )
    return finalized.filter(
      (attachment): attachment is UploadedAttachment => attachment !== undefined
    )
  }

  // Converts one pending attachment record into a durable Session-owned upload record.
  private async finalizeAttachment(
    sessionId: string,
    attachment: UploadedAttachment
  ): Promise<UploadedAttachment> {
    if (attachment.sessionId === sessionId) {
      const targetDir = getSessionUploadDir(this.storageRoot, sessionId)
      const resolvedFilePath = await this.dependencies.resolver.resolveManagedUploadPath({
        path: attachment.path
      })

      assertPathInsideRoot(await realpath(targetDir), resolvedFilePath)
      return { ...attachment, size: (await stat(resolvedFilePath)).size }
    }

    if (attachment.sessionId !== PENDING_UPLOAD_SESSION_ID) {
      throw new Error('Upload attachment belongs to a different session.')
    }

    const pendingDir = getSessionUploadDir(this.storageRoot, PENDING_UPLOAD_SESSION_ID)
    const targetDir = getSessionUploadDir(this.storageRoot, sessionId)
    const sourcePath = await this.dependencies.resolver.resolveManagedUploadPath({
      path: attachment.path
    })

    assertPathInsideRoot(await realpath(pendingDir), sourcePath)
    await mkdir(targetDir, { recursive: true })

    const { filename, filePath } = await moveToUniqueUploadFile(
      sourcePath,
      targetDir,
      attachment.name
    )

    return createUploadedAttachment({
      ...attachment,
      sessionId,
      filename,
      filePath
    })
  }

  // Publishes one independent upload through SQLite staging authority before moving its immutable
  // bytes. A retry recovers the same v1 row by uploadFileId.
  private async publishAttachment(
    projectId: string,
    sessionId: string,
    attachment: UploadedAttachment,
    options: PublicationOptions = {}
  ): Promise<UploadedAttachment | undefined> {
    const uploadFileId = assertSafePathSegment(attachment.id)
    const client = await this.options.getClient!()
    const existingFile = await client.uploadFile.findUnique({
      where: { id: uploadFileId },
      include: { versions: { where: { versionNumber: 1 }, take: 1 } }
    })
    if (existingFile) {
      if (existingFile.projectId !== projectId || existingFile.sessionId !== sessionId) {
        throw new Error('Upload file identity belongs to a different project or session.')
      }
      const existingVersion = existingFile.versions[0]
      if (!existingVersion) throw new Error('Upload file has no immutable v1 metadata.')
      if (attachment.versionId && attachment.versionId !== existingVersion.id) {
        throw new Error('Upload Version identity conflicts with the existing immutable Version.')
      }
      const published = await this.dependencies.completeStagingUpload(
        projectId,
        sessionId,
        attachment,
        existingVersion,
        { preserveSource: options.preserveLegacySource === true }
      )
      if (
        !options.preserveLegacySource &&
        attachment.sessionId === sessionId &&
        !attachment.versionId
      ) {
        await this.dependencies.removeVerifiedLegacyCopy({
          projectId,
          sessionId,
          uploadFileId,
          versionId: existingVersion.id,
          filename: attachment.name,
          legacyPath: attachment.path
        })
      }
      return published
    }

    if (options.requireExistingAuthority) {
      if (
        !(await this.dependencies.hasOrphanLegacyCandidate(
          projectId,
          sessionId,
          uploadFileId,
          attachment
        ))
      ) {
        return undefined
      }
      throw new OrphanLegacyUploadAuthorityMissingError(
        `Legacy Upload authority is unavailable: ${uploadFileId}`
      )
    }

    const sourcePath = await this.dependencies.resolver.resolveManagedUploadPath({
      path: attachment.path
    })
    if (attachment.sessionId === PENDING_UPLOAD_SESSION_ID) {
      const pendingRoot = await realpath(
        getSessionUploadDir(this.storageRoot, PENDING_UPLOAD_SESSION_ID)
      )
      assertPathInsideRoot(
        pendingRoot,
        sourcePath,
        'Upload file is outside pending upload storage.'
      )
    } else if (attachment.sessionId === sessionId) {
      const legacySessionRoot = await realpath(getSessionUploadDir(this.storageRoot, sessionId))
      assertPathInsideRoot(
        legacySessionRoot,
        sourcePath,
        'Legacy upload file belongs to a different session.'
      )
    } else {
      throw new Error('Unregistered upload attachment belongs to a different session.')
    }
    const fileInfo = await stat(sourcePath)
    const checksum = await sha256File(sourcePath)
    const versionId = assertSafePathSegment(attachment.versionId ?? randomUUID())
    const contentStorageKey = [
      UPLOADS_DIR,
      projectId,
      sessionId,
      uploadFileId,
      'versions',
      versionId,
      'content'
    ].join('/')
    const requestedCreatedAt = attachment.createdAt ? new Date(attachment.createdAt) : undefined
    if (requestedCreatedAt && Number.isNaN(requestedCreatedAt.getTime())) {
      throw new Error(`Invalid upload creation time: ${attachment.createdAt}`)
    }
    const createdAt =
      attachment.sessionId === PENDING_UPLOAD_SESSION_ID
        ? (requestedCreatedAt ?? new Date())
        : undefined

    const registered = await client.$transaction(async (tx) => {
      await tx.fileOriginSession.upsert({
        where: { projectId_sessionId: { projectId, sessionId } },
        create: { projectId, sessionId },
        update: {}
      })
      await tx.uploadFile.create({
        data: {
          id: uploadFileId,
          projectId,
          sessionId,
          filename: attachment.name,
          originalFilename: attachment.originalName
        }
      })
      return tx.uploadVersion.create({
        data: {
          id: versionId,
          uploadFileId,
          versionNumber: 1,
          state: 'staging',
          contentStorageKey,
          filename: attachment.name,
          originalFilename: attachment.originalName,
          contentType: attachment.mimeType,
          sizeBytes: BigInt(fileInfo.size),
          checksum,
          createdAt
        }
      })
    })

    return this.dependencies.completeStagingUpload(projectId, sessionId, attachment, registered, {
      preserveSource: options.preserveLegacySource === true
    })
  }
}

export { OrphanLegacyUploadAuthorityMissingError, StagedPublicationOwner }
export type { PublicationOptions, UploadVersionRecord }
