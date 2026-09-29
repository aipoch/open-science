import type { PrismaClient } from '@prisma/client'
import { researchDraftPayloadSchema } from '../../shared/research-draft'
import { researchSubmissionPayloadSchema } from '../../shared/research-submission'
import type { UploadedAttachment } from '../../shared/uploads'
import { ManagedFileVersionError } from '../managed-file-versions/error'
import type { ManagedFileVersionService } from '../managed-file-versions/service'

type ExactUploadPreviewRequest = {
  projectId: string
  fileId: string
  versionId: string
  sessionId?: string
}

/**
 * Research drafts keep completed bytes outside Files until a message publishes them. A renderer
 * locator alone is not authority for producer read-back: require the exact attachment in a
 * durable, project-scoped draft or question before opening the ordinary verified immutable lease.
 */
export const openUploadPreviewVersion = async (
  versions: Pick<ManagedFileVersionService, 'openVersion' | 'openUnpublishedVersion'>,
  getClient: () => Promise<PrismaClient>,
  request: ExactUploadPreviewRequest
): ReturnType<ManagedFileVersionService['openVersion']> => {
  const identity = {
    source: 'upload' as const,
    projectId: request.projectId,
    fileId: request.fileId
  }
  try {
    return await versions.openVersion(identity, request.versionId)
  } catch (error) {
    // This exception is only for a completed, still-private research upload. Integrity, deletion,
    // foreign Project/File and all other failures retain the normal managed-file boundary.
    if (!(error instanceof ManagedFileVersionError) || error.code !== 'VERSION_NOT_FOUND') {
      throw error
    }
    const client = await getClient()
    const version = await client.uploadVersion.findFirst({
      where: {
        id: request.versionId,
        uploadFileId: request.fileId,
        state: 'ready',
        originKind: 'user_upload',
        versionNumber: 1,
        basedOnVersionId: null,
        uploadFile: { is: { projectId: request.projectId, currentVersionId: null } }
      },
      select: { uploadFile: { select: { sessionId: true } } }
    })
    const sessionId = version?.uploadFile.sessionId
    if (
      !sessionId ||
      !/^(research-draft|research-submission)-.+/.test(sessionId) ||
      (request.sessionId !== undefined && request.sessionId !== sessionId)
    ) {
      throw error
    }
    const hasReference = async (): Promise<boolean> => {
      const where = {
        projectId: request.projectId,
        payloadJson: { contains: JSON.stringify(request.versionId) }
      }
      const [drafts, submissions] = await Promise.all([
        client.researchDraft.findMany({
          where: { ...where, state: 'active' },
          select: { payloadJson: true }
        }),
        client.researchSubmission.findMany({ where, select: { payloadJson: true } })
      ])
      const matches = (attachment: UploadedAttachment): boolean =>
        attachment.id === request.fileId &&
        attachment.versionId === request.versionId &&
        attachment.sessionId === sessionId
      for (const [rows, schema] of [
        [drafts, researchDraftPayloadSchema],
        [submissions, researchSubmissionPayloadSchema]
      ] as const) {
        for (const row of rows) {
          if (row.payloadJson.length > 4_000_000) continue
          try {
            const parsed = schema.safeParse(JSON.parse(row.payloadJson))
            if (parsed.success && parsed.data.attachments.some(matches)) return true
          } catch {
            // A malformed journal must not grant access to unpublished bytes.
          }
        }
      }
      return false
    }
    if (!(await hasReference())) throw error
    const lease = await versions.openUnpublishedVersion(identity, request.versionId)
    try {
      // Opening the file crosses an async boundary; a concurrently discarded last reference no
      // longer authorizes private read-back. The lease still owns path and checksum verification.
      if (!(await hasReference())) throw error
      return lease
    } catch (cause) {
      await lease.close()
      throw cause
    }
  }
}
