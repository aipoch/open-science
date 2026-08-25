import { createLogger, flushLogs, initLogger, type Logger } from '../logger'
import { flushDiagnosticsWithTimeout, type DiagnosticFlushOutcome } from './flush'
import { startDiagnosticOperation, type DiagnosticOperation } from './operation'

type ApplicationDiagnosticMetadata = {
  logDir: string
  runId?: string
  mirrorToConsole?: boolean
  version: string
  isPackaged: boolean
  platform: NodeJS.Platform
  arch: string
  electronVersion: string
  nodeVersion: string
  cpuUsage?: () => { user: number; system: number }
}

export type ApplicationDiagnostics = {
  log: Logger
  operation: DiagnosticOperation
  flush: () => Promise<void>
}

export const initializeApplicationDiagnostics = (
  metadata: ApplicationDiagnosticMetadata
): ApplicationDiagnostics => {
  initLogger({
    logDir: metadata.logDir,
    ...(metadata.runId === undefined ? {} : { runId: metadata.runId }),
    ...(metadata.mirrorToConsole === undefined ? {} : { mirrorToConsole: metadata.mirrorToConsole })
  })
  const log = createLogger('main')
  const operation = startDiagnosticOperation(log, {
    operation: 'application-startup',
    fields: {
      platform: metadata.platform,
      arch: metadata.arch,
      isPackaged: metadata.isPackaged
    },
    ...(metadata.cpuUsage ? { cpuUsage: metadata.cpuUsage } : {})
  })
  log.info('app starting', {
    logSchemaVersion: 1,
    version: metadata.version,
    isPackaged: metadata.isPackaged,
    platform: metadata.platform,
    arch: metadata.arch,
    electron: metadata.electronVersion,
    node: metadata.nodeVersion
  })
  return { log, operation, flush: flushLogs }
}

export const reportApplicationStartupFailure = async (input: {
  operation?: DiagnosticOperation
  error: unknown
  flush: () => Promise<void>
  timeoutMs?: number
}): Promise<DiagnosticFlushOutcome> => {
  input.operation?.fail(input.error)
  return flushDiagnosticsWithTimeout(input.flush, input.timeoutMs ?? 1_000)
}
