export const APPLICATION_COMMAND_ERROR_CODES = [
  'invalid-command-arguments',
  'invalid-command-result',
  'command-unavailable',
  'command-failed',
  'session-details-conflict',
  'session-size-limit',
  'session-revision-conflict',
  'csl-file-too-large',
  'csl-invalid-xml',
  'csl-unsupported-doctype',
  'csl-unsupported-style',
  'csl-missing-metadata',
  'csl-dependent-style',
  'csl-undefined-macro',
  'csl-missing-sections'
] as const

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

export const isApplicationCommandErrorCode = (
  value: unknown
): value is ApplicationCommandErrorCode => typeof value === 'string' && errorCodes.has(value)

export class ApplicationCommandError extends Error {
  constructor(
    readonly code: ApplicationCommandErrorCode,
    message: string,
    readonly parameters?: Readonly<{ macro: string }>
  ) {
    super(message)
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
      : {
          code: 'command-failed' as const,
          message: error instanceof Error ? error.message : String(error)
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
