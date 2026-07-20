import type { ArtifactFile } from '../../../../shared/artifacts'
import type { ChatSession } from '@/stores/session-store'
import { getUploadedAttachmentName } from '../../../../shared/uploads'

import { getArtifactName } from './artifact-preview-utils'
import type { MessageArtifact, MessageUploadAttachment } from './preview-file-item'

export type ProjectUploadFileNode = {
  id: string
  sessionId: string
  name: string
  size: number
  timestamp: number
  attachment: MessageUploadAttachment
}

export type ProjectArtifactFileNode = {
  id: string
  name: string
  size?: number
  artifact: MessageArtifact
}

export type ProjectArtifactGroup = {
  sessionId: string
  title: string
  files: ProjectArtifactFileNode[]
}

export type ProjectFileLibrary = {
  uploadFiles: ProjectUploadFileNode[]
  artifactGroups: ProjectArtifactGroup[]
}

// Stable session id for the group holding artifacts whose owning session no longer exists in metadata.
export const ORPHANED_ARTIFACTS_GROUP_ID = '__orphaned_artifacts__'

// Adapts an on-disk artifact record to the same MessageArtifact shape session-derived files use, so the
// preview/download/@-mention paths treat an orphan exactly like any other managed file.
const toMessageArtifact = (file: ArtifactFile): MessageArtifact => ({
  id: file.id,
  kind: 'managed-file',
  path: file.path,
  fileUrl: file.fileUrl,
  name: file.name,
  mimeType: file.mimeType,
  size: file.size,
  mtimeMs: file.mtimeMs
})

// Derives the project file library from persisted session metadata. When on-disk artifacts are passed
// in, any whose file path is not already referenced by a live session is surfaced under an "Orphaned"
// group — so deleting a session (or project) keeps its generated files reachable instead of stranding
// them. Files that a live session still references are never duplicated into the orphan group.
export const buildProjectFileLibrary = (
  sessions: ChatSession[],
  diskArtifacts: ArtifactFile[] = []
): ProjectFileLibrary => {
  const uploadFiles: ProjectUploadFileNode[] = []
  const artifactGroups: ProjectArtifactGroup[] = []
  const referencedPaths = new Set<string>()

  for (const session of sessions) {
    for (const message of session.messages) {
      if (message.role !== 'user' || !message.uploads) continue

      for (const attachment of message.uploads) {
        if (!attachment.path) continue

        uploadFiles.push({
          id: `upload:${attachment.id}`,
          sessionId: session.id,
          name: getUploadedAttachmentName(attachment),
          size: attachment.size,
          timestamp: message.updatedAt || message.createdAt,
          attachment
        })
      }
    }

    const managedArtifacts =
      session.artifacts?.filter(
        (artifact) => artifact.kind === 'managed-file' && Boolean(artifact.path)
      ) ?? []

    for (const artifact of managedArtifacts) {
      if (artifact.path) referencedPaths.add(artifact.path)
    }

    const files = managedArtifacts.map((artifact) => ({
      id: artifact.id,
      name: getArtifactName(artifact),
      size: artifact.size,
      artifact
    }))

    if (files.length > 0) {
      artifactGroups.push({
        sessionId: session.id,
        title: session.title,
        files
      })
    }
  }

  // Any on-disk artifact no live session still references is orphaned (its session was deleted, or it
  // was left pending by a crash). Surface it so it stays previewable/downloadable rather than lost.
  const orphanedFiles: ProjectArtifactFileNode[] = []
  const seenOrphanPaths = new Set<string>()

  for (const file of diskArtifacts) {
    if (referencedPaths.has(file.path) || seenOrphanPaths.has(file.path)) continue
    seenOrphanPaths.add(file.path)

    const artifact = toMessageArtifact(file)
    orphanedFiles.push({
      id: artifact.id,
      name: getArtifactName(artifact),
      size: artifact.size,
      artifact
    })
  }

  if (orphanedFiles.length > 0) {
    orphanedFiles.sort((left, right) => (right.artifact.mtimeMs ?? 0) - (left.artifact.mtimeMs ?? 0))
    artifactGroups.push({
      sessionId: ORPHANED_ARTIFACTS_GROUP_ID,
      title: 'Orphaned',
      files: orphanedFiles
    })
  }

  uploadFiles.sort((left, right) => right.timestamp - left.timestamp)

  return {
    uploadFiles,
    artifactGroups
  }
}
