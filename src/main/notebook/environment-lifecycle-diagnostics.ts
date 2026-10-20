import { randomUUID } from 'node:crypto'

import type { NotebookLanguage } from '@aipoch/environment/contracts'
import { createLogger, errorLogFields } from '@aipoch/diagnostics/node'
import type { ProvisionProgress } from '@aipoch/environment/contracts'

type LoggedRuntimeOperation = 'provision' | 'repair'
type RuntimeLogContext = {
  operation: LoggedRuntimeOperation
  language: NotebookLanguage
  root: string
  operationId: string
}

const log = createLogger('notebook-env')

const redactRuntimeLogText = (value: string): string =>
  value
    .replace(/https?:\/\/[^\s"'<>]+/gi, (rawUrl) => {
      try {
        const url = new URL(rawUrl)
        url.username = ''
        url.password = ''
        url.pathname = url.pathname.replace(
          /\/(t|token|auth|api[_-]?key|secret|password)\/[^/]+/gi,
          '/$1/[redacted]'
        )
        for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[redacted]')
        url.hash = ''
        return url.toString()
      } catch {
        return rawUrl
      }
    })
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|token|secret|password)\b(\s*[:=]\s*)[^\s,"'&]+/gi, '$1$2[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')

const redactRuntimeLogValue = (value: unknown): unknown => {
  if (typeof value === 'string') return redactRuntimeLogText(value)
  if (Array.isArray(value)) return value.map(redactRuntimeLogValue)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, redactRuntimeLogValue(nested)])
  )
}

const runtimeErrorLogFields = (error: unknown): Record<string, unknown> =>
  redactRuntimeLogValue(errorLogFields(error)) as Record<string, unknown>

const logRuntimeInfo = (message: string, fields: Record<string, unknown>): void => {
  try {
    log.info(message, redactRuntimeLogValue(fields) as Record<string, unknown>)
  } catch {
    // Diagnostics are best-effort and never interrupt progress delivery.
  }
}

const runLoggedRuntimeOperation = async (
  operation: LoggedRuntimeOperation,
  language: NotebookLanguage,
  root: string,
  run: (report: (progress: ProvisionProgress) => void) => Promise<void>,
  projectProgress: (progress: ProvisionProgress) => void
): Promise<void> => {
  const context: RuntimeLogContext = { operation, language, root, operationId: randomUUID() }
  const startedAt = Date.now()
  let lastPhase: string | undefined
  let lastReconnectAttempt: number | undefined
  logRuntimeInfo('runtime operation started', context)

  const report = (progress: ProvisionProgress): void => {
    projectProgress(progress)
    const reconnectAttempt =
      progress.download?.phase === 'reconnecting' ? progress.download.attempt : undefined
    const phaseChanged = progress.phase !== lastPhase
    const reconnectChanged =
      reconnectAttempt !== undefined && reconnectAttempt !== lastReconnectAttempt
    lastPhase = progress.phase
    if (reconnectAttempt !== undefined) lastReconnectAttempt = reconnectAttempt
    if (!phaseChanged && !reconnectChanged) return

    logRuntimeInfo('runtime operation progress', {
      ...context,
      phase: progress.phase,
      event: progress.event,
      diagnostic: progress.diagnostic,
      progress: progress.progress,
      ...(progress.download ? { download: progress.download } : {})
    })
  }

  try {
    await run(report)
    logRuntimeInfo('runtime operation completed', {
      ...context,
      durationMs: Date.now() - startedAt,
      lastPhase
    })
  } catch (error) {
    if (lastPhase !== 'error') {
      try {
        report({
          phase: 'error',
          diagnostic: redactRuntimeLogText(error instanceof Error ? error.message : String(error)),
          progress: 0,
          language
        })
      } catch {
        // Progress projection is best-effort and must never replace the operation failure.
      }
    }
    try {
      log.error('runtime operation failed', {
        ...runtimeErrorLogFields(error),
        ...context,
        durationMs: Date.now() - startedAt
      })
    } catch {
      // Diagnostics must never replace the original operation error.
    }
    throw error
  }
}

const logStartupGateFailure = (error: unknown): void => {
  try {
    log.error('startup gate failed', runtimeErrorLogFields(error))
  } catch {
    // Diagnostics are best-effort and never suppress the startup progress projection.
  }
}

export { logStartupGateFailure, runLoggedRuntimeOperation }
