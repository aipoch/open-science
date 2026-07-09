import type { ChatMessage, ChatSession, ToolActivity } from '@/stores/session-store'

type ConversationMessageItem = {
  id: string
  type: 'message'
  createdAt: number
  sortIndex: number
  message: ChatMessage
}

type ConversationActivityItem = {
  id: string
  type: 'activity'
  createdAt: number
  sortIndex: number
  activity: ToolActivity
}

type ConversationItem = ConversationMessageItem | ConversationActivityItem

const KNOWN_TITLE_TOOL_NAMES = new Set(['ToolSearch'])

// Treats pending and in-progress tool calls as live activity rows.
const isActivityActive = (activity: ToolActivity): boolean =>
  activity.status === 'pending' || activity.status === 'in_progress'

// Normalizes optional labels so empty strings can fall back to tool-kind names.
const trimDetail = (value: string | null | undefined): string | undefined => {
  const trimmedValue = value?.trim()

  return trimmedValue ? trimmedValue : undefined
}

// Converts one raw tool-kind segment into the PascalCase fragment used by tool labels.
const formatToolKindSegment = (value: string): string => {
  const normalizedValue = value.trim()

  return normalizedValue
    ? `${normalizedValue.charAt(0).toUpperCase()}${normalizedValue.slice(1)}`
    : ''
}

// Converts ACP tool kinds into generic tool labels without leaking query, path, or URL details.
const formatToolKindName = (toolKind: ToolActivity['toolKind']): string => {
  if (!toolKind) return 'tool'

  const formattedKind = toolKind.split(/[-_]/u).map(formatToolKindSegment).filter(Boolean).join('')

  return formattedKind ? `Tool${formattedKind}` : 'tool'
}

// Uses only trusted tool identity fields for generic rows, preserving known wrapper titles.
const formatActivityToolName = (activity: ToolActivity): string => {
  const providerToolName = trimDetail(activity.providerToolName)
  const title = trimDetail(activity.title)

  if (providerToolName) return providerToolName
  if (title && KNOWN_TITLE_TOOL_NAMES.has(title)) return title

  return formatToolKindName(activity.toolKind)
}

// Builds the status-sensitive text for non-search activity chips.
const formatActivityTitle = (activity: ToolActivity): string => {
  const toolName = formatActivityToolName(activity)

  if (activity.status === 'failed') return `Tool failed: ${toolName}`
  if (activity.status === 'completed') return `Used tool: ${toolName}`

  return `Using tool: ${toolName}`
}

// Projects persisted chat messages and transient tool activities into one sortable transcript list.
const createConversationItems = (session: ChatSession | undefined): ConversationItem[] => {
  const messages: ConversationItem[] =
    session?.messages.map((message, index) => ({
      id: message.id,
      type: 'message',
      createdAt: message.createdAt,
      sortIndex: message.sortIndex ?? index,
      message
    })) ?? []
  const activities: ConversationItem[] =
    session?.activities?.map((activity) => ({
      id: `activity-${activity.id}`,
      type: 'activity',
      createdAt: activity.createdAt,
      sortIndex: activity.sortIndex,
      activity
    })) ?? []

  // Runtime events and chat chunks use separate sequences, so sorting uses timestamps first.
  return [...messages, ...activities].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
    if (left.sortIndex !== right.sortIndex) return left.sortIndex - right.sortIndex
    return left.id.localeCompare(right.id)
  })
}

export { createConversationItems, formatActivityTitle, isActivityActive }
export type { ConversationItem }
