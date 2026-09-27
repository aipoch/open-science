import { composeApplicationRuntimeWithAdapters } from './application-runtime'
import { installElectronRuntimeAdapters } from './runtime-electron-wiring'
import { createLogger } from './logger'
import { startDiagnosticOperation } from './diagnostics/operation'
import {
  createApplicationModules,
  type IpcRegistration,
  type IpcRegistrationOptions
} from './ipc-application-composition'

export type { ApplicationRuntimeInterfaces } from './ipc-application-composition'

// Keep the public registration facade focused on lifecycle ownership. Application construction lives
// in its own module so the Electron adapter boundary remains easy to inspect without changing the
// construction or teardown order of the application graph.
const registerIpcHandlers = async (options: IpcRegistrationOptions): Promise<IpcRegistration> => {
  performance.mark('open-science:ipc-registration-start')
  const composition = startDiagnosticOperation(createLogger('startup'), {
    operation: 'application-composition',
    cpuUsage: process.cpuUsage
  })
  try {
    const applicationRuntime = await composeApplicationRuntimeWithAdapters(
      (modules) => createApplicationModules(options, modules, composition),
      installElectronRuntimeAdapters
    )
    composition.phase('ipc-adapters')
    composition.complete()
    performance.mark('open-science:ipc-registration-complete')
    performance.measure(
      'open-science:ipc-registration',
      'open-science:ipc-registration-start',
      'open-science:ipc-registration-complete'
    )
    return {
      ...applicationRuntime.interfaces,
      dispose: applicationRuntime.dispose
    }
  } catch (error) {
    composition.fail(error)
    throw error
  }
}

export { registerIpcHandlers }
