import { getLogFilePath } from '@aipoch/diagnostics/node'
import { runtimeMetadata } from '../runtime-metadata'
import { resolveDesktopLogPaths } from './desktop-log-paths'
import { createSessionDiagnosticsDesktop, type SessionDiagnosticsDesktop } from './desktop'
import createDiagnosticsWorker from './worker-entry?nodeWorker'

/**
 * Diagnostics are normally owned by the Node runtime. Keep a small Electron-owned owner ready
 * for the recovery window, when that runtime is unavailable but its files are still inspectable.
 */
export function createElectronSessionDiagnosticsFallback(options: {
  configRoot: string
  dataRoot: string
  chooseDestination: (defaultName: string) => Promise<string | undefined>
}): SessionDiagnosticsDesktop {
  return createSessionDiagnosticsDesktop({
    createWorker: createDiagnosticsWorker,
    resolveSources: () => ({
      dataRoot: options.dataRoot,
      configRoot: options.configRoot,
      logPath: getLogFilePath(),
      ...resolveDesktopLogPaths({
        configRoot: options.configRoot,
        packaged: runtimeMetadata().packaged,
        homePath: runtimeMetadata().homePath
      }),
      appVersion: runtimeMetadata().version
    }),
    chooseDestination: options.chooseDestination
  })
}
