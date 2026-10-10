import { ACP_CONTEXT_COMPACTION_ACTIVITY_TOOL_NAME } from '../../../../shared/acp'
import {
  isHiddenControlMessage,
  type PersistedChatMessage,
  type PersistedChatSession,
  type PersistedToolActivity
} from '../../../../shared/session-persistence'
import { projectInlineParentMessages } from '../../pages/workspace/subagent-release-projection'

type MessageItem = { type: 'message'; message: PersistedChatMessage }
type ActivityItem = {
  type: 'activity' | 'plan-activity' | 'compaction-activity'
  activity: PersistedToolActivity
}
type ActivityGroup = {
  type: 'activity-group'
  activities: PersistedToolActivity[]
  activityGroupId?: string
  title?: string
}
type Barrier = { type: 'annotation' }
type OrderedItem = (MessageItem | ActivityItem | Barrier) & {
  id: string
  createdAt: number
  sortIndex: number
}
const planTool =
  /^(?:(?:mcp__|mcp\.)?open[-_]science[-_]plan(?:__|\.|_)|)(generate_plan|update_step_status)$/iu

/**
 * Persisted transcript evidence in the same ordering/grouping as the conversation surface.
 * UI-only turn footers, configuration labels and live state do not form Replay evidence.
 * This projection intentionally has no renderer store, locale, DOM or Electron dependency.
 */
export function createReplayTranscript(
  session: PersistedChatSession
): (MessageItem | ActivityItem | ActivityGroup)[] {
  const items: OrderedItem[] = session.messages.flatMap((message, index): OrderedItem[] =>
    isHiddenControlMessage(message)
      ? []
      : [
          {
            type: 'message',
            message,
            id: message.id,
            createdAt: message.createdAt,
            sortIndex: (message as PersistedChatMessage & { sortIndex?: number }).sortIndex ?? index
          }
        ]
  )
  for (const activity of session.activities ?? []) {
    const kind = [activity.providerToolName, activity.title]
      .map((name) => planTool.exec(name?.trim() ?? '')?.[1])
      .find(Boolean)
    if (kind === 'update_step_status') continue
    const compaction = activity.providerToolName === ACP_CONTEXT_COMPACTION_ACTIVITY_TOOL_NAME
    items.push({
      type: compaction
        ? 'compaction-activity'
        : kind === 'generate_plan'
          ? 'plan-activity'
          : 'activity',
      id: `${compaction ? 'compaction-' : kind === 'generate_plan' ? 'plan-' : ''}activity-${activity.id}`,
      createdAt: activity.createdAt,
      sortIndex: activity.sortIndex,
      activity
    })
  }
  // A delegated annotation separates adjacent business groups even though its own source
  // messages are presented on a distinct research branch.
  for (const message of projectInlineParentMessages(session))
    items.push({
      type: 'annotation',
      id: `subagent-message-${message.messageId}`,
      createdAt: message.queuedAt,
      sortIndex: Number.MAX_SAFE_INTEGER
    })
  items.sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      left.sortIndex - right.sortIndex ||
      left.id.localeCompare(right.id)
  )
  const groups = new Map((session.activityGroups ?? []).map((group) => [group.id, group]))
  const result: (MessageItem | ActivityItem | ActivityGroup | Barrier)[] = []
  for (const item of items) {
    if (item.type !== 'activity' || item.activity.elicitation) {
      result.push(item)
      continue
    }
    const previous = result.at(-1)
    const groupId = item.activity.activityGroupId
    if (previous?.type === 'activity-group' && previous.activityGroupId === groupId)
      previous.activities.push(item.activity)
    else
      result.push({
        type: 'activity-group',
        activities: [item.activity],
        activityGroupId: groupId,
        title: groupId ? groups.get(groupId)?.title : undefined
      })
  }
  return result.filter((item) => item.type !== 'annotation')
}
