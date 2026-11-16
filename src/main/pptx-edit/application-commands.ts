import { ZodError } from 'zod'

import type { SaveTextEditResult } from '../../shared/managed-file-versions'
import { PptxEditError } from '../../shared/pptx-edit'
import type {
  PptxEditSessionApplyRequest,
  PptxEditSessionOpenRequest,
  PptxEditSessionResult,
  PptxEditSessionSaveRequest,
  PptxEditSessionView
} from '../../shared/pptx-edit-session'
import type { ApplicationCallerLease, ApplicationInvocation } from '../application-command-router'
import { requireDesktopCaller } from '../caller-context'
import { ManagedFileVersionError } from '../managed-file-versions/error'
import { PptxEditSessionError, type PptxEditSessions } from './edit-sessions'

type SessionStore = Pick<
  PptxEditSessions,
  'open' | 'apply' | 'save' | 'close' | 'closeOwner' | 'identityOf'
>

type PptxEditCommandDependencies = {
  sessions: SessionStore
  withDataRootWrite<Result>(write: () => Promise<Result>): Promise<Result>
  onSaved?(request: PptxEditSessionSaveRequest, result: SaveTextEditResult): void
}

export type PptxEditCommands = {
  open(
    invocation: ApplicationInvocation<readonly [PptxEditSessionOpenRequest]>
  ): Promise<PptxEditSessionResult<PptxEditSessionView>>
  apply(
    invocation: ApplicationInvocation<readonly [PptxEditSessionApplyRequest]>
  ): Promise<PptxEditSessionResult<PptxEditSessionView>>
  save(
    invocation: ApplicationInvocation<readonly [PptxEditSessionSaveRequest]>
  ): Promise<PptxEditSessionResult<SaveTextEditResult>>
  close(invocation: ApplicationInvocation<readonly [string]>): Promise<void>
}

const failure = (
  code:
    | 'INVALID_OPERATIONS'
    | 'OPERATION_REJECTED'
    | 'VERSION_UNAVAILABLE'
    | 'SESSION_NOT_FOUND'
    | 'TOO_LARGE',
  message: string
): PptxEditSessionResult<never> => ({
  ok: false,
  error: { code, message }
})

const toFailure = (error: unknown): PptxEditSessionResult<never> => {
  if (error instanceof PptxEditSessionError) return failure(error.code, error.message)
  if (error instanceof ZodError)
    return failure('INVALID_OPERATIONS', 'Edit operations are invalid.')
  if (error instanceof PptxEditError) {
    return failure(
      error.code === 'OUTPUT_TOO_LARGE' ? 'TOO_LARGE' : 'OPERATION_REJECTED',
      error.message
    )
  }
  if (error instanceof ManagedFileVersionError) {
    return failure('VERSION_UNAVAILABLE', 'The file version is not available.')
  }
  throw error
}

const attempt = async <Value>(
  run: () => Promise<Value> | Value
): Promise<PptxEditSessionResult<Value>> => {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return toFailure(error)
  }
}

export const createPptxEditCommands = (
  dependencies: PptxEditCommandDependencies
): PptxEditCommands => {
  const watched = new WeakSet<ApplicationCallerLease>()
  const caller = (
    invocation: ApplicationInvocation<readonly unknown[]>
  ): ApplicationCallerLease => {
    requireDesktopCaller(invocation.callerContext)
    const lease = invocation.callerLease
    if (lease.signal.aborted || !lease.isCurrent())
      throw new Error('Edit caller is no longer valid.')
    if (!watched.has(lease)) {
      watched.add(lease)
      lease.signal.addEventListener('abort', () => dependencies.sessions.closeOwner(lease), {
        once: true
      })
    }
    return lease
  }
  return {
    open: (invocation) =>
      attempt(() => dependencies.sessions.open(caller(invocation), invocation.args[0])),
    apply: (invocation) =>
      attempt(() => dependencies.sessions.apply(caller(invocation), invocation.args[0])),
    save: (invocation) =>
      attempt(async () => {
        const lease = caller(invocation)
        const [request] = invocation.args
        const result = await dependencies.withDataRootWrite(() =>
          dependencies.sessions.save(lease, request)
        )
        dependencies.onSaved?.(request, result)
        return result
      }),
    close: async (invocation) => {
      const [sessionId] = invocation.args
      if (typeof sessionId === 'string') dependencies.sessions.close(caller(invocation), sessionId)
    }
  }
}
