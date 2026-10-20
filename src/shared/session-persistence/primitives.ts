import type { AgentFrameworkId } from '../settings'
import type { SessionRuntimeContextValue } from '../session-runtime-context'

export const AGENT_FRAMEWORK_IDS = new Set<AgentFrameworkId>([
  'claude-code',
  'opencode',
  'codex',
  'codebuddy'
])

// Checks for plain JSON objects so persisted payloads can be sanitized safely.
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Reads string fields from untrusted persisted payloads.
export const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

// Reads finite numeric fields from untrusted persisted payloads.
export const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

// Filters mixed arrays down to strings so event and artifact ids stay JSON-safe.
export const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

export const sanitizeRuntimeContextValue = (
  value: unknown,
  budget: { remaining: number },
  depth = 0
): SessionRuntimeContextValue | undefined => {
  if (budget.remaining-- <= 0 || depth > 20) return undefined
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    const result: SessionRuntimeContextValue[] = []
    for (const item of value) {
      const sanitized = sanitizeRuntimeContextValue(item, budget, depth + 1)
      if (sanitized === undefined) return undefined
      result.push(sanitized)
    }
    return result
  }
  if (!isRecord(value)) return undefined

  const result: { [key: string]: SessionRuntimeContextValue } = {}
  for (const [key, item] of Object.entries(value)) {
    const sanitized = sanitizeRuntimeContextValue(item, budget, depth + 1)
    if (sanitized === undefined) return undefined
    Object.defineProperty(result, key, {
      value: sanitized,
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
  return result
}

export const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key))

export const asBoundedString = (value: unknown, maxChars: number): string | undefined => {
  const text = asString(value)
  return text !== undefined && text.length <= maxChars ? text : undefined
}

export const hasOnlyFields = (value: Record<string, unknown>, fields: readonly string[]): boolean =>
  Object.keys(value).every((field) => fields.includes(field))
