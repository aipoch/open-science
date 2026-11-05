import type { Logger } from '@aipoch/diagnostics/node'
import {
  RENDERER_FAILURE_CHANNEL,
  isRendererFailureReport,
  type RendererFailureReport
} from '../shared/diagnostics'

type RendererFailureReporter = {
  report(senderKey: string, value: unknown): 'recorded' | 'rejected' | 'suppressed'
}

type RendererFailureReporterOptions = {
  log: Pick<Logger, 'error' | 'warn'> & Partial<Pick<Logger, 'info'>>
  now?: () => number
  windowMs?: number
  maxReportsPerWindow?: number
  maxRecoveryReportsPerWindow?: number
}

const projectRendererFailureReport = (value: unknown): RendererFailureReport | undefined => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined

    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (
      keys.some(
        (key) =>
          ![
            'source',
            'surface',
            'errorCategory',
            'context',
            'fingerprint',
            'sessionWrite'
          ].includes(key)
      )
    ) {
      return undefined
    }
    if (!keys.includes('source') || !keys.includes('surface') || !keys.includes('errorCategory')) {
      return undefined
    }

    // Snapshot nested metadata before validation so a getter cannot replace a reviewed field
    // with content between validation and logging. Electron normally supplies plain cloned data.
    const rawWrite = keys.includes('sessionWrite') ? record.sessionWrite : undefined
    const sessionWrite =
      rawWrite && typeof rawWrite === 'object' && !Array.isArray(rawWrite)
        ? { ...rawWrite }
        : rawWrite
    if (sessionWrite && typeof sessionWrite === 'object' && 'recovery' in sessionWrite) {
      const recovery = sessionWrite.recovery
      if (recovery && typeof recovery === 'object' && !Array.isArray(recovery))
        sessionWrite.recovery = { ...recovery }
    }
    const candidate = {
      source: record.source,
      surface: record.surface,
      errorCategory: record.errorCategory,
      ...(keys.includes('context') ? { context: record.context } : {}),
      ...(keys.includes('fingerprint') ? { fingerprint: record.fingerprint } : {}),
      ...(keys.includes('sessionWrite') ? { sessionWrite } : {})
    }
    if (!isRendererFailureReport(candidate)) return undefined
    const write = candidate.sessionWrite
    return {
      ...candidate,
      ...(write
        ? {
            sessionWrite: {
              target: write.target,
              code: write.code,
              epoch: write.epoch,
              phase: write.phase,
              ...(write.recovery ? { recovery: { ...write.recovery } } : {}),
              ...(write.sessionId ? { sessionId: write.sessionId } : {}),
              ...(write.projectId ? { projectId: write.projectId } : {})
            }
          }
        : {})
    }
  } catch {
    return undefined
  }
}

export const createRendererFailureReporter = (
  options: RendererFailureReporterOptions
): RendererFailureReporter => {
  const now = options.now ?? Date.now
  const windowMs = options.windowMs ?? 60_000
  const maxReportsPerWindow = options.maxReportsPerWindow ?? 10
  const maxRecoveryReportsPerWindow = options.maxRecoveryReportsPerWindow ?? 120
  const readNow = (): number => {
    try {
      const timestamp = now()
      return Number.isFinite(timestamp) ? timestamp : 0
    } catch {
      return 0
    }
  }
  const warn = (message: string, fields: Record<string, unknown>): void => {
    try {
      options.log.warn(message, fields)
    } catch {
      // Diagnostics must never affect the failure path being observed.
    }
  }
  const error = (message: string, fields: Record<string, unknown>): void => {
    try {
      options.log.error(message, fields)
    } catch {
      // Diagnostics must never affect the failure path being observed.
    }
  }
  const info = (message: string, fields: Record<string, unknown>): void => {
    try {
      if (options.log.info) options.log.info(message, fields)
      else options.log.warn(message, fields)
    } catch {
      // Diagnostics must never affect the recovery path being observed.
    }
  }
  const windows = new Map<
    string,
    {
      startedAt: number
      fingerprints: Set<string>
      reportCount: number
      suppressedCount: number
    }
  >()

  return {
    report: (senderKey, value) => {
      // Select a separate bounded budget without evaluating renderer-controlled getters. Recovery
      // milestones must not consume the error budget or lose repeated flashes to fingerprint dedup.
      let recoveryPayload = false
      try {
        const write = Object.getOwnPropertyDescriptor(value, 'sessionWrite')?.value
        recoveryPayload = Object.getOwnPropertyDescriptor(write, 'recovery')?.value !== undefined
      } catch {
        // Invalid envelopes use the ordinary bounded validation path below.
      }
      const windowKey = `${recoveryPayload ? 'recovery' : 'failure'}:${senderKey}`
      const limit = recoveryPayload ? maxRecoveryReportsPerWindow : maxReportsPerWindow
      const timestamp = readNow()
      let window = windows.get(windowKey)
      if (!window || timestamp - window.startedAt >= windowMs) {
        if (window?.suppressedCount) {
          warn(
            recoveryPayload
              ? 'session storage recovery reports suppressed'
              : 'renderer failure reports suppressed',
            {
              suppressedCount: window.suppressedCount,
              windowMs
            }
          )
        }
        window = {
          startedAt: timestamp,
          fingerprints: new Set(),
          reportCount: 0,
          suppressedCount: 0
        }
        windows.set(windowKey, window)
      }

      if (window.reportCount >= limit) {
        window.suppressedCount += 1
        if (recoveryPayload && window.suppressedCount === 1)
          warn('session storage recovery rate limit reached', {
            windowMs,
            maxReportsPerWindow: limit
          })
        return 'suppressed'
      }
      window.reportCount += 1

      const report = projectRendererFailureReport(value)
      if (!report) {
        warn('renderer failure report rejected', {
          errorCategory: 'invalid-payload'
        })
        return 'rejected'
      }

      const fingerprint = [
        report.source,
        report.surface,
        report.errorCategory,
        report.context ?? 'none',
        report.fingerprint ?? 'none',
        report.sessionWrite?.target ?? '',
        report.sessionWrite?.sessionId ?? '',
        report.sessionWrite?.projectId ?? '',
        report.sessionWrite?.code ?? '',
        report.sessionWrite?.epoch ?? '',
        report.sessionWrite?.phase ?? ''
      ].join(':')
      if (!recoveryPayload && window.fingerprints.has(fingerprint)) {
        window.suppressedCount += 1
        return 'suppressed'
      }
      if (!recoveryPayload) window.fingerprints.add(fingerprint)
      const recovery = report.sessionWrite?.recovery
      if (recovery) {
        if (
          ['retained', 'reconcile-unconfirmed', 'retry-failed', 'discard-failed'].includes(
            recovery.event
          )
        )
          warn('session storage recovery', report)
        else info('session storage recovery', report)
      } else {
        error('renderer javascript failure', report)
      }
      return 'recorded'
    }
  }
}

type RendererDiagnosticsIpcTarget = {
  on(
    channel: string,
    listener: (event: { sender: { id: number } }, value: unknown) => void
  ): unknown
  removeListener(
    channel: string,
    listener: (event: { sender: { id: number } }, value: unknown) => void
  ): unknown
}

export const registerRendererDiagnosticsIpc = (
  target: RendererDiagnosticsIpcTarget,
  reporter: RendererFailureReporter
): (() => void) => {
  const listener = (event: { sender: { id: number } }, value: unknown): void => {
    try {
      reporter.report(String(event.sender.id), value)
    } catch {
      // A diagnostics adapter must not escape back into Electron's event dispatch.
    }
  }
  let installed = false
  try {
    target.on(RENDERER_FAILURE_CHANNEL, listener)
    installed = true
  } catch {
    // Diagnostics are optional and must not block main-process startup.
  }
  return () => {
    if (!installed) return
    try {
      target.removeListener(RENDERER_FAILURE_CHANNEL, listener)
    } catch {
      // Removal remains best effort during main-process teardown.
    }
  }
}
