import { pathToFileURL } from 'node:url'

import type {
  PersistedArtifact,
  PersistedChatMessage,
  PersistedChatSession
} from '../../shared/session-persistence'
import { decodeDataPath, encodeDataPath } from '../storage/data-path'

// Replaces a data-root absolute path with a $DATA sentinel and drops the derived fileUrl.
const encodeArtifact = (
  artifact: PersistedArtifact,
  dataRoot: string | undefined
): PersistedArtifact => {
  const encoded: PersistedArtifact = {
    ...artifact,
    path: encodeDataPath(artifact.path, dataRoot) as string
  }
  delete encoded.fileUrl
  return encoded
}

// Resolves a $DATA sentinel back to an absolute path and recomputes fileUrl from it.
const decodeArtifact = (
  artifact: PersistedArtifact,
  dataRoot: string | undefined
): PersistedArtifact => {
  const path = decodeDataPath(artifact.path, dataRoot) as string
  return { ...artifact, path, fileUrl: pathToFileURL(path).href }
}

const transformMessageUploadPaths = <Message extends PersistedChatMessage>(
  messages: readonly Message[],
  transformPath: (path: string) => string
): Message[] =>
  messages.map((message) => ({
    ...message,
    uploads: message.uploads?.map((upload) =>
      upload.path ? { ...upload, path: transformPath(upload.path) } : upload
    )
  }))

// Encodes/decodes a session's persisted paths (cwd, upload paths, artifact paths) without touching
// any other field. Pure and immutable: always returns a new session object.
export const encodeSessionDataPaths = (
  session: PersistedChatSession,
  dataRoot?: string
): PersistedChatSession => {
  const encodeUploadPath = (path: string): string => encodeDataPath(path, dataRoot) as string
  return {
    ...session,
    cwd: encodeDataPath(session.cwd, dataRoot) as string,
    messages: transformMessageUploadPaths(session.messages, encodeUploadPath),
    ...(session.conversationGraph
      ? {
          conversationGraph: {
            ...session.conversationGraph,
            messages: transformMessageUploadPaths(
              session.conversationGraph.messages,
              encodeUploadPath
            )
          }
        }
      : {}),
    artifacts: session.artifacts?.map((artifact) => encodeArtifact(artifact, dataRoot))
  }
}

export const decodeSessionDataPaths = (
  session: PersistedChatSession,
  dataRoot?: string
): PersistedChatSession => {
  const decodeUploadPath = (path: string): string => decodeDataPath(path, dataRoot) as string
  return {
    ...session,
    cwd: decodeDataPath(session.cwd, dataRoot) as string,
    messages: transformMessageUploadPaths(session.messages, decodeUploadPath),
    ...(session.conversationGraph
      ? {
          conversationGraph: {
            ...session.conversationGraph,
            messages: transformMessageUploadPaths(
              session.conversationGraph.messages,
              decodeUploadPath
            )
          }
        }
      : {}),
    artifacts: session.artifacts?.map((artifact) => decodeArtifact(artifact, dataRoot))
  }
}
