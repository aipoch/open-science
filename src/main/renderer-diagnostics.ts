import type { Logger } from './logger'
import {
  RENDERER_FAILURE_CHANNEL,
  isRendererFailureReport,
  type RendererFailureReport
} from '../shared/diagnostics'

type RendererFailureReporter = {
  report(senderKey: string, value: unknown): 'recorded' | 'rejected' | 'suppressed'
}

type RendererFailureReporterOptions = {
  log: Pick<Logger, 'error' | 'warn'>
  now?: () => number
  windowMs?: number
  maxReportsPerWindow?: number
}

const projectRendererFailureReport = (value: unknown): RendererFailureReport | undefined => {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined

    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (
      keys.some(
        (key) => !['source', 'surface', 'errorCategory', 'context', 'fingerprint'].includes(key)
      )
    ) {
      return undefined
    }
    if (!keys.includes('source') || !keys.includes('surface') || !keys.includes('errorCategory')) {
      return undefined
    }

    const candidate = {
      source: record.source,
      surface: record.surface,
      errorCategory: record.errorCategory,
      ...(keys.includes('context') ? { context: record.context } : {}),
      ...(keys.includes('fingerprint') ? { fingerprint: record.fingerprint } : {})
    }
    return isRendererFailureReport(candidate) ? candidate : undefined
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
      const timestamp = readNow()
      let window = windows.get(senderKey)
      if (!window || timestamp - window.startedAt >= windowMs) {
        if (window?.suppressedCount) {
          warn('renderer failure reports suppressed', {
            suppressedCount: window.suppressedCount,
            windowMs
          })
        }
        window = {
          startedAt: timestamp,
          fingerprints: new Set(),
          reportCount: 0,
          suppressedCount: 0
        }
        windows.set(senderKey, window)
      }

      if (window.reportCount >= maxReportsPerWindow) {
        window.suppressedCount += 1
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
        report.fingerprint ?? 'none'
      ].join(':')
      if (window.fingerprints.has(fingerprint)) {
        window.suppressedCount += 1
        return 'suppressed'
      }
      window.fingerprints.add(fingerprint)
      error('renderer javascript failure', report)
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
