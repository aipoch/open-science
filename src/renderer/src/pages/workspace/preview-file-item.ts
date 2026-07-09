import type { PreviewFileItem, PreviewFileSource } from '@/stores/preview-workbench-store'
import type { ChatSession } from '@/stores/session-store'
import { getUploadedAttachmentName } from '../../../../shared/uploads'

import { getArtifactExtension, getArtifactName } from './artifact-preview-utils'
import { getFileExtension, getPreviewFormat } from './preview-support'

export type MessageArtifact = NonNullable<ChatSession['artifacts']>[number]
export type MessageUploadAttachment = NonNullable<
  ChatSession['messages'][number]['uploads']
>[number]

// Builds the common preview workbench file item for generated artifacts and user uploads.
export const createPreviewFileItem = ({
  id,
  sessionId,
  path,
  name,
  extension,
  mimeType,
  source
}: {
  id: string
  sessionId: string
  path: string
  name: string
  extension: string
  mimeType?: string
  source?: PreviewFileSource
}): PreviewFileItem => {
  const item: PreviewFileItem = {
    id,
    sessionId,
    title: name,
    type: 'file',
    path,
    name,
    format: getPreviewFormat(extension, mimeType)
  }

  // Only uploads need an explicit source because artifacts are the historical default.
  if (source) item.source = source

  return item
}

// Converts app-managed generated files into preview tabs and ignores unmanaged artifacts.
export const createPreviewFileItemFromArtifact = (
  artifact: MessageArtifact,
  sessionId: string
): PreviewFileItem | undefined => {
  if (artifact.kind !== 'managed-file') return undefined

  const artifactName = getArtifactName(artifact)

  return createPreviewFileItem({
    id: artifact.id,
    sessionId,
    path: artifact.path,
    name: artifactName,
    extension: getArtifactExtension(artifact),
    mimeType: artifact.mimeType
  })
}

// Converts a sent user upload into the same preview shape used by message attachment clicks.
export const createPreviewFileItemFromUpload = (
  attachment: MessageUploadAttachment,
  sessionId: string
): PreviewFileItem => {
  const attachmentName = getUploadedAttachmentName(attachment)

  return createPreviewFileItem({
    id: `upload:${attachment.id}`,
    sessionId,
    source: 'upload',
    path: attachment.path,
    name: attachmentName,
    extension: getFileExtension(attachmentName),
    mimeType: attachment.mimeType
  })
}
