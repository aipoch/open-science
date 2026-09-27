import type { PersistedChatSession } from './session'

export const MAX_PERSISTED_SESSION_BYTES = 256 * 1024 * 1024

export const SESSION_SIZE_LIMIT_ERROR_CODE = 'session-size-limit' as const

export const SESSION_REVISION_CONFLICT_ERROR_CODE = 'session-revision-conflict' as const

export const SESSION_DETAILS_CONFLICT_ERROR_CODE = 'session-details-conflict' as const

export class SessionSizeLimitError extends Error {
  readonly code = SESSION_SIZE_LIMIT_ERROR_CODE

  constructor(readonly maxBytes = MAX_PERSISTED_SESSION_BYTES) {
    super(`Session exceeds the ${maxBytes} byte persistence limit.`)
    this.name = 'SessionSizeLimitError'
  }
}

export const isSessionSizeLimitError = (
  error: unknown
): error is Readonly<{ code: typeof SESSION_SIZE_LIMIT_ERROR_CODE }> =>
  error instanceof SessionSizeLimitError ||
  (typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === SESSION_SIZE_LIMIT_ERROR_CODE)

export class SessionDetailsConflictError extends Error {
  readonly code = SESSION_DETAILS_CONFLICT_ERROR_CODE

  constructor() {
    super('Session details changed elsewhere. Reopen the editor and try again.')
    this.name = 'SessionDetailsConflictError'
  }
}

export const isSessionDetailsConflictError = (
  error: unknown
): error is Readonly<{ code: typeof SESSION_DETAILS_CONFLICT_ERROR_CODE }> =>
  error instanceof SessionDetailsConflictError ||
  (typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === SESSION_DETAILS_CONFLICT_ERROR_CODE)

export class SessionRevisionConflictError extends Error {
  readonly code = SESSION_REVISION_CONFLICT_ERROR_CODE

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(
      `Session revision conflict: expected ${expectedRevision}, actual ${actualRevision}. Reload the latest conversation before retrying.`
    )
    this.name = 'SessionRevisionConflictError'
  }
}

export const sessionRevision = (session: Pick<PersistedChatSession, 'revision'>): number =>
  Number.isSafeInteger(session.revision) && (session.revision ?? -1) >= 0 ? session.revision! : 0

export const isSessionRevisionConflictError = (
  error: unknown
): error is Readonly<{ code: typeof SESSION_REVISION_CONFLICT_ERROR_CODE }> =>
  error instanceof SessionRevisionConflictError ||
  (typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === SESSION_REVISION_CONFLICT_ERROR_CODE) ||
  (error instanceof Error && error.message.includes('Session revision conflict:'))

export class SessionConfigurationBusyError extends Error {
  readonly code = 'session-configuration-busy' as const

  constructor(readonly sessionId: string) {
    super(`Session has active work: ${sessionId}`)
    this.name = 'SessionConfigurationBusyError'
  }
}

export const isSessionConfigurationBusyError = (
  error: unknown
): error is Readonly<{ code: SessionConfigurationBusyError['code']; message: string }> =>
  error instanceof SessionConfigurationBusyError ||
  (typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'session-configuration-busy' &&
    'message' in error &&
    typeof error.message === 'string')
