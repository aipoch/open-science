import { REDACTED_MARKER, isSensitiveDiagnosticKey, redactSensitiveText } from '@aipoch/diagnostics'
import {
  webResultSchema,
  WEB_RESULT_MAX_BYTES,
  WEB_RESULT_MAX_CODE_UNITS,
  type WebResult
} from './web-tools'

const MAX_TOOL_DETAIL_TEXT_CHARS = 16_000
const MAX_TOOL_DETAIL_CONTENT_CHARS = 32_000

// Long immutable source is revalidated at several transport and persistence boundaries. Reuse
// only exact fixed points of the existing redactor; never retain changed/unredacted credentials.
// ponytail: bounded per-process reuse, not a source store or an authorization cache.
const unchangedLongToolTexts = new Set<string>()
let unchangedLongToolTextChars = 0
const MAX_UNCHANGED_TOOL_TEXT_CHARS = 16 * 1024 * 1024
const redactToolPayloadText = (value: string): string => {
  const cacheable = value.length >= 16_000 && value.length <= 1024 * 1024
  if (cacheable && unchangedLongToolTexts.delete(value)) {
    unchangedLongToolTexts.add(value)
    return value
  }
  const redacted = redactSensitiveText(value)
  if (cacheable && redacted === value) {
    unchangedLongToolTexts.add(value)
    unchangedLongToolTextChars += value.length
    while (
      unchangedLongToolTexts.size > 64 ||
      unchangedLongToolTextChars > MAX_UNCHANGED_TOOL_TEXT_CHARS
    ) {
      const oldest = unchangedLongToolTexts.values().next().value!
      unchangedLongToolTexts.delete(oldest)
      unchangedLongToolTextChars -= oldest.length
    }
  }
  return redacted
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const capToolDetailText = (text: string): string =>
  text.length > MAX_TOOL_DETAIL_TEXT_CHARS
    ? `${text.slice(0, MAX_TOOL_DETAIL_TEXT_CHARS)}\n…`
    : text

// Keep known Web envelopes structurally complete after credential redaction expands text. This
// is a display projection only; execution arguments, receipts and snapshot hashes are immutable.
const sanitizeWebResultText = (text: string): string | undefined => {
  if (text.length > WEB_RESULT_MAX_CODE_UNITS) return undefined
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return undefined
  }
  const parsed = webResultSchema.safeParse(value)
  if (!parsed.success) return undefined
  const projected = sanitizeRawToolPayload(parsed.data, 256 * 1024) as WebResult | undefined
  if (!projected) return undefined
  // This closed enum is a category, not an authentication credential. The generic key policy
  // deliberately redacts unknown auth_* fields, so restore only this validated metadata value.
  if (projected.provider && parsed.data.provider)
    projected.provider.auth_mode = parsed.data.provider.auth_mode
  projected.attempts?.forEach((attempt, index) => {
    const original = parsed.data.attempts?.[index]
    if (original) {
      attempt.provider.auth_mode = original.provider.auth_mode
      // Restore only the closed numeric metering fields that the generic token-key policy
      // can redact. Cost labels/version strings still pass through ordinary secret redaction.
      if (original.usage && attempt.usage) {
        for (const field of [
          'input_tokens',
          'output_tokens',
          'total_tokens',
          'search_requests',
          'credits'
        ] as const) {
          const value = original.usage[field]
          if (value !== undefined) attempt.usage[field] = value
        }
      }
    }
  })
  if (projected.synthesis)
    projected.synthesis.text = [...projected.synthesis.text].slice(0, 2000).join('')
  const serialize = (): string => JSON.stringify(projected)
  const fits = (serialized: string): boolean =>
    serialized.length <= WEB_RESULT_MAX_CODE_UNITS &&
    new TextEncoder().encode(serialized).length <= WEB_RESULT_MAX_BYTES &&
    JSON.stringify({ type: 'content', content: { type: 'text', text: serialized } }).length <=
      MAX_TOOL_DETAIL_CONTENT_CHARS
  // Redaction can expand short secrets past per-field limits. Preserve a valid display schema.
  const clip = (value: string, limit: number): string => {
    let clipped = value.slice(0, limit)
    if (/[\uD800-\uDBFF]$/u.test(clipped)) clipped = clipped.slice(0, -1)
    return clipped
  }
  if ('query' in projected.request && projected.request.query !== undefined) {
    projected.request.query = Array.from(projected.request.query.trim()).slice(0, 2000).join('')
  }
  for (const source of projected.sources) {
    if (source.title) {
      if (source.title.length > 512) projected.results_truncated = true
      source.title = clip(source.title, 512)
    }
    if (source.snippet) {
      if (source.snippet.length > 8000) projected.results_truncated = true
      source.snippet = clip(source.snippet, 8000)
    }
  }
  let serialized = serialize()
  if (fits(serialized)) return webResultSchema.safeParse(projected).success ? serialized : undefined
  if (projected.operation === 'search') {
    projected.results_truncated = true
    delete projected.synthesis
    // Reduce excerpts first, retaining source identities and their ranking whenever possible.
    const excerpts = projected.sources.map((source) => Array.from(source.snippet ?? ''))
    let low = 0
    let high = Math.max(0, ...excerpts.map((points) => points.length))
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      projected.sources.forEach((source, index) => {
        if (source.snippet !== undefined) source.snippet = excerpts[index].slice(0, middle).join('')
      })
      if (fits(serialize())) low = middle
      else high = middle - 1
    }
    projected.sources.forEach((source, index) => {
      if (source.snippet !== undefined) source.snippet = excerpts[index].slice(0, low).join('')
    })
    while (!fits(serialize()) && projected.sources.length > 0) projected.sources.pop()
    projected.returned_count = projected.sources.length
    serialized = serialize()
  }
  if (projected.document) {
    const document = projected.document
    const points = Array.from(document.text)
    document.truncated = true
    delete document.next_cursor
    let low = 0
    let high = points.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      document.text = points.slice(0, middle).join('')
      if (fits(serialize())) low = middle
      else high = middle - 1
    }
    document.text = points.slice(0, low).join('')
    document.end_line = document.text
      ? document.start_line + document.text.split('\n').length - 1
      : Math.max(0, document.start_line - 1)
    serialized = serialize()
  }
  // Metadata alone can exhaust the budget. Fall back through the ordinary redacted text path.
  return fits(serialized) && webResultSchema.safeParse(projected).success ? serialized : undefined
}

const sanitizeToolDetailText = (text: string): string =>
  sanitizeWebResultText(text) ?? capToolDetailText(redactSensitiveText(capToolDetailText(text)))

const asSanitizedString = (value: unknown): string | undefined => {
  const text = asString(value)
  return text ? sanitizeToolDetailText(text) : undefined
}

const sanitizeContentBlock = (block: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(block)) return undefined

  switch (asString(block.type)) {
    case 'text': {
      const text = asSanitizedString(block.text)
      return text !== undefined ? { type: 'text', text } : undefined
    }
    case 'resource_link': {
      const uri = asSanitizedString(block.uri)
      if (!uri) return undefined

      const link: Record<string, unknown> = { type: 'resource_link', uri }
      const name = asSanitizedString(block.name)
      const title = asSanitizedString(block.title)
      if (name) link.name = name
      if (title) link.title = title
      return link
    }
    case 'resource': {
      if (!isRecord(block.resource)) return undefined

      const uri = asSanitizedString(block.resource.uri)
      const text = asSanitizedString(block.resource.text)
      const resource: Record<string, unknown> = {}
      if (uri) resource.uri = uri
      if (text !== undefined) resource.text = text
      return Object.keys(resource).length > 0 ? { type: 'resource', resource } : undefined
    }
    default:
      return undefined
  }
}

const sanitizeToolContentEntry = (entry: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(entry)) return undefined

  const type = asString(entry.type)
  if (type === 'content') {
    const content = sanitizeContentBlock(entry.content)
    return content ? { type: 'content', content } : undefined
  }
  if (type === 'diff') {
    const path = asSanitizedString(entry.path)
    if (!path) return undefined

    const oldText = asString(entry.oldText)
    return {
      type: 'diff',
      path,
      oldText: oldText !== undefined ? sanitizeToolDetailText(oldText) : null,
      newText: sanitizeToolDetailText(asString(entry.newText) ?? '')
    }
  }

  return undefined
}

// Bounds the same live and persisted tool-detail projection before it reaches IPC or disk.
const sanitizeToolContent = (value: unknown): unknown[] | undefined => {
  if (!Array.isArray(value)) return undefined

  const entries: unknown[] = []
  let usedChars = 0
  for (const rawEntry of value) {
    const entry = sanitizeToolContentEntry(rawEntry)
    if (!entry) continue

    usedChars += JSON.stringify(entry).length
    if (usedChars > MAX_TOOL_DETAIL_CONTENT_CHARS) break
    entries.push(entry)
  }

  return entries.length > 0 ? entries : undefined
}

// Host-owned Notebook reviews carry executable source rather than a generic tool preview.
// Bound evidence independently so long source survives transport and restart without unbounded JSON.
const sanitizeNotebookCodeReviewPayload = (value: unknown): unknown | undefined => {
  if (!isRecord(value) || typeof value.code !== 'string' || value.code.length > 1024 * 1024)
    return undefined
  const review = value.notebookCodeRisk
  if (
    !isRecord(review) ||
    typeof review.language !== 'string' ||
    !['python', 'r', 'repl', 'bash'].includes(review.language) ||
    !Array.isArray(review.risks) ||
    !review.risks.length ||
    !review.risks.every(
      (risk) =>
        isRecord(risk) &&
        typeof risk.operation === 'string' &&
        typeof risk.source === 'string' &&
        Number.isInteger(risk.line) &&
        (risk.line as number) > 0
    )
  )
    return undefined
  const metadata = Object.fromEntries(
    ['runId', 'environment', 'runtimeId'].flatMap((key) =>
      typeof review[key] === 'string' ? [[key, review[key].slice(0, 1024)]] : []
    )
  )
  return sanitizeRawToolPayload(
    {
      code: value.code,
      notebookCodeRisk: {
        ...metadata,
        language: review.language,
        ...(review.language === 'bash' &&
        isRecord(review.shellRuntime) &&
        review.shellRuntime.kind === 'powershell'
          ? { shellRuntime: { kind: 'powershell' } }
          : {}),
        riskCount: Math.max(
          review.risks.length,
          Number.isSafeInteger(review.riskCount) && (review.riskCount as number) <= 100_000
            ? (review.riskCount as number)
            : 0
        ),
        risks: review.risks.slice(0, 128).map((risk) => ({
          operation: risk.operation.slice(0, 512),
          source: risk.source.slice(0, 1024),
          line: risk.line
        }))
      }
    },
    8 * 1024 * 1024
  )
}

// Rebuilds a bounded JSON-safe projection while replacing sensitive fields at every nesting level.
const sanitizeRawToolPayload = (
  value: unknown,
  maxSerializedChars: number
): unknown | undefined => {
  if (value === undefined || value === null) return undefined

  try {
    const serialized = JSON.stringify(value, (key, nestedValue) => {
      if (key && isSensitiveDiagnosticKey(key)) return REDACTED_MARKER
      return typeof nestedValue === 'string' ? redactToolPayloadText(nestedValue) : nestedValue
    })

    if (serialized === undefined || serialized.length > maxSerializedChars) return undefined

    return JSON.parse(serialized) as unknown
  } catch {
    return undefined
  }
}

export {
  capToolDetailText,
  sanitizeRawToolPayload,
  sanitizeToolContent,
  sanitizeToolDetailText,
  sanitizeNotebookCodeReviewPayload,
  sanitizeWebResultText
}
