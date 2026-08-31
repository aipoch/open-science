import type { ChatMessage, ChatSession, ToolActivity } from '@/stores/session-store'
import { ACP_CONTEXT_COMPACTION_ACTIVITY_TOOL_NAME } from '../../../../shared/acp'
import type { HandoffLifecycleEvent } from '../../../../shared/handoff-lifecycle'
import {
  isHiddenControlMessage,
  type PersistedMessageAgentTarget
} from '../../../../shared/session-persistence'

import {
  projectHandoffLifecycle,
  type HandoffTranscriptProjection
} from './handoff-lifecycle-projection'
import { isSkillActivity } from './workspace-tool-activity-details'
import { getLoadedSkillName } from './workspace-skill-load'
import {
  projectInlineParentMessages,
  type InlineParentMessageProjection
} from './subagent-release-projection'
import { isNotebookExecutionActivity, type ToolExecutionPhase } from './tool-execution-phase'
import {
  getNotebookMemoryToolDisplayName,
  NOTEBOOK_MEMORY_TOOL_SUFFIXES
} from './notebook-tool-names'

type ConversationMessageItem = {
  id: string
  type: 'message'
  createdAt: number
  sortIndex: number
  message: ChatMessage
}

type ConversationActivityItemBase<
  ItemType extends 'activity' | 'plan-activity' | 'compaction-activity'
> = {
  id: string
  type: ItemType
  createdAt: number
  sortIndex: number
  activity: ToolActivity
}

type ConversationActivityItem = ConversationActivityItemBase<'activity'>
type ConversationPlanActivityItem = ConversationActivityItemBase<'plan-activity'>
type ConversationCompactionActivityItem = ConversationActivityItemBase<'compaction-activity'>

// A lifecycle row is a read-only annotation on its originating user turn. It is not another user
// message and cannot own a separate continuation identity.
type ConversationHandoffItem = HandoffTranscriptProjection & {
  type: 'handoff'
  createdAt: number
  sortIndex: number
}

type ConversationSubagentMessageItem = {
  id: string
  type: 'subagent-message'
  createdAt: number
  sortIndex: number
  message: InlineParentMessageProjection
}

// A quiet divider derived (never persisted) above a user Message whose resolved send target
// differs from the previous stamped turn.
type ConversationSessionConfigChangeItem = {
  id: string
  type: 'session-config-change'
  createdAt: number
  sortIndex: number
  agentTarget: PersistedMessageAgentTarget
}

type ConversationItem =
  | ConversationMessageItem
  | ConversationActivityItem
  | ConversationPlanActivityItem
  | ConversationCompactionActivityItem
  | ConversationHandoffItem
  | ConversationSubagentMessageItem
  | ConversationSessionConfigChangeItem

const KNOWN_TITLE_TOOL_NAMES = new Set(['ToolSearch'])

// Claude Code namespaces MCP tools with `mcp__`; Codex records completed tools as dotted titles.
// Both preserve the notebook server name, with Codex occasionally sanitizing its hyphens.
const NOTEBOOK_PROVIDER_TOOL_PATTERN =
  /^(?:mcp__|mcp\.)?open[-_]science[-_]notebook(?:__|\.)([^.]+)$/iu
const PLAN_PROVIDER_TOOL_PATTERN =
  /^(?:(?:mcp__|mcp\.)?open[-_]science[-_]plan(?:__|\.|_)|)(generate_plan|update_step_status)$/iu

const getPlanToolKind = (
  activity: ToolActivity
): 'generate_plan' | 'update_step_status' | undefined => {
  const names = [activity.providerToolName, activity.title]
  for (const name of names) {
    const match = PLAN_PROVIDER_TOOL_PATTERN.exec(name?.trim() ?? '')
    if (match?.[1] === 'generate_plan' || match?.[1] === 'update_step_status') return match[1]
  }
  return undefined
}

// Returns the notebook tool suffix (e.g. "notebook_execute") for a notebook MCP tool identity, or
// undefined when the name is not a notebook tool. Framework-agnostic across the two server-name forms.
const getNotebookToolSuffix = (toolName: string | undefined): string | undefined =>
  NOTEBOOK_PROVIDER_TOOL_PATTERN.exec(toolName?.trim() ?? '')?.[1]

// Maps a notebook MCP tool to a clean human label so rows read as notebook actions, not raw
// mcp__…__* names. Returns undefined for non-notebook tools.
const formatNotebookToolName = (toolName: string): string | undefined => {
  const memoryToolName = getNotebookMemoryToolDisplayName(toolName)

  if (memoryToolName) return memoryToolName

  const suffix = getNotebookToolSuffix(toolName)

  if (!suffix) return undefined
  // A Memory suffix that failed the strict matcher above is an unknown provider identity, not a
  // generic Notebook action. Preserve its raw label rather than hiding it behind "Notebook".
  if (NOTEBOOK_MEMORY_TOOL_SUFFIXES.some((memorySuffix) => memorySuffix === suffix.toLowerCase()))
    return undefined

  switch (suffix) {
    case 'notebook_execute':
      return 'Notebook run'
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
  (activity.status === 'pending' || activity.status === 'in_progress') &&
  !isNotebookExecutionActivity(activity)

const isContextCompactionActivity = (activity: ToolActivity): boolean =>
  activity.providerToolName === ACP_CONTEXT_COMPACTION_ACTIVITY_TOOL_NAME

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
const formatActivityToolName = (
  activity: ToolActivity,
  t: (key: string, options?: Record<string, unknown>) => string
): string => {
  const providerToolName = trimDetail(activity.providerToolName)
  const title = trimDetail(activity.title)

  const notebookToolName =
    (providerToolName && formatNotebookToolName(providerToolName)) ??
    (title && formatNotebookToolName(title))

  if (notebookToolName) return t(notebookToolName)
  if (providerToolName) return providerToolName
  if (title && KNOWN_TITLE_TOOL_NAMES.has(title)) return title

  return formatToolKindName(activity.toolKind)
}

// Builds the status-sensitive text for non-search activity chips.
const formatActivityTitle = (
  activity: ToolActivity,
  phase: ToolExecutionPhase | undefined,
  t: (key: string, options?: Record<string, unknown>) => string
): string => {
  if (phase === 'closed')
    return t('Request ended: {{name}}', { name: formatActivityToolName(activity, t) })

  if (isContextCompactionActivity(activity)) {
    const title = trimDetail(activity.title)

    if (title === 'Compacting context') return t('Compacting context')
    if (title === 'Context compacted') return t('Context compacted')
    if (title === 'Context compaction failed') return t('Context compaction failed')
    if (title === 'Context compaction cancelled') return t('Context compaction cancelled')
    if (title) return title
    if (activity.status === 'failed') return t('Context compaction failed')
    if (activity.status === 'completed') return t('Context compacted')
    return t('Compacting context')
  }

  if (isSkillActivity(activity)) {
    const skillName = getLoadedSkillName(activity)

    if (activity.status === 'failed')
      return skillName ? t('Skill failed: {{name}}', { name: skillName }) : t('Skill failed')
    if (activity.status === 'completed')
      return skillName ? t('Loaded skill: {{name}}', { name: skillName }) : t('Loaded skill')
    return skillName ? t('Loading skill: {{name}}', { name: skillName }) : t('Loading skill')
  }

  const toolName = formatActivityToolName(activity, t)

  if (phase === 'declined') return t('Declined by you: {{name}}', { name: toolName })
  if (phase === 'awaiting-approval')
    return t('Waiting for your approval: {{name}}', { name: toolName })
  if (phase === 'prepared') return t('Code shown: {{name}}', { name: toolName })
  if (phase === 'limit-reached') return t('Execution limit reached: {{name}}', { name: toolName })
  if (phase === 'cancelled') return t('Cancelled: {{name}}', { name: toolName })
  if (phase === 'interrupted') return t('Interrupted: {{name}}', { name: toolName })
  if (phase === 'failed') return t('Tool failed: {{name}}', { name: toolName })
  if (phase === 'completed') return t('Used tool: {{name}}', { name: toolName })
  if (phase === 'executing') return t('Using tool: {{name}}', { name: toolName })
  if (activity.status === 'failed') return t('Tool failed: {{name}}', { name: toolName })
  if (activity.status === 'completed') return t('Used tool: {{name}}', { name: toolName })

  return t('Using tool: {{name}}', { name: toolName })
}

// Config-change dividers are annotations on the following user Message. Hide them with that
// Message (and other message-like rows) so they cannot appear while the owning turn is still
// behind the presentation barrier. Tool and activity rows stay live so running work remains
// visible above the paced reply.
const hidesBehindPresentationBarrier = (type: string): boolean =>
  type === 'message' || type === 'subagent-message' || type === 'session-config-change'

// Two send targets describe the same turn configuration only when every routed field matches.
const agentTargetsMatch = (
  left: PersistedMessageAgentTarget,
  right: PersistedMessageAgentTarget
): boolean =>
  left.frameworkId === right.frameworkId &&
  left.backendId === right.backendId &&
  left.providerId === right.providerId &&
  left.model === right.model &&
  left.reasoningEffort === right.reasoningEffort

// Derives divider rows above user Messages whose resolved send target changed from the previous
// stamped turn. Messages without a snapshot (legacy turns, relayed side-chat messages) neither
// emit a divider nor move the baseline, so upgraded sessions show no false markers.
const createSessionConfigChangeItems = (
  messages: readonly ConversationMessageItem[]
): ConversationSessionConfigChangeItem[] => {
  const ordered = [...messages].sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      left.sortIndex - right.sortIndex ||
      left.id.localeCompare(right.id)
  )
  const items: ConversationSessionConfigChangeItem[] = []
  let baseline: PersistedMessageAgentTarget | undefined
  for (const item of ordered) {
    const target =
      item.message.role === 'user' && !item.message.relayedFrom
        ? item.message.agentTarget
        : undefined
    if (!target) continue
    if (baseline && !agentTargetsMatch(baseline, target)) {
      items.push({
        id: `session-config-change-${item.id}`,
        type: 'session-config-change',
        createdAt: item.createdAt,
        // Half a step below the owning Message keeps the divider directly above it under the
        // shared (createdAt, sortIndex) transcript sort.
        sortIndex: item.sortIndex - 0.5,
        agentTarget: target
      })
    }
    baseline = target
  }
  return items
}

// Projects persisted chat messages and transient tool activities into one sortable transcript list.
const createConversationItems = (
  session: ChatSession | undefined,
  handoffEvents: readonly HandoffLifecycleEvent[] = []
): ConversationItem[] => {
  const messages: ConversationMessageItem[] =
    session?.messages.flatMap((message, index): ConversationMessageItem[] =>
      isHiddenControlMessage(message)
        ? []
        : [
            {
              id: message.id,
              type: 'message',
              createdAt: message.createdAt,
              sortIndex: message.sortIndex ?? index,
              message
            }
          ]
    ) ?? []
  const activities: ConversationItem[] =
    session?.activities?.flatMap((activity): ConversationItem[] => {
      const planToolKind = getPlanToolKind(activity)
      if (planToolKind === 'update_step_status') return []
      const isCompaction = isContextCompactionActivity(activity)
      return [
        {
          id: isCompaction
            ? `compaction-activity-${activity.id}`
            : planToolKind === 'generate_plan'
              ? `plan-activity-${activity.id}`
              : `activity-${activity.id}`,
          type: isCompaction
            ? 'compaction-activity'
            : planToolKind === 'generate_plan'
              ? 'plan-activity'
              : 'activity',
          createdAt: activity.createdAt,
          sortIndex: activity.sortIndex,
          activity
        }
      ]
    }) ?? []
  const handoffs: ConversationItem[] = projectHandoffLifecycle(handoffEvents).map((handoff) => ({
    ...handoff,
    type: 'handoff',
    createdAt: handoff.timelineAt,
    // Runtime messages and coordinator lifecycle events use independent sequences. Timestamp is
    // authoritative across the two streams; this only makes exact ties deterministic.
    sortIndex: Number.MAX_SAFE_INTEGER
  }))
  const subagentMessages: ConversationItem[] = projectInlineParentMessages(session).map(
    (message) => ({
      id: `subagent-message-${message.messageId}`,
      type: 'subagent-message',
      createdAt: message.queuedAt,
      // Durable commands have their own lane sequence. Timestamp plus stable identity orders them
      // against the independent runtime message/activity sequence without inventing shared state.
      sortIndex: Number.MAX_SAFE_INTEGER,
      message
    })
  )

  // Runtime events and chat chunks use separate sequences, so sorting uses timestamps first.
  return [
    ...messages,
    ...activities,
    ...handoffs,
    ...subagentMessages,
    ...createSessionConfigChangeItems(messages)
  ].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
    if (left.sortIndex !== right.sortIndex) return left.sortIndex - right.sortIndex
    return left.id.localeCompare(right.id)
  })
}

// Each user turn may be answered by several agent fragments (text split around tool calls). Only
// the chronologically last fragment owns the whole-turn surface — footer, usage, and the projected
// child Versions. This resolves that terminal fragment id set from raw chat messages so the
// transcript scroller and the artifact visibility hook share one definition.
const resolveTurnTerminalAgentMessageIds = (messages: readonly ChatMessage[]): Set<string> => {
  const footerIds = new Set<string>()
  const footerByPrompt = new Map<string, string>()
  const interruptedPromptIds = new Set(
    messages
      .filter((message) => message.role === 'user' && message.interrupted)
      .map((message) => message.id)
  )
  const ordered = messages.map((message, index) => ({
    id: message.id,
    role: message.role,
    responseToMessageId: message.responseToMessageId,
    createdAt: message.createdAt,
    sortIndex: message.sortIndex ?? index
  }))
  ordered.sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      left.sortIndex - right.sortIndex ||
      left.id.localeCompare(right.id)
  )
  for (const message of ordered) {
    if (message.role !== 'agent') continue
    const promptId = message.responseToMessageId
    if (!promptId) {
      footerIds.add(message.id)
      continue
    }
    if (interruptedPromptIds.has(promptId)) continue
    const previousId = footerByPrompt.get(promptId)
    if (previousId) footerIds.delete(previousId)
    footerByPrompt.set(promptId, message.id)
    footerIds.add(message.id)
  }
  return footerIds
}

export {
  createConversationItems,
  formatActivityTitle,
  formatNotebookToolName,
  getNotebookToolSuffix,
  hidesBehindPresentationBarrier,
  isActivityActive,
  resolveTurnTerminalAgentMessageIds,
  isContextCompactionActivity
}
export type { ConversationItem }
