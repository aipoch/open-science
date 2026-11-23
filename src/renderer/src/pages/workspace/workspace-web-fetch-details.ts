import type { ToolActivity } from '@/stores/session-store-contract'
import { readWebResultEnvelope, type WebResult } from '../../../../shared/web-tools'
import { sanitizeToolDetailText } from '../../../../shared/tool-detail-sanitizer'

// The host stamps appOwned after checking the provisioned route. Neither a tool title nor a
// schema embedded in external content establishes that authority.
const isBuiltinWebActivity = (activity: ToolActivity, operation: 'search' | 'fetch'): boolean =>
  activity.appOwned === true &&
  [`mcp__open_science_web__web_${operation}`, `mcp__open-science-web__web_${operation}`].includes(
    activity.providerToolName ?? ''
  ) &&
  Boolean(activity.executionInvocationId)

const isBuiltinWebFetchActivity = (activity: ToolActivity): boolean =>
  isBuiltinWebActivity(activity, 'fetch')

const safeWebUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > 2048) return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      return undefined
    const safe = sanitizeToolDetailText(url.href)
    // Redacted URLs remain readable evidence, but must not become a different outgoing request.
    return safe === url.href ? url.href : undefined
  } catch {
    return undefined
  }
}

const readBuiltinWebResult = (
  activity: ToolActivity,
  operation: 'search' | 'fetch'
): WebResult | undefined => {
  if (!isBuiltinWebActivity(activity, operation)) return undefined
  const candidates: unknown[] = [activity.rawOutput]
  for (const entry of activity.toolContent ?? []) {
    if (entry.type === 'content' && entry.content.type === 'text')
      candidates.push(entry.content.text)
  }
  for (const candidate of candidates) {
    const result = readWebResultEnvelope(candidate)
    if (result?.operation === operation && result.invocation_id === activity.executionInvocationId)
      return result
  }
  return undefined
}

const readWebFetchResult = (activity: ToolActivity): WebResult | undefined =>
  readBuiltinWebResult(activity, 'fetch')

const getWebFetchRequestUrl = (activity: ToolActivity): string | undefined => {
  const input = activity.rawInput
  return input && typeof input === 'object' && !Array.isArray(input) && 'url' in input
    ? safeWebUrl(input.url)
    : undefined
}

export {
  isBuiltinWebFetchActivity,
  isBuiltinWebActivity,
  readBuiltinWebResult,
  readWebFetchResult,
  getWebFetchRequestUrl,
  safeWebUrl
}
