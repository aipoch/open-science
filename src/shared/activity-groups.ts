export const ACTIVITY_GROUP_MCP_SERVER_NAME = 'open-science-activity'
export const BEGIN_ACTIVITY_GROUP_TOOL_NAME = 'begin_activity_group'
export const MAX_ACTIVITY_GROUP_TITLE_LENGTH = 80

type ActivityGroupToolEvent = {
  title?: string
  providerToolName?: string
  rawInput?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const ACTIVITY_GROUP_TOOL_NAMES = new Set([
  `mcp__${ACTIVITY_GROUP_MCP_SERVER_NAME}__${BEGIN_ACTIVITY_GROUP_TOOL_NAME}`,
  `mcp__${ACTIVITY_GROUP_MCP_SERVER_NAME.replaceAll('-', '_')}__${BEGIN_ACTIVITY_GROUP_TOOL_NAME}`,
  `mcp.${ACTIVITY_GROUP_MCP_SERVER_NAME}.${BEGIN_ACTIVITY_GROUP_TOOL_NAME}`,
  `${ACTIVITY_GROUP_MCP_SERVER_NAME}_${BEGIN_ACTIVITY_GROUP_TOOL_NAME}`,
  `${ACTIVITY_GROUP_MCP_SERVER_NAME.replaceAll('-', '_')}_${BEGIN_ACTIVITY_GROUP_TOOL_NAME}`
])

export const sanitizeActivityGroupTitle = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined

  const collapsed = value.replace(/\s+/gu, ' ').trim()
  const withoutPrefix = collapsed.replace(/^title\s*:\s*/iu, '')
  const withoutWrappingQuotes = withoutPrefix.replace(/^["'`“”‘’]+|["'`“”‘’]+$/gu, '')
  const withoutTrailingPunctuation = withoutWrappingQuotes.replace(/[.!?。！？]+$/u, '').trim()

  if (!withoutTrailingPunctuation) return undefined

  return Array.from(withoutTrailingPunctuation)
    .slice(0, MAX_ACTIVITY_GROUP_TITLE_LENGTH)
    .join('')
    .trim()
}

export const isActivityGroupToolEvent = (event: ActivityGroupToolEvent): boolean => {
  const names = [event.providerToolName, event.title]
    .map((value) => value?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value))

  if (names.some((name) => ACTIVITY_GROUP_TOOL_NAMES.has(name))) return true
  if (!isRecord(event.rawInput)) return false

  return (
    event.rawInput.server === ACTIVITY_GROUP_MCP_SERVER_NAME &&
    event.rawInput.tool === BEGIN_ACTIVITY_GROUP_TOOL_NAME
  )
}

export const getActivityGroupTitleFromToolEvent = (
  event: ActivityGroupToolEvent
): string | undefined => {
  if (!isActivityGroupToolEvent(event) || !isRecord(event.rawInput)) return undefined

  const input =
    isRecord(event.rawInput.arguments) && event.rawInput.server === ACTIVITY_GROUP_MCP_SERVER_NAME
      ? event.rawInput.arguments
      : event.rawInput

  return sanitizeActivityGroupTitle(input.title)
}
