import { resolveMessageBranchPath } from '../../shared/conversation-graph'
import { isHiddenControlMessage, type PersistedChatSession } from '../../shared/session-persistence'
import type {
  ResearchVideoPresentationRequest,
  ResearchVideoPresentationStatus
} from '../../shared/research-video-presentation'

import type { ResearchVideoSessionSource } from '@aipoch/research-film'
export type { ResearchVideoSessionSource } from '@aipoch/research-film'

export function researchVideoGenerationBlock(
  session: PersistedChatSession | undefined | null,
  request: ResearchVideoPresentationRequest
): ResearchVideoPresentationStatus['generationBlock'] {
  if (
    !session ||
    session.id !== request.sessionId ||
    session.projectId !== request.projectId ||
    session.archivedAt
  )
    return 'unavailable'
  const graph = session.conversationGraph
  const activeBranch = graph?.frames.find((frame) => frame.id === graph.rootFrameId)?.activeBranchId
  const branchId = request.branchId ?? activeBranch
  if (request.branchId && !graph) return 'unavailable'
  if (graph && branchId && !graph.branches.some((branch) => branch.id === branchId))
    return 'unavailable'
  const messages = (
    graph && branchId ? resolveMessageBranchPath(graph, branchId) : session.messages
  ).filter(
    (message) =>
      !isHiddenControlMessage(message) && ['user', 'agent', 'assistant'].includes(message.role)
  )
  if (
    ((!request.branchId || request.branchId === activeBranch) && session.status === 'running') ||
    messages.some((message) => message.status === 'streaming')
  )
    return 'busy'
  if (!messages.some((message) => message.content.trim())) return 'empty'
  if (
    !messages.some(
      (message) =>
        ['agent', 'assistant'].includes(message.role) &&
        message.status === 'complete' &&
        message.content.trim()
    )
  )
    return 'awaiting-reply'
  return undefined
}
export function researchVideoSessionSource(
  session: PersistedChatSession,
  request: ResearchVideoPresentationRequest
): ResearchVideoSessionSource {
  if (
    session.id !== request.sessionId ||
    session.projectId !== request.projectId ||
    session.archivedAt
  )
    throw new Error('Research session is unavailable.')
  const graph = session.conversationGraph
  const branchId =
    request.branchId ??
    graph?.frames.find((frame) => frame.id === graph.rootFrameId)?.activeBranchId
  if (!graph && request.branchId) throw new Error('Research branch is unavailable.')
  const messages = (
    graph && branchId ? resolveMessageBranchPath(graph, branchId) : session.messages
  )
    .filter(
      (message) =>
        !isHiddenControlMessage(message) &&
        ['user', 'agent', 'assistant'].includes(message.role) &&
        message.content.trim()
    )
    .map((message, i) => ({
      i,
      id: message.id,
      role: message.role,
      md: message.content,
      artifactIds: message.artifactIds ?? []
    }))
  if (!messages.length) throw new Error('This session has no research content to explain.')
  const source = {
    sessionTitle: session.title,
    project: session.projectId,
    messages,
    provenance: {
      projectId: session.projectId,
      sessionId: session.id,
      branchId,
      sourceRevision: session.revision,
      sourceClaimsIndependentlyVerified: false
    }
  }
  return source
}
