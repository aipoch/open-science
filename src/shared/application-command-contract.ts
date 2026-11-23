import { redactSensitiveText } from '@aipoch/diagnostics'

export const APPLICATION_COMMAND_ERROR_CODES = [
  'invalid-command-arguments',
  'invalid-command-result',
  'command-unavailable',
  'command-failed',
  'schedule-conflict',
  'schedule-pending',
  'schedule-running',
  'schedule-limit-reached',
  'schedule-no-future-run',
  'schedule-outside-window',
  'schedule-invalid-change',
  'schedule-target-unavailable',
  'schedule-request-conflict',
  'SESSION_HISTORY_CURSOR_STALE',
  'session-file-missing',
  'session-file-unreadable',
  'session-file-corrupt',
  'session-file-unsupported-version',
  'session-file-too-large',
  'response-too-large',
  'desktop-runtime-disconnected',
  'desktop-runtime-not-submitted',
  'literature-metadata-temporarily-unavailable',
  'settings-storage-unavailable',
  'settings-invalid',
  'settings-credential-unavailable',
  'session-details-conflict',
  'session-size-limit',
  'session-package-busy',
  'session-package-source-unavailable',
  'session-package-invalid-archive',
  'session-revision-conflict',
  'SESSION_RUNTIME_WRITER_LOST',
  'csl-file-too-large',
  'csl-invalid-xml',
  'csl-unsupported-doctype',
  'csl-unsupported-style',
  'csl-missing-metadata',
  'csl-dependent-style',
  'csl-undefined-macro',
  'csl-missing-sections'
] as const

export const isSessionReadChannel = (channel: string): boolean =>
  channel === 'sessions:load-one' || channel === 'sessions:load-history-page'

export type ApplicationCommandErrorCode = (typeof APPLICATION_COMMAND_ERROR_CODES)[number]

export type RuntimeCodec<Value> = Readonly<{
  parse: (value: unknown) => Value
}>

export const validationCodec = <Value>(codec: RuntimeCodec<Value>): RuntimeCodec<Value> =>
  Object.freeze({
    parse: (value): Value => {
      codec.parse(value)
      return value as Value
    }
  })

export type ApplicationCommandContract<Args extends readonly unknown[], Result> = Readonly<{
  args: RuntimeCodec<Args>
  result: RuntimeCodec<Result>
}>

// Domain modules compose runtime-validated command contracts with this helper so arg/result codecs
// stay colocated with the shared domain types they parse.
export const defineApplicationCommandContract = <Args extends readonly unknown[], Result>(
  args: ApplicationCommandContract<Args, Result>['args'],
  result: ApplicationCommandContract<Args, Result>['result']
): ApplicationCommandContract<Args, Result> => Object.freeze({ args, result })

export type ApplicationCommandErrorEnvelope = Readonly<{
  code: ApplicationCommandErrorCode
  message: string
  parameters?: Readonly<{ macro: string }>
}>

export type ApplicationCommandOutcome<Result> =
  | Readonly<{ ok: true; result: Result }>
  | Readonly<{ ok: false; error: ApplicationCommandErrorEnvelope }>

const errorCodes = new Set<string>(APPLICATION_COMMAND_ERROR_CODES)

const MAX_PUBLIC_REQUEST_ERROR_DETAIL_LENGTH = 300

const publicRequestErrorDetail = (error: Error): string | undefined => {
  if (error.name !== 'RequestError' || !('code' in error) || error.code !== -32603) return undefined

  const data = 'data' in error ? error.data : undefined
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined

  const details = 'details' in data ? data.details : undefined
  if (typeof details !== 'string') return undefined

  const redacted = redactSensitiveText(details).replace(/\s+/g, ' ').trim()
  if (!redacted) return undefined
  return redacted.length <= MAX_PUBLIC_REQUEST_ERROR_DETAIL_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_PUBLIC_REQUEST_ERROR_DETAIL_LENGTH)}…`
}

const publicErrorMessage = (error: Error): string => {
  const detail = publicRequestErrorDetail(error)
  if (!detail || error.message.includes(detail)) return error.message
  return `${error.message}: ${detail}`
}

export const isApplicationCommandErrorCode = (
  value: unknown
): value is ApplicationCommandErrorCode => typeof value === 'string' && errorCodes.has(value)

export class ApplicationCommandError extends Error {
  constructor(
    readonly code: ApplicationCommandErrorCode,
    message: string,
    readonly parameters?: Readonly<{ macro: string }>,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ApplicationCommandError'
  }
}

export const toApplicationCommandErrorEnvelope = (
  error: unknown
): ApplicationCommandErrorEnvelope =>
  Object.freeze(
    error instanceof ApplicationCommandError
      ? {
          code: error.code,
          message: error.message,
          ...(error.code === 'csl-undefined-macro' && error.parameters
            ? { parameters: { macro: error.parameters.macro } }
            : {})
        }
      : error instanceof Error &&
          'code' in error &&
          (error.code === 'desktop-runtime-disconnected' ||
            error.code === 'desktop-runtime-not-submitted')
        ? { code: error.code, message: error.message }
        : {
            code: 'command-failed' as const,
            message: error instanceof Error ? publicErrorMessage(error) : String(error)
          }
  )

const invalidOutcome = (): ApplicationCommandError =>
  new ApplicationCommandError(
    'invalid-command-result',
    'Application command returned an invalid response.'
  )

export const parseApplicationCommandError = (
  error: unknown
): ApplicationCommandError | undefined => {
  if (
    error != null &&
    typeof error === 'object' &&
    'code' in error &&
    isApplicationCommandErrorCode(error.code) &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    const parameters = 'parameters' in error ? error.parameters : undefined
    if (error.code === 'csl-undefined-macro') {
      if (
        !parameters ||
        typeof parameters !== 'object' ||
        !('macro' in parameters) ||
        typeof parameters.macro !== 'string' ||
        Object.keys(parameters).length !== 1
      )
        return undefined
      return new ApplicationCommandError(error.code, error.message, {
        macro: parameters.macro
      })
    }
    if (parameters !== undefined) return undefined
    return new ApplicationCommandError(error.code, error.message)
  }
  return undefined
}

export const unwrapApplicationCommandOutcome = <Result>(value: unknown): Result => {
  if (!value || typeof value !== 'object' || !('ok' in value)) throw invalidOutcome()
  if (value.ok === true && 'result' in value) return value.result as Result
  if (value.ok === false && 'error' in value) {
    throw parseApplicationCommandError(value.error) ?? invalidOutcome()
  }
  throw invalidOutcome()
}
