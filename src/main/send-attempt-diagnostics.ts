import { AsyncLocalStorage } from 'node:async_hooks'
import { createLogger } from '@aipoch/diagnostics/node'
import {
  isSendDiagnosticId,
  observeSendAttemptWait,
  readSendAttemptIdentity,
  startSendAttemptPhase,
  type SendAttemptFields,
  type SendAttemptPhase,
  type SendAttemptScope
} from '../shared/send-attempt-diagnostics'

const log = createLogger('send-attempt')
const scope = new AsyncLocalStorage<SendAttemptScope>()

/** Accepts validated diagnostic identities at process boundaries. Authorization stays with the session and runtime. */
export function withSendAttempt<Result>(
  value: unknown,
  ids: { projectId?: string; sessionId?: string; promptMessageId?: string },
  run: () => Result
): Result {
  const identity = readSendAttemptIdentity(value)
  if (!identity || (ids.promptMessageId && identity.promptMessageId !== ids.promptMessageId))
    return run()
  return scope.run(
    {
      ...identity,
      ...(isSendDiagnosticId(ids.projectId) ? { projectId: ids.projectId } : {}),
      ...(isSendDiagnosticId(ids.sessionId) ? { sessionId: ids.sessionId } : {})
    },
    run
  )
}

export const currentSendAttempt = (): SendAttemptScope | undefined => scope.getStore()

export function writeSendAttempt(fields: SendAttemptFields): void {
  const identity = scope.getStore()
  if (!identity) return
  try {
    const level = fields.result === 'failed' || fields.result === 'timed-out' ? 'warn' : 'info'
    log[level]('conversation send phase', { ...identity, ...fields })
  } catch {
    // Logging failures must leave the original operation unaffected.
  }
}

export function startMainSendPhase(
  phase: SendAttemptPhase,
  metadata?: Pick<SendAttemptFields, 'detail' | 'timeoutMs'>
): ReturnType<typeof startSendAttemptPhase> {
  // Capture the phase identity so callbacks from another async entry point can still be correlated.
  const identity = scope.getStore()
  return identity
    ? startSendAttemptPhase(
        (fields) => scope.run(identity, () => writeSendAttempt(fields)),
        phase,
        metadata
      )
    : () => undefined
}

export function traceMainSendWait<Result>(
  phase: SendAttemptPhase,
  run: () => Promise<Result>,
  metadata?: Pick<SendAttemptFields, 'detail' | 'timeoutMs'>
): Promise<Result> {
  return scope.getStore() ? observeSendAttemptWait(startMainSendPhase(phase, metadata), run) : run()
}
