export type ContextOverflowKind = 'context-overflow' | 'compaction-exhausted' | 'payload-overflow'

const codes: Readonly<Record<string, ContextOverflowKind>> = {
  'context-overflow': 'context-overflow',
  'compaction-exhausted': 'compaction-exhausted',
  'payload-overflow': 'payload-overflow',
  context_length_exceeded: 'context-overflow',
  context_window_exceeded: 'context-overflow',
  media_unstrippable: 'compaction-exhausted',
  compaction_exhausted: 'compaction-exhausted',
  request_too_large: 'payload-overflow',
  request_entity_too_large: 'payload-overflow'
}

// Only traverse error envelopes: arbitrary request data can contain quoted failure messages.
export function classifyContextOverflowError(error: unknown): ContextOverflowKind | undefined {
  const seen = new Set<object>()
  const classify = (
    value: unknown,
    depth: number,
    structuredOnly: boolean
  ): ContextOverflowKind | undefined => {
    if (depth > 8) return undefined
    if (typeof value === 'string') {
      if (structuredOnly) return undefined
      if (
        /media[_\s-]?unstrippable|session too large to compact\s*[-–:]\s*context exceeds model limit even after stripping media|conversation history too large to compact\s*[-–:]\s*exceeds model context limit/i.test(
          value
        )
      )
        return 'compaction-exhausted'
      if (/request[_\s-]?(?:entity[_\s-]?)?too[_\s-]?large/i.test(value)) return 'payload-overflow'
      if (
        /maximum context length|context[_\s-]?(?:length|window)[_\s-]?exceeded|prompt is too long/i.test(
          value
        )
      )
        return 'context-overflow'
      return undefined
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return undefined
    seen.add(value)
    const envelope = value as Record<string, unknown>
    for (const key of ['code', 'type', 'errorKind']) {
      const code = envelope[key]
      if (typeof code === 'string' && Object.hasOwn(codes, code)) return codes[code]
    }
    if (!structuredOnly && (envelope.status === 413 || envelope.statusCode === 413))
      return 'payload-overflow'
    for (const key of ['error', 'cause', 'data', 'message']) {
      const result = classify(envelope[key], depth + 1, structuredOnly)
      if (result) return result
    }
    return undefined
  }
  const structured = classify(error, 0, true)
  if (structured) return structured
  seen.clear()
  return classify(error, 0, false)
}

// Compatibility for callers that still display the legacy overflow notice.
export const isMediaOverflowError = (message: string | undefined | null): boolean =>
  classifyContextOverflowError(message) !== undefined
