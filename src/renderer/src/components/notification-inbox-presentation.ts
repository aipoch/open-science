import type { NotificationInboxItem } from '../../../shared/notifications'
import { isHiddenControlMessage, isHumanUserMessage } from '../../../shared/session-persistence'
import type { Project } from '../../../shared/projects'
import type { ChatSession } from '@/stores/session-store'

export type NotificationInboxGroup = Readonly<{
  key: 'unread' | 'earlier'
  label: 'Unread' | 'Earlier'
  items: readonly PresentedNotificationInboxItem[]
}>

export type PresentedNotificationInboxItem = Readonly<{
  notification: NotificationInboxItem
  projectName?: string
  sessionTitle?: string
  detailPreview?: string
}>

const previewText = (content: unknown): string | undefined => {
  if (typeof content !== 'string') return undefined
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return normalized.length > 180 ? `${normalized.slice(0, 177).trimEnd()}…` : normalized
}

const messagePrecedesNotification = (
  message: ChatSession['messages'][number],
  notification: NotificationInboxItem
): boolean =>
  typeof message.createdAt === 'number' &&
  Number.isFinite(message.createdAt) &&
  typeof notification.createdAt === 'number' &&
  Number.isFinite(notification.createdAt) &&
  message.createdAt <= notification.createdAt

const resolveDetailPreview = (
  notification: NotificationInboxItem,
  session: ChatSession | undefined
): string | undefined => {
  if (!session) return undefined

  if (notification.source === 'agent-question') {
    const question = (Array.isArray(session.activities) ? session.activities : [])?.find(
      (activity) =>
        activity.elicitation?.durable?.requestId === notification.originId ||
        activity.id === notification.originId
    )?.elicitation?.message
    const questionPreview = previewText(question)
    if (questionPreview) return questionPreview
  }

  const messages = Array.isArray(session.messages) ? session.messages : []
  const prompt = messages.reduce<ChatSession['messages'][number] | undefined>((latest, message) => {
    if (
      !messagePrecedesNotification(message, notification) ||
      !isHumanUserMessage(message) ||
      isHiddenControlMessage(message)
    ) {
      return latest
    }
    return !latest || message.createdAt > latest.createdAt ? message : latest
  }, undefined)
  const preview = previewText(prompt?.content ?? '')
  const sessionTitle = previewText(session.title)

  return preview && preview !== sessionTitle ? preview : undefined
}

// Joins durable notification identity to the already-hydrated renderer caches. This keeps the
// notification transport small while giving every presentation surface task and Project context.
export const presentNotificationInbox = (
  items: readonly NotificationInboxItem[],
  sessions: readonly ChatSession[],
  projects: readonly Project[]
): readonly NotificationInboxGroup[] => {
  const safeSessions = Array.isArray(sessions) ? sessions : []
  const safeProjects = Array.isArray(projects) ? projects : []
  const safeItems = Array.isArray(items) ? items : []
  const sessionsById = new Map(safeSessions.map((session) => [session.id, session]))
  const projectsById = new Map(safeProjects.map((project) => [project.id, project]))
  const grouped: Record<NotificationInboxGroup['key'], PresentedNotificationInboxItem[]> = {
    unread: [],
    earlier: []
  }

  for (const notification of [...safeItems].sort((left, right) => {
    const leftCreatedAt = Number.isFinite(left.createdAt) ? left.createdAt : 0
    const rightCreatedAt = Number.isFinite(right.createdAt) ? right.createdAt : 0
    return rightCreatedAt - leftCreatedAt
  })) {
    const session = notification.sessionId ? sessionsById.get(notification.sessionId) : undefined
    const projectId = notification.projectId ?? session?.projectId
    const projectName = previewText(projectsById.get(projectId ?? '')?.name)
    const detailPreview = resolveDetailPreview(notification, session)
    const sessionTitle = previewText(session?.title)
    const presented: PresentedNotificationInboxItem = {
      notification,
      ...(projectName ? { projectName } : {}),
      ...(sessionTitle ? { sessionTitle } : {}),
      ...(detailPreview ? { detailPreview } : {})
    }
    grouped[notification.readAt === undefined ? 'unread' : 'earlier'].push(presented)
  }

  return [
    ...(grouped.unread.length > 0
      ? [{ key: 'unread', label: 'Unread', items: grouped.unread } as const]
      : []),
    ...(grouped.earlier.length > 0
      ? [{ key: 'earlier', label: 'Earlier', items: grouped.earlier } as const]
      : [])
  ]
}
