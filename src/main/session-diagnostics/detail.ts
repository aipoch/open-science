import { homedir } from 'node:os'

import { redactSensitiveText } from '../diagnostic-redaction'

export type DiagnosticTextOptions = {
  configRoot?: string
  dataRoot?: string
  home?: string
}

const MAX_TEXT_CHARS = 4_000
const MAX_ERROR_CHARS = 16_000
const MAX_CAUSE_DEPTH = 4
const TRUNCATED = '…[truncated]'

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const replaceRoot = (text: string, root: string | undefined, marker: string): string => {
  if (!root || /^[\\/]+$/.test(root) || /^[A-Za-z]:[\\/]*$/.test(root)) return text
  const normalized = root.replace(/[\\/]+$/, '')
  const variants = new Set([normalized, normalized.replace(/\\/g, '/')])
  let result = text
  for (const variant of variants) {
    const flags = /^[A-Za-z]:[\\/]/.test(variant) || variant.startsWith('\\\\') ? 'gi' : 'g'
    result = result.replace(new RegExp(`${escapeRegExp(variant)}(?=$|[\\/])`, flags), marker)
  }
  return result
}

const absolutePathMarker = (path: string): string => {
  const tail = path
    .replace(/^file:\/\//i, '')
    .split(/[\\/]/)
    .at(-1)
  return tail ? `<absolute-path>/${tail}` : '<absolute-path>'
}

const redactPaths = (text: string): string =>
  text
    .replace(
      /(["'`])((?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/)[^\r\n]*?)\1/g,
      (_match, quote: string, path: string) => `${quote}${absolutePathMarker(path)}${quote}`
    )
    .replace(
      /\(((?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/)[^\r\n]+)\)/g,
      (_match, path: string) => `(${absolutePathMarker(path)})`
    )
    .replace(/\bfile:\/\/[^\r\n"'<>()[\]{}]+/gi, '<absolute-path>')
    .replace(/\\\\[^\r\n"'<>()[\]{}]+/g, '<absolute-path>')
    .replace(/(^|[\s("'=,[{])\/\/(?!\/)[^\r\n"'<>()[\]{}]*/gm, '$1<absolute-path>')
    .replace(/(^|[\s("'=:,[{])[A-Za-z]:[\\/][^\r\n"'<>()[\]{}]*/gm, '$1<absolute-path>')
    .replace(/(^|[\s("'=:,[{])\/(?!\/)[^\r\n"'<>()[\]{}]*/gm, '$1<absolute-path>')

export function diagnosticText(
  value: string,
  options: DiagnosticTextOptions = {},
  maxChars = MAX_TEXT_CHARS
): string {
  const roots = [
    [options.configRoot, '<config-root>'],
    [options.dataRoot, '<data-root>'],
    [options.home ?? homedir(), '~']
  ] as const
  const withNamedRoots = [...roots]
    .sort(([left], [right]) => (right?.length ?? 0) - (left?.length ?? 0))
    .reduce((text, [root, marker]) => replaceRoot(text, root, marker), value)
  const redacted = redactPaths(redactSensitiveText(withNamedRoots))
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : MAX_TEXT_CHARS
  return redacted.length <= limit
    ? redacted
    : limit > TRUNCATED.length
      ? `${redacted.slice(0, limit - TRUNCATED.length)}${TRUNCATED}`
      : TRUNCATED.slice(0, limit)
}

type DiagnosticRecord = Record<string, unknown>
const object = (value: unknown): DiagnosticRecord | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as DiagnosticRecord)
    : undefined
const read = (source: DiagnosticRecord, key: string): unknown => {
  try {
    return source[key]
  } catch {
    return undefined
  }
}

// Logs can contain native Errors, errorLogFields' flat `{ error, stack, cause }` form,
// or serialized request errors. Only these known diagnostic fields are projected.
export function projectDiagnosticError(
  value: unknown,
  options: DiagnosticTextOptions = {}
): DiagnosticRecord | undefined {
  let remaining = MAX_ERROR_CHARS
  const seen = new Set<object>()
  const text = (value: string, limit = MAX_TEXT_CHARS): string => {
    const projected = diagnosticText(value, options, Math.min(limit, remaining))
    remaining -= projected.length
    return projected
  }
  const project = (value: unknown, depth: number): DiagnosticRecord | undefined => {
    if (remaining <= 0) return { message: '[diagnostic text budget exhausted]' }
    if (depth > MAX_CAUSE_DEPTH) return { message: '[further causes omitted]' }
    if (typeof value === 'string') return { message: text(value) }
    const source = object(value)
    if (!source) return undefined
    if (seen.has(value as object)) return { message: '[circular]' }
    seen.add(value as object)
    const result: DiagnosticRecord = {}
    const rawMessage = read(source, 'message')
    const rawError = read(source, 'error')
    const message = typeof rawMessage === 'string' ? rawMessage : rawError
    if (typeof message === 'string') result.message = text(message)
    for (const key of ['name', 'stack', 'syscall', 'signal', 'details', 'reason'] as const) {
      const candidate = read(source, key)
      if (typeof candidate === 'string')
        result[key] = text(candidate, key === 'stack' ? 8_000 : 2_000)
    }
    for (const key of [
      'code',
      'errno',
      'exitCode',
      'status',
      'statusCode',
      'httpStatus'
    ] as const) {
      const candidate = read(source, key)
      if (typeof candidate === 'number' && Number.isFinite(candidate)) result[key] = candidate
      else if (
        key === 'code' &&
        typeof candidate === 'string' &&
        /^[A-Z][A-Z0-9_]{0,60}$/.test(candidate)
      )
        result[key] = text(candidate, 64)
    }
    if (depth <= MAX_CAUSE_DEPTH) {
      const nestedError = object(rawError) ? project(rawError, depth + 1) : undefined
      if (nestedError) result.error = nestedError
      const rawCause = read(source, 'cause')
      const cause = rawCause === undefined ? undefined : project(rawCause, depth + 1)
      if (cause) result.cause = cause
      // JSON-RPC RequestError.data often holds the actual provider reason. Read only
      // diagnostic fields, never arbitrary response/request payload keys.
      const rawData = read(source, 'data')
      const data = rawData === undefined ? undefined : project(rawData, depth + 1)
      if (data) result.data = data
    }
    seen.delete(value as object)
    return Object.keys(result).length ? result : undefined
  }
  try {
    return project(value, 0)
  } catch {
    // A revoked Proxy or hostile native error must not replace the original failure.
    return { message: '[unreadable error]' }
  }
}
