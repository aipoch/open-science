import type { PersistedActivityGroup } from '../../../../shared/session-persistence'
import type { ToolActivity } from '@/stores/session-store'

import {
  getNotebookToolSuffix,
  isActivityActive,
  type ConversationItem
} from './workspace-conversation-items'
import { identityTranslate, type TranslateClause } from './workspace-translate-clause'
import { isEditActivity, isSkillActivity } from './workspace-tool-activity-details'
import { hasWebSearchContentEvidence } from './workspace-web-search-details'

type ConversationActivityGroupItem = {
  id: string
  type: 'activity-group'
  createdAt: number
  sortIndex: number
  activities: ToolActivity[]
  activityGroupId?: string
  title?: string
}

type GroupedConversationItem = ConversationItem | ConversationActivityGroupItem
type ActivityExpansionOverrides = Record<string, boolean>
type RenderableActivityEntry = {
  activity: ToolActivity
  activityIndex: number
}

const WEB_SEARCH_PROVIDER_TOOL_NAME = 'websearch'

// Collapses consecutive activity items into one transcript group between chat messages.
const groupConversationItems = (
  items: ConversationItem[],
  activityGroups: PersistedActivityGroup[] = []
): GroupedConversationItem[] => {
  const groupedItems: GroupedConversationItem[] = []
  const groupsById = new Map(activityGroups.map((group) => [group.id, group]))

  for (const item of items) {
    // Handoff annotations, Plan call records, and elicitations are standalone transcript items.
    // Keep their timeline position and prevent them from merging into adjacent ordinary tools.
    if (
      item.type === 'message' ||
      item.type === 'subagent-message' ||
      item.type === 'handoff' ||
      item.type === 'plan-activity' ||
      item.type === 'compaction-activity' ||
      (item.type === 'activity' && item.activity.elicitation)
    ) {
      groupedItems.push(item)
      continue
    }

    const previousItem = groupedItems[groupedItems.length - 1]
    const activityGroupId = item.activity.activityGroupId
    const declaredGroup = activityGroupId ? groupsById.get(activityGroupId) : undefined

    if (
      previousItem?.type === 'activity-group' &&
      previousItem.activityGroupId === activityGroupId
    ) {
      previousItem.activities.push(item.activity)
      continue
    }

    groupedItems.push({
      id: activityGroupId
        ? `activity-group-${activityGroupId}`
        : `activity-group-${item.activity.id}`,
      type: 'activity-group',
      createdAt: item.createdAt,
      sortIndex: item.sortIndex,
      activities: [item.activity],
      activityGroupId,
      title: declaredGroup?.title
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
  | 'notebook'
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
  'notebook',
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

  // A notebook_execute call is one cell run; summarize it as such instead of a generic tool.
  if (getNotebookToolSuffix(providerName) === 'notebook_execute') return 'notebook'
  if (isSkillActivity(activity)) return 'skill'
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

// Plural key + English singular as defaultValue_one: English has no catalog, so the singular has to
// travel with the call rather than live in one.
const CATEGORY_CLAUSE_KEYS: Record<ActivityCategory, readonly [string, string]> = {
  command: ['ran {{count}} commands', 'ran a command'],
  search: ['ran {{count}} searches', 'ran a search'],
  toolSearch: ['ran {{count}} tool searches', 'ran a tool search'],
  fetch: ['fetched {{count}} pages', 'fetched a page'],
  read: ['read {{count}} files', 'read a file'],
  edit: ['edited {{count}} files', 'edited a file'],
  skill: ['loaded {{count}} skills', 'loaded a skill'],
  environment: ['managed environments', 'managed an environment'],
  call: ['made {{count}} calls', 'made a call'],
  artifact: ['saved {{count}} files', 'saved a file'],
  notebook: ['ran {{count}} notebook cells', 'ran a notebook cell'],
  other: ['ran {{count}} tools', 'ran a tool']
}

// Builds one natural-language clause (verb + count) for a category present in the group.
const formatCategoryClause = (
  category: ActivityCategory,
  count: number,
  t: TranslateClause = identityTranslate
): string => {
  const [pluralKey, singular] = CATEGORY_CLAUSE_KEYS[category]

  return t(pluralKey, { count, defaultValue_one: singular })
}

// Uppercases the first character so the joined lowercase clauses read as a sentence fragment.
// Scripts without case (Chinese) are returned unchanged by toUpperCase(), so this is a no-op there.
const capitalizeFirst = (value: string): string =>
  value.length > 0 ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value

// Summarizes a group as "Ran 2 commands, loaded a skill, made a call" style category clauses.
const formatActivityGroupTitle = (
  activities: ToolActivity[],
  declaredTitle?: string,
  t: TranslateClause = identityTranslate
): string => {
  const groupTitle = declaredTitle?.trim()
  if (groupTitle) return groupTitle

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
  ).map((category) => formatCategoryClause(category, categoryCounts.get(category) ?? 0, t))

  if (clauses.length === 0) return capitalizeFirst(t('ran a tool'))

  // The separator itself is a key (its English text is ", ") so CJK can use a full-width comma.
  return capitalizeFirst(clauses.join(t(', ')))
}

// Removes ToolSearch wrapper rows from rendering once concrete search rows are available.
const getRenderableActivityEntries = (activities: ToolActivity[]): RenderableActivityEntry[] => {
  const hasSearchActivities = countSearchActivities(activities) > 0

  return activities
    .map((activity, activityIndex) => ({ activity, activityIndex }))
    .filter(({ activity }) => !(hasSearchActivities && isToolSearchWrapperActivity(activity)))
}

// Formats the group header's total visible-step count, flagging any failed steps.
const formatStepCount = (
  activities: ToolActivity[],
  t: TranslateClause = identityTranslate
): string => {
  const activityCount = activities.length
  const stepLabel = t('{{count}} steps', {
    count: activityCount,
    defaultValue_one: '{{count}} step'
  })
  const failedCount = activities.filter((activity) => activity.status === 'failed').length

  return failedCount > 0
    ? `${stepLabel} · ${t('{{count}} failed', { count: failedCount })}`
    : stepLabel
}

// Adds each tool's own runtime, excluding idle gaps between tools in the same group.
const getActivityGroupElapsedMs = (activities: ToolActivity[], now: number): number =>
  activities.reduce(
    (total, activity) =>
      total +
      Math.max(0, (isActivityActive(activity) ? now : activity.updatedAt) - activity.createdAt),
    0
  )

// Keeps short work precise, then switches to compact clock units as the elapsed span grows.
const formatActivityGroupElapsed = (elapsedMs: number): string => {
  const milliseconds = Math.max(0, Math.floor(elapsedMs))
  if (milliseconds < 1000) return `${milliseconds}ms`

  const totalSeconds = Math.floor(milliseconds / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export {
  formatActivityGroupElapsed,
  formatActivityGroupTitle,
  formatStepCount,
  getActivityGroupElapsedMs,
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
