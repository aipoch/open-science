import {
  MAX_COMPOSER_ATTACHMENTS,
  PENDING_UPLOAD_SESSION_ID,
  imageAttachmentMimeType,
  type UploadedAttachment
} from '../../../../shared/uploads'
import { usePreviewWorkbenchStore } from '../../stores/preview-workbench-store'

type FinalizeWorkspaceAttachmentsInput = {
  sessionId: string
  attachments: UploadedAttachment[]
  projectId?: string
  preserveSourceOwnership?: boolean
}

export const finalizeWorkspaceAttachments = async ({
  sessionId,
  attachments,
  projectId,
  preserveSourceOwnership = false
}: FinalizeWorkspaceAttachmentsInput): Promise<UploadedAttachment[]> => {
  const staged = attachments.filter((attachment) => !attachment.versionId)
  if (staged.length === 0) return attachments

  const stagedBySession = new Map<string, UploadedAttachment[]>()
  for (const attachment of staged) {
    const ownerSessionId =
      preserveSourceOwnership && attachment.sessionId !== PENDING_UPLOAD_SESSION_ID
        ? attachment.sessionId
        : sessionId
    const ownedAttachments = stagedBySession.get(ownerSessionId) ?? []
    ownedAttachments.push(attachment)
    stagedBySession.set(ownerSessionId, ownedAttachments)
  }

  const finalized = (
    await Promise.all(
      [...stagedBySession].map(([ownerSessionId, ownedAttachments]) =>
        window.api.uploads.finalizeSession({
          projectId,
          sessionId: ownerSessionId,
          attachments: ownedAttachments
        })
      )
    )
  ).flat()
  const finalizedById = new Map(finalized.map((attachment) => [attachment.id, attachment]))
  usePreviewWorkbenchStore.getState().reconcileFinalizedUploads(finalized)
  return attachments.map((attachment) => {
    if (attachment.versionId) return attachment
    const replacement = finalizedById.get(attachment.id)
    if (!replacement) {
      throw new Error(`Upload finalization did not return the attachment: ${attachment.id}`)
    }
    return replacement
  })
}

export const filterWorkspaceHistoryAttachments = (
  attachments: UploadedAttachment[],
  supportsImageInput?: boolean,
  supportsImageRelay?: boolean
): UploadedAttachment[] =>
  supportsImageInput === false && supportsImageRelay !== true
    ? attachments.filter(
        (attachment) => !imageAttachmentMimeType(attachment.name, attachment.mimeType)
      )
    : attachments

export const mergeWorkspaceHistoryAttachments = ({
  historyAttachments = [],
  latestAttachments,
  supportsImageInput,
  supportsImageRelay
}: {
  historyAttachments?: UploadedAttachment[]
  latestAttachments: UploadedAttachment[]
  supportsImageInput?: boolean
  supportsImageRelay?: boolean
}): UploadedAttachment[] => {
  const filteredLatest = filterWorkspaceHistoryAttachments(
    latestAttachments,
    supportsImageInput,
    supportsImageRelay
  )
  const historyLimit = Math.max(0, MAX_COMPOSER_ATTACHMENTS - filteredLatest.length)
  const latestHistory = historyLimit > 0 ? historyAttachments.slice(-historyLimit) : []
  return [...latestHistory, ...filteredLatest]
}
