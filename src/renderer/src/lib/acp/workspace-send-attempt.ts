import {
  isSendDiagnosticId,
  observeSendAttemptWait,
  startSendAttemptPhase,
  type SendAttemptDetail,
  type SendAttemptFields,
  type SendAttemptIdentity,
  type SendAttemptMode,
  type SendAttemptPhase
} from '../../../../shared/send-attempt-diagnostics'

const sending = new Map<string, SendAttemptIdentity>()

export const workspaceMessageSendAttempt = (
  sessionId: string,
  promptMessageId: string | undefined
): SendAttemptIdentity | undefined => {
  const owner = sending.get(sessionId)
  return owner?.promptMessageId === promptMessageId ? owner : undefined
}

export function createWorkspaceSendAttempt(
  promptMessageId: string,
  mode: SendAttemptMode,
  projectId?: string,
  sessionId?: string
): {
  identity?: SendAttemptIdentity
  bind: (sessionId: string, projectId?: string) => void
  release: () => void
  start: (
    phase: SendAttemptPhase,
    metadata?: Pick<SendAttemptFields, 'detail' | 'timeoutMs'>
  ) => ReturnType<typeof startSendAttemptPhase>
  wait: <Result>(
    phase: SendAttemptPhase,
    run: () => Promise<Result>,
    detail?: SendAttemptDetail
  ) => Promise<Result>
  record: (fields: SendAttemptFields) => void
} {
  const identity =
    typeof window !== 'undefined' &&
    window.api?.diagnostics?.reportRendererFailure &&
    isSendDiagnosticId(promptMessageId)
      ? { sendAttemptId: crypto.randomUUID(), promptMessageId }
      : undefined
  const owned = new Set<string>()
  const record = (fields: SendAttemptFields): void => {
    if (!identity) return
    try {
      window.api.diagnostics?.reportRendererFailure({
        source: 'handled-error',
        surface: 'workspace',
        errorCategory: 'unknown',
        sendAttempt: {
          ...identity,
          mode,
          ...(isSendDiagnosticId(sessionId) ? { sessionId } : {}),
          ...(isSendDiagnosticId(projectId) ? { projectId } : {}),
          ...fields
        }
      })
    } catch {
      // Continue sending if the diagnostics bridge is unavailable.
    }
  }
  const bind = (id: string, project?: string): void => {
    sessionId = id
    projectId = project ?? projectId
    if (!identity) return
    sending.set(id, identity)
    owned.add(id)
  }
  if (sessionId) bind(sessionId)
  return {
    identity,
    bind,
    record,
    release: () => {
      for (const id of owned) if (sending.get(id) === identity) sending.delete(id)
    },
    start: (phase, metadata) =>
      identity ? startSendAttemptPhase(record, phase, metadata) : () => undefined,
    wait: (phase, run, detail) =>
      identity
        ? observeSendAttemptWait(startSendAttemptPhase(record, phase, { detail }), run)
        : run()
  }
}

export type WorkspaceSendAttemptTrace = ReturnType<typeof createWorkspaceSendAttempt>
