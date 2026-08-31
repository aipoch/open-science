import { isDeepStrictEqual } from 'node:util'

import type {
  AcpContinueInterruptedTurnRequest,
  AcpPromptRequest,
  AcpStateSnapshot
} from '../../shared/acp'
import { prepareAnnotationsForAgent } from '../../shared/annotations'
import {
  getActiveConversationContext,
  resolveActiveConversationMessages
} from '../../shared/conversation-graph'
import { buildSessionHistoryReplay } from '../../shared/session-history-replay'
import { sessionPdfContextToFileReferences } from '../../shared/session-pdf-context'
import {
  isHiddenControlMessage,
  sanitizeSessionReferences,
  type PersistedChatSession
} from '../../shared/session-persistence'
import { toRuntimeUploadedAttachment } from '../../shared/uploads'
import type { TaskNotificationService } from '../notifications/task-notifications'

const INTERRUPTED_TURN_CONTINUATION_PROMPT =
  'Continue the interrupted turn from where it stopped. Do not repeat completed work or completed tool calls unless needed to finish the original request.'
const SAVE_AS_SKILL_PROMPT = `[System] Distill this session into a reusable Skill.

Review the active conversation branch: what was the goal, which agents and tools were used, what were the key steps, and what steering or corrections did the user provide along the way? Capture the reusable pattern, not a verbatim transcript.

First decide whether the branch contains a settled procedure the user is likely to run again. If it does not, briefly explain why and stop. If it does, load Customize and follow its Skill Creator workflow.`

const buildContinuationPrompt = (
  prompt: PersistedChatSession['messages'][number],
  contextReset: boolean
): string =>
  prompt.turnIntent === 'save-as-skill'
    ? SAVE_AS_SKILL_PROMPT
    : contextReset
      ? INTERRUPTED_TURN_CONTINUATION_PROMPT
      : `${INTERRUPTED_TURN_CONTINUATION_PROMPT}\n\nOriginal user request:\n${prompt.content}`

type InterruptedTurnContinuationRuntime = {
  getSnapshot(): AcpStateSnapshot
  getLatestUserPrompt(sessionId: string, promptMessageId: string): AcpPromptRequest | undefined
  startContinuation(request: AcpPromptRequest): Promise<void>
}

type InterruptedTurnContinuationDependencies = {
  runtime: InterruptedTurnContinuationRuntime
  loadSession(projectId: string, sessionId: string): Promise<PersistedChatSession | undefined>
  startDispatchAdmittedContinuation?: (
    request: AcpPromptRequest,
    validate: () => Promise<void>
  ) => Promise<unknown>
  notifications?: Pick<TaskNotificationService, 'trackPrompt' | 'untrackPrompt'>
}

const expectedFrameworkForReplayTarget = (
  target: NonNullable<AcpContinueInterruptedTurnRequest['contextReset']>['historyReplayTarget']
): NonNullable<PersistedChatSession['agentFrameworkId']> => {
  if (target === 'opencode') return 'opencode'
  if (target === 'codex-response' || target === 'codex-bridge') return 'codex'
  return 'claude-code'
}

const requireInterruptedTurn = (
  session: PersistedChatSession,
  request: AcpContinueInterruptedTurnRequest
): NonNullable<PersistedChatSession['messages'][number]> => {
  if (
    session.resumeRecovery?.kind !== 'resume-required' ||
    session.resumeRecovery.promptMessageId !== request.promptMessageId
  ) {
    throw new Error(
      'Resume no longer matches the interrupted turn on the active Conversation Branch.'
    )
  }

  const prompt = session.messages.find((message) => message.id === request.promptMessageId)
  if (prompt?.role !== 'user') {
    throw new Error(
      'Resume no longer matches the interrupted turn on the active Conversation Branch.'
    )
  }
  return prompt
}

const resolveProvenanceContext = (
  session: PersistedChatSession,
  request: AcpContinueInterruptedTurnRequest
): NonNullable<AcpPromptRequest['provenanceContext']> => {
  const graph = session.conversationGraph
  if (!graph) return { promptMessageId: request.promptMessageId }

  const provenance = getActiveConversationContext(graph, request.promptMessageId)
  const contextReset = request.contextReset
  if (!contextReset) return provenance

  const segment = graph.runtimeSegments.find(
    (candidate) => candidate.id === contextReset.runtimeSegmentId
  )
  const expectedFramework = expectedFrameworkForReplayTarget(contextReset.historyReplayTarget)
  if (
    !segment ||
    segment.agentFrameId !== provenance.agentFrameId ||
    segment.frameworkId !== expectedFramework ||
    (session.agentFrameworkId && session.agentFrameworkId !== expectedFramework)
  ) {
    throw new Error('Resume Runtime Segment does not match the adopted Agent context.')
  }

  return { ...provenance, runtimeSegmentId: segment.id }
}

const buildContinuationRequest = (
  session: PersistedChatSession,
  prompt: PersistedChatSession['messages'][number],
  request: AcpContinueInterruptedTurnRequest,
  livePrompt: AcpPromptRequest | undefined
): AcpPromptRequest => {
  const skillIds = prompt.parts?.flatMap((part) => (part.type === 'skill' ? [part.id] : []))
  const referencedArtifacts = (prompt.parts ?? []).reduce<
    NonNullable<AcpPromptRequest['referencedArtifacts']>
  >((references, part) => {
    if (part.type !== 'artifact') return references
    references.push(
      part.source === 'linked-folder'
        ? {
            id: part.id,
            name: part.name,
            source: part.source,
            rootId: part.rootId,
            relativePath: part.relativePath,
            mimeType: part.mimeType
          }
        : {
            id: part.id,
            name: part.name,
            path: part.path,
            source: part.source,
            sourceFileId: part.sourceFileId,
            mimeType: part.mimeType,
            versionId: part.versionId,
            checksum: part.checksum
          }
    )
    return references
  }, [])
  if (prompt.pdfContext) {
    for (const pdfReference of sessionPdfContextToFileReferences(
      session.projectId,
      prompt.pdfContext
    )) {
      if (
        !referencedArtifacts.some(
          (reference) =>
            reference.source !== 'linked-folder' &&
            pdfReference.source !== 'linked-folder' &&
            reference.source === pdfReference.source &&
            reference.versionId === pdfReference.versionId
        )
      ) {
        referencedArtifacts.push(pdfReference)
      }
    }
  }
  const preparedAnnotations = prepareAnnotationsForAgent(
    buildContinuationPrompt(prompt, Boolean(request.contextReset)),
    prompt.annotations ?? [],
    livePrompt?.referencedArtifacts?.length ? livePrompt.referencedArtifacts : referencedArtifacts
  )
  const referencedSessions = sanitizeSessionReferences(prompt.parts)
  const provenanceContext = resolveProvenanceContext(session, request)
  const contextReset = request.contextReset
  const replayMessages = contextReset
    ? (session.conversationGraph
        ? resolveActiveConversationMessages(session.conversationGraph)
        : session.messages
      )
        .filter((message) => !isHiddenControlMessage(message))
        .map((message) =>
          message.role === 'agent' &&
          message.responseToMessageId === request.promptMessageId &&
          message.status === 'error'
            ? { ...message, status: 'complete' as const }
            : message
        )
    : undefined
  const replay =
    contextReset && replayMessages
      ? buildSessionHistoryReplay(
          replayMessages,
          {
            target: contextReset.historyReplayTarget,
            contextWindow: contextReset.contextWindow
          },
          session.projectId,
          contextReset.supportsImageInput
        )
      : undefined
  if (contextReset && !replay) {
    throw new Error('Interrupted conversation history could not be replayed after context reset.')
  }
  const attachments = contextReset
    ? undefined
    : livePrompt?.attachments?.length
      ? livePrompt.attachments
      : prompt.uploads?.map((upload) => toRuntimeUploadedAttachment(upload, session.projectId))
  const retainedPromptImages = contextReset ? undefined : prompt.images

  return {
    sessionId: request.sessionId,
    text: preparedAnnotations.promptText,
    memoryEnabled: session.memoryEnabled !== false,
    suppressUserMessage: true,
    provenanceContext,
    ...(prompt.turnIntent === 'plan-first' || livePrompt?.turnIntent === 'plan-first'
      ? { turnIntent: 'plan-first' as const }
      : {}),
    ...(prompt.turnIntent === 'save-as-skill'
      ? {}
      : livePrompt?.forcedSkillIds?.length
        ? { forcedSkillIds: livePrompt.forcedSkillIds }
        : skillIds?.length
          ? { forcedSkillIds: skillIds }
          : {}),
    ...(preparedAnnotations.referencedArtifacts?.length
      ? { referencedArtifacts: preparedAnnotations.referencedArtifacts }
      : {}),
    ...(livePrompt?.referencedSessions?.length
      ? { referencedSessions: livePrompt.referencedSessions }
      : referencedSessions.length
        ? { referencedSessions }
        : {}),
    ...(attachments?.length ? { attachments } : {}),
    ...(preparedAnnotations.images?.length ? { currentImages: preparedAnnotations.images } : {}),
    ...(replay?.historyPreamble ? { historyPreamble: replay.historyPreamble } : {}),
    ...(replay?.historyAttachments.length ? { historyAttachments: replay.historyAttachments } : {}),
    ...(replay?.historyImages.length
      ? { historyImages: replay.historyImages }
      : retainedPromptImages?.length
        ? { historyImages: retainedPromptImages }
        : {}),
    ...(contextReset ? { contextReset: true } : {})
  }
}

// Continues one durable interrupted turn through the app-owned prompt path. The renderer supplies
// only identity and a closed replay policy; all hidden provider content is reconstructed in Main.
export const continueInterruptedTurn = async (
  dependencies: InterruptedTurnContinuationDependencies,
  request: AcpContinueInterruptedTurnRequest
): Promise<AcpStateSnapshot> => {
  const session = await dependencies.loadSession(request.projectId, request.sessionId)
  if (!session) throw new Error('Interrupted Session could not be loaded.')
  const prompt = requireInterruptedTurn(session, request)
  const livePrompt = dependencies.runtime.getLatestUserPrompt(
    request.sessionId,
    request.promptMessageId
  )
  const snapshot = dependencies.runtime.getSnapshot()
  if (
    livePrompt &&
    (snapshot.agentPromptInFlightSessionIds ?? snapshot.promptInFlightSessionIds).includes(
      request.sessionId
    )
  ) {
    return snapshot
  }

  const tracked = dependencies.notifications?.trackPrompt({
    sessionId: request.sessionId,
    text: prompt.content
  })
  try {
    const continuation = buildContinuationRequest(session, prompt, request, livePrompt)
    if (dependencies.startDispatchAdmittedContinuation) {
      await dependencies.startDispatchAdmittedContinuation(continuation, async () => {
        const admittedSession = await dependencies.loadSession(request.projectId, request.sessionId)
        if (!admittedSession) throw new Error('Interrupted Session could not be loaded.')
        const admittedPrompt = requireInterruptedTurn(admittedSession, request)
        const admittedLivePrompt = dependencies.runtime.getLatestUserPrompt(
          request.sessionId,
          request.promptMessageId
        )
        const admittedContinuation = buildContinuationRequest(
          admittedSession,
          admittedPrompt,
          request,
          admittedLivePrompt
        )
        if (!isDeepStrictEqual(admittedContinuation, continuation)) {
          throw new Error('Interrupted Session changed before provider admission.')
        }
      })
    } else {
      await dependencies.runtime.startContinuation(continuation)
    }
  } catch (error) {
    if (tracked) dependencies.notifications?.untrackPrompt(request.sessionId, tracked)
    throw error
  }
  return dependencies.runtime.getSnapshot()
}

export type { InterruptedTurnContinuationDependencies, InterruptedTurnContinuationRuntime }
export { SAVE_AS_SKILL_PROMPT }
