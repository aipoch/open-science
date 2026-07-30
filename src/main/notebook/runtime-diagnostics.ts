import { errorLogFields, type Logger } from '../logger'

const MAX_RUNTIME_DIAGNOSTIC_CHARS = 7_800
const RUNTIME_DIAGNOSTIC_EDGE_CHARS = 3_800

type RuntimeDiagnosticLogger = Pick<Logger, 'info' | 'warn' | 'error'>

type BoundedRuntimeDiagnostic = {
  text: string
  truncated: boolean
  omittedChars?: number
}

const redactRuntimeDiagnosticText = (value: string): string =>
  value
    .replace(/https?:\/\/[^\s"'<>]+/gi, (rawUrl) => {
      try {
        const url = new URL(rawUrl)
        url.username = ''
        url.password = ''
        url.pathname = url.pathname.replace(
          /\/(t|token|auth|api[_-]?key|secret|password)\/[^/]+/gi,
          '/$1/[redacted]'
        )
        for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[redacted]')
        url.hash = ''
        return url.toString().replaceAll('%5Bredacted%5D', '[redacted]')
      } catch {
        return rawUrl
      }
    })
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|token|secret|password)\b(\s*[:=]\s*)[^\s,"'&]+/gi, '$1$2[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')

const redactRuntimeDiagnosticValue = (value: unknown): unknown => {
  if (typeof value === 'string') return redactRuntimeDiagnosticText(value)
  if (Array.isArray(value)) return value.map(redactRuntimeDiagnosticValue)
  if (value === null || typeof value !== 'object') return value
  try {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactRuntimeDiagnosticValue(nested)])
    )
  } catch {
    return '[unreadable]'
  }
}

const boundedRuntimeDiagnostic = (value: string): BoundedRuntimeDiagnostic => {
  const redacted = redactRuntimeDiagnosticText(value)
  if (redacted.length <= MAX_RUNTIME_DIAGNOSTIC_CHARS) {
    return { text: redacted, truncated: false }
  }
  const omittedChars = redacted.length - RUNTIME_DIAGNOSTIC_EDGE_CHARS * 2
  return {
    text:
      `${redacted.slice(0, RUNTIME_DIAGNOSTIC_EDGE_CHARS)}\n` +
      `…[${omittedChars} chars omitted]…\n` +
      redacted.slice(-RUNTIME_DIAGNOSTIC_EDGE_CHARS),
    truncated: true,
    omittedChars
  }
}

const safeChildField = (error: unknown, key: string): unknown => {
  try {
    return error !== null && typeof error === 'object'
      ? (error as Record<string, unknown>)[key]
      : undefined
  } catch {
    return '[unreadable]'
  }
}

const runtimeChildProcessErrorFields = (error: unknown): Record<string, unknown> => {
  const fields = redactRuntimeDiagnosticValue(errorLogFields(error)) as Record<string, unknown>
  for (const key of ['signal', 'killed'] as const) {
    const value = safeChildField(error, key)
    if (value !== undefined) fields[key] = redactRuntimeDiagnosticValue(value)
  }
  for (const key of ['stdout', 'stderr', 'cmd'] as const) {
    const value = safeChildField(error, key)
    if (typeof value === 'string') fields[key] = boundedRuntimeDiagnostic(value)
    else if (Buffer.isBuffer(value)) fields[key] = boundedRuntimeDiagnostic(value.toString('utf8'))
    else if (value !== undefined) fields[key] = redactRuntimeDiagnosticValue(value)
  }
  return fields
}

export {
  boundedRuntimeDiagnostic,
  redactRuntimeDiagnosticText,
  redactRuntimeDiagnosticValue,
  runtimeChildProcessErrorFields
}
export type { BoundedRuntimeDiagnostic, RuntimeDiagnosticLogger }
