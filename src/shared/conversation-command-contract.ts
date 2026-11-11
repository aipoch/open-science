import type { PersistedRuntimeSegment } from './conversation-graph'
import type { PersistedChatMessage } from './session-message-contract'
import type { PersistedActiveRun } from './session-run-contract'

// User actions carry intent, never a replacement copy of the runtime-owned graph. Stable Message,
// Branch and Segment identities make replay independent of a lost renderer acknowledgement.
export type SessionConversationCommand = {
  id: string
  timestamp: number
  preparationId?: string
} & (
  | { kind: 'prepare-prompt'; promptMessageId: string; mode: 'new' | 'resume' | 'rearm' }
  | { kind: 'rollback-prompt'; preparationId: string; preserveSubmittedMessage?: boolean }
  | {
      kind: 'append-user'
      branchId: string
      parentMessageId?: string
      message: PersistedChatMessage
    }
  | { kind: 'fork-message'; branchId: string; parentBranchId: string; messageId: string }
  | {
      kind: 'fork-activity'
      branchId: string
      parentBranchId: string
      messageId: string
      activityId: string
    }
  | { kind: 'select-branch'; branchId: string; previousBranchId: string }
  | { kind: 'open-segment'; segment: Omit<PersistedRuntimeSegment, 'agentFrameId' | 'endedAt'> }
  | { kind: 'start-run' | 'resume-run'; run: PersistedActiveRun }
)
