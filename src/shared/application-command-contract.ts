export const APPLICATION_COMMAND_ERROR_CODES = [
  'invalid-command-arguments',
  'invalid-command-result',
  'command-unavailable',
  'command-failed',
  'session-details-conflict',
  'session-size-limit',
  'session-revision-conflict'
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
    message: string
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
      ? { code: error.code, message: error.message }
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

export const unwrapApplicationCommandOutcome = <Result>(value: unknown): Result => {
  if (!value || typeof value !== 'object' || !('ok' in value)) throw invalidOutcome()
  if (value.ok === true && 'result' in value) return value.result as Result
  if (
    value.ok === false &&
    'error' in value &&
    value.error != null &&
    typeof value.error === 'object' &&
    'code' in value.error &&
    isApplicationCommandErrorCode(value.error.code) &&
    'message' in value.error &&
    typeof value.error.message === 'string'
  ) {
    throw new ApplicationCommandError(value.error.code, value.error.message)
  }
  throw invalidOutcome()
}
