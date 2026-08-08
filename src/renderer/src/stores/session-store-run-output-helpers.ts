import type { ArtifactFile } from '../../../shared/artifacts'
import {
  MAX_ACP_SESSION_IMAGE_BYTES,
  normalizeClaudeCodeRefusalText,
  sanitizeAcpMessageImage,
  type AcpMessageImage,
  type AcpTurnTokenUsage
} from '../../../shared/acp'
import {
  sanitizeMessageImages,
  type PersistedArtifact,
  type PersistedUploadedAttachment
} from '../../../shared/session-persistence'
import {
  createPersistedUpload,
  synchronizeSessionGraph
} from './session-store-message-graph-helpers'
import type { AppendMessageResult } from './session-store-message-graph-helpers'
import { createMessageId, createSortIndex } from './session-store-message-graph-owner'
import type { ChatMessage, ChatSession } from './session-store-persistence-owner'

export type AppendAgentMessageChunkInput = {
  sessionId: string
  streamId: string
  eventId: string
  promptMessageId?: string
  content?: string
  image?: AcpMessageImage
}

export type AttachRunArtifactsInput = {
  sessionId: string
  runId: string
  promptMessageId?: string
  eventId: string
  artifacts: ArtifactFile[]
  turnUsage?: AcpTurnTokenUsage
  turnUsageUnavailable?: true
}

export type ReplaceMessageArtifactsInput = {
  sessionId: string
  messageId: string
  artifacts: ArtifactFile[]
}

export type ReplaceMessageUploadsInput = {
  sessionId: string
  messageId: string
  uploads: PersistedUploadedAttachment[]
}

type SessionProjectionResult = {
  session: ChatSession
  result?: AppendMessageResult
  shouldCommit?: boolean
}

const createPersistedArtifact = (artifact: ArtifactFile): PersistedArtifact => {
  const persisted: PersistedArtifact = {
    id: artifact.id,
    kind: 'managed-file',
    path: artifact.path,
    fileUrl: artifact.fileUrl,
    name: artifact.name,
    mimeType: artifact.mimeType,
    size: artifact.size,
    mtimeMs: artifact.mtimeMs
  }
  if (artifact.artifactId) persisted.artifactId = artifact.artifactId
  if (artifact.versionId) persisted.versionId = artifact.versionId
  if (artifact.versionNumber !== undefined) persisted.versionNumber = artifact.versionNumber
  if (artifact.checksum) persisted.sha256 = artifact.checksum
  return persisted
}

const arePersistedUploadsEqual = (
  left: PersistedUploadedAttachment[] | undefined,
  right: PersistedUploadedAttachment[]
): boolean => {
  const current = left ?? []
  return (
    current.length === right.length &&
    current.every((item, index) => {
      const next = right[index]
      return (
        item.id === next.id &&
        item.sessionId === next.sessionId &&
        item.name === next.name &&
        item.originalName === next.originalName &&
        item.path === next.path &&
        item.mimeType === next.mimeType &&
        item.size === next.size
      )
    })
  )
}

const arePersistedArtifactsEqual = (
  left: PersistedArtifact[] | undefined,
  right: PersistedArtifact[]
): boolean => {
  const current = left ?? []
  return (
    current.length === right.length &&
    current.every((item, index) => {
      const next = right[index]
      return (
        item.id === next.id &&
        item.kind === next.kind &&
        item.path === next.path &&
        item.fileUrl === next.fileUrl &&
        item.name === next.name &&
        item.mimeType === next.mimeType &&
        item.size === next.size &&
        item.mtimeMs === next.mtimeMs &&
        item.sha256 === next.sha256
      )
    })
  )
}

const areStringArraysEqual = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index])

const upsertArtifacts = (
  existingArtifacts: PersistedArtifact[] | undefined,
  incomingArtifacts: PersistedArtifact[]
): PersistedArtifact[] => {
  const artifactsById = new Map<string, PersistedArtifact>()
  for (const artifact of existingArtifacts ?? []) artifactsById.set(artifact.id, artifact)
  for (const artifact of incomingArtifacts) artifactsById.set(artifact.id, artifact)
  return Array.from(artifactsById.values())
}

const appendUniqueStrings = (
  existingItems: string[] | undefined,
  incomingItems: string[]
): string[] => Array.from(new Set([...(existingItems ?? []), ...incomingItems]))

export const projectAgentMessageChunk = (
  session: ChatSession,
  input: AppendAgentMessageChunkInput
): SessionProjectionResult => {
  let sanitizedImage = sanitizeAcpMessageImage(input.image)
  const content = input.content ?? ''
  if (!input.streamId || !input.eventId || (content.length === 0 && !sanitizedImage)) {
    return { session }
  }
  const responseToMessageId = input.promptMessageId ?? session.activeRun?.promptMessageId
  const replayedGraphMessage = session.conversationGraph?.messages.find(
    (message) =>
      message.role === 'agent' &&
      message.responseToMessageId === responseToMessageId &&
      message.eventIds.includes(input.eventId)
  )
  if (replayedGraphMessage) {
    return { session, result: { sessionId: input.sessionId, messageId: replayedGraphMessage.id } }
  }

  const sessionImageBytes = session.messages.reduce(
    (total, message) =>
      total + (message.images ?? []).reduce((sum, candidate) => sum + candidate.byteLength, 0),
    0
  )
  if (
    sanitizedImage &&
    sessionImageBytes + sanitizedImage.byteLength > MAX_ACP_SESSION_IMAGE_BYTES
  ) {
    sanitizedImage = undefined
    if (content.length === 0) return { session }
  }

  const hasVisibleOutput = content.trim().length > 0 || Boolean(sanitizedImage)
  const existingMessage = session.messages.find(
    (message) => message.role === 'agent' && message.streamId === input.streamId
  )
  const mergedContent = (current = ''): string => {
    const text = `${current}${content}`
    return session.agentFrameworkId === 'claude-code' ? normalizeClaudeCodeRefusalText(text) : text
  }
  const messageId = existingMessage?.id ?? createMessageId()
  const result = { sessionId: input.sessionId, messageId }
  const now = Date.now()

  if (existingMessage) {
    if (existingMessage.eventIds.includes(input.eventId)) {
      return { session, result, shouldCommit: true }
    }
    return {
      result,
      shouldCommit: true,
      session: {
        ...session,
        status:
          session.status === 'waiting-for-user' || session.status === 'waiting-permission'
            ? session.status
            : 'running',
        awaitingFirstAgentOutput: hasVisibleOutput ? undefined : session.awaitingFirstAgentOutput,
        messages: session.messages.map((message) =>
          message.id === existingMessage.id
            ? {
                ...message,
                content: mergedContent(message.content),
                images: sanitizedImage
                  ? sanitizeMessageImages([
                      ...(message.images ?? []),
                      { id: input.eventId, ...sanitizedImage }
                    ])
                  : message.images,
                eventIds: [...message.eventIds, input.eventId],
                updatedAt: now
              }
            : message
        ),
        updatedAt: now
      }
    }
  }

  const agentMessage: ChatMessage = {
    id: messageId,
    role: 'agent',
    content: mergedContent(),
    status: 'streaming',
    streamId: input.streamId,
    responseToMessageId,
    eventIds: [input.eventId],
    images: sanitizedImage ? [{ id: input.eventId, ...sanitizedImage }] : undefined,
    sortIndex: createSortIndex(),
    createdAt: now,
    updatedAt: now
  }
  return {
    result,
    shouldCommit: true,
    session: {
      ...session,
      status:
        session.status === 'waiting-for-user' || session.status === 'waiting-permission'
          ? session.status
          : 'running',
      awaitingFirstAgentOutput: hasVisibleOutput ? undefined : session.awaitingFirstAgentOutput,
      messages: [...session.messages, agentMessage],
      updatedAt: now
    }
  }
}

export const projectRunArtifacts = (
  session: ChatSession,
  input: AttachRunArtifactsInput
): SessionProjectionResult => {
  const now = Date.now()
  const incomingArtifacts = input.artifacts.map(createPersistedArtifact)
  const incomingArtifactIds = incomingArtifacts.map((artifact) => artifact.id)
  const ownsArtifactPrompt = (message: ChatMessage): boolean =>
    !input.promptMessageId || message.responseToMessageId === input.promptMessageId
  const alreadyAppliedMessage = session.messages.find(
    (message) => message.eventIds.includes(input.eventId) && ownsArtifactPrompt(message)
  )
  if (alreadyAppliedMessage) {
    return {
      session,
      result: { sessionId: input.sessionId, messageId: alreadyAppliedMessage.id }
    }
  }
  const alreadyAppliedGraphMessage = session.conversationGraph?.messages.find(
    (message) => message.eventIds.includes(input.eventId) && ownsArtifactPrompt(message)
  )
  if (alreadyAppliedGraphMessage) {
    return {
      session,
      result: { sessionId: input.sessionId, messageId: alreadyAppliedGraphMessage.id }
    }
  }

  const responseToMessageId = input.promptMessageId ?? session.activeRun?.promptMessageId
  const agentMessages = [...session.messages]
    .reverse()
    .filter((message) => message.role === 'agent')
  const existingMessage =
    (responseToMessageId
      ? agentMessages.find((message) => message.responseToMessageId === responseToMessageId)
      : undefined) ?? agentMessages.find((message) => message.streamId === input.runId)
  const promptIsActive = input.promptMessageId
    ? session.messages.some((message) => message.id === input.promptMessageId)
    : false

  if (!existingMessage && input.promptMessageId && !promptIsActive && session.conversationGraph) {
    const graphResponses = session.conversationGraph.messages.filter(
      (message) => message.role === 'agent' && message.responseToMessageId === input.promptMessageId
    )
    if (graphResponses.length === 1) {
      const graphResponse = graphResponses[0]
      const conversationGraph = {
        ...session.conversationGraph,
        messages: session.conversationGraph.messages.map((message) =>
          message.id === graphResponse.id
            ? {
                ...message,
                eventIds: appendUniqueStrings(message.eventIds, [input.eventId]),
                artifactIds: appendUniqueStrings(message.artifactIds, incomingArtifactIds),
                updatedAt: now
              }
            : message
        ),
        updatedAt: now
      }
      return {
        result: { sessionId: input.sessionId, messageId: graphResponse.id },
        session: {
          ...session,
          artifacts: upsertArtifacts(session.artifacts, incomingArtifacts),
          conversationGraph,
          updatedAt: now
        }
      }
    }
    return { session }
  }

  const messageId = existingMessage?.id ?? createMessageId()
  const result = { sessionId: input.sessionId, messageId }
  if (existingMessage) {
    const messages = session.messages.map((message) =>
      message.id === existingMessage.id
        ? {
            ...message,
            eventIds: appendUniqueStrings(message.eventIds, [input.eventId]),
            artifactIds: appendUniqueStrings(message.artifactIds, incomingArtifactIds),
            ...(input.turnUsage
              ? { turnUsage: input.turnUsage, turnUsageUnavailable: undefined }
              : input.turnUsageUnavailable
                ? { turnUsage: undefined, turnUsageUnavailable: true as const }
                : {}),
            updatedAt: now
          }
        : message
    )
    return {
      result,
      session: {
        ...session,
        artifacts: upsertArtifacts(session.artifacts, incomingArtifacts),
        messages,
        conversationGraph: synchronizeSessionGraph(session, messages, now),
        updatedAt: now
      }
    }
  }

  const artifactMessage: ChatMessage = {
    id: messageId,
    role: 'agent',
    content: '',
    status: session.activeRun ? 'streaming' : 'complete',
    streamId: input.runId,
    responseToMessageId,
    eventIds: [input.eventId],
    artifactIds: incomingArtifactIds,
    ...(input.turnUsage
      ? { turnUsage: input.turnUsage }
      : input.turnUsageUnavailable
        ? { turnUsageUnavailable: true as const }
        : {}),
    sortIndex: createSortIndex(),
    createdAt: now,
    ...(session.activeRun ? {} : { completedAt: now }),
    updatedAt: now
  }
  const messages = [...session.messages, artifactMessage]
  return {
    result,
    session: {
      ...session,
      artifacts: upsertArtifacts(session.artifacts, incomingArtifacts),
      messages,
      conversationGraph: synchronizeSessionGraph(session, messages, now),
      updatedAt: now
    }
  }
}

export const projectMessageArtifacts = (
  session: ChatSession,
  input: ReplaceMessageArtifactsInput
): ChatSession => {
  const incomingArtifacts = input.artifacts.map(createPersistedArtifact)
  const incomingArtifactIds = incomingArtifacts.map((artifact) => artifact.id)
  const message = session.messages.find((item) => item.id === input.messageId)
  const graphMessage = session.conversationGraph?.messages.find(
    (item) => item.id === input.messageId
  )

  if (!message) {
    if (!graphMessage || !session.conversationGraph) return session
    const replacedArtifactIds = new Set(graphMessage.artifactIds ?? [])
    const preservedArtifacts = (session.artifacts ?? []).filter(
      (artifact) => !replacedArtifactIds.has(artifact.id)
    )
    const now = Date.now()
    const conversationGraph = {
      ...session.conversationGraph,
      messages: session.conversationGraph.messages.map((item) =>
        item.id === input.messageId
          ? { ...item, artifactIds: incomingArtifactIds, updatedAt: now }
          : item
      ),
      updatedAt: now
    }
    return {
      ...session,
      artifacts: upsertArtifacts(preservedArtifacts, incomingArtifacts),
      conversationGraph,
      updatedAt: now
    }
  }

  const replacedArtifactIds = new Set(message.artifactIds ?? [])
  const preservedArtifacts = (session.artifacts ?? []).filter(
    (artifact) => !replacedArtifactIds.has(artifact.id)
  )
  const nextArtifacts = upsertArtifacts(preservedArtifacts, incomingArtifacts)
  if (
    arePersistedArtifactsEqual(session.artifacts, nextArtifacts) &&
    areStringArraysEqual(message.artifactIds ?? [], incomingArtifactIds) &&
    areStringArraysEqual(graphMessage?.artifactIds ?? [], incomingArtifactIds)
  ) {
    return session
  }

  const now = Date.now()
  const messages = session.messages.map((item) =>
    item.id === input.messageId
      ? { ...item, artifactIds: incomingArtifactIds, updatedAt: now }
      : item
  )
  const synchronizedGraph = synchronizeSessionGraph(session, messages, now)
  return {
    ...session,
    artifacts: nextArtifacts,
    messages,
    conversationGraph: {
      ...synchronizedGraph,
      messages: synchronizedGraph.messages.map((item) =>
        item.id === input.messageId
          ? { ...item, artifactIds: incomingArtifactIds, updatedAt: now }
          : item
      )
    },
    filesRevision: (session.filesRevision ?? 0) + 1,
    updatedAt: now
  }
}

export const projectMessageUploads = (
  session: ChatSession,
  input: ReplaceMessageUploadsInput
): ChatSession => {
  const incomingUploads = input.uploads.map(createPersistedUpload)
  const targetMessage = session.messages.find((message) => message.id === input.messageId)
  if (!targetMessage || arePersistedUploadsEqual(targetMessage.uploads, incomingUploads))
    return session

  const now = Date.now()
  const messages = session.messages.map((message) =>
    message.id === input.messageId
      ? { ...message, uploads: incomingUploads, updatedAt: now }
      : message
  )
  const synchronizedGraph = synchronizeSessionGraph(session, messages, now)
  return {
    ...session,
    messages,
    conversationGraph: {
      ...synchronizedGraph,
      messages: synchronizedGraph.messages.map((message) =>
        message.id === input.messageId
          ? { ...message, uploads: incomingUploads, updatedAt: now }
          : message
      )
    },
    filesRevision: (session.filesRevision ?? 0) + 1,
    updatedAt: now
  }
}
