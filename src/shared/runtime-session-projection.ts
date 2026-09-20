import {
  ACP_CONTEXT_COMPACTION_ACTIVITY_TOOL_NAME,
  getAcpRuntimeEventImage,
  getAcpRuntimeEventText,
  MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE,
  MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE,
  MAX_ACP_SESSION_IMAGE_BYTES,
  normalizeClaudeCodeRefusalText,
  sanitizeAcpContextWindowSample,
  type AcpRuntimeEvent
} from './acp'
import { getActivityGroupTitleFromToolEvent, isActivityGroupToolEvent } from './activity-groups'
import { artifactCreatedAtMs, type ArtifactFile } from './artifacts'
import {
  projectConversationMessage,
  resolveActiveConversationActivities,
  resolveActiveConversationMessages,
  resolveMessageBranchPath,
  validateConversationGraph,
  type PersistedBranchActivityGroup,
  type PersistedAgentFrame,
  type PersistedConversationGraph,
  type PersistedMessageBranch,
  type PersistedMessageNode
} from './conversation-graph'
import {
  INTERRUPTED_TURN_ERROR,
  retainRecentSessionEventIds,
  type PersistedArtifact,
  type PersistedChatSession,
  type PersistedToolActivityStatus
} from './session-persistence'
import { isClaudeApiResponseInterruption } from './run-error-classification'
import { createRuntimeAgentMessageId } from './runtime-message-identity'

export type RuntimeSessionScope = {
  promptMessageId: string
  agentFrameId: string
  messageBranchId: string
  runtimeSegmentId: string
}

const scopedPath = (
  session: PersistedChatSession,
  scope: RuntimeSessionScope
): {
  graph: PersistedConversationGraph
  frame: PersistedAgentFrame
  branch: PersistedMessageBranch
  path: PersistedMessageNode[]
} => {
  const graph = session.conversationGraph
  if (!graph) throw new Error('Runtime Session projection requires a conversation graph.')
  const frame = graph.frames.find(({ id }) => id === scope.agentFrameId)
  const branch = graph.branches.find(({ id }) => id === scope.messageBranchId)
  const segment = graph.runtimeSegments.find(({ id }) => id === scope.runtimeSegmentId)
  if (!frame || !branch || branch.agentFrameId !== frame.id) {
    throw new Error('Runtime Session scope does not identify one Message Branch.')
  }
  if (!segment || segment.agentFrameId !== frame.id) {
    throw new Error('Runtime Session scope does not identify a Runtime Segment.')
  }
  const path = resolveMessageBranchPath(graph, branch.id)
  if (!path.some(({ id, role }) => id === scope.promptMessageId && role === 'user')) {
    throw new Error('Runtime Session prompt is not on the supplied Message Branch.')
  }
  return { graph, frame, branch, path }
}

const appendUnique = (
  current: readonly string[] | undefined,
  values: readonly string[]
): string[] => [...new Set([...(current ?? []), ...values])]

const isTerminal = (status: PersistedToolActivityStatus): boolean =>
  status === 'completed' || status === 'failed'

const toolStatus = (value: string | undefined): PersistedToolActivityStatus | undefined =>
  value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'failed'
    ? value
    : undefined

const persistedArtifact = (
  artifact: ArtifactFile,
  fallbackCreatedAt: number
): PersistedArtifact => {
  const createdAt = artifactCreatedAtMs(artifact.createdAt) ?? fallbackCreatedAt
  return {
    id: artifact.id,
    kind: 'managed-file',
    path: artifact.path,
    fileUrl: artifact.fileUrl,
    name: artifact.name,
    mimeType: artifact.mimeType,
    size: artifact.size,
    createdAt,
    mtimeMs: artifact.mtimeMs,
    ...(artifact.artifactId ? { artifactId: artifact.artifactId } : {}),
    ...(artifact.versionId ? { versionId: artifact.versionId } : {}),
    ...(artifact.versionNumber === undefined ? {} : { versionNumber: artifact.versionNumber }),
    ...(artifact.checksum ? { sha256: artifact.checksum } : {})
  }
}

const artifactsEqual = (left: PersistedArtifact, right: PersistedArtifact): boolean =>
  left.id === right.id &&
  left.kind === right.kind &&
  left.path === right.path &&
  left.fileUrl === right.fileUrl &&
  left.name === right.name &&
  left.mimeType === right.mimeType &&
  left.size === right.size &&
  left.createdAt === right.createdAt &&
  left.mtimeMs === right.mtimeMs &&
  left.sha256 === right.sha256 &&
  left.artifactId === right.artifactId &&
  left.versionId === right.versionId &&
  left.versionNumber === right.versionNumber

const synchronizeFlatProjection = (session: PersistedChatSession): PersistedChatSession => {
  const graph = session.conversationGraph!
  const messages = resolveActiveConversationMessages(graph).map(projectConversationMessage)
  const activityProjection = resolveActiveConversationActivities(graph)
  return {
    ...session,
    messages,
    activities: activityProjection.activities,
    activityGroups: activityProjection.activityGroups
  }
}

const completeGroups = (
  groups: PersistedBranchActivityGroup[],
  scope: RuntimeSessionScope,
  now: number
): void => {
  for (const group of groups) {
    if (
      group.agentFrameId === scope.agentFrameId &&
      group.messageBranchId === scope.messageBranchId &&
      group.promptMessageId === scope.promptMessageId &&
      group.completedAt === undefined &&
      group.activityIds.length > 0
    ) {
      group.completedAt = now
      group.updatedAt = now
    }
  }
}

const terminalContextSample = (
  event: AcpRuntimeEvent,
  scope: RuntimeSessionScope
): ReturnType<typeof sanitizeAcpContextWindowSample> => {
  const terminal = event.terminalContextWindow
  if (!terminal) return undefined
  return sanitizeAcpContextWindowSample({
    id: event.id,
    timestamp: event.timestamp,
    termination: terminal.termination,
    contextWindow: terminal.contextWindow,
    modelStepUsage: terminal.modelStepUsage,
    source: event.kind === 'stop' ? 'stop' : 'error',
    runtimeSegmentId: scope.runtimeSegmentId
  })
}

const terminalize = (
  session: PersistedChatSession,
  scope: RuntimeSessionScope,
  event: AcpRuntimeEvent
): void => {
  const graph = session.conversationGraph!
  const cancelled = event.kind === 'stop' && event.text === 'cancelled'
  const connectionLost =
    event.kind === 'error' &&
    event.providerError === true &&
    isClaudeApiResponseInterruption(event.text)
  const failed = event.kind === 'error' || cancelled
  const responses = graph.messages.filter(
    (message) =>
      message.agentFrameId === scope.agentFrameId &&
      message.introducedOnBranchId === scope.messageBranchId &&
      message.role === 'agent' &&
      message.responseToMessageId === scope.promptMessageId
  )
  const usageOwner = responses.at(-1)
  for (const message of responses) {
    if (message.status === 'streaming') {
      message.status = failed ? 'error' : 'complete'
      if (failed) message.failedAt = event.timestamp
      else message.completedAt = event.timestamp
    }
    delete message.turnUsage
    delete message.turnUsageUnavailable
    delete message.modelCallUsage
    if (message === usageOwner) {
      if (event.turnUsage) {
        message.turnUsage = structuredClone(event.turnUsage)
        message.modelCallUsage = event.modelCallUsage?.map((usage) => structuredClone(usage))
      } else {
        message.turnUsageUnavailable = true
      }
    }
    message.eventIds = retainRecentSessionEventIds(message.eventIds)
    message.updatedAt = Math.max(message.updatedAt, event.timestamp)
  }
  const prompt = graph.messages.find(({ id }) => id === scope.promptMessageId)
  const sample = terminalContextSample(event, scope)
  if (prompt && sample && !prompt.contextWindowSamples?.some(({ id }) => id === sample.id)) {
    prompt.contextWindowSamples = [...(prompt.contextWindowSamples ?? []), sample]
    prompt.updatedAt = Math.max(prompt.updatedAt, event.timestamp)
  }
  if ((cancelled || connectionLost) && prompt) prompt.interrupted = true
  const pendingPermission = session.runtimeContext?.permission
  for (const activity of graph.activities) {
    if (
      activity.agentFrameId === scope.agentFrameId &&
      activity.messageBranchId === scope.messageBranchId &&
      activity.promptMessageId === scope.promptMessageId &&
      !isTerminal(activity.status)
    ) {
      // A durable MCP approval still owns this invocation after the provider Attempt ends.
      // Its decision/continuation, rather than an old stop, settles the tool activity.
      if (
        pendingPermission?.state === 'pending' &&
        pendingPermission.request.isMcp === true &&
        pendingPermission.request.sessionId === session.id &&
        pendingPermission.originatingPromptMessageId === scope.promptMessageId &&
        pendingPermission.request.toolCallId === activity.id
      )
        continue
      activity.status = failed ? 'failed' : 'completed'
      activity.updatedAt = event.timestamp
      activity.eventIds = retainRecentSessionEventIds(activity.eventIds)
    }
  }
  completeGroups(graph.activityGroups, scope, event.timestamp)
  if (session.activeRun?.promptMessageId === scope.promptMessageId) {
    const permissionPending = session.runtimeContext?.permission?.state === 'pending'
    const elicitationPending = graph.activities.some(
      (activity) =>
        activity.agentFrameId === scope.agentFrameId &&
        activity.messageBranchId === scope.messageBranchId &&
        activity.promptMessageId === scope.promptMessageId &&
        activity.elicitation?.state === 'pending' &&
        activity.elicitation.durable?.kind === 'agent-user-choice'
    )
    const planPending = session.runtimeContext?.plan?.approval === 'pending'
    const blocked = permissionPending || elicitationPending || planPending
    session.activeRun = undefined
    session.status = permissionPending
      ? 'waiting-permission'
      : elicitationPending
        ? 'waiting-for-user'
        : planPending
          ? 'waiting-plan-approval'
          : failed
            ? 'error'
            : 'idle'
    session.error =
      failed && !blocked
        ? cancelled
          ? INTERRUPTED_TURN_ERROR
          : event.text || event.title
        : undefined
    session.errorReportable = event.kind === 'error' && !blocked ? !event.providerError : undefined
    session.resumeRecovery =
      (cancelled || connectionLost) && !blocked
        ? {
            kind: 'resume-required',
            cause: cancelled ? 'cancelled' : 'connection-lost',
            promptMessageId: scope.promptMessageId
          }
        : undefined
  }
}

export const attachRuntimeSessionArtifacts = (
  inputSession: PersistedChatSession,
  scope: RuntimeSessionScope,
  input: {
    messageId?: string
    eventId: string
    runId: string
    artifacts: readonly ArtifactFile[]
    timestamp: number
  }
): { session: PersistedChatSession; messageId: string } => {
  const session = structuredClone(inputSession)
  const { graph, branch } = scopedPath(session, scope)
  let owner = input.messageId
    ? graph.messages.find(
        (message) =>
          message.id === input.messageId &&
          message.agentFrameId === scope.agentFrameId &&
          message.introducedOnBranchId === scope.messageBranchId &&
          message.role === 'agent' &&
          message.responseToMessageId === scope.promptMessageId &&
          message.runtimeSegmentId === scope.runtimeSegmentId
      )
    : undefined
  if (input.messageId && !owner) {
    throw new Error('Runtime Artifact owner Message is outside the supplied Session scope.')
  }
  owner ??= graph.messages.findLast(
    (message) =>
      message.agentFrameId === scope.agentFrameId &&
      message.introducedOnBranchId === scope.messageBranchId &&
      message.role === 'agent' &&
      message.responseToMessageId === scope.promptMessageId &&
      message.runtimeSegmentId === scope.runtimeSegmentId &&
      (message.streamId === input.runId || !input.messageId)
  )
  if (!owner) {
    const id = createRuntimeAgentMessageId(session.id, input.runId, scope.promptMessageId)
    owner = {
      id,
      role: 'agent',
      content: '',
      status: 'complete',
      streamId: input.runId,
      responseToMessageId: scope.promptMessageId,
      eventIds: [],
      createdAt: input.timestamp,
      completedAt: input.timestamp,
      updatedAt: input.timestamp,
      agentFrameId: scope.agentFrameId,
      introducedOnBranchId: scope.messageBranchId,
      parentMessageId: branch.headMessageId,
      runtimeSegmentId: scope.runtimeSegmentId
    }
    graph.messages.push(owner)
    branch.headMessageId = id
  }
  const artifacts = input.artifacts.map((artifact) =>
    persistedArtifact(artifact, owner?.createdAt ?? input.timestamp)
  )
  owner.eventIds = appendUnique(owner.eventIds, [input.eventId])
  owner.artifactIds = appendUnique(
    owner.artifactIds,
    artifacts.map(({ id }) => id)
  )
  owner.updatedAt = Math.max(owner.updatedAt, input.timestamp)
  branch.updatedAt = Math.max(branch.updatedAt, input.timestamp)
  const byId = new Map((session.artifacts ?? []).map((artifact) => [artifact.id, artifact]))
  let artifactsChanged = false
  for (const artifact of artifacts) {
    const current = byId.get(artifact.id)
    if (!current || !artifactsEqual(current, artifact)) artifactsChanged = true
    byId.set(artifact.id, artifact)
  }
  session.artifacts = [...byId.values()]
  if (artifactsChanged) session.filesRevision = (session.filesRevision ?? 0) + 1
  session.updatedAt = Math.max(session.updatedAt, input.timestamp)
  validateConversationGraph(graph)
  return { session: synchronizeFlatProjection(session), messageId: owner.id }
}

export const applyRuntimeSessionEvents = (
  inputSession: PersistedChatSession,
  scope: RuntimeSessionScope,
  events: readonly AcpRuntimeEvent[]
): PersistedChatSession => {
  let session = structuredClone(inputSession)
  scopedPath(session, scope)
  const groupControls = new Set(
    session
      .conversationGraph!.activityGroups.filter(
        (group) =>
          group.agentFrameId === scope.agentFrameId &&
          group.messageBranchId === scope.messageBranchId
      )
      .map(({ id }) => id)
  )
  for (const event of events) {
    if (event.sessionId && event.sessionId !== session.id) continue
    // A cancelled provider turn cannot regain transcript ownership through queued chunks. Native
    // artifact publication remains admissible because finalization may complete after cancellation.
    if (
      event.kind !== 'artifact' &&
      session.resumeRecovery?.cause === 'cancelled' &&
      session.resumeRecovery.promptMessageId === scope.promptMessageId
    ) {
      continue
    }
    const graph = session.conversationGraph!
    const branch = graph.branches.find(({ id }) => id === scope.messageBranchId)!
    if (event.kind === 'artifact') {
      const attached = attachRuntimeSessionArtifacts(session, scope, {
        messageId: event.messageId,
        eventId: event.id,
        runId: event.runId,
        artifacts: event.artifacts,
        timestamp: event.timestamp
      })
      session = attached.session
      continue
    }
    if (event.kind === 'message' && event.role === 'assistant') {
      const text = getAcpRuntimeEventText(event) ?? ''
      let image = getAcpRuntimeEventImage(event)
      if (!text && !image) continue
      completeGroups(graph.activityGroups, scope, event.timestamp)
      const streamId = event.messageId ?? event.id
      const id = createRuntimeAgentMessageId(session.id, streamId, scope.promptMessageId)
      let message = graph.messages.find(({ id: candidate }) => candidate === id)
      if (message?.eventIds.includes(event.id)) continue
      if (message?.status === 'complete' && event.timestamp <= message.updatedAt) {
        continue
      }
      if (image) {
        const messageImages = message?.images ?? []
        const messageBytes = messageImages.reduce(
          (total, candidate) => total + candidate.byteLength,
          0
        )
        const sessionBytes = graph.messages.reduce(
          (total, candidate) =>
            total + (candidate.images ?? []).reduce((sum, item) => sum + item.byteLength, 0),
          0
        )
        if (
          messageImages.length >= MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE ||
          messageBytes + image.byteLength > MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE ||
          sessionBytes + image.byteLength > MAX_ACP_SESSION_IMAGE_BYTES
        ) {
          image = undefined
          if (!text) continue
        }
      }
      if (!message) {
        message = {
          id,
          role: 'agent',
          content: '',
          status: 'streaming',
          streamId,
          responseToMessageId: scope.promptMessageId,
          eventIds: [],
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
          agentFrameId: scope.agentFrameId,
          introducedOnBranchId: scope.messageBranchId,
          parentMessageId: branch.headMessageId,
          runtimeSegmentId: scope.runtimeSegmentId
        }
        graph.messages.push(message)
        branch.headMessageId = id
      }
      const mergedContent = `${message.content}${text}`
      message.content =
        session.agentFrameworkId === 'claude-code'
          ? normalizeClaudeCodeRefusalText(mergedContent)
          : mergedContent
      if (image) message.images = [...(message.images ?? []), { id: event.id, ...image }]
      message.eventIds.push(event.id)
      message.updatedAt = Math.max(message.updatedAt, event.timestamp)
      branch.updatedAt = Math.max(branch.updatedAt, event.timestamp)
    } else if ((event.kind === 'tool' || event.kind === 'compaction') && event.toolCallId) {
      if (event.kind === 'compaction') completeGroups(graph.activityGroups, scope, event.timestamp)
      if (
        event.kind === 'tool' &&
        (isActivityGroupToolEvent(event) || groupControls.has(event.toolCallId))
      ) {
        groupControls.add(event.toolCallId)
        const title = getActivityGroupTitleFromToolEvent(event)
        if (title && !graph.activityGroups.some(({ id }) => id === event.toolCallId)) {
          completeGroups(graph.activityGroups, scope, event.timestamp)
          graph.activityGroups.push({
            id: event.toolCallId,
            title,
            sortIndex: event.timestamp,
            activityIds: [],
            promptMessageId: scope.promptMessageId,
            createdAt: event.timestamp,
            updatedAt: event.timestamp,
            agentFrameId: scope.agentFrameId,
            messageBranchId: scope.messageBranchId
          })
        }
        continue
      }
      let activity = graph.activities.find(
        ({ id, agentFrameId, messageBranchId }) =>
          id === event.toolCallId &&
          agentFrameId === scope.agentFrameId &&
          messageBranchId === scope.messageBranchId
      )
      if (activity?.eventIds.includes(event.id)) continue
      const status = toolStatus(event.status === 'cancelled' ? 'completed' : event.status)
      if (!activity) {
        const group = graph.activityGroups.findLast(
          (candidate) =>
            candidate.agentFrameId === scope.agentFrameId &&
            candidate.messageBranchId === scope.messageBranchId &&
            candidate.promptMessageId === scope.promptMessageId &&
            candidate.completedAt === undefined
        )
        activity = {
          id: event.toolCallId,
          kind: 'tool',
          title:
            event.title?.trim() ||
            (event.toolKind === 'fetch' || event.toolKind === 'search' ? '' : 'Tool activity'),
          status: status ?? 'pending',
          eventIds: [],
          sortIndex: event.timestamp,
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
          agentFrameId: scope.agentFrameId,
          messageBranchId: scope.messageBranchId,
          promptMessageId: scope.promptMessageId,
          runtimeSegmentId: scope.runtimeSegmentId,
          ...(group ? { activityGroupId: group.id } : {})
        }
        graph.activities.push(activity)
        if (group) {
          group.activityIds.push(activity.id)
          group.updatedAt = event.timestamp
        }
      }
      const wasTerminal = isTerminal(activity.status)
      activity.eventIds.push(event.id)
      activity.title = event.title?.trim() || activity.title
      if (!wasTerminal && status) activity.status = status
      activity.toolDisposition = event.toolDisposition ?? activity.toolDisposition
      activity.executionInvocationId = event.executionInvocationId ?? activity.executionInvocationId
      activity.providerToolName =
        event.kind === 'compaction'
          ? ACP_CONTEXT_COMPACTION_ACTIVITY_TOOL_NAME
          : (event.providerToolName ?? activity.providerToolName)
      activity.toolKind =
        event.kind === 'compaction' ? 'other' : (event.toolKind ?? activity.toolKind)
      activity.toolContent = event.toolContent ?? activity.toolContent
      activity.toolLocations = event.toolLocations ?? activity.toolLocations
      activity.rawInput = event.rawInput ?? activity.rawInput
      activity.rawOutput = event.rawOutput ?? activity.rawOutput
      activity.terminalOutput = event.terminalOutput ?? activity.terminalOutput
      activity.terminalExitCode = event.terminalExitCode ?? activity.terminalExitCode
      activity.elicitation = event.elicitation ?? activity.elicitation
      if (!wasTerminal) activity.updatedAt = event.timestamp
    } else if (event.kind === 'stop' || event.kind === 'error') {
      terminalize(session, scope, event)
    }
    session.updatedAt = Math.max(session.updatedAt, event.timestamp)
  }
  validateConversationGraph(session.conversationGraph!)
  return synchronizeFlatProjection(session)
}
