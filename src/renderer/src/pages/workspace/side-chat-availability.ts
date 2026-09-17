import type { TFunction } from 'i18next'
import type { ChatSession } from '@/stores/session-store'

export type SideChatAction = 'open' | 'transfer' | 'send'
export type SideChatBlock =
  | 'parent-unavailable'
  | 'parent-pending'
  | 'parent-read-only'
  | 'history-unavailable'
  | 'snapshot-pending'
  | 'restoring'
  | 'restore-failed'
  | 'closing'
  | 'running'
  | 'attachments'
  | 'empty'

// Side chat owns a separate runtime. Main turn readiness (including waits and replay) is
// deliberately absent here. All entry points and mutations use this same decision surface.
export function sideChatBlock(input: {
  action: SideChatAction
  parent: ChatSession | undefined
  projectId?: string
  projectArchived?: boolean
  persistenceReady?: boolean
  hydrated?: boolean
  hydrationError?: string
  closing?: boolean
  running?: boolean
  hasAttachments?: boolean
  hasContent?: boolean
}): SideChatBlock | undefined {
  const { parent, action } = input
  if (
    !parent ||
    (input.projectId && parent.projectId !== input.projectId) ||
    parent.archivedAt !== undefined ||
    input.projectArchived
  )
    return 'parent-unavailable'
  if (parent.isPending) return 'parent-pending'
  if (parent.packageOrigin) return 'parent-read-only'
  if (!parent.messages.some((message) => message.role === 'user' && !message.relayedFrom))
    return 'history-unavailable'
  if (action === 'open') return undefined
  if (input.closing) return 'closing'
  if (action === 'transfer') return undefined
  if (input.persistenceReady === false || parent.conversationGraphSyncBlocked)
    return 'snapshot-pending'
  if (input.hydrationError) return 'restore-failed'
  if (input.hydrated === false) return 'restoring'
  if (input.running) return 'running'
  if (input.hasAttachments) return 'attachments'
  if (input.hasContent === false) return 'empty'
  return undefined
}

export function sideChatBlockMessage(
  block: SideChatBlock | undefined,
  t: TFunction,
  hydrationError?: string
): string | undefined {
  switch (block) {
    case 'parent-unavailable':
      return t('The parent Session is unavailable.')
    case 'parent-pending':
      return t('Resolve the current Session operation first.')
    case 'parent-read-only':
      return t('This session is read-only.')
    case 'history-unavailable':
      return t('Send a message in the main conversation first.')
    case 'snapshot-pending':
      return t('Waiting for conversation history to be saved.')
    case 'restoring':
      return t('Restoring Side chats…')
    case 'restore-failed':
      return t('Could not restore Side chats: {{error}}', { error: hydrationError })
    case 'closing':
      return t('Closing Side chat…')
    case 'running':
      return t('A Side chat prompt is already running.')
    case 'attachments':
      return t('Attachments are unavailable in Side chat')
    case 'empty':
      return t('Enter a message to send.')
    default:
      return undefined
  }
}
