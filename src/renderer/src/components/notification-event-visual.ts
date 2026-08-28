import {
  CircleCheck,
  CircleX,
  ClipboardList,
  KeyRound,
  MessageCircleQuestion,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon
} from 'lucide-react'

import type { NotificationInboxItem } from '../../../shared/notifications'

export type NotificationEventTone = 'success' | 'danger' | 'waiting' | 'neutral'

export type NotificationEventVisual = Readonly<{
  Icon: LucideIcon
  tone: NotificationEventTone
}>

// Two-dimensional encoding (GitHub/Linear-style): the glyph says what happened, the tone says
// whether it still needs the user. Settled lifecycle states always resolve to neutral so the
// chromatic tokens only ever mark fresh outcomes or requests that still need a decision.
const SETTLED_ACTION_STATES: ReadonlySet<NotificationInboxItem['actionState']> = new Set([
  'resolved',
  'rejected',
  'expired',
  'cancelled'
])

const resolveGlyph = (
  notification: Pick<NotificationInboxItem, 'kind' | 'attentionReason'>
): LucideIcon => {
  if (notification.kind === 'authorization.required') return ShieldCheck
  if (notification.kind === 'task.completed') return CircleCheck
  if (notification.kind === 'task.failed') return CircleX
  if (notification.attentionReason === 'waiting-for-user') return MessageCircleQuestion
  if (notification.attentionReason === 'waiting-permission') return KeyRound
  if (notification.attentionReason === 'waiting-plan-approval') return ClipboardList
  return TriangleAlert
}

export const resolveNotificationEventVisual = (
  notification: Pick<
    NotificationInboxItem,
    'kind' | 'attentionReason' | 'actionState' | 'targetInvalidatedAt'
  >
): NotificationEventVisual => {
  const Icon = resolveGlyph(notification)
  const settled =
    notification.targetInvalidatedAt !== undefined ||
    SETTLED_ACTION_STATES.has(notification.actionState)
  if (settled) return { Icon, tone: 'neutral' }
  if (notification.kind === 'task.completed') return { Icon, tone: 'success' }
  if (notification.kind === 'task.failed') return { Icon, tone: 'danger' }
  return { Icon, tone: 'waiting' }
}

// Shared token classes so the bell panel and the live toast render the same visual language.
export const notificationEventToneClasses: Record<
  NotificationEventTone,
  Readonly<{ tile: string; chip: string }>
> = {
  success: {
    tile: 'bg-success-000/10 text-success-000',
    chip: 'border-success-000/25 bg-success-000/10 text-success-000'
  },
  danger: {
    tile: 'bg-danger-000/10 text-danger-000',
    chip: 'border-danger-000/25 bg-danger-000/10 text-danger-000'
  },
  waiting: {
    tile: 'bg-session-waiting/10 text-session-waiting',
    chip: 'border-session-waiting/25 bg-session-waiting/10 text-session-waiting'
  },
  neutral: {
    tile: 'bg-bg-300 text-text-300',
    chip: 'border-border-200/70 bg-bg-100 text-text-300'
  }
}
