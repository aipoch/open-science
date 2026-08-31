import type { PreviewFileItem, PreviewFileSource } from '@/stores/preview-workbench-store'
import type { ChatSession } from '@/stores/session-store'
import type { ArtifactFile } from '../../../../shared/artifacts'
import type { MessagePart, SessionPdfBinding } from '../../../../shared/session-persistence'
import { sessionPdfBindingToFileReference } from '../../../../shared/session-pdf-context'
import {
  createArtifactVersionLocator,
  parseArtifactVersionLocator,
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
  artifact: MessageArtifact | ArtifactFile,
  sessionId: string,
  projectId?: string
): PreviewFileItem | undefined => {
  if ('kind' in artifact && artifact.kind !== 'managed-file') return undefined

  const artifactName = 'kind' in artifact ? getArtifactName(artifact) : artifact.name
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

// An omitted selection opens the newest finalized Version. An explicit selection is immutable
// evidence: if it no longer resolves, callers must show it as unavailable rather than substitute bytes.
export const resolveArtifactVersionDescriptor = (
  lineage: ArtifactLineageProvenance,
  selectedVersionId: string | undefined
): ArtifactVersionDescriptor | undefined =>
  selectedVersionId === undefined
    ? lineage.versions.at(-1)
    : lineage.versions.find((version) => version.versionId === selectedVersionId)

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

// Reopens the exact immutable Version captured by a Session PDF binding.
export const createPreviewFileItemFromPdfContext = (
  context: SessionPdfBinding,
  projectId: string
): PreviewFileItem => {
  const reference = sessionPdfBindingToFileReference(projectId, context)
  if (reference.source === 'linked-folder') {
    throw new Error('Session PDF context must resolve to a managed file Version.')
  }
  const isArtifact = context.sourceKind === 'artifact-version'

  return createPreviewFileItem({
    id: isArtifact ? context.sourceFileId : `upload:${context.sourceFileId}`,
    projectId,
    sessionId: context.sourceSessionId,
    path: reference.path,
    name: context.name,
    mimeType: context.mimeType,
    size: context.sizeBytes,
    source: isArtifact ? undefined : 'upload',
    artifactId: isArtifact ? context.sourceFileId : undefined,
    selectedVersionId: isArtifact ? context.sourceVersionId : undefined
  })
}

// Sentinel session id for local ("This computer") preview tabs. Local files belong to no chat
// session, so they use a stable non-session key (mirrors the project-files tool's sentinel) — this
// keeps them out of removeSessionItems cleanup when a real session is deleted.
export const LOCAL_PREVIEW_SESSION_ID = '__local_files__'

// Builds a preview tab for a local ("This computer") file. The path is an absolute filesystem
// path; the id is namespaced by path so re-opening the same file re-activates its tab. sessionId
// scopes the tab to the active session like every other preview item.
export const createPreviewFileItemFromLocal = ({
  sessionId,
  path,
  name,
  size,
  mtimeMs
}: {
  sessionId: string
  path: string
  name: string
  size?: number
  mtimeMs?: number
}): PreviewFileItem =>
  createPreviewFileItem({
    id: `local:${path}`,
    sessionId,
    source: 'local',
    path,
    name,
    size,
    mtimeMs
  })

// Converts a sent-message artifact mention into the same preview shape used by its source panel.
export const createPreviewFileItemFromMention = (
  part: ManagedArtifactMentionPart,
  sessionId: string,
  projectId?: string
): PreviewFileItem => {
  const identity = part.source === 'artifact' ? parseArtifactVersionLocator(part.path) : undefined
  const artifactId =
    part.source === 'artifact'
      ? (identity?.artifactId ?? (part.versionId ? part.id : undefined))
      : undefined
  const selectedVersionId =
    part.source === 'artifact' ? (identity?.versionId ?? part.versionId) : undefined

  return createPreviewFileItem({
    id: artifactId ?? part.id,
    projectId: identity?.projectId ?? projectId,
    sessionId: identity?.appSessionId ?? sessionId,
    path: part.path,
    name: part.name,
    mimeType: part.mimeType,
    source: part.source === 'upload' ? 'upload' : undefined,
    artifactId,
    selectedVersionId
  })
}
