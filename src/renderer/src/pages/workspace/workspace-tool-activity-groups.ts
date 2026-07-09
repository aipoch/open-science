import type { ToolActivity } from '@/stores/session-store'

import { isActivityActive, type ConversationItem } from './workspace-conversation-items'
import { isEditActivity } from './workspace-tool-activity-details'
import { hasWebSearchContentEvidence } from './workspace-web-search-details'

type ConversationActivityGroupItem = {
  id: string
  type: 'activity-group'
  createdAt: number
  sortIndex: number
  activities: ToolActivity[]
}

type GroupedConversationItem =
  Extract<ConversationItem, { type: 'message' }> | ConversationActivityGroupItem
type ActivityExpansionOverrides = Record<string, boolean>
type RenderableActivityEntry = {
  activity: ToolActivity
  activityIndex: number
}

const WEB_SEARCH_PROVIDER_TOOL_NAME = 'websearch'

// Collapses consecutive activity items into one transcript group between chat messages.
const groupConversationItems = (items: ConversationItem[]): GroupedConversationItem[] => {
  const groupedItems: GroupedConversationItem[] = []

  for (const item of items) {
    if (item.type === 'message') {
      groupedItems.push(item)
      continue
    }

    const previousItem = groupedItems[groupedItems.length - 1]

    if (previousItem?.type === 'activity-group') {
      previousItem.activities.push(item.activity)
      continue
    }

    groupedItems.push({
      id: `activity-group-${item.activity.id}`,
      type: 'activity-group',
      createdAt: item.createdAt,
      sortIndex: item.sortIndex,
      activities: [item.activity]
    })
  }

  return groupedItems
}

// Provides a normalized title for detection rules that depend on ACP tool names.
const getTrimmedActivityTitle = (activity: ToolActivity): string => activity.title.trim()

// Detects the synthetic ToolSearch wrapper row that can precede the real search entries.
const isToolSearchWrapperActivity = (activity: ToolActivity): boolean =>
  activity.providerToolName?.trim().toLowerCase() === 'toolsearch' ||
  getTrimmedActivityTitle(activity).toLowerCase() === 'toolsearch'

// Matches Claude's concrete WebSearch tool identity without conflating file-search kinds.
const isProviderWebSearchActivity = (activity: ToolActivity): boolean =>
  activity.providerToolName?.trim().toLowerCase() === WEB_SEARCH_PROVIDER_TOOL_NAME

// Quoted titles are how the current ACP payload represents individual search queries.
const isQuotedActivityTitle = (activity: ToolActivity): boolean =>
  /^["'].+["']$/u.test(getTrimmedActivityTitle(activity))

// Checks prior sibling rows so ToolSearch can classify following quoted fetch rows as searches.
const hasEarlierToolSearchWrapper = (activities: ToolActivity[], activityIndex: number): boolean =>
  activities.slice(0, activityIndex).some((activity) => isToolSearchWrapperActivity(activity))

// ToolSearch can emit concrete search rows as fetch activities or without a tool kind.
const canInferToolSearchResultActivity = (activity: ToolActivity): boolean =>
  activity.toolKind === undefined || activity.toolKind === 'fetch'

// Explicit non-WebSearch provider names are stronger evidence than legacy title heuristics.
const canUseToolSearchProviderInference = (activity: ToolActivity): boolean =>
  activity.providerToolName === undefined ||
  activity.providerToolName.trim() === '' ||
  activity.providerToolName.trim().toLowerCase() === 'toolsearch'

// Allows provisional running searches while requiring payload evidence for completed rows.
const hasToolSearchInferenceEvidence = (activity: ToolActivity): boolean =>
  isActivityActive(activity) || hasWebSearchContentEvidence(activity)

// Classifies concrete WebSearch tools and likely ToolSearch result rows as web searches.
const isSearchActivity = (
  activity: ToolActivity,
  activities: ToolActivity[],
  activityIndex: number
): boolean =>
  isProviderWebSearchActivity(activity) ||
  (canInferToolSearchResultActivity(activity) &&
    canUseToolSearchProviderInference(activity) &&
    isQuotedActivityTitle(activity) &&
    hasToolSearchInferenceEvidence(activity) &&
    hasEarlierToolSearchWrapper(activities, activityIndex))

// Counts detected search activities so headers can summarize searches instead of raw tool calls.
const countSearchActivities = (activities: ToolActivity[]): number =>
  activities.filter((activity, activityIndex) =>
    isSearchActivity(activity, activities, activityIndex)
  ).length

// Coarse activity categories that map many concrete tools onto a few readable header verbs.
type ActivityCategory =
  | 'search'
  | 'toolSearch'
  | 'command'
  | 'fetch'
  | 'read'
  | 'edit'
  | 'skill'
  | 'environment'
  | 'call'
  | 'artifact'
  | 'other'

// Provider tool names that behave like shell/interpreter commands regardless of ACP tool kind.
const COMMAND_PROVIDER_TOOL_NAMES = new Set([
  'python',
  'bash',
  'shell',
  'sh',
  'zsh',
  'node',
  'run_code',
  'jupyter',
  'bashoutput'
])

// Header clauses are emitted in this fixed order so summaries read consistently.
const ACTIVITY_CATEGORY_ORDER: ActivityCategory[] = [
  'command',
  'search',
  'toolSearch',
  'fetch',
  'read',
  'edit',
  'skill',
  'environment',
  'call',
  'artifact',
  'other'
]

// Reads the lowercased provider tool name used for category matching.
const getNormalizedProviderName = (activity: ToolActivity): string =>
  activity.providerToolName?.trim().toLowerCase() ?? ''

// Assigns one activity to the category that best describes what it did for the header summary.
const categorizeActivity = (
  activity: ToolActivity,
  activities: ToolActivity[],
  activityIndex: number
): ActivityCategory => {
  if (isSearchActivity(activity, activities, activityIndex)) return 'search'
  if (isToolSearchWrapperActivity(activity)) return 'toolSearch'

  const providerName = getNormalizedProviderName(activity)

  if (providerName === 'skill') return 'skill'
  if (providerName === 'save_artifacts' || providerName.includes('artifact')) return 'artifact'
  if (providerName === 'manage_packages' || providerName.includes('package')) return 'environment'
  if (providerName === 'request_network_access' || providerName.startsWith('request_network')) {
    return 'call'
  }
  if (activity.toolKind === 'execute' || COMMAND_PROVIDER_TOOL_NAMES.has(providerName)) {
    return 'command'
  }
  if (isEditActivity(activity)) return 'edit'
  if (activity.toolKind === 'read') return 'read'
  if (activity.toolKind === 'fetch') return 'fetch'

  return 'other'
}

// Builds one natural-language clause (verb + count) for a category present in the group.
const formatCategoryClause = (category: ActivityCategory, count: number): string => {
  switch (category) {
    case 'command':
      return count === 1 ? 'ran a command' : `ran ${count} commands`
    case 'search':
      return count === 1 ? 'ran a search' : `ran ${count} searches`
    case 'toolSearch':
      return count === 1 ? 'ran a tool search' : `ran ${count} tool searches`
    case 'fetch':
      return count === 1 ? 'fetched a page' : `fetched ${count} pages`
    case 'read':
      return count === 1 ? 'read a file' : `read ${count} files`
    case 'edit':
      return count === 1 ? 'edited a file' : `edited ${count} files`
    case 'skill':
      return count === 1 ? 'loaded a skill' : `loaded ${count} skills`
    case 'environment':
      return count === 1 ? 'managed an environment' : 'managed environments'
    case 'call':
      return count === 1 ? 'made a call' : `made ${count} calls`
    case 'artifact':
      return count === 1 ? 'saved a file' : `saved ${count} files`
    default:
      return count === 1 ? 'ran a tool' : `ran ${count} tools`
  }
}

// Uppercases the first character so the joined lowercase clauses read as a sentence fragment.
const capitalizeFirst = (value: string): string =>
  value.length > 0 ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value

// Summarizes a group as "Ran 2 commands, loaded a skill, made a call" style category clauses.
const formatActivityGroupTitle = (activities: ToolActivity[]): string => {
  const hasSearchActivities = countSearchActivities(activities) > 0
  const categoryCounts = new Map<ActivityCategory, number>()

  activities.forEach((activity, activityIndex) => {
    // Mirror rendering: drop the synthetic ToolSearch wrapper once concrete searches exist.
    if (hasSearchActivities && isToolSearchWrapperActivity(activity)) return

    const category = categorizeActivity(activity, activities, activityIndex)

    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1)
  })

  const clauses = ACTIVITY_CATEGORY_ORDER.filter(
    (category) => (categoryCounts.get(category) ?? 0) > 0
  ).map((category) => formatCategoryClause(category, categoryCounts.get(category) ?? 0))

  if (clauses.length === 0) return 'Ran a tool'

  return capitalizeFirst(clauses.join(', '))
}

// Removes ToolSearch wrapper rows from rendering once concrete search rows are available.
const getRenderableActivityEntries = (activities: ToolActivity[]): RenderableActivityEntry[] => {
  const hasSearchActivities = countSearchActivities(activities) > 0

  return activities
    .map((activity, activityIndex) => ({ activity, activityIndex }))
    .filter(({ activity }) => !(hasSearchActivities && isToolSearchWrapperActivity(activity)))
}

// Formats the group header's total visible-step count, flagging any failed steps.
const formatStepCount = (activities: ToolActivity[]): string => {
  const activityCount = activities.length
  const stepLabel = activityCount === 1 ? '1 step' : `${activityCount} steps`
  const failedCount = activities.filter((activity) => activity.status === 'failed').length

  return failedCount > 0 ? `${stepLabel} · ${failedCount} failed` : stepLabel
}

export {
  formatActivityGroupTitle,
  formatStepCount,
  getRenderableActivityEntries,
  groupConversationItems,
  isSearchActivity
}
export type {
  ActivityExpansionOverrides,
  ConversationActivityGroupItem,
  GroupedConversationItem,
  RenderableActivityEntry
}
