import { channel } from 'node:diagnostics_channel'

export type SkillDiagnostic = {
  scope: string
  level: 'info' | 'warn'
  message: string
  fields?: unknown
}
const diagnostics = channel('@aipoch/skills/diagnostics')
export const subscribeSkillDiagnostics = (
  listener: (entry: SkillDiagnostic) => void
): (() => void) => {
  const receive = (entry: unknown): void => listener(entry as SkillDiagnostic)
  diagnostics.subscribe(receive)
  return () => diagnostics.unsubscribe(receive)
}
export const createLogger = (
  scope: string
): {
  info(message: string, fields?: unknown): void
  warn(message: string, fields?: unknown): void
} => ({
  info: (message, fields) => diagnostics.publish({ scope, level: 'info', message, fields }),
  warn: (message, fields) => diagnostics.publish({ scope, level: 'warn', message, fields })
})

export const diagnosticErrorFields = (error: unknown): { errorCategory: string } => {
  try {
    if (error === null) return { errorCategory: 'null' }

    const type = typeof error
    if (type !== 'object' && type !== 'function') return { errorCategory: type }

    const code = Reflect.get(error as object, 'code')
    if (typeof code === 'number' && Number.isFinite(code)) {
      return { errorCategory: 'request' }
    }
    if (typeof code === 'string') {
      if (code === 'ENOENT' || code === 'ENOTDIR') return { errorCategory: 'not-found' }
      if (code === 'EACCES' || code === 'EPERM') return { errorCategory: 'permission' }
      if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
        return { errorCategory: 'timeout' }
      }
      if (
        code === 'ECONNREFUSED' ||
        code === 'ECONNRESET' ||
        code === 'ENETUNREACH' ||
        code === 'EHOSTUNREACH' ||
        code === 'EAI_AGAIN'
      ) {
        return { errorCategory: 'network' }
      }
      if (code.length <= 64 && /^(?:E[A-Z0-9_]+|ERR_[A-Z0-9_]+)$/.test(code)) {
        return { errorCategory: 'system' }
      }
    }

    const name = Reflect.get(error as object, 'name')
    const categoriesByName: Record<string, string> = {
      AbortError: 'aborted',
      AggregateError: 'aggregate',
      Error: 'error',
      RangeError: 'range',
      ReferenceError: 'reference',
      RequestError: 'request',
      SyntaxError: 'syntax',
      SystemError: 'system',
      TimeoutError: 'timeout',
      TypeError: 'type',
      URIError: 'uri'
    }
    if (typeof name === 'string' && Object.hasOwn(categoriesByName, name)) {
      return { errorCategory: categoriesByName[name] }
    }

    return { errorCategory: 'object' }
  } catch {
    return { errorCategory: 'unknown' }
  }
}
