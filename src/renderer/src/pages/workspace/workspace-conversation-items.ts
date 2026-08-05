import type { ChatMessage, ChatSession, ToolActivity } from '@/stores/session-store'
import type { HandoffLifecycleEvent } from '../../../../shared/handoff-lifecycle'

import {
  projectHandoffLifecycle,
  type HandoffTranscriptProjection
} from './handoff-lifecycle-projection'
import { getLoadedSkillName, isSkillActivity } from './workspace-tool-activity-details'

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

// A lifecycle row is a read-only annotation on its originating user turn. It is not another user
// message and cannot own a separate continuation identity.
type ConversationHandoffItem = HandoffTranscriptProjection & {
  type: 'handoff'
  createdAt: number
  sortIndex: number
}

type ConversationItem = ConversationMessageItem | ConversationActivityItem | ConversationHandoffItem

const KNOWN_TITLE_TOOL_NAMES = new Set(['ToolSearch'])

// Claude Code namespaces MCP tools with `mcp__`; Codex records completed tools as dotted titles.
// Both preserve the notebook server name, with Codex occasionally sanitizing its hyphens.
const NOTEBOOK_PROVIDER_TOOL_PATTERN =
  /^(?:mcp__|mcp\.)?open[-_]science[-_]notebook(?:__|\.)([^.]+)$/iu
const PLAN_PROVIDER_TOOL_PATTERN =
  /^(?:(?:mcp__|mcp\.)?open[-_]science[-_]plan(?:__|\.|_)|)(?:generate_plan|update_step_status)$/iu

const isSuccessfulPlanActivity = (activity: ToolActivity): boolean =>
  activity.status !== 'failed' &&
  PLAN_PROVIDER_TOOL_PATTERN.test(activity.providerToolName?.trim() ?? activity.title.trim())

// Returns the notebook tool suffix (e.g. "notebook_execute") for a notebook MCP tool identity, or
// undefined when the name is not a notebook tool. Framework-agnostic across the two server-name forms.
const getNotebookToolSuffix = (toolName: string | undefined): string | undefined =>
  NOTEBOOK_PROVIDER_TOOL_PATTERN.exec(toolName?.trim() ?? '')?.[1]

// Maps a notebook MCP tool to a clean human label so rows read as notebook actions, not raw
// mcp__…__* names. Returns undefined for non-notebook tools.
const formatNotebookToolName = (toolName: string): string | undefined => {
  const suffix = getNotebookToolSuffix(toolName)

  if (!suffix) return undefined

  switch (suffix) {
    case 'notebook_execute':
      return 'Notebook cell'
    case 'notebook_state':
      return 'Notebook state'
    case 'notebook_restart':
      return 'Notebook restart'
    case 'notebook_shutdown':
      return 'Notebook shutdown'
    default:
      return 'Notebook'
  }
}

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

  const notebookToolName =
    (providerToolName && formatNotebookToolName(providerToolName)) ??
    (title && formatNotebookToolName(title))

  if (notebookToolName) return notebookToolName
  if (providerToolName) return providerToolName
  if (title && KNOWN_TITLE_TOOL_NAMES.has(title)) return title

  return formatToolKindName(activity.toolKind)
}

// Builds the status-sensitive text for non-search activity chips.
const formatActivityTitle = (activity: ToolActivity): string => {
  if (isSkillActivity(activity)) {
    const skillName = getLoadedSkillName(activity)

    if (activity.status === 'failed')
      return skillName ? `Skill failed: ${skillName}` : 'Skill failed'
    if (activity.status === 'completed')
      return skillName ? `Loaded skill: ${skillName}` : 'Loaded skill'
    return skillName ? `Loading skill: ${skillName}` : 'Loading skill'
  }

  const toolName = formatActivityToolName(activity)

  if (activity.status === 'failed') return `Tool failed: ${toolName}`
  if (activity.status === 'completed') return `Used tool: ${toolName}`

  return `Using tool: ${toolName}`
}

// Projects persisted chat messages and transient tool activities into one sortable transcript list.
const createConversationItems = (
  session: ChatSession | undefined,
  handoffEvents: readonly HandoffLifecycleEvent[] = []
): ConversationItem[] => {
  const messages: ConversationItem[] =
    session?.messages.map((message, index) => ({
      id: message.id,
      type: 'message',
      createdAt: message.createdAt,
      sortIndex: message.sortIndex ?? index,
      message
    })) ?? []
  const activities: ConversationItem[] =
    session?.activities
      ?.filter((activity) => !isSuccessfulPlanActivity(activity))
      .map((activity) => ({
        id: `activity-${activity.id}`,
        type: 'activity',
        createdAt: activity.createdAt,
        sortIndex: activity.sortIndex,
        activity
      })) ?? []
  const handoffs: ConversationItem[] = projectHandoffLifecycle(handoffEvents).map((handoff) => ({
    ...handoff,
    type: 'handoff',
    createdAt: handoff.timelineAt,
    // Runtime messages and coordinator lifecycle events use independent sequences. Timestamp is
    // authoritative across the two streams; this only makes exact ties deterministic.
    sortIndex: Number.MAX_SAFE_INTEGER
  }))

  // Runtime events and chat chunks use separate sequences, so sorting uses timestamps first.
  return [...messages, ...activities, ...handoffs].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
    if (left.sortIndex !== right.sortIndex) return left.sortIndex - right.sortIndex
    return left.id.localeCompare(right.id)
  })
}

export {
  createConversationItems,
  formatActivityTitle,
  formatNotebookToolName,
  getNotebookToolSuffix,
  isActivityActive
}
export type { ConversationItem }
