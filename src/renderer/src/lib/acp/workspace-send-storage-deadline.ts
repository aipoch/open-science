import type { WorkspaceSendAttemptTrace } from './workspace-send-attempt'
import { classifySendAttemptError } from '../../../../shared/send-attempt-diagnostics'
import type { SessionSendStorageOperation } from '../../../../shared/diagnostics'
import { i18next } from '../../i18n'
import { projectRendererFailure } from '../../renderer-diagnostics'
import { getDesktopRuntimeEpoch } from '../../stores/desktop-runtime-recovery-store'

const SEND_STORAGE_DEADLINE_MS = 15_000

type SendStorageWait = {
  operation: SessionSendStorageOperation
  sessionId: string
  projectId?: string
  promptMessageId: string
}

export class WorkspaceSendStorageTimeout extends Error {
  constructor(readonly wait: SendStorageWait) {
    super(
      wait.operation === 'flush-before-send'
        ? i18next.t('Waiting for earlier conversation changes timed out. Try sending again.')
        : i18next.t('Saving the message before sending timed out. Try sending again.')
    )
    this.name = 'WorkspaceSendStorageTimeout'
  }
}

export async function waitForWorkspaceSendStorage<Result>(
  wait: SendStorageWait,
  work: Promise<Result>,
  trace?: WorkspaceSendAttemptTrace
): Promise<Result> {
  const finish = trace?.start(wait.operation, { timeoutMs: SEND_STORAGE_DEADLINE_MS })
  const startedAt = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new WorkspaceSendStorageTimeout(wait)
          reject(error)
          try {
            window.api?.diagnostics?.reportRendererFailure(
              projectRendererFailure('handled-error', error, 'workspace', 'session-save', {
                target: 'session',
                sessionId: wait.sessionId,
                projectId: wait.projectId,
                code: 'session-save-unconfirmed',
                epoch: getDesktopRuntimeEpoch(),
                phase: 'result-unknown',
                recovery: {
                  event: 'send-timeout',
                  operation: wait.operation,
                  promptMessageId: wait.promptMessageId,
                  elapsedMs: Math.max(0, Math.round(performance.now() - startedAt))
                }
              })
            )
          } catch {
            // 诊断异常不影响发送超时。
          }
        }, SEND_STORAGE_DEADLINE_MS)
      })
    ])
    finish?.('completed', 'acknowledged')
    return result
  } catch (error) {
    finish?.(
      error instanceof WorkspaceSendStorageTimeout ? 'timed-out' : classifySendAttemptError(error)
    )
    throw error
  } finally {
    clearTimeout(timer)
  }
}
