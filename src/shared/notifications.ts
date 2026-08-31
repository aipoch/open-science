import type { SessionWaitReason } from './session-persistence'

// The conversation a desktop-notification click should open. Main holds it (consume-once) until
// the renderer pulls it via 'notifications:take-pending-open-session' once its session store is
// hydrated — a push sent before the renderer's listener exists would be lost. Token uniquely
// identifies the click even when consecutive notifications target the same conversation.
export type OpenSessionFromNotificationRequest = {
  sessionId: string
  token: number
}

// Renderer-owned visibility evidence. Durable session existence comes from main's complete scan.
export type UnreadTaskViewState = {
  challengeId?: number
  visibleSessionId?: string
}

// Closed user-attention taxonomy for the message center. Application lifecycle facts such as
// Project/Session create, update, archive, restore, and delete belong to a separate activity or
// audit projection; adding them here would incorrectly give management history unread semantics.
export type NotificationKind =
  'task.completed' | 'task.needs-attention' | 'task.failed' | 'authorization.required'

export type NotificationSource =
  | 'agent-tool'
  | 'agent-question'
  | 'agent-runtime'
  | 'connector'
  | 'compute'
  | 'skill-import'
  | 'session-plan'

export type NotificationAttentionReason =
  | SessionWaitReason
  | 'task-max-tokens'
  | 'task-max-turn-requests'
  | 'task-refusal'
  | 'task-unclean-stop'

export type NotificationActionState = 'pending' | 'resolved' | 'rejected' | 'expired' | 'cancelled'

export type NotificationInboxItem = Readonly<{
  id: string
  sequence: number
  dedupeKey: string
  kind: NotificationKind
  source?: NotificationSource
  attentionReason?: NotificationAttentionReason
  projectId?: string
  sessionId?: string
  originId: string
  title: string
  summary: string
  createdAt: number
  readAt?: number
  actionState?: NotificationActionState
  settledAt?: number
  targetInvalidatedAt?: number
}>

export type NotificationInboxSnapshot = Readonly<{
  revision: number
  unreadCount: number
  unreadSessionIds: readonly string[]
  latestSequence: number
  items: readonly NotificationInboxItem[]
}>

export type NotificationInboxChanged = Readonly<{
  revision: number
  unreadCount: number
  latestSequence: number
}>

export type NotificationDesktopAvailability = 'supported' | 'unavailable'
export type NotificationTestResult = 'shown' | 'failed' | 'unconfirmed' | 'unavailable'

export type NotificationMarkReadRequest = Readonly<{ ids: readonly string[] }>

export type NotificationMarkAllReadRequest = Readonly<{ throughSequence: number }>

export type NotificationMarkSessionCompletionsReadRequest = Readonly<{
  sessionIds: readonly string[]
}>

export type NotificationMarkSessionUnreadRequest = Readonly<{
  sessionIds: readonly string[]
}>
