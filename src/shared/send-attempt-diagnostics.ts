export const SEND_ATTEMPT_PHASES = [
  'send',
  'bind-session',
  'hydrate-session',
  'resume-session',
  'create-session',
  'archive-availability',
  'previous-resume',
  'previous-turn',
  'runtime-initialization',
  'resume-cleanup',
  'reconnect-barrier',
  'acp-connect',
  'acp-spawn',
  'acp-initialize',
  'resume-deadline',
  'acp-authenticate',
  'acp-provider-configuration',
  'acp-resume',
  'checkpoint-lock',
  'adopt-replacement',
  'acp-session-new',
  'acp-timeout-cleanup',
  'prepare-attachments',
  'flush-before-send',
  'prepare-prompt',
  'append-user',
  'flush-before-dispatch',
  'save-session',
  'wait-terminal-write',
  'retry-terminal-write',
  'wait-save-lane',
  'wait-session-export',
  'persist-session',
  'commit-session',
  'dispatch-prompt',
  'prompt-admission',
  'acp-session-prompt',
  'first-output',
  'turn-terminal',
  'composer-feedback'
] as const

export type SendAttemptPhase = (typeof SEND_ATTEMPT_PHASES)[number]
export type SendAttemptResult =
  'started' | 'completed' | 'failed' | 'timed-out' | 'cancelled' | 'late-result'
export type SendAttemptMode = 'new-session' | 'existing-session' | 'branch-to-new-session'
export type SendAttemptDetail =
  | 'reuse-live'
  | 'resume-required'
  | 'session/load'
  | 'session/resume'
  | 'session/new'
  | 'requested-fresh'
  | 'incompatible-runtime'
  | 'resume-rejected'
  | 'acknowledged'
  | 'reconciled'
  | 'unconfirmed'
  | 'draft-restored'
  | 'draft-preserved'
  | 'error-reported'
  | 'no-output'

export type SendAttemptIdentity = { sendAttemptId: string; promptMessageId: string }
export type SendAttemptScope = SendAttemptIdentity & { projectId?: string; sessionId?: string }
export type SendAttemptEvent = SendAttemptScope & {
  phase: SendAttemptPhase
  result: SendAttemptResult
  mode?: SendAttemptMode
  detail?: SendAttemptDetail
  operationId?: string
  durationMs?: number
  timeoutMs?: number
}
export type SendAttemptFields = Omit<SendAttemptEvent, keyof SendAttemptScope>

export const isSendDiagnosticId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)

export const readSendAttemptIdentity = (value: unknown): SendAttemptIdentity | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { sendAttemptId, promptMessageId } = value as Partial<SendAttemptIdentity>
  if (!isSendDiagnosticId(sendAttemptId) || !isSendDiagnosticId(promptMessageId)) return undefined
  return { sendAttemptId, promptMessageId }
}

export const readSendAttemptEvent = (value: unknown): SendAttemptEvent | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const event = { ...value } as SendAttemptEvent
  const ids = readSendAttemptIdentity(event)
  if (
    !ids ||
    Object.keys(event).some(
      (key) =>
        ![
          'sendAttemptId',
          'promptMessageId',
          'projectId',
          'sessionId',
          'phase',
          'result',
          'mode',
          'detail',
          'operationId',
          'durationMs',
          'timeoutMs'
        ].includes(key)
    )
  )
    return undefined
  if (
    (event.projectId !== undefined && !isSendDiagnosticId(event.projectId)) ||
    (event.sessionId !== undefined && !isSendDiagnosticId(event.sessionId)) ||
    (event.operationId !== undefined && !isSendDiagnosticId(event.operationId)) ||
    !SEND_ATTEMPT_PHASES.includes(event.phase) ||
    !['started', 'completed', 'failed', 'timed-out', 'cancelled', 'late-result'].includes(
      event.result
    ) ||
    (event.mode !== undefined &&
      !['new-session', 'existing-session', 'branch-to-new-session'].includes(event.mode)) ||
    (event.detail !== undefined &&
      ![
        'reuse-live',
        'resume-required',
        'session/load',
        'session/resume',
        'session/new',
        'requested-fresh',
        'incompatible-runtime',
        'resume-rejected',
        'acknowledged',
        'reconciled',
        'unconfirmed',
        'draft-restored',
        'draft-preserved',
        'error-reported',
        'no-output'
      ].includes(event.detail)) ||
    [event.durationMs, event.timeoutMs].some(
      (ms) => ms !== undefined && (!Number.isSafeInteger(ms) || ms < 0)
    )
  )
    return undefined
  return event
}

export function startSendAttemptPhase(
  emit: (fields: SendAttemptFields) => void,
  phase: SendAttemptPhase,
  metadata: Pick<SendAttemptFields, 'detail' | 'timeoutMs'> = {}
): (result: Exclude<SendAttemptResult, 'started'>, detail?: SendAttemptDetail) => void {
  const started = performance.now()
  emit({ phase, result: 'started', ...metadata })
  return (result, detail) =>
    emit({
      phase,
      result,
      ...metadata,
      ...(detail ? { detail } : {}),
      durationMs: Math.max(0, Math.round(performance.now() - started))
    })
}

export function classifySendAttemptError(error: unknown): 'failed' | 'timed-out' | 'cancelled' {
  if (!(error instanceof Error)) return 'failed'
  if (error.name === 'AbortError') return 'cancelled'
  if (error.name === 'TimeoutError' || /\btimed out\b/i.test(error.message)) return 'timed-out'
  return 'failed'
}

export async function observeSendAttemptWait<Result>(
  finish: (result: 'completed' | 'failed' | 'timed-out' | 'cancelled') => void,
  run: () => Promise<Result>
): Promise<Result> {
  try {
    const result = await run()
    finish('completed')
    return result
  } catch (error) {
    finish(classifySendAttemptError(error))
    throw error
  }
}
