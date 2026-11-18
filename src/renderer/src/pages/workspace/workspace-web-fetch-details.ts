import type { ToolActivity } from '@/stores/session-store-contract'
import { parseWebResult, type WebResult } from '../../../../shared/web-tools'
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

const readEnvelope = (value: unknown, depth = 0): WebResult | undefined => {
  if (depth > 4) return undefined
  if (typeof value === 'string') {
    if (value.length > 16_000) return undefined
    try {
      return readEnvelope(JSON.parse(value) as unknown, depth + 1)
    } catch {
      return undefined
    }
  }
  const parsed = parseWebResult(value)
  if (parsed) return parsed
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const wrapper = value as Record<string, unknown>
  for (const nested of [wrapper.structuredContent, wrapper.result, wrapper.content]) {
    if (Array.isArray(nested)) {
      for (const block of nested) {
        if (block && typeof block === 'object' && 'text' in block) {
          const result = readEnvelope(block.text, depth + 1)
          if (result) return result
        }
      }
    } else {
      const result = readEnvelope(nested, depth + 1)
      if (result) return result
    }
  }
  return undefined
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
    const result = readEnvelope(candidate)
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
