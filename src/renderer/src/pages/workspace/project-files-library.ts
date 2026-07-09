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

// Derives the project file library from persisted session metadata without reading the file system.
export const buildProjectFileLibrary = (sessions: ChatSession[]): ProjectFileLibrary => {
  const uploadFiles: ProjectUploadFileNode[] = []
  const artifactGroups: ProjectArtifactGroup[] = []

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

    const files =
      session.artifacts
        ?.filter((artifact) => artifact.kind === 'managed-file' && Boolean(artifact.path))
        .map((artifact) => ({
          id: artifact.id,
          name: getArtifactName(artifact),
          size: artifact.size,
          artifact
        })) ?? []

    if (files.length > 0) {
      artifactGroups.push({
        sessionId: session.id,
        title: session.title,
        files
      })
    }
  }

  uploadFiles.sort((left, right) => right.timestamp - left.timestamp)

  return {
    uploadFiles,
    artifactGroups
  }
}
