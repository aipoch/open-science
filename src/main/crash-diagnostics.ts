import type { Details as ChildProcessGoneDetails, Event as ElectronEvent } from 'electron'

type LocalCrashReporterStartOptions = {
  productName: string
  companyName: string
  uploadToServer: false
  compress: false
  extra: { appVersion: string }
}

type LocalCrashReportingStatus = { enabled: true; uploadsEnabled: false } | { enabled: false }

type StartLocalCrashReportingOptions = {
  platform: NodeJS.Platform
  productName: string
  companyName: string
  appVersion: string
  start: (options: LocalCrashReporterStartOptions) => void
}

type ChildProcessGoneListener = (event: ElectronEvent, details: ChildProcessGoneDetails) => void

type DiagnosticLogger = {
  error: (message: string, metadata: Record<string, unknown>) => void
}

// Starts local-only Crashpad before a Windows renderer can be created. Other platforms keep their
// existing crash-reporting behavior and never call Electron's crashReporter.start().
const startLocalCrashReporting = ({
  platform,
  productName,
  companyName,
  appVersion,
  start
}: StartLocalCrashReportingOptions): LocalCrashReportingStatus => {
  if (platform !== 'win32') return { enabled: false }

  start({
    productName,
    companyName,
    uploadToServer: false,
    compress: false,
    extra: { appVersion }
  })

  return { enabled: true, uploadsEnabled: false }
}

// Binds app-level GPU/utility diagnostics while deliberately projecting only lifecycle vocabulary
// and numeric exit metadata; command lines, URLs, and filesystem paths never reach main.log.
const installChildProcessGoneLogging = (
  register: (listener: ChildProcessGoneListener) => void,
  log: DiagnosticLogger
): void => {
  register((_event, details) => {
    log.error('child process gone', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName,
      name: details.name
    })
  })
}

export { installChildProcessGoneLogging, startLocalCrashReporting }
