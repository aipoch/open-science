import { artifactCreatedAtMs, type ArtifactFile } from '../../../shared/artifacts'
import {
  MAX_ACP_SESSION_IMAGE_BYTES,
  normalizeClaudeCodeRefusalText,
  sanitizeAcpMessageImage,
  type AcpMessageImage,
  type AcpModelCallUsage,
  type AcpTurnTokenUsage
} from '../../../shared/acp'
import {
  sanitizeMessageImages,
  type MessagePdfContextSnapshot,
  type PersistedUploadedAttachment
} from '../../../shared/session-persistence'
import {
  createPersistedUpload,
  synchronizeSessionGraph
} from './session-store-message-graph-helpers'
import type { AppendMessageResult } from './session-store-message-graph-helpers'
import { createSortIndex } from './session-store-message-graph-owner'
import type {
  ChatArtifact,
  ChatMessage,
  ChatSession,
  StreamingMessageContentByMessageId
} from './session-store-persistence-owner'

// A Session can be projected by more than one renderer. Derive Agent identity from runtime-owned
// stream identity so both projections choose the same Artifact owner instead of local sequence ids.
const createRuntimeAgentMessageId = (
  sessionId: string,
  streamId: string,
  responseToMessageId?: string
): string => {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(
    `${sessionId}\0${responseToMessageId ?? ''}\0${streamId}`
  )) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `message-stream-${hash.toString(16).padStart(16, '0')}`
}

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
  modelCallUsage?: readonly AcpModelCallUsage[]
}

export type ReplaceMessageArtifactsInput = {
  sessionId: string
  messageId: string
  artifacts: ArtifactFile[]
  preserveArtifactIds?: string[]
}

export type ReplaceMessageUploadsInput = {
  sessionId: string
  messageId: string
  uploads: PersistedUploadedAttachment[]
}

export type ReplaceMessagePdfContextInput = {
  sessionId: string
  messageId: string
  pdfContext: MessagePdfContextSnapshot
}

type SessionProjectionResult = {
  session: ChatSession
  result?: AppendMessageResult
  shouldCommit?: boolean
}

type SessionBatchProjectionResult = {
  session: ChatSession
  results: Array<AppendMessageResult | undefined>
  shouldCommit: boolean
  streamingMessages: StreamingMessageContentByMessageId
}

const createChatArtifact = (artifact: ArtifactFile, fallbackCreatedAt?: number): ChatArtifact => {
  const createdAt =
    artifactCreatedAtMs(artifact.createdAt) ??
    (fallbackCreatedAt !== undefined && Number.isFinite(fallbackCreatedAt) && fallbackCreatedAt >= 0
      ? fallbackCreatedAt
      : undefined)
  const persisted: ChatArtifact = {
    id: artifact.id,
    ...(artifact.isPublished === undefined ? {} : { isPublished: artifact.isPublished }),
    kind: 'managed-file',
    path: artifact.path,
    fileUrl: artifact.fileUrl,
    name: artifact.name,
    mimeType: artifact.mimeType,
    size: artifact.size,
    ...(createdAt === undefined ? {} : { createdAt }),
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

const areChatArtifactsEqual = (
  left: ChatArtifact[] | undefined,
  right: ChatArtifact[]
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
        item.createdAt === next.createdAt &&
        item.mtimeMs === next.mtimeMs &&
        item.sha256 === next.sha256 &&
        item.isPublished === next.isPublished
      )
    })
  )
}

const areStringArraysEqual = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index])

const upsertArtifacts = (
  existingArtifacts: ChatArtifact[] | undefined,
  incomingArtifacts: ChatArtifact[]
): ChatArtifact[] => {
  const artifactsById = new Map<string, ChatArtifact>()
  for (const artifact of existingArtifacts ?? []) artifactsById.set(artifact.id, artifact)
  for (const artifact of incomingArtifacts) artifactsById.set(artifact.id, artifact)
  return Array.from(artifactsById.values())
}

const appendUniqueStrings = (
  existingItems: string[] | undefined,
  incomingItems: string[]
): string[] => Array.from(new Set([...(existingItems ?? []), ...incomingItems]))

// A presentation tick can contain several deltas for one stream. Index durable replay and current
// messages once, then advance the batch locally so long Session history is not rescanned per delta.
//
// Pure text growth for an already-projected Message is committed to the streaming slice (keyed by
// Message id) instead of the Message object, so per-tick appends keep the Session object and the
// messages array referentially stable; only the streaming Message's own store subscriber re-renders.
// Message creation, image deltas, and one-time run metadata (first visible output, running status)
// still change Session identity, as does turn-end materialization.
export const projectAgentMessageChunks = (
  session: ChatSession,
  inputs: AppendAgentMessageChunkInput[],
  streamingMessages: StreamingMessageContentByMessageId
): SessionBatchProjectionResult => {
  const preparedInputs = inputs.map((input) => ({
    input,
    content: input.content ?? '',
    image: sanitizeAcpMessageImage(input.image)
  }))
  const streamIds = new Set(
    preparedInputs.flatMap(({ input, content, image }) =>
      input.streamId && input.eventId && (content.length > 0 || image) ? [input.streamId] : []
    )
  )
  const incomingEventIds = new Set(
    preparedInputs.flatMap(({ input, content, image }) =>
      input.streamId && input.eventId && (content.length > 0 || image) ? [input.eventId] : []
    )
  )
  if (streamIds.size === 0) {
    return {
      session,
      results: inputs.map(() => undefined),
      shouldCommit: false,
      streamingMessages
    }
  }
  const replayedGraphMessages = new Map<string, ChatMessage[]>()
  const graphMessagesById = new Map<string, ChatMessage>()
  for (const message of session.conversationGraph?.messages ?? []) {
    graphMessagesById.set(message.id, message)
    if (message.role !== 'agent') continue
    for (const eventId of message.eventIds) {
      if (!incomingEventIds.has(eventId)) continue
      const matches = replayedGraphMessages.get(eventId)
      if (matches) matches.push(message)
      else replayedGraphMessages.set(eventId, [message])
    }
  }

  const hasIncomingImage = preparedInputs.some(({ input, content, image }) =>
    Boolean(input.streamId && input.eventId && (content.length > 0 || image) && image)
  )
  let sessionImageBytes = 0
  const messageByStreamId = new Map<string, { index: number; message: ChatMessage }>()
  for (let index = 0; index < session.messages.length; index += 1) {
    const message = session.messages[index]
    if (hasIncomingImage) {
      sessionImageBytes += (message.images ?? []).reduce(
        (total, image) => total + image.byteLength,
        0
      )
    }
    if (
      message.role === 'agent' &&
      message.streamId &&
      streamIds.has(message.streamId) &&
      !messageByStreamId.has(message.streamId)
    ) {
      messageByStreamId.set(message.streamId, { index, message })
    }
  }

  const results: Array<AppendMessageResult | undefined> = []
  let messages = session.messages
  let changed = false
  let shouldCommit = false
  let streaming = streamingMessages
  let awaitingFirstAgentOutput = session.awaitingFirstAgentOutput
  let status = session.status
  let updatedAt = session.updatedAt
  const setStreamingEntry = (
    messageId: string,
    content: string,
    eventIds: string[],
    now: number
  ): void => {
    if (streaming === streamingMessages) streaming = { ...streamingMessages }
    streaming[messageId] = { sessionId: session.id, content, eventIds, updatedAt: now }
  }
  const clearStreamingEntry = (messageId: string): void => {
    if (!streaming[messageId]) return
    if (streaming === streamingMessages) streaming = { ...streamingMessages }
    delete streaming[messageId]
  }

  for (const prepared of preparedInputs) {
    const { input, content } = prepared
    let sanitizedImage = prepared.image
    if (!input.streamId || !input.eventId || (content.length === 0 && !sanitizedImage)) {
      results.push(undefined)
      continue
    }
    const responseToMessageId = input.promptMessageId ?? session.activeRun?.promptMessageId
    const replayedGraphMessage = replayedGraphMessages
      .get(input.eventId)
      ?.find((message) => message.responseToMessageId === responseToMessageId)
    if (replayedGraphMessage) {
      results.push({ sessionId: input.sessionId, messageId: replayedGraphMessage.id })
      continue
    }

    if (
      sanitizedImage &&
      sessionImageBytes + sanitizedImage.byteLength > MAX_ACP_SESSION_IMAGE_BYTES
    ) {
      sanitizedImage = undefined
      if (content.length === 0) {
        results.push(undefined)
        continue
      }
    }

    const existing = messageByStreamId.get(input.streamId)
    const messageId =
      existing?.message.id ??
      createRuntimeAgentMessageId(input.sessionId, input.streamId, responseToMessageId)
    const result = { sessionId: input.sessionId, messageId }
    results.push(result)

    // In-flight event ids live in the streaming slice once text growth moved there; consult both.
    const streamingEntry = streaming[messageId]
    const appliedEventIds = streamingEntry?.eventIds ?? existing?.message.eventIds
    if (appliedEventIds?.includes(input.eventId)) {
      shouldCommit = true
      continue
    }

    const hasVisibleOutput = content.trim().length > 0 || Boolean(sanitizedImage)
    const now = Math.max(
      Date.now(),
      (existing?.message.updatedAt ?? -1) + 1,
      (graphMessagesById.get(messageId)?.updatedAt ?? -1) + 1
    )
    const mergeContent = (current = ''): string => {
      const text = `${current}${content}`
      return session.agentFrameworkId === 'claude-code'
        ? normalizeClaudeCodeRefusalText(text)
        : text
    }

    if (existing && !sanitizedImage) {
      // Pure text growth: append into the streaming slice and leave Session identity untouched.
      setStreamingEntry(
        messageId,
        mergeContent(streamingEntry?.content ?? existing.message.content),
        [...(streamingEntry?.eventIds ?? existing.message.eventIds), input.eventId],
        now
      )
      if (hasVisibleOutput) awaitingFirstAgentOutput = undefined
      if (status !== 'waiting-for-user' && status !== 'waiting-permission') status = 'running'
      shouldCommit = true
      continue
    }

    // Message creation or an image delta commits to the Message object; any in-flight slice entry
    // is folded back in so the Message owns the full text again.
    const baseEventIds = streamingEntry?.eventIds ?? existing?.message.eventIds ?? []
    const nextMessage: ChatMessage = existing
      ? {
          ...existing.message,
          content: mergeContent(streamingEntry?.content ?? existing.message.content),
          images: sanitizedImage
            ? sanitizeMessageImages([
                ...(existing.message.images ?? []),
                { id: input.eventId, ...sanitizedImage }
              ])
            : existing.message.images,
          eventIds: [...baseEventIds, input.eventId],
          updatedAt: now
        }
      : {
          id: messageId,
          role: 'agent',
          content: mergeContent(streamingEntry?.content ?? ''),
          status: 'streaming',
          streamId: input.streamId,
          responseToMessageId,
          eventIds: [...baseEventIds, input.eventId],
          images: sanitizedImage ? [{ id: input.eventId, ...sanitizedImage }] : undefined,
          sortIndex: createSortIndex(),
          createdAt: now,
          updatedAt: now
        }
    clearStreamingEntry(messageId)

    if (!changed) messages = session.messages.slice()
    if (existing) messages[existing.index] = nextMessage
    else messages.push(nextMessage)
    messageByStreamId.set(input.streamId, {
      index: existing?.index ?? messages.length - 1,
      message: nextMessage
    })
    if (sanitizedImage) {
      const previousImageBytes = (existing?.message.images ?? []).reduce(
        (total, image) => total + image.byteLength,
        0
      )
      const nextImageBytes = (nextMessage.images ?? []).reduce(
        (total, image) => total + image.byteLength,
        0
      )
      sessionImageBytes += nextImageBytes - previousImageBytes
    }
    if (hasVisibleOutput) awaitingFirstAgentOutput = undefined
    updatedAt = now
    changed = true
    shouldCommit = true
  }

  if (status !== 'waiting-for-user' && status !== 'waiting-permission' && changed) {
    status = 'running'
  }
  const sessionChanged =
    changed ||
    awaitingFirstAgentOutput !== session.awaitingFirstAgentOutput ||
    status !== session.status

  return {
    results,
    shouldCommit,
    streamingMessages: streaming,
    session: sessionChanged
      ? {
          ...session,
          status,
          awaitingFirstAgentOutput,
          ...(changed ? { messages } : {}),
          updatedAt: changed ? updatedAt : Date.now()
        }
      : session
  }
}

export const projectRunArtifacts = (
  session: ChatSession,
  input: AttachRunArtifactsInput
): SessionProjectionResult => {
  const now = Date.now()
  const incomingArtifacts = input.artifacts.map((artifact) => createChatArtifact(artifact, now))
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

  const messageId =
    existingMessage?.id ??
    createRuntimeAgentMessageId(input.sessionId, input.runId, responseToMessageId)
  const result = { sessionId: input.sessionId, messageId }
  if (existingMessage) {
    const messages = session.messages.map((message) =>
      message.id === existingMessage.id
        ? {
            ...message,
            eventIds: appendUniqueStrings(message.eventIds, [input.eventId]),
            artifactIds: appendUniqueStrings(message.artifactIds, incomingArtifactIds),
            ...(input.turnUsage
              ? {
                  turnUsage: input.turnUsage,
                  turnUsageUnavailable: undefined,
                  modelCallUsage: input.modelCallUsage?.map((call) => ({ ...call }))
                }
              : input.turnUsageUnavailable
                ? {
                    turnUsage: undefined,
                    turnUsageUnavailable: true as const,
                    modelCallUsage: undefined
                  }
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
      ? {
          turnUsage: input.turnUsage,
          modelCallUsage: input.modelCallUsage?.map((call) => ({ ...call }))
        }
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
  const message = session.messages.find((item) => item.id === input.messageId)
  const graphMessage = session.conversationGraph?.messages.find(
    (item) => item.id === input.messageId
  )
  const artifactOwner = message ?? graphMessage
  const ownerTimestamp = artifactOwner?.completedAt ?? artifactOwner?.createdAt
  const incomingArtifacts = input.artifacts.map((artifact) =>
    createChatArtifact(artifact, ownerTimestamp)
  )
  const preservedArtifactIds = (artifactOwner?.artifactIds ?? []).filter((artifactId) =>
    input.preserveArtifactIds?.includes(artifactId)
  )
  const incomingArtifactIds = appendUniqueStrings(
    preservedArtifactIds,
    incomingArtifacts.map((artifact) => artifact.id)
  )

  if (!message) {
    if (!graphMessage || !session.conversationGraph) return session
    const replacedArtifactIds = new Set(
      (graphMessage.artifactIds ?? []).filter(
        (artifactId) => !preservedArtifactIds.includes(artifactId)
      )
    )
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

  const replacedArtifactIds = new Set(
    (message.artifactIds ?? []).filter((artifactId) => !preservedArtifactIds.includes(artifactId))
  )
  const preservedArtifacts = (session.artifacts ?? []).filter(
    (artifact) => !replacedArtifactIds.has(artifact.id)
  )
  const nextArtifacts = upsertArtifacts(preservedArtifacts, incomingArtifacts)
  if (
    areChatArtifactsEqual(session.artifacts, nextArtifacts) &&
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

export const projectMessagePdfContext = (
  session: ChatSession,
  input: ReplaceMessagePdfContextInput
): ChatSession => {
  const targetMessage = session.messages.find((message) => message.id === input.messageId)
  if (
    !targetMessage ||
    JSON.stringify(targetMessage.pdfContext) === JSON.stringify(input.pdfContext)
  ) {
    return session
  }

  const now = Date.now()
  const messages = session.messages.map((message) =>
    message.id === input.messageId
      ? { ...message, pdfContext: input.pdfContext, updatedAt: now }
      : message
  )
  return {
    ...session,
    messages,
    conversationGraph: synchronizeSessionGraph(session, messages, now),
    updatedAt: now
  }
}
