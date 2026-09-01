import {
  REDACTED_MARKER,
  isSensitiveDiagnosticKey,
  redactSensitiveText
} from './diagnostic-redaction'

const MAX_TOOL_DETAIL_TEXT_CHARS = 16_000
const MAX_TOOL_DETAIL_CONTENT_CHARS = 32_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const capToolDetailText = (text: string): string =>
  text.length > MAX_TOOL_DETAIL_TEXT_CHARS
    ? `${text.slice(0, MAX_TOOL_DETAIL_TEXT_CHARS)}\n…`
    : text

const sanitizeToolDetailText = (text: string): string =>
  capToolDetailText(redactSensitiveText(capToolDetailText(text)))

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

// Rebuilds a bounded JSON-safe projection while replacing sensitive fields at every nesting level.
const sanitizeRawToolPayload = (
  value: unknown,
  maxSerializedChars: number
): unknown | undefined => {
  if (value === undefined || value === null) return undefined

  try {
    const serialized = JSON.stringify(value, (key, nestedValue) => {
      if (key && isSensitiveDiagnosticKey(key)) return REDACTED_MARKER
      return typeof nestedValue === 'string' ? redactSensitiveText(nestedValue) : nestedValue
    })

    if (serialized === undefined || serialized.length > maxSerializedChars) return undefined

    return JSON.parse(serialized) as unknown
  } catch {
    return undefined
  }
}

export { capToolDetailText, sanitizeRawToolPayload, sanitizeToolContent, sanitizeToolDetailText }
