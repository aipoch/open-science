import type {
  PersistedChatSession,
  SaveSessionOptions,
  SessionConflictRebaseField
} from '../../shared/session-persistence'
import { sanitizeSessionConversationCommands } from '../../shared/session-conversation-command'

const RENDERER_SESSION_CONFLICT_REBASE_FIELDS = new Set<SessionConflictRebaseField>([
  'title',
  'permissionProfile',
  'autoReviewEnabled',
  'memoryEnabled',
  'agentConfiguration',
  'pinned'
])
const COMMAND_OWNED_SESSION_FIELDS = new Set(['enabledComputeHosts', 'selectedComputeHosts'])

// Electron IPC arguments are runtime values even when the preload contract is typed. Project only
// renderer-owned rebase authority before the request reaches Main's Session persistence owner.
export const sanitizeRendererSaveSessionOptions = (
  options: unknown,
  session?: PersistedChatSession
): SaveSessionOptions | undefined => {
  if (typeof options !== 'object' || options === null) return undefined
  const fields = Reflect.get(options, 'conflictRebaseFields')
  const candidate = Array.isArray(fields) ? fields : []
  const conversationCommands = sanitizeSessionConversationCommands(
    Reflect.get(options, 'conversationCommands'),
    session
  )
  if (candidate.some((field) => COMMAND_OWNED_SESSION_FIELDS.has(field))) {
    throw new Error('Compute Host settings cannot be replayed through Session saves.')
  }
  const conflictRebaseFields = [
    ...new Set(
      candidate.filter(
        (field): field is SessionConflictRebaseField =>
          typeof field === 'string' &&
          RENDERER_SESSION_CONFLICT_REBASE_FIELDS.has(field as SessionConflictRebaseField)
      )
    )
  ]
  return conflictRebaseFields.length > 0 || conversationCommands.length > 0
    ? {
        ...(conflictRebaseFields.length ? { conflictRebaseFields } : {}),
        ...(conversationCommands.length ? { conversationCommands } : {})
      }
    : undefined
}
