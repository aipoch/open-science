import type { PersistedChatSession } from '../../../../shared/session-persistence'
import { isHiddenControlMessage } from '../../../../shared/session-persistence'
import { resolveMessageBranchPath } from '../../../../shared/conversation-graph'

type SaveAsSkillSession = PersistedChatSession & {
  interrupted?: boolean
  fixLoopActive?: boolean
  compacting?: boolean
  conversationGraphSyncBlocked?: boolean
  branchContextResetRequired?: boolean
  specialistSwitchResetRequired?: boolean
}

type SaveAsSkillAvailabilityInput = {
  session: SaveAsSkillSession | undefined
  persistenceReady: boolean
  runtimeInteraction: boolean
  pending: boolean
  running: boolean
  customizeAvailable: boolean
  hasRunningSubagents: boolean
  sideChatOpen: boolean
}

export type SaveAsSkillAvailability =
  { enabled: true; disabledReason: undefined } | { enabled: false; disabledReason: string }

export const resolveSaveAsSkillAvailability = ({
  session,
  persistenceReady,
  runtimeInteraction,
  pending,
  running,
  customizeAvailable,
  hasRunningSubagents,
  sideChatOpen
}: SaveAsSkillAvailabilityInput): SaveAsSkillAvailability => {
  const activeFrame = session?.conversationGraph?.frames.find(
    ({ id }) => id === session.conversationGraph?.activeFrameId
  )
  let activeBranchMessages: ReturnType<typeof resolveMessageBranchPath> | undefined
  try {
    activeBranchMessages =
      session?.conversationGraph && activeFrame
        ? resolveMessageBranchPath(session.conversationGraph, activeFrame.activeBranchId)
        : undefined
  } catch {
    activeBranchMessages = undefined
  }
  const disabledReason = !session
    ? 'Open a conversation before saving it as a Skill.'
    : !customizeAvailable
      ? 'The Customize Skill is unavailable to the active Specialist.'
      : !persistenceReady
        ? 'Wait for conversation history to finish loading.'
        : sideChatOpen
          ? 'Close Side chat before saving this conversation as a Skill.'
          : hasRunningSubagents
            ? 'Wait for all subagents to finish.'
            : running
              ? 'Save as skill is running.'
              : session.interrupted ||
                  session.resumeRecovery ||
                  session.pendingHistoryReplay ||
                  session.branchContextResetRequired ||
                  session.specialistSwitchResetRequired ||
                  session.fixLoopActive ||
                  session.compacting
                ? 'Resolve the current Session operation first.'
                : pending || runtimeInteraction || session.status !== 'idle' || session.activeRun
                  ? 'Wait for the current agent activity to finish.'
                  : session.conversationGraphSyncBlocked
                    ? 'Resolve the conversation branch synchronization error first.'
                    : !session.conversationGraph || !activeBranchMessages
                      ? 'Conversation branch history is unavailable.'
                      : activeBranchMessages?.at(-1)?.role !== 'agent' ||
                          activeBranchMessages.at(-1)?.status !== 'complete'
                        ? 'Wait for a completed Agent response.'
                        : undefined

  return disabledReason
    ? { enabled: false, disabledReason }
    : { enabled: true, disabledReason: undefined }
}

export const isSaveAsSkillRunning = (session: SaveAsSkillSession | undefined): boolean => {
  const promptMessageId = session?.activeRun?.promptMessageId
  if (!promptMessageId) return false

  return session.messages.some(
    (message) => message.id === promptMessageId && isHiddenControlMessage(message)
  )
}
