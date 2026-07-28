import type { PreviewFileItem, PreviewFileSource } from '@/stores/preview-workbench-store'
import type { ChatSession } from '@/stores/session-store'
import type { MessagePart } from '../../../../shared/session-persistence'
import {
  createArtifactVersionLocator,
  type ArtifactLineageProvenance,
  type ArtifactVersionDescriptor
} from '../../../../shared/artifact-provenance'
import { getUploadedAttachmentName, getUploadedAttachmentPath } from '../../../../shared/uploads'

import { getArtifactName } from './artifact-preview-utils'
import { getPreviewFormatForFile } from './preview-support'

export type MessageArtifact = NonNullable<ChatSession['artifacts']>[number]
export type MessageUploadAttachment = NonNullable<
  ChatSession['messages'][number]['uploads']
>[number]
type ArtifactMentionPart = Extract<MessagePart, { type: 'artifact' }>
type ManagedArtifactMentionPart = Exclude<ArtifactMentionPart, { source: 'linked-folder' }>

// Builds the common preview workbench file item for generated artifacts and user uploads.
export const createPreviewFileItem = ({
  id,
  projectId,
  sessionId,
  path,
  name,
  mimeType,
  source,
  size,
  mtimeMs,
  artifactId,
  selectedVersionId,
  versionNumber,
  originSession
}: {
  id: string
  projectId?: string
  sessionId: string
  path: string
  name: string
  mimeType?: string
  source?: PreviewFileSource
  size?: number
  mtimeMs?: number
  artifactId?: string
  selectedVersionId?: string
  versionNumber?: number
  originSession?: PreviewFileItem['originSession']
}): PreviewFileItem => {
  const item: PreviewFileItem = {
    id,
    ...(projectId ? { projectId } : {}),
    sessionId,
    title: name,
    type: 'file',
    path,
    name,
    format: getPreviewFormatForFile({ name, mimeType })
  }

  // Only uploads need an explicit source because artifacts are the historical default.
  if (source) item.source = source
  if (mimeType) item.mimeType = mimeType
  if (typeof size === 'number') item.size = size
  if (typeof mtimeMs === 'number') item.mtimeMs = mtimeMs
  if (artifactId) item.artifactId = artifactId
  if (selectedVersionId) item.selectedVersionId = selectedVersionId
  if (typeof versionNumber === 'number') item.versionNumber = versionNumber
  if (originSession) item.originSession = originSession

  return item
}

// Converts app-managed generated files into preview tabs and ignores unmanaged artifacts.
export const createPreviewFileItemFromArtifact = (
  artifact: MessageArtifact,
  sessionId: string,
  projectId?: string
): PreviewFileItem | undefined => {
  if (artifact.kind !== 'managed-file') return undefined

  const artifactName = getArtifactName(artifact)
  const nativeVersionPath =
    projectId && artifact.artifactId && artifact.versionId
      ? createArtifactVersionLocator({
          projectId,
          appSessionId: sessionId,
          artifactId: artifact.artifactId,
          versionId: artifact.versionId
        })
      : artifact.path

  return createPreviewFileItem({
    id: artifact.artifactId ?? artifact.id,
    projectId,
    sessionId,
    path: nativeVersionPath,
    name: artifactName,
    mimeType: artifact.mimeType,
    size: artifact.size,
    mtimeMs: artifact.mtimeMs,
    artifactId: artifact.artifactId,
    selectedVersionId: artifact.versionId,
    versionNumber: artifact.versionNumber
  })
}

// Applies one immutable Artifact Version to the stable preview tab identity. Both image preview
// and Provenance use this projection so switching Versions never creates a second tab.
export const createPreviewFileItemForArtifactVersion = ({
  item,
  version,
  projectId
}: {
  item: PreviewFileItem
  version: ArtifactVersionDescriptor
  projectId: string
}): PreviewFileItem => ({
  ...item,
  projectId,
  selectedVersionId: version.versionId,
  versionNumber: version.versionNumber,
  path: createArtifactVersionLocator({
    projectId,
    appSessionId: item.sessionId,
    artifactId: version.artifactId,
    versionId: version.versionId
  }),
  name: version.name,
  title: version.name,
  size: version.size,
  mtimeMs: version.mtimeMs
})

// A persisted preview may briefly carry an obsolete Version id after overwrite/finalization.
// Lineage is authoritative: keep a valid selection, otherwise use its newest finalized Version.
export const resolveArtifactVersionDescriptor = (
  lineage: ArtifactLineageProvenance,
  selectedVersionId: string | undefined
): ArtifactVersionDescriptor | undefined =>
  lineage.versions.find((version) => version.versionId === selectedVersionId) ??
  lineage.versions.at(-1)

// Converts a sent user upload into the same preview shape used by message attachment clicks.
export const createPreviewFileItemFromUpload = (
  attachment: MessageUploadAttachment,
  sessionId: string,
  projectId?: string
): PreviewFileItem => {
  const attachmentName = getUploadedAttachmentName(attachment)

  return createPreviewFileItem({
    id: `upload:${attachment.id}`,
    projectId,
    sessionId,
    source: 'upload',
    path: getUploadedAttachmentPath(attachment, projectId),
    name: attachmentName,
    mimeType: attachment.mimeType,
    size: attachment.size
  })
}

// Converts a sent-message artifact mention into the same preview shape used by its source panel.
export const createPreviewFileItemFromMention = (
  part: ManagedArtifactMentionPart,
  sessionId: string,
  projectId?: string
): PreviewFileItem =>
  createPreviewFileItem({
    id: part.id,
    projectId,
    sessionId,
    path: part.path,
    name: part.name,
    mimeType: part.mimeType,
    source: part.source === 'upload' ? 'upload' : undefined
  })
